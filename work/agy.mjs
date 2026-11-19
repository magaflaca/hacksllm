// bichi agy: Antigravity (agy) trabajando en la computadora del usuario de bichi code.
// agy corre aqui, en un sandbox, pero su carpeta de trabajo es un disco FUSE cuyo contenido vive en la PC del usuario
// y su bash es una bash falsa que ejecuta los comandos alla. Este servicio hace de puente: el disco y la bash le
// preguntan por un enchufe unix, y cada pregunta viaja a bichi code dentro de la respuesta del turno.
//   POST /agy/turn   -> NDJSON: {t:'ready'} {t:'status'} {t:'ev'} {t:'op'} ... {t:'done'}
//   POST /agy/reply  -> respuestas de bichi code a las {t:'op'}, en lote
//   POST /agy/cancel -> corta el turno
// Va aparte de bichi work (otro servicio, otro usuario para el agente, otra carpeta), aunque comparte el parser de agy.
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { authorizer } from './auth.mjs';
import { parseAgy, QUOTA } from './engines.mjs';

const PORT = Number(process.env.AGY_PORT ?? 20140);
const GATEWAY = process.env.WORK_GATEWAY ?? 'http://127.0.0.1:20128';
const CONCURRENCY = Number(process.env.AGY_CONCURRENCY ?? 2);
const ROOT = process.env.AGY_ROOT ?? '/srv/hacksllm-agy';
const TURNS = path.join(ROOT, 't');
const RUNNER = ['sudo', '-n', '/usr/local/bin/bichi-agy-run'];
const PYTHON = process.env.AGY_PYTHON ?? '/opt/hacksllm/agy-venv/bin/python';
const DISK = path.join(import.meta.dirname, 'agy-fs.py');
const AGENT_UID = Number(process.env.AGY_UID ?? 0);
const AGENT_GID = Number(process.env.AGY_GID ?? 0);

// Limites: un proyecto enorme (una carpeta de juegos, por ejemplo) no puede llenar el VPS ni la conexion.
const LIMITS = {
  prompt: 60_000, // caracteres del mensaje
  context: 30_000, // conversacion previa que se le pasa cuando no puede retomar la suya
  file: 25 << 20, // un archivo mas grande no se lee por el disco (con comandos si se puede trabajar con el)
  turnBytes: 400 << 20, // lo que puede viajar entre la PC y el VPS en un turno
  tree: 20_000, // entradas del arbol del proyecto que se conocen de antemano
  listing: 3_000, // entradas de una carpeta que se lista bajo demanda
  op: 120_000, // espera maxima a que la PC conteste una lectura o un listado
  approval: 30 * 60_000, // lo que puede esperar algo que pide permiso al usuario (escribir, borrar, ejecutar)
  run: 30 * 60_000, // espera maxima de un comando
  turn: 25 * 60_000, // duracion maxima de un turno
  silence: 30_000, // sin noticias de bichi code (ni respuestas ni latidos) en este tiempo, el turno se corta
  reply: 64 << 20, // cuerpo de /agy/reply
  start: 8 << 20, // cuerpo de /agy/turn (el arbol va dentro)
};
const MODELS = [
  { key: 'flash', model: (effort) => `gemini-3.8-flash-${effort}` },
  { key: 'oss', model: () => 'gpt-oss-120b-medium' },
];
const EFFORTS = new Set(['low', 'medium', 'high']);
const E = { NOENT: 2, IO: 5, ACCES: 13, EXIST: 17, NOTDIR: 20, ISDIR: 21, FBIG: 27, NOSPC: 28, NOTEMPTY: 39 };

const authorize = authorizer(GATEWAY);
const runner = (...args) => spawn(RUNNER[0], [...RUNNER.slice(1), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });

// ---- cola y descansos

let running = 0;
const waiting = [];
const acquire = (onQueued) =>
  new Promise((resolve) => {
    if (running < CONCURRENCY) return (running++, resolve());
    waiting.push(resolve);
    onQueued(waiting.length);
  });
const release = () => (waiting.length ? waiting.shift()() : running--);
const cooldown = new Map();
const resting = (key) => (cooldown.get(key) ?? 0) > Date.now();

const turns = new Map(); // id -> Turn
const byOwner = new Map(); // owner -> Turn

// ---- arbol del proyecto (lo que se sabe de la PC sin preguntar)

const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const nameOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const relOf = (fusePath) => String(fusePath ?? '/').replace(/^\/+|\/+$/g, '');

class Tree {
  constructor(entries = []) {
    this.nodes = new Map([['', { dir: true, size: 0, mtime: Date.now() / 1000, loaded: false, kids: new Set() }]]);
    this.fill('', entries, true);
  }

  // entries: [rel, size, mtime, 'f' | 'd' (carpeta conocida) | 'D' (carpeta sin listar)], relativas a `base`.
  fill(base, entries, complete) {
    const root = this.nodes.get(base);
    if (root) {
      for (const kid of root.kids) this.drop(base ? `${base}/${kid}` : kid);
      root.loaded = complete;
    }
    for (const [rel, size, mtime, flag] of entries.slice(0, LIMITS.tree)) {
      const full = base ? `${base}/${rel}` : rel;
      if (!full || full.split('/').some((part) => !part || part === '..' || part === '.')) continue;
      this.set(full, { dir: flag !== 'f', size: Number(size) || 0, mtime: Number(mtime) || Date.now() / 1000, loaded: flag === 'd' });
    }
  }

  set(rel, node) {
    const old = this.nodes.get(rel);
    this.nodes.set(rel, { kids: old?.kids ?? new Set(), ...node });
    let child = rel;
    while (child) {
      const parent = parentOf(child);
      if (!this.nodes.has(parent)) this.nodes.set(parent, { dir: true, size: 0, mtime: Date.now() / 1000, loaded: false, kids: new Set() });
      this.nodes.get(parent).kids.add(nameOf(child));
      child = parent;
    }
  }

  drop(rel) {
    const node = this.nodes.get(rel);
    if (!node) return;
    for (const kid of node.kids) this.drop(`${rel}/${kid}`);
    this.nodes.delete(rel);
    this.nodes.get(parentOf(rel))?.kids.delete(nameOf(rel));
  }

  move(from, to) {
    const moved = [...this.nodes.entries()].filter(([rel]) => rel === from || rel.startsWith(`${from}/`));
    this.drop(from);
    for (const [rel, node] of moved) this.set(to + rel.slice(from.length), { ...node, kids: new Set(node.kids) });
  }
}

// ---- un turno

class Turn {
  constructor(owner, res, body) {
    this.id = randomBytes(12).toString('hex');
    this.owner = owner;
    this.res = res;
    this.body = body;
    this.dir = path.join(TURNS, this.id);
    this.mnt = path.join(this.dir, 'mnt');
    this.sock = path.join(this.dir, 'io', 'link.sock');
    this.tree = new Tree(Array.isArray(body.tree) ? body.tree : []);
    this.files = new Map(); // rel -> { data: Buffer, dirty }
    this.pending = new Map(); // id -> { resolve, timer }
    this.next = 0;
    this.bytes = 0;
    this.controller = new AbortController();
    this.closed = false;
    this.seen = Date.now(); // ultima noticia de bichi code: por la web, cerrar la ventana no siempre corta la conexion
  }

  stale() {
    return Date.now() - this.seen > LIMITS.silence;
  }

  send(message) {
    if (!this.res.writableEnded) this.res.write(`${JSON.stringify(message)}\n`);
  }

  // Pregunta a bichi code (en la PC). Devuelve su respuesta o { errno }.
  ask(op, timeout = LIMITS.op) {
    if (this.closed) return Promise.resolve({ errno: E.IO });
    const id = ++this.next;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ errno: E.IO, error: 'la PC no contesto a tiempo' });
      }, timeout);
      this.pending.set(id, { resolve, timer });
      this.send({ t: 'op', id, ...op });
    });
  }

  answer(reply) {
    const waiter = this.pending.get(reply.id);
    if (!waiter) return;
    this.pending.delete(reply.id);
    clearTimeout(waiter.timer);
    waiter.resolve(reply);
  }

  spend(bytes) {
    this.bytes += bytes;
    return this.bytes <= LIMITS.turnBytes;
  }

  // ---- el disco

  async node(rel) {
    if (this.tree.nodes.has(rel)) return this.tree.nodes.get(rel);
    // Dentro de una carpeta que no se listo aun (pesada o profunda): se lista ahora, una vez.
    const parent = parentOf(rel);
    const up = rel ? await this.node(parent) : null;
    if (up?.dir && !up.loaded) await this.list(parent);
    return this.tree.nodes.get(rel) ?? null;
  }

  async list(rel) {
    const reply = await this.ask({ op: 'ls', path: rel });
    if (reply.errno) return reply;
    const entries = Array.isArray(reply.entries) ? reply.entries.slice(0, LIMITS.listing) : [];
    this.tree.fill(rel, entries, true);
    return {};
  }

  async content(rel) {
    const cached = this.files.get(rel);
    if (cached) return cached;
    const node = await this.node(rel);
    if (!node) return { errno: E.NOENT };
    if (node.dir) return { errno: E.ISDIR };
    if (node.size > LIMITS.file) return { errno: E.FBIG };
    const reply = await this.ask({ op: 'read', path: rel });
    if (reply.errno) return reply;
    const data = Buffer.from(reply.data ?? '', 'base64');
    if (!this.spend(data.length)) return { errno: E.NOSPC };
    const file = { data, dirty: false };
    this.files.set(rel, file);
    this.tree.set(rel, { ...node, size: data.length });
    return file;
  }

  async flush(rel) {
    const file = this.files.get(rel);
    if (!file?.dirty) return 0;
    if (file.data.length > LIMITS.file) return E.FBIG;
    if (!this.spend(file.data.length)) return E.NOSPC;
    const reply = await this.ask({ op: 'put', path: rel, data: file.data.toString('base64') }, LIMITS.approval);
    if (reply.errno) {
      // Rechazado en la PC: se olvida lo escrito para que el disco vuelva a mostrar lo que hay alla.
      this.files.delete(rel);
      if (reply.missing) this.tree.drop(rel);
      return reply.errno;
    }
    file.dirty = false;
    this.tree.set(rel, { dir: false, size: file.data.length, mtime: Date.now() / 1000, loaded: true });
    return 0;
  }

  async disk(message) {
    const rel = relOf(message.path);
    switch (message.op) {
      case 'getattr': {
        const node = await this.node(rel);
        if (!node) return { errno: E.NOENT };
        const size = this.files.get(rel)?.data.length ?? node.size;
        return { ok: { dir: node.dir, size, mtime: node.mtime } };
      }
      case 'readdir': {
        const node = await this.node(rel);
        if (!node) return { errno: E.NOENT };
        if (!node.dir) return { errno: E.NOTDIR };
        if (!node.loaded) {
          const listed = await this.list(rel);
          if (listed.errno) return listed;
        }
        return { ok: [...(this.tree.nodes.get(rel)?.kids ?? [])] };
      }
      case 'read': {
        const file = await this.content(rel);
        if (file.errno) return file;
        const offset = Number(message.offset) || 0;
        return { ok: file.data.subarray(offset, offset + (Number(message.size) || 0)).toString('base64') };
      }
      case 'write': {
        const node = await this.node(rel);
        const file = node ? await this.content(rel) : { data: Buffer.alloc(0) };
        if (file.errno) return file;
        const chunk = Buffer.from(message.data ?? '', 'base64');
        const offset = Number(message.offset) || 0;
        const end = offset + chunk.length;
        if (end > LIMITS.file) return { errno: E.FBIG };
        let data = file.data;
        if (end > data.length) data = Buffer.concat([data, Buffer.alloc(end - data.length)]);
        chunk.copy(data, offset);
        this.files.set(rel, { data, dirty: true });
        this.tree.set(rel, { dir: false, size: data.length, mtime: Date.now() / 1000, loaded: true });
        return { ok: chunk.length };
      }
      case 'truncate': {
        const length = Number(message.length) || 0;
        if (length > LIMITS.file) return { errno: E.FBIG };
        const file = length ? await this.content(rel) : { data: Buffer.alloc(0) };
        if (file.errno) return file;
        const data = Buffer.alloc(length);
        file.data.copy(data, 0, 0, Math.min(length, file.data.length));
        this.files.set(rel, { data, dirty: true });
        this.tree.set(rel, { dir: false, size: length, mtime: Date.now() / 1000, loaded: true });
        return { ok: 0 };
      }
      case 'create': {
        const parent = await this.node(parentOf(rel));
        if (!parent?.dir) return { errno: E.NOENT };
        this.files.set(rel, { data: Buffer.alloc(0), dirty: true });
        this.tree.set(rel, { dir: false, size: 0, mtime: Date.now() / 1000, loaded: true });
        return { ok: 0 };
      }
      case 'flush':
        return { ok: 0, errno: (await this.flush(rel)) || undefined };
      case 'unlink':
      case 'rmdir': {
        this.files.delete(rel);
        const reply = await this.ask({ op: message.op === 'unlink' ? 'rm' : 'rmdir', path: rel }, LIMITS.approval);
        if (reply.errno) return reply;
        this.tree.drop(rel);
        return { ok: 0 };
      }
      case 'mkdir': {
        const reply = await this.ask({ op: 'mkdir', path: rel });
        if (reply.errno) return reply;
        this.tree.set(rel, { dir: true, size: 0, mtime: Date.now() / 1000, loaded: true });
        return { ok: 0 };
      }
      case 'rename': {
        const to = relOf(message.to);
        const failed = await this.flush(rel);
        if (failed) return { errno: failed };
        const reply = await this.ask({ op: 'mv', path: rel, to });
        if (reply.errno) return reply;
        for (const [key, file] of [...this.files]) {
          if (key === rel || key.startsWith(`${rel}/`)) {
            this.files.delete(key);
            this.files.set(to + key.slice(rel.length), file);
          }
        }
        this.tree.move(rel, to);
        return { ok: 0 };
      }
      case 'run': {
        // La bash falsa: el comando se ejecuta en la PC. Antes se guarda lo pendiente para que el comando lo vea.
        for (const key of this.files.keys()) await this.flush(key);
        const reply = await this.ask({ op: 'run', command: String(message.command ?? '').slice(0, 100_000), cwd: rel }, LIMITS.approval + LIMITS.run);
        if (reply.errno) return { ok: { out: reply.error ?? 'no se pudo ejecutar en la PC', code: 126 } };
        // El comando pudo cambiar cualquier cosa: la PC manda el arbol de nuevo y se olvida lo leido.
        if (Array.isArray(reply.tree)) {
          this.tree = new Tree(reply.tree);
          this.files.clear();
        }
        return { ok: { out: String(reply.out ?? ''), code: Number(reply.code) || 0 } };
      }
      default:
        return { errno: E.IO };
    }
  }

  // ---- enchufe para el disco y la bash falsa

  listen() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        const lines = createInterface({ input: socket });
        lines.on('line', async (line) => {
          let reply;
          try {
            reply = await this.disk(JSON.parse(line));
          } catch {
            reply = { errno: E.IO };
          }
          if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
        });
        socket.on('error', () => {});
      });
      this.server.on('error', reject);
      this.server.listen(this.sock, async () => {
        await chmod(this.sock, 0o666);
        resolve();
      });
    });
  }

  async mount() {
    await mkdir(this.mnt, { recursive: true });
    await mkdir(path.dirname(this.sock), { recursive: true });
    await chmod(this.dir, 0o755);
    await chmod(path.dirname(this.sock), 0o755);
    await this.listen();
    this.fuse = spawn(PYTHON, [DISK, this.mnt, this.sock, String(AGENT_UID), String(AGENT_GID)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    this.fuse.stderr.on('data', (chunk) => (errors = (errors + chunk).slice(-2000)));
    for (let i = 0; i < 50; i++) {
      const mounts = await readFile('/proc/mounts', 'utf8');
      if (mounts.includes(` ${this.mnt} `)) return;
      if (this.fuse.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`no se pudo montar el disco: ${errors.slice(-300)}`);
  }

  async cleanup() {
    this.closed = true;
    for (const { resolve, timer } of this.pending.values()) (clearTimeout(timer), resolve({ errno: E.IO }));
    this.pending.clear();
    await new Promise((resolve) => runner('stop', this.id).on('close', resolve).on('error', resolve));
    await unmount(this.mnt);
    this.fuse?.kill('SIGTERM');
    this.server?.close();
    await rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}

const unmount = (mnt) => new Promise((resolve) => spawn('fusermount3', ['-uz', mnt], { stdio: 'ignore' }).on('close', resolve).on('error', resolve));

// ---- el prompt

const FOLDER = /^[A-Za-z0-9._-]{1,60}$/;

function preamble(body, folder) {
  const shell = body.shell === 'powershell' ? 'PowerShell de Windows' : body.os === 'win32' ? 'Git Bash en Windows (sirven los comandos de bash y las rutas tipo C:/...)' : 'bash';
  const lines = [
    '[bichi code · modo agy]',
    `Trabajas directamente en la computadora del usuario, a traves de bichi code. Tu carpeta de trabajo /pc/${folder} ES la carpeta del proyecto en su computadora (${String(body.where ?? '').slice(0, 300)}, sistema ${body.os ?? 'desconocido'}): lo que leas o escribas ahi cambia sus archivos de verdad.`,
    `Los comandos de tu terminal se ejecutan en su computadora con ${shell}; ~ es su carpeta de usuario. Instalar, compilar o ejecutar programas pasa alli, no aqui.`,
    `Fuera de /pc/${folder} esta maquina no tiene nada del usuario: para otras carpetas suyas (Descargas, Escritorio...) usa comandos, no tus herramientas de archivos.`,
    `Los archivos de mas de 25 MB no se pueden leer con tus herramientas de archivos (para esos usa comandos). Si existen AGENTS.md, CLAUDE.md o .bichi/BICHI.md en el proyecto, siguelos.`,
    'Responde en el idioma del usuario, claro y breve. Puedes publicar webs estaticas como bichi paginas solo si el usuario lo pide.',
  ];
  const context = String(body.context ?? '').slice(-LIMITS.context);
  if (context) lines.push('', 'Conversacion anterior con el usuario (para que tengas el contexto):', context);
  return `${lines.join('\n')}\n\n---\n\n`;
}

// ---- un turno de agy, con el modelo de respaldo si el primero no puede

function runModel(turn, { model, resume, mode, folder, prompt }) {
  return new Promise((resolve) => {
    const child = runner('run', turn.id, model, resume ?? '-', mode, folder);
    child.stdin.end(prompt);
    let final = null;
    let failure = '';
    let stderr = '';
    let conversation = null;
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    createInterface({ input: child.stdout }).on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      for (const out of parseAgy(event)) {
        if (out.type === 'final') final = out.text;
        else if (out.type === 'fail') failure = out.message;
        else if (out.type === 'resume') {
          conversation = out.id;
          // Se avisa ya: si la conexion se corta a mitad, bichi puede retomar esta misma conversacion.
          turn.send({ t: 'resume', model: turn.modelKey, id: out.id });
        }
        else turn.send({ t: 'ev', ...out });
      }
      // Lo que agy piensa (si lo manda) tambien se ve en bichi.
      const thinking = event.step_update?.thinking_delta;
      if (thinking) turn.send({ t: 'ev', type: 'thinking', delta: String(thinking) });
    });
    child.on('close', (code) => {
      const reason = failure || stderr || `salida ${code}`;
      resolve({ ok: final !== null && !failure && code === 0, final, reason, quota: QUOTA.test(reason), conversation });
    });
  });
}

async function runTurn(turn) {
  const { body } = turn;
  const effort = EFFORTS.has(body.effort) ? body.effort : 'medium';
  const mode = body.mode === 'plan' ? 'plan' : 'auto';
  const folder = FOLDER.test(body.folder ?? '') ? body.folder : 'proyecto';
  const message = String(body.message ?? '').slice(0, LIMITS.prompt);
  const resumes = typeof body.resume === 'object' && body.resume ? body.resume : {};
  const order = MODELS.filter((entry) => !resting(entry.key));
  if (!order.length) order.push(...MODELS);
  for (const [index, entry] of order.entries()) {
    if (turn.controller.signal.aborted) break;
    if (index) turn.send({ t: 'status', text: 'cambiando de modelo…' });
    const resume = /^[A-Za-z0-9_-]{1,80}$/.test(resumes[entry.key] ?? '') ? resumes[entry.key] : null;
    const prompt = resume ? message : preamble(body, folder) + message;
    turn.modelKey = entry.key;
    const result = await runModel(turn, { model: entry.model(effort), resume, mode, folder, prompt });
    if (result.ok) return { ok: true, text: result.final, model: entry.key, resume: { ...resumes, [entry.key]: result.conversation ?? resume } };
    if (turn.controller.signal.aborted) break;
    console.warn(`[agy] ${entry.key} fallo: ${result.reason.slice(0, 300)}`);
    cooldown.set(entry.key, Date.now() + (result.quota ? 30 : 3) * 60_000);
    // Una conversacion que ya no existe no se vuelve a intentar.
    delete resumes[entry.key];
  }
  return { ok: false, text: turn.controller.signal.aborted ? 'interrumpido' : 'agy no pudo con este turno ahora mismo; prueba en un rato o cambia de modelo', resume: resumes };
}

// ---- http

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (res, status, message) => send(res, status, { error: { message } });

async function readJson(req, max) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('demasiado grande'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function startTurn(req, res, owner) {
  const body = await readJson(req, LIMITS.start);
  if (!String(body.message ?? '').trim()) return fail(res, 400, 'falta el mensaje');
  const previous = byOwner.get(owner);
  if (previous && !previous.stale()) return fail(res, 409, 'ya tienes un turno de agy en marcha');
  // Uno abandonado (bichi se cerro sin avisar) se corta y deja sitio al nuevo.
  if (previous) previous.controller.abort();
  const turn = new Turn(owner, res, body);
  turns.set(turn.id, turn);
  byOwner.set(owner, turn);
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  turn.send({ t: 'ready', turn: turn.id });
  const abort = () => turn.controller.abort();
  res.on('close', abort);
  const keepalive = setInterval(() => {
    turn.send({ t: 'ping' });
    if (turn.stale()) abort();
  }, 10_000);
  const deadline = setTimeout(abort, LIMITS.turn);
  turn.controller.signal.addEventListener('abort', () => runner('stop', turn.id), { once: true });
  let slot = false;
  try {
    await acquire((position) => turn.send({ t: 'status', text: `en cola: ${position} por delante` }));
    slot = true;
    if (turn.controller.signal.aborted) throw new Error('interrumpido');
    await turn.mount();
    const result = await runTurn(turn);
    // Lo ultimo que quedo sin guardar (un archivo abierto al terminar) se manda tambien.
    for (const key of turn.files.keys()) await turn.flush(key);
    turn.send({ t: 'done', ...result });
  } catch (error) {
    turn.send({ t: 'done', ok: false, text: error.message });
  } finally {
    clearInterval(keepalive);
    clearTimeout(deadline);
    res.off('close', abort);
    await turn.cleanup();
    if (slot) release();
    turns.delete(turn.id);
    if (byOwner.get(owner) === turn) byOwner.delete(owner);
    if (!res.writableEnded) res.end();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    const [, scope, action] = url.pathname.split('/');
    if (scope !== 'agy' || req.method !== 'POST') return fail(res, 404, 'no existe');
    const owner = await authorize(req);
    if (!owner) return fail(res, 401, 'hace falta una clave de la API valida');
    if (action === 'turn') return await startTurn(req, res, owner);
    const body = await readJson(req, LIMITS.reply);
    const turn = turns.get(String(body.turn ?? ''));
    if (!turn || turn.owner !== owner) return fail(res, 404, 'ese turno ya no esta');
    turn.seen = Date.now();
    if (action === 'reply') {
      for (const reply of Array.isArray(body.replies) ? body.replies : []) turn.answer(reply);
      return send(res, 200, { ok: true });
    }
    if (action === 'cancel') {
      turn.controller.abort();
      return send(res, 200, { ok: true });
    }
    fail(res, 404, 'no existe');
  } catch (error) {
    if (!res.headersSent) fail(res, error.status ?? 500, error.status ? error.message : 'error interno');
    else res.end();
    if (!error.status) console.error('[agy]', error);
  }
});

// Restos de un arranque anterior (discos montados, carpetas de turnos).
await mkdir(TURNS, { recursive: true });
for (const id of await readdir(TURNS).catch(() => [])) {
  await unmount(path.join(TURNS, id, 'mnt'));
  await rm(path.join(TURNS, id), { recursive: true, force: true }).catch(() => {});
}
server.listen(PORT, '127.0.0.1', () => console.log(`[agy] escuchando en ${PORT}`));
