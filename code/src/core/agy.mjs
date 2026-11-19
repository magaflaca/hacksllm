// Modo agy: Antigravity (agy, con Gemini 3.8 Flash y gpt-oss de respaldo) trabaja en esta computadora desde el VPS de
// hacksllm. Alla su carpeta de trabajo es un disco que en realidad es este proyecto, y su terminal es una bash falsa
// que ejecuta aqui: el servicio nos va pidiendo leer, escribir, listar o ejecutar, y aqui se hace (con permisos).
import { readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { mkdir, readdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SITE } from '../config.mjs';
import { backoff, RETRIES, sleep, transient } from './retry.mjs';
import { hacksKey } from './work.mjs';

export const isAgy = (model) => model === 'agy' || model === 'bichi-agy';

// Carpetas pesadas: se ven como carpetas, pero su contenido solo se lista si agy entra en ellas.
const HEAVY = new Set(['node_modules', '.git', '.hg', '.svn', 'bin', 'obj', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.gradle', '.idea', '.vs', 'vendor', 'packages', 'coverage', '.cache', 'Library', 'Temp']);
const LIMITS = { entries: 20_000, depth: 8, perDir: 3_000, file: 25 << 20 };
const E = { NOENT: 2, IO: 5, ACCES: 13, EXIST: 17, ISDIR: 21, FBIG: 27, NOTEMPTY: 39 };

// Donde no se trabaja en modo agy: la raiz del disco o la carpeta de usuario (ahi se ofrece crear una carpeta de
// proyecto) y las carpetas del sistema (ahi no).
export function projectProblem(cwd) {
  const here = path.resolve(cwd);
  const same = (a, b) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
  if (/^[a-z]:\\windows(\\|$)/i.test(here) || /^\/(etc|usr|bin|sbin|var|proc|sys)(\/|$)/.test(here)) return { reason: 'system', message: 'el modo agy no trabaja en carpetas del sistema' };
  if (same(here, path.parse(here).root)) return { reason: 'root', message: 'esta conversacion no tiene carpeta de proyecto' };
  if (same(here, os.homedir())) return { reason: 'home', message: 'esta conversacion no tiene carpeta de proyecto' };
  return null;
}

// Nombre de la carpeta tal como la vera agy (/pc/<nombre>).
export const folderName = (cwd) => path.basename(path.resolve(cwd)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 60) || 'proyecto';

// Arbol del proyecto que se manda al empezar: [ruta, tamano, mtime, 'f' | 'd' (completa) | 'D' (sin listar)].
export function scanTree(root) {
  const out = [];
  const walk = (dir, rel, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    if (entries.length > LIMITS.perDir) return false;
    for (const entry of entries) {
      if (out.length >= LIMITS.entries) return false;
      const full = path.join(dir, entry.name);
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        const row = [child, 0, info.mtimeMs / 1000, 'D'];
        out.push(row);
        if (!HEAVY.has(entry.name) && depth < LIMITS.depth && walk(full, child, depth + 1)) row[3] = 'd';
      } else if (info.isFile()) out.push([child, info.size, info.mtimeMs / 1000, 'f']);
    }
    return true;
  };
  walk(root, '', 0);
  return out;
}

async function listing(dir) {
  const entries = (await readdir(dir, { withFileTypes: true })).slice(0, LIMITS.perDir);
  const out = [];
  for (const entry of entries) {
    const info = await stat(path.join(dir, entry.name)).catch(() => null);
    if (info?.isDirectory()) out.push([entry.name, 0, info.mtimeMs / 1000, 'D']);
    else if (info?.isFile()) out.push([entry.name, info.size, info.mtimeMs / 1000, 'f']);
  }
  return out;
}

// Rutas entre los dos lados: agy ve /pc/<carpeta>; aqui es la carpeta real.
export function translator(cwd) {
  const folder = folderName(cwd);
  const pc = `/pc/${folder}`;
  const real = path.resolve(cwd);
  const slash = real.replace(/\\/g, '/');
  const variants = [real, slash];
  if (/^[a-z]:/i.test(slash)) variants.push(`/${slash[0].toLowerCase()}${slash.slice(2)}`); // estilo Git Bash: /c/...
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const realPattern = new RegExp(variants.sort((a, b) => b.length - a.length).map(escape).join('|'), 'gi');
  const url = pathToFileURL(real).href;
  return {
    folder,
    // Comando de agy -> comando aqui.
    toLocal: (command) => command.split(pc).join(slash),
    // Salida de aqui -> lo que vera agy.
    toAgy: (text) => text.replace(realPattern, pc),
    // Texto de agy -> lo que ve el usuario (links a sus archivos de verdad, rutas relativas).
    display: (text) => text.split(`file://${pc}`).join(url).split(`${pc}/`).join('').split(pc).join('.'),
  };
}

// Ruta relativa de agy -> ruta real, sin salir nunca del proyecto.
function inside(root, rel) {
  const full = path.resolve(root, String(rel ?? ''));
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) throw Object.assign(new Error('fuera del proyecto'), { errno: E.ACCES });
  return full;
}

const errnoOf = (error) => error.errno && error.errno > 0 ? error.errno : { ENOENT: E.NOENT, EACCES: E.ACCES, EPERM: E.ACCES, EEXIST: E.EXIST, EISDIR: E.ISDIR, ENOTEMPTY: E.NOTEMPTY }[error.code] ?? E.IO;

// Peticiones cortas al servicio (respuestas, latidos, cancelar) por su propia conexion: mientras el turno esta
// abierto, el fetch de Node puede quedarse esperando detras de el y la respuesta nunca sale.
const agents = { 'https:': new https.Agent({ keepAlive: true, maxSockets: 4 }), 'http:': new http.Agent({ keepAlive: true, maxSockets: 4 }) };

function postJson(url, body, headers) {
  const target = new URL(url);
  const data = Buffer.from(JSON.stringify(body));
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const request = client.request(target, { method: 'POST', agent: agents[target.protocol], timeout: 60_000, headers: { ...headers, 'content-length': data.length } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(0));
    request.end(data);
  });
}

// El turno tambien va por su propia conexion (no por fetch): mientras dura, bichi sigue pudiendo usar fetch contra
// la misma web (publicar una pagina, describir una imagen...) sin quedarse esperando detras.
function openStream(url, body, headers, signal) {
  const target = new URL(url);
  const data = Buffer.from(JSON.stringify(body));
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(target, { method: 'POST', agent: false, headers: { ...headers, 'content-length': data.length } }, (response) => {
      const status = response.statusCode ?? 0;
      resolve({
        ok: status >= 200 && status < 300,
        status,
        body: response,
        text: async () => {
          let out = '';
          for await (const chunk of response) out += chunk;
          return out;
        },
      });
    });
    const abort = () => request.destroy(Object.assign(new Error('interrumpido'), { name: 'AbortError' }));
    signal?.addEventListener('abort', abort, { once: true });
    request.on('close', () => signal?.removeEventListener('abort', abort));
    request.on('error', reject);
    request.end(data);
  });
}

const agyError = (message, extra = {}) => Object.assign(new Error(`agy: ${message}`), extra);

// Un turno: manda el mensaje, atiende lo que pide agy y devuelve { ok, text, resume, model }. Si la conexion falla
// al empezar, reintenta con espera creciente; si se corta a mitad, retoma la misma conversacion de agy.
// hooks: onEvent(ev), onStatus(text), onRetry({ attempt, of, wait, reason }), put(rel, Buffer) -> errno|0,
//        run(command, rel) -> {out, code}, remove(rel, dir) -> errno|0, shellName()
export async function runAgyTurn(options) {
  const { signal, hooks } = options;
  const resume = { ...(options.resume ?? {}) };
  let message = options.message;
  let cuts = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptTurn({ ...options, message, resume, onResume: (model, id) => (resume[model] = id) });
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw Object.assign(new Error('interrumpido'), { name: 'AbortError' });
      // Cortado a mitad: se retoma la conversacion de agy (si ya se sabia), pidiendole que siga donde iba.
      if (error.cut && cuts++ < 2) {
        if (Object.values(resume).some(Boolean)) message = '(se corto la conexion a mitad de tu trabajo; revisa como quedaron los archivos y sigue donde ibas)';
        attempt = 0;
      } else if (!error.retry || attempt >= RETRIES - 1) throw error;
      const wait = backoff(attempt);
      hooks.onRetry?.({ attempt: attempt + 1, of: RETRIES, wait, reason: error.message.replace(/^agy: /, '') });
      await sleep(wait, signal);
    }
  }
}

async function attemptTurn({ config, cwd, message, context, effort, mode, resume, signal, hooks, onResume }) {
  const key = hacksKey(config);
  if (!key) throw agyError('el modo agy necesita tu api key de hacksllm (/key)');
  const root = path.resolve(cwd);
  const tr = translator(root);
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const body = { message, context, effort, mode, resume, folder: tr.folder, where: root, os: process.platform, shell: hooks.shellName?.() ?? 'bash', tree: scanTree(root) };
  let response;
  try {
    response = await openStream(`${SITE}/agy/turn`, body, headers, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw agyError('no hay conexion con hacksllm', { retry: true });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let reason = text;
    try {
      reason = JSON.parse(text).error?.message ?? text;
    } catch {
      /* no era json */
    }
    throw agyError(reason.slice(0, 200) || `error ${response.status}`, { retry: transient(response.status), status: response.status });
  }

  let turn = null;
  let queue = [];
  let timer = null;
  const send = (action, payload) => postJson(`${SITE}/agy/${action}`, { turn, ...payload }, headers);
  const flush = () => {
    timer = null;
    if (!queue.length || !turn) return;
    const replies = queue;
    queue = [];
    send('reply', { replies });
  };
  const reply = (id, result) => {
    queue.push({ id, ...result });
    timer ??= setTimeout(flush, 8);
  };
  // Latido: el servicio sabe que bichi sigue aqui (si no, libera el turno en medio minuto).
  const heartbeat = setInterval(() => turn && send('reply', { replies: [] }), 10_000);
  const onAbort = () => turn && send('cancel', {});
  signal?.addEventListener('abort', onAbort, { once: true });

  // Lo que pide agy, hecho aqui.
  const handle = async (op) => {
    try {
      switch (op.op) {
        case 'read': {
          const file = inside(root, op.path);
          const info = await stat(file);
          if (info.size > LIMITS.file) return { errno: E.FBIG };
          return { data: (await readFile(file)).toString('base64') };
        }
        case 'ls':
          return { entries: await listing(inside(root, op.path)) };
        case 'put': {
          inside(root, op.path);
          const errno = await hooks.put(op.path, Buffer.from(op.data ?? '', 'base64'));
          return errno ? { errno } : {};
        }
        case 'rm':
        case 'rmdir': {
          inside(root, op.path);
          const errno = await hooks.remove(op.path, op.op === 'rmdir');
          return errno ? { errno } : {};
        }
        case 'mkdir':
          await mkdir(inside(root, op.path));
          return {};
        case 'mv':
          await rename(inside(root, op.path), inside(root, op.to));
          return {};
        case 'run': {
          const result = await hooks.run(tr.toLocal(String(op.command ?? '')), String(op.cwd ?? ''));
          return { out: tr.toAgy(result.out ?? ''), code: result.code ?? 0, tree: scanTree(root) };
        }
        default:
          return { errno: E.IO };
      }
    } catch (error) {
      return { errno: errnoOf(error), error: error.message };
    }
  };

  let done = null;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.t === 'ready') turn = event.turn;
        else if (event.t === 'op') {
          const { t, id, ...op } = event;
          handle(op).then((result) => reply(id, result));
        } else if (event.t === 'ev') hooks.onEvent?.(event);
        else if (event.t === 'resume') onResume(event.model, event.id);
        else if (event.t === 'status') hooks.onStatus?.(event.text);
        else if (event.t === 'done') done = event;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    clearInterval(heartbeat);
    clearTimeout(timer);
    flush();
  }
  if (signal?.aborted) throw Object.assign(new Error('interrumpido'), { name: 'AbortError' });
  if (!done) throw agyError('se corto la conexion', { cut: true, retry: true });
  return { ok: Boolean(done.ok), text: tr.display(String(done.text ?? '')), resume: done.resume ?? resume, model: done.model };
}

// Para pedir permiso al borrar: se ve como una herramienta mas.
export const deleteTool = { name: 'delete', kind: 'write', label: (input) => ({ title: 'Borrar', arg: input.path }) };

export { rm, rmdir };
