// Sesiones de bichi work: una por visita a la web, ligada al hash de la clave que la creo. El espacio de
// trabajo vive en /srv/hacksllm-work/ws/<id> (lo crea y borra bichi-run como root) y los metadatos aqui.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { runner } from './engines.mjs';

export const WORKSPACES = '/srv/hacksllm-work/ws';
const META = process.env.WORK_META ?? '/opt/hacksllm/data/work';
const IDLE_MS = 48 * 3600_000;
const MAX_SESSIONS = 120;
const HIDDEN = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.git', '.cache', '.npm']);
const MAX_LISTED = 400;

await mkdir(META, { recursive: true });

export { ownerOf } from './auth.mjs';
const metaFile = (id) => path.join(META, `${id}.json`);
export const workspace = (id) => path.join(WORKSPACES, id);

const exec = (...args) =>
  new Promise((resolve, reject) => {
    const child = runner(...args);
    child.stdin.end();
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`bichi-run ${args[0]} -> ${code}`))));
  });

export async function load(id) {
  if (!/^[a-z0-9]{16,40}$/.test(id ?? '')) return null;
  try {
    return JSON.parse(await readFile(metaFile(id), 'utf8'));
  } catch {
    return null;
  }
}

export const save = (session) => writeFile(metaFile(session.id), JSON.stringify({ ...session, touchedAt: Date.now() }));

export async function create(owner) {
  if ((await readdir(META)).length >= MAX_SESSIONS) await sweep(0.5 * IDLE_MS);
  const id = randomBytes(12).toString('hex');
  await exec('new', id);
  const session = { id, owner, createdAt: Date.now(), resume: {}, engine: null, history: [] };
  await save(session);
  return session;
}

export async function destroy(id) {
  await exec('clean', id).catch(() => {});
  await rm(metaFile(id), { force: true });
}

export async function sweep(idle = IDLE_MS) {
  for (const name of await readdir(META)) {
    const session = await load(name.replace(/\.json$/, ''));
    if (!session || Date.now() - session.touchedAt > idle) await destroy(name.replace(/\.json$/, ''));
  }
}

// Ruta relativa segura dentro del espacio, o null.
export function resolveInside(id, relative) {
  const root = workspace(id);
  const target = path.resolve(root, relative.replace(/^\/+/, ''));
  return target.startsWith(root + path.sep) ? target : null;
}

export async function listFiles(id) {
  const root = workspace(id);
  const files = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_LISTED || entry.name.startsWith('.') || HIDDEN.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const info = await stat(full);
        files.push({ path: path.relative(root, full).split(path.sep).join('/'), size: info.size, mtime: Math.round(info.mtimeMs) });
      }
    }
  }
  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export const totalSize = (files) => files.reduce((sum, file) => sum + file.size, 0);

export function changedSince(before, after) {
  const previous = new Map(before.map((file) => [file.path, file]));
  return after.filter((file) => {
    const old = previous.get(file.path);
    return !old || old.mtime !== file.mtime || old.size !== file.size;
  });
}
