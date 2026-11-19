// API de bichi work, detras de nginx en /work/. Solo con una clave valida de OmniRoute.
import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { ENGINES, available, rest, runEngine } from './engines.mjs';
import * as sessions from './sessions.mjs';
import { authorizer } from './auth.mjs';
import * as pages from './pages.mjs';
import * as transport from './transport.mjs';

const PORT = Number(process.env.WORK_PORT ?? 20130);
const GATEWAY = process.env.WORK_GATEWAY ?? 'http://127.0.0.1:20128';
const CONCURRENCY = Number(process.env.WORK_CONCURRENCY ?? 1);
const MAX_UPLOAD = 100 * 1024 * 1024;
const MAX_SPACE = 1024 * 1024 * 1024;
const MAX_PROMPT = 60_000;
const EFFORTS = new Set(['low', 'medium', 'high']);
const HISTORY_TURNS = 6;

const PREAMBLE = `[bichi work]
Eres bichi, el agente de trabajo de hacksllm. Trabajas en el directorio actual, que es el espacio privado de esta
sesion; los archivos que sube el usuario estan aqui. Puedes ejecutar codigo e instalar dependencias sin root
(pip install --user, uv, npm en el proyecto, venv). No hay sudo ni apt.
Cuando el usuario pida algo entregable, dejalo como archivos en este directorio y, si son varios, empaquetalos
tambien en un .zip. Nombra cada entregable por su ruta relativa (por ejemplo \`web/index.html\`) sin rutas absolutas.
Responde en el idioma del usuario, claro y breve. No digas que modelo, proveedor ni herramienta interna eres:
si te lo preguntan, eres bichi, de hacksllm.

[bichi paginas]
Puedes publicar webs estaticas en ${pages.PUBLIC_BASE}/<nombre>, pero solo si el usuario lo pide o si este turno
lo marca. Para publicar: deja el sitio completo en la carpeta \`${pages.FOLDER}/\` con \`${pages.FOLDER}/index.html\` como
entrada; solo html, css, js, imagenes, fuentes y medios, con rutas relativas, sin backend ni servidor (lo que
necesite datos debe funcionar en el navegador). Despues escribe el nombre en \`${pages.FOLDER}/${pages.MARKER}\`: el
que pida el usuario o uno corto y descriptivo (minusculas, numeros y guiones, de 3 a 40). Al terminar el turno el
sistema la publica y muestra el enlace; no escribas tu la direccion. Para actualizarla, edita la carpeta y vuelve
a escribir el mismo nombre.`;

// ---- auth

const authorize = authorizer(GATEWAY);

// ---- cola

let running = 0;
const waiting = [];
const acquire = (onQueued) =>
  new Promise((resolve) => {
    if (running < CONCURRENCY) return (running++, resolve());
    waiting.push(resolve);
    onQueued(waiting.length);
  });
const release = () => (waiting.length ? waiting.shift()() : running--);

const active = new Map();

// ---- respuestas

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (res, status, message) => send(res, status, { error: { message } });

async function readJson(req, limit = MAX_PROMPT * 2) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error('cuerpo demasiado grande');
  }
  return JSON.parse(raw || '{}');
}

const tidy = (id, text) =>
  text
    .replaceAll(`file://${sessions.workspace(id)}/`, '')
    .replaceAll(`${sessions.workspace(id)}/`, '')
    .replaceAll(sessions.workspace(id), '.')
    .replaceAll('/srv/hacksllm-work', '~');

function buildPrompt(session, message, uploads, fresh, publish, redirect) {
  const parts = [PREAMBLE];
  if (fresh && session.history.length) {
    const recent = session.history.slice(-HISTORY_TURNS).map(({ role, text }) => `${role === 'user' ? 'usuario' : 'bichi'}: ${text}`);
    parts.push(`[conversacion previa de esta sesion]\n${recent.join('\n\n')}`);
  }
  if (redirect) parts.push('[el usuario corto el turno anterior para redirigir el trabajo: revisa como quedaron los archivos y sigue con esta indicacion]');
  if (publish) parts.push('[este turno el usuario pidio publicarlo como bichi pagina]');
  if (uploads.length) parts.push(`[archivos nuevos del usuario]\n${uploads.map((name) => `- ${name}`).join('\n')}`);
  parts.push(`[mensaje del usuario]\n${message}`);
  return parts.join('\n\n').slice(-MAX_PROMPT);
}

// ---- bichi paginas

// Publica pagina/ si el agente dejo el marcador o si el usuario lo pidio en este turno.
async function publishPage(session, requested, emit) {
  if (!pages.enabled) return;
  const folder = path.join(sessions.workspace(session.id), pages.FOLDER);
  const marker = await readFile(path.join(folder, pages.MARKER), 'utf8').catch(() => null);
  if (marker === null && !requested) return;
  emit({ type: 'status', text: 'publicando la pagina' });
  try {
    const page = await pages.publish({ owner: session.owner, workspace: sessions.workspace(session.id), wanted: marker?.trim() || session.page || '' });
    session.page = page.slug;
    emit({ type: 'page', ...page });
  } catch (error) {
    const reason = error.message === 'falta index.html' ? `falta ${pages.FOLDER}/index.html` : error.message;
    console.warn('[work] pagina', reason);
    emit({ type: 'notice', message: `no pude publicar la pagina: ${reason}` });
  }
}

// ---- turno

async function run(req, res, session) {
  const { message = '', effort = 'medium', uploads = [], context = [], publish = false, redirect = false, page = '' } = await readJson(req);
  if (!session.page && page) session.page = pages.slugify(page);
  if (!session.history.length && Array.isArray(context)) {
    session.history = context
      .filter((turn) => ['user', 'assistant'].includes(turn?.role) && typeof turn.text === 'string')
      .slice(-HISTORY_TURNS)
      .map(({ role, text }) => ({ role, text: text.slice(0, 2000) }));
  }
  if (!message.trim()) return fail(res, 400, 'mensaje vacio');
  if (session.busy && Date.now() - session.busy < 30 * 60_000) return fail(res, 409, 'esta sesion ya esta trabajando');

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  const controller = new AbortController();
  active.set(session.id, controller);
  res.on('close', () => controller.abort());

  session.busy = Date.now();
  await sessions.save(session);
  await acquire((position) => emit({ type: 'status', text: `en cola, ${position} por delante` }));
  const before = await sessions.listFiles(session.id);
  let answer = '';
  try {
    emit({ type: 'status', text: 'trabajando' });
    const engines = available();
    const queue = session.engine ? [...engines.filter((e) => e.key === session.engine), ...engines.filter((e) => e.key !== session.engine)] : engines;
    let done = false;
    for (const [index, engine] of queue.entries()) {
      if (controller.signal.aborted) break;
      if (index) emit({ type: 'status', text: 'sigo por otro camino' });
      const resume = session.resume[engine.key];
      const prompt = buildPrompt(session, message, Array.isArray(uploads) ? uploads.map(String).slice(0, 50) : [], !resume || index > 0, publish, redirect);
      const result = await runEngine(engine, {
        session: session.id,
        effort: EFFORTS.has(effort) ? effort : 'medium',
        resume,
        prompt,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'resume') session.resume[engine.key] = event.id;
          else if (event.type === 'text') emit({ type: 'text', delta: tidy(session.id, event.delta) });
          else emit({ ...event, label: tidy(session.id, event.label).slice(0, 160) });
        },
      });
      if (result.ok) {
        session.engine = engine.key;
        answer = tidy(session.id, result.final);
        done = true;
        break;
      }
      if (controller.signal.aborted) break;
      console.warn(`[work] ${engine.key} fallo: ${result.reason.slice(0, 300)}`);
      rest(engine, result.quota);
      delete session.resume[engine.key];
    }
    if (done) await publishPage(session, Boolean(publish), emit);
    const files = sessions.changedSince(before, await sessions.listFiles(session.id));
    if (files.length) emit({ type: 'files', files });
    if (done) emit({ type: 'done', text: answer });
    else if (!controller.signal.aborted) emit({ type: 'error', message: 'ahora mismo no pude terminar el trabajo, prueba en un rato' });
  } finally {
    release();
    clearInterval(ping);
    active.delete(session.id);
    session.history.push({ role: 'user', text: message.slice(0, 2000) }, { role: 'assistant', text: (answer || '(sin terminar)').slice(0, 2000) });
    session.history = session.history.slice(-HISTORY_TURNS * 2);
    session.busy = 0;
    await sessions.save(session);
    res.end();
  }
}

// Acepta rutas con carpetas (restaurar entregables); cada tramo se limpia y nada empieza por punto.
async function upload(req, res, session, name) {
  const segments = decodeURIComponent(name)
    .split('/')
    .map((part) => part.replace(/[^\w.\- ()À-ɏ]/g, '_').slice(0, 120))
    .filter(Boolean);
  const clean = segments.join('/');
  const target = segments.length && segments.length <= 8 && !segments.some((part) => part.startsWith('.')) && sessions.resolveInside(session.id, clean);
  if (!target) return fail(res, 400, 'nombre de archivo invalido');
  await mkdir(path.dirname(target), { recursive: true, mode: 0o2775 });
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > MAX_UPLOAD) return fail(res, 413, 'el archivo pasa de 100 MB');
  if (sessions.totalSize(await sessions.listFiles(session.id)) + length > MAX_SPACE) return fail(res, 413, 'el espacio de la sesion esta lleno (1 GB)');
  let received = 0;
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_UPLOAD) req.destroy(new Error('demasiado grande'));
  });
  await pipeline(req, createWriteStream(target, { mode: 0o664 }));
  send(res, 201, { path: clean, size: received });
}

async function download(res, session, relative) {
  const target = sessions.resolveInside(session.id, decodeURIComponent(relative));
  const file = target && (await sessions.listFiles(session.id)).find((item) => sessions.resolveInside(session.id, item.path) === target);
  if (!file) return fail(res, 404, 'no existe');
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': file.size,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file.path))}`,
    'cache-control': 'no-store',
  });
  createReadStream(target).pipe(res);
}

function zip(res, session) {
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': 'attachment; filename="bichi-work.zip"',
    'cache-control': 'no-store',
  });
  const child = spawn('zip', ['-r', '-q', '-y', '-', '.', '-x', '.*', '*/.*', '*/node_modules/*', 'node_modules/*', '*/.venv/*', '.venv/*', '*/__pycache__/*'], {
    cwd: sessions.workspace(session.id),
  });
  child.stdout.pipe(res);
  res.on('close', () => child.kill());
}

// ---- panel de paginas

// Corta el cuerpo si pasa del limite, aunque el cliente no mande content-length. Es un Transform: no consume
// nada hasta que alguien lee, asi no se pierden trozos mientras el handler aun esta preparando el destino.
function capped(req, max) {
  const tooBig = () => new pages.PageError(413, `pasa de ${Math.round(max / 1048576)} MB`);
  if (Number(req.headers['content-length'] ?? 0) > max) throw tooBig();
  let seen = 0;
  return req.pipe(
    new Transform({
      transform(chunk, _encoding, done) {
        seen += chunk.length;
        done(seen > max ? tooBig() : null, chunk);
      },
    }),
  );
}

async function readBody(req, max = 4096) {
  let raw = '';
  for await (const chunk of capped(req, max)) raw += chunk;
  return JSON.parse(raw || '{}');
}

function zipFolder(res, cwd, name) {
  res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}.zip"`, 'cache-control': 'no-store' });
  const child = spawn('zip', ['-r', '-q', '-y', '-', '.'], { cwd });
  child.stdout.pipe(res);
  res.on('close', () => child.kill());
}

// /work/tp: conversaciones llevadas de la web a bichi code.
async function transportRoute(req, res, owner, id) {
  if (!id && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of capped(req, transport.MAX_BODY)) chunks.push(chunk);
    return send(res, 201, await transport.save(owner, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')));
  }
  if (!id && req.method === 'GET') return send(res, 200, { items: await transport.list(owner) });
  if (id && req.method === 'GET') {
    const item = await transport.get(owner, id);
    return item ? send(res, 200, item) : fail(res, 404, 'esa conversacion ya no esta');
  }
  if (id && req.method === 'DELETE') return (await transport.remove(owner, id), send(res, 200, { ok: true }));
  return fail(res, 405, 'metodo no permitido');
}

async function pagesRoute(req, res, owner, slug, resource, rest) {
  const route = rest.join('/');
  if (!slug && req.method === 'GET') return send(res, 200, { pages: await pages.mine(owner) });
  if (!slug) return fail(res, 404, 'no existe');
  if (!resource && req.method === 'PUT') return send(res, 200, await pages.fromZip(owner, slug, capped(req, pages.MAX_ZIP)));
  if (!resource && req.method === 'PATCH') return send(res, 200, await pages.renameSite(owner, slug, (await readBody(req)).slug));
  if (!resource && req.method === 'DELETE') return (await pages.unpublish(owner, slug), send(res, 200, { ok: true }));
  if (resource === 'zip' && req.method === 'GET') return zipFolder(res, (await pages.zipArgs(owner, slug)).cwd, slug);
  if (resource !== 'files') return fail(res, 404, 'no existe');
  if (!route && req.method === 'GET') return send(res, 200, { files: await pages.files(owner, slug) });
  if (route && req.method === 'GET') {
    const target = await pages.file(owner, slug, decodeURIComponent(route));
    if (!(await stat(target).catch(() => null))?.isFile()) return fail(res, 404, 'ese archivo no existe');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    return createReadStream(target).on('error', () => res.end()).pipe(res);
  }
  if (route && req.method === 'PUT') return send(res, 200, await pages.writeFileTo(owner, slug, decodeURIComponent(route), capped(req, pages.MAX_FILE)));
  if (route && req.method === 'DELETE') return send(res, 200, await pages.removeFile(owner, slug, decodeURIComponent(route)));
  fail(res, 404, 'no existe');
}

// ---- rutas

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    const [, scope, collection, id, resource, ...rest] = url.pathname.split('/');
    if (scope !== 'work' || !['sessions', 'pages', 'tp'].includes(collection)) return fail(res, 404, 'no existe');
    const owner = await authorize(req);
    if (!owner) return fail(res, 401, 'hace falta una clave de la API valida');

    if (collection === 'pages') return await pagesRoute(req, res, owner, id, resource, rest);
    if (collection === 'tp') return await transportRoute(req, res, owner, id);

    if (!id && req.method === 'POST') {
      const session = await sessions.create(owner);
      return send(res, 201, { id: session.id });
    }
    const session = await sessions.load(id);
    if (!session || session.owner !== owner) return fail(res, 404, 'la sesion ya no existe');

    if (!resource && req.method === 'GET') return send(res, 200, { id: session.id, busy: Boolean(session.busy), files: await sessions.listFiles(session.id) });
    if (!resource && req.method === 'DELETE') return (await sessions.destroy(session.id), send(res, 200, { ok: true }));
    if (resource === 'run' && req.method === 'POST') return await run(req, res, session);
    if (resource === 'stop' && req.method === 'POST') return (active.get(session.id)?.abort(), send(res, 200, { ok: true }));
    if (resource === 'zip' && req.method === 'GET') return zip(res, session);
    if (resource === 'pages' && rest.length === 1 && req.method === 'POST') {
      const page = await pages.checkout(owner, rest[0], sessions.workspace(session.id));
      session.page = page.slug;
      await sessions.save(session);
      return send(res, 200, page);
    }
    if (resource === 'files' && !rest.length && req.method === 'GET') return send(res, 200, { files: await sessions.listFiles(session.id) });
    if (resource === 'files' && rest.length && req.method === 'PUT') return await upload(req, res, session, rest.join('/'));
    if (resource === 'files' && rest.length && req.method === 'GET') return await download(res, session, rest.join('/'));
    fail(res, 404, 'no existe');
  } catch (error) {
    if (error instanceof pages.PageError) return res.headersSent ? res.end() : fail(res, error.status, error.message);
    console.error('[work]', error);
    if (!res.headersSent) fail(res, 500, 'error interno');
    else res.end();
  }
});

server.requestTimeout = 0;
server.listen(PORT, '127.0.0.1', () => console.log(`[work] escuchando en ${PORT}, motores: ${ENGINES.map((e) => e.key).join(' > ')}`));
setInterval(() => sessions.sweep().catch((error) => console.error('[work] limpieza', error)), 10 * 60_000);
