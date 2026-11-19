// Modo agy: Antigravity (agy, con Gemini 3.8 Flash y gpt-oss de respaldo) trabaja en esta computadora desde el VPS de
// hacksllm. Alla su carpeta de trabajo es un disco que en realidad es este proyecto, y su terminal es una bash falsa
// que ejecuta aqui: el servicio nos va pidiendo leer, escribir, listar o ejecutar, y aqui se hace (con permisos).
import { readdirSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SITE } from '../config.mjs';
import { hacksKey } from './work.mjs';

export const isAgy = (model) => model === 'agy' || model === 'bichi-agy';

// Carpetas pesadas: se ven como carpetas, pero su contenido solo se lista si agy entra en ellas.
const HEAVY = new Set(['node_modules', '.git', '.hg', '.svn', 'bin', 'obj', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.gradle', '.idea', '.vs', 'vendor', 'packages', 'coverage', '.cache', 'Library', 'Temp']);
const LIMITS = { entries: 20_000, depth: 8, perDir: 3_000, file: 25 << 20 };
const E = { NOENT: 2, IO: 5, ACCES: 13, EXIST: 17, ISDIR: 21, FBIG: 27, NOTEMPTY: 39 };

// Donde no tiene sentido abrir el modo agy: la raiz del disco, la carpeta de usuario o la del sistema.
export function projectProblem(cwd) {
  const here = path.resolve(cwd);
  const same = (a, b) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
  if (same(here, path.parse(here).root)) return 'el modo agy no trabaja en la raiz del disco: abre bichi dentro de la carpeta de un proyecto';
  if (same(here, os.homedir())) return 'el modo agy no trabaja en tu carpeta de usuario entera: abre bichi dentro de la carpeta de un proyecto';
  if (/^[a-z]:\\windows(\\|$)/i.test(here) || /^\/(etc|usr|bin|sbin|var|proc|sys)(\/|$)/.test(here)) return 'el modo agy no trabaja en carpetas del sistema';
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

// Un turno: manda el mensaje, atiende lo que pide agy y devuelve { ok, text, resume, model }.
// hooks: onEvent(ev), onStatus(text), put(rel, Buffer) -> errno|0, run(command, rel) -> {out, code}, remove(rel, dir) -> errno|0
export async function runAgyTurn({ config, cwd, message, context, effort, mode, resume, signal, hooks }) {
  const key = hacksKey(config);
  if (!key) throw new Error('el modo agy necesita tu api key de hacksllm (/key)');
  const root = path.resolve(cwd);
  const tr = translator(root);
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const body = {
    message,
    context,
    effort,
    mode,
    resume,
    folder: tr.folder,
    where: root,
    os: process.platform,
    shell: hooks.shellName?.() ?? 'bash',
    tree: scanTree(root),
  };
  const response = await fetch(`${SITE}/agy/turn`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!response.ok) {
    const text = await response.text();
    let reason = text;
    try {
      reason = JSON.parse(text).error?.message ?? text;
    } catch {
      /* no era json */
    }
    throw new Error(`agy: ${reason.slice(0, 200) || response.status}`);
  }

  let turn = null;
  let queue = [];
  let timer = null;
  const flush = () => {
    timer = null;
    if (!queue.length || !turn) return;
    const replies = queue;
    queue = [];
    fetch(`${SITE}/agy/reply`, { method: 'POST', headers, body: JSON.stringify({ turn, replies }) }).catch(() => {});
  };
  const reply = (id, result) => {
    queue.push({ id, ...result });
    timer ??= setTimeout(flush, 8);
  };
  const onAbort = () => turn && fetch(`${SITE}/agy/cancel`, { method: 'POST', headers, body: JSON.stringify({ turn }) }).catch(() => {});
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
        else if (event.t === 'status') hooks.onStatus?.(event.text);
        else if (event.t === 'done') done = event;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    clearTimeout(timer);
    flush();
  }
  if (signal?.aborted) throw Object.assign(new Error('interrumpido'), { name: 'AbortError' });
  if (!done) throw new Error('agy: se corto la conexion con el servidor');
  return { ok: Boolean(done.ok), text: tr.display(String(done.text ?? '')), resume: done.resume ?? resume, model: done.model };
}

// Para pedir permiso al borrar: se ve como una herramienta mas.
export const deleteTool = { name: 'delete', kind: 'write', label: (input) => ({ title: 'Borrar', arg: input.path }) };

export { rm, rmdir };
