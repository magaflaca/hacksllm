// bichi paginas: webs estaticas en bichi.hacks.win/<nombre>, servidas por el worker de bichi/ desde Workers KV.
// El VPS nunca sirve: guarda la copia fuente de cada pagina (para editar, renombrar y descargar) y el registro de
// duenos, que es la fuente de verdad (KV es eventualmente consistente y cachea las ausencias). Las paginas no
// caducan: viven hasta que su dueno, la clave que las publico, las quita.
import { readdir, readFile, writeFile, stat, rm, cp, mkdir, mkdtemp, rename } from 'node:fs/promises';
import { createWriteStream, lstatSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const { BICHI_ACCOUNT, BICHI_KV, BICHI_TOKEN } = process.env;
const API = `https://api.cloudflare.com/client/v4/accounts/${BICHI_ACCOUNT}/storage/kv/namespaces/${BICHI_KV}`;
const DATA = process.env.BICHI_DATA ?? '/opt/hacksllm/data';
const REGISTRY = path.join(DATA, 'bichi-pages.json');
const SITES = path.join(DATA, 'bichi-sites');
const STAGING = path.join(DATA, 'bichi-staging');

export const PUBLIC_BASE = 'https://bichi.hacks.win';
export const FOLDER = 'pagina';
export const MARKER = '.publicar';
export const MAX_ZIP = 40 * 1024 * 1024;
export const MAX_FILE = 10 * 1024 * 1024;

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const RESERVED = new Set(['api', 'www', 'admin', 'bichi', 'assets', 'static', 'login', 'hacksllm', 'favicon-ico', 'robots-txt']);
const ALLOWED = /\.(html?|css|m?js|json|txt|md|xml|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp3|ogg|wav|mp4|webm|pdf|wasm|csv|webmanifest)$/i;
const SKIP = (name) => name.startsWith('.') || name === 'node_modules' || name === '__MACOSX';
const MAX_FILES = 300;
const MAX_SITE = 25 * 1024 * 1024;

export const enabled = Boolean(BICHI_ACCOUNT && BICHI_KV && BICHI_TOKEN);

export class PageError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

await mkdir(SITES, { recursive: true });
await mkdir(STAGING, { recursive: true });

async function kv(method, route, body) {
  const response = await fetch(API + route, {
    method,
    headers: { authorization: `Bearer ${BICHI_TOKEN}`, ...(body && { 'content-type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) throw new Error(`kv ${method} ${response.status} ${JSON.stringify(data.errors ?? data).slice(0, 200)}`);
  return data;
}

// ---- registro

let registry = null;
let writing = Promise.resolve();
const sites = async () => (registry ??= JSON.parse(await readFile(REGISTRY, 'utf8').catch(() => '{}')));
const commit = () => (writing = writing.then(() => writeFile(REGISTRY, JSON.stringify(registry))));

const summary = (slug, meta) => ({
  slug,
  url: `${PUBLIC_BASE}/${slug}/`,
  files: meta.files.length,
  size: meta.files.reduce((sum, file) => sum + file.size, 0),
  created: meta.created,
  updated: meta.updated,
});

export const slugify = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');

const valid = (slug) => SLUG.test(slug) && !RESERVED.has(slug);

async function owned(owner, slug) {
  const meta = (await sites())[slug];
  if (!meta?.files || meta.owner !== owner) throw new PageError(404, 'esa pagina no existe o no es tuya');
  return meta;
}

// Nombre para publicar. Desde bichi work se busca el primero libre (nombre, nombre-2...); desde el panel el
// nombre pedido es exacto y si es de otro se avisa.
async function claim(wanted, owner, { exact = false } = {}) {
  const all = await sites();
  if (exact && !valid(wanted)) throw new PageError(400, 'el nombre lleva de 3 a 40 minusculas, numeros o guiones');
  const base = valid(wanted) ? wanted : `bichi-${Math.random().toString(36).slice(2, 8)}`;
  for (let n = 1; n <= (exact ? 1 : 30); n++) {
    const slug = n === 1 ? base : `${base.slice(0, 36)}-${n}`;
    const previous = all[slug];
    if (!previous || previous.owner === owner) {
      all[slug] = { ...previous, owner, claimed: Date.now() };
      return { slug, previous };
    }
  }
  throw new PageError(409, exact ? 'ese nombre ya es de otra persona' : 'no encontre un nombre libre');
}

// ---- archivos

async function collect(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const relative = path.relative(root, full).split(path.sep).join('/');
        if (!ALLOWED.test(relative)) throw new PageError(400, `${relative} no es un archivo estatico permitido`);
        const { size } = await stat(full);
        if (size > MAX_FILE) throw new PageError(400, `${relative} pasa de 10 MB`);
        files.push({ path: relative, full, size });
        if (files.length > MAX_FILES) throw new PageError(400, `mas de ${MAX_FILES} archivos`);
      }
    }
  }
  await walk(root).catch((error) => {
    throw error.code === 'ENOENT' ? new PageError(400, 'no hay archivos para publicar') : error;
  });
  if (!files.some((file) => file.path === 'index.html')) throw new PageError(400, 'falta index.html');
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_SITE) throw new PageError(400, 'la pagina pasa de 25 MB');
  return files;
}

const inside = (root, relative) => {
  const target = path.resolve(root, String(relative).replace(/^\/+/, ''));
  if (!target.startsWith(root + path.sep) || relative.split('/').some(SKIP)) throw new PageError(400, 'ruta invalida');
  return target;
};

// Nunca se copian enlaces simbolicos: un zip o el agente podrian apuntar a secretos del servidor.
const copyTree = (from, to) =>
  cp(from, to, { recursive: true, filter: (source) => source === from || (!SKIP(path.basename(source)) && !lstatSync(source).isSymbolicLink()) });

// Sube source a KV como slug, deja la copia fuente en disco y actualiza el registro. Solo se escriben en KV los
// archivos que cambiaron (por hash): el plan gratis admite 1000 escrituras al dia.
async function deploy(slug, owner, source, previous) {
  const files = await collect(source);
  const known = new Map((previous?.files ?? []).map((file) => [file.path, file.hash]));
  const pairs = [];
  for (const file of files) {
    const data = await readFile(file.full);
    file.hash = createHash('sha1').update(data).digest('hex');
    if (known.get(file.path) !== file.hash) pairs.push({ key: `file:${slug}/${file.path}`, value: data.toString('base64'), base64: true });
  }
  const meta = { owner, files: files.map(({ path, size, hash }) => ({ path, size, hash })), created: previous?.created ?? Date.now(), updated: Date.now() };
  const all = await sites();
  try {
    await kv('PUT', '/bulk', [...pairs, { key: `site:${slug}`, value: JSON.stringify(meta) }]);
  } catch (error) {
    if (previous?.files) all[slug] = previous;
    else delete all[slug];
    await commit();
    throw error;
  }
  const fresh = await mkdtemp(path.join(STAGING, `${slug}-`));
  await rm(fresh, { recursive: true });
  await copyTree(source, fresh);
  await rm(path.join(SITES, slug), { recursive: true, force: true });
  await rename(fresh, path.join(SITES, slug));
  all[slug] = meta;
  await commit();
  const stale = (previous?.files ?? []).map((file) => file.path).filter((old) => !files.some((file) => file.path === old));
  if (stale.length) await kv('POST', '/bulk/delete', stale.map((old) => `file:${slug}/${old}`));
  return summary(slug, meta);
}

// Copia de trabajo de una pagina para cambiarla y volver a publicarla.
async function revise(owner, slug, change) {
  const meta = await owned(owner, slug);
  const stage = await mkdtemp(path.join(STAGING, `${slug}-`));
  try {
    await copyTree(path.join(SITES, slug), stage);
    await change(stage);
    return await deploy(slug, owner, stage, meta);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

// ---- desde bichi work

export async function publish({ owner, workspace, wanted }) {
  const root = path.join(workspace, FOLDER);
  await collect(root);
  const { slug, previous } = await claim(slugify(wanted), owner);
  const page = await deploy(slug, owner, root, previous);
  await rm(path.join(root, MARKER), { force: true });
  return { ...page, updated: Boolean(previous?.files) };
}

// Pone la copia fuente de una pagina en pagina/ de una sesion, para que el agente la edite.
export async function checkout(owner, slug, workspace) {
  await owned(owner, slug);
  const target = path.join(workspace, FOLDER);
  await rm(target, { recursive: true, force: true });
  await copyTree(path.join(SITES, slug), target);
  return summary(slug, (await sites())[slug]);
}

// ---- panel

export const mine = async (owner) =>
  Object.entries(await sites())
    .filter(([, meta]) => meta.owner === owner && meta.files)
    .map(([slug, meta]) => summary(slug, meta))
    .sort((a, b) => b.updated - a.updated);

export const files = async (owner, slug) => (await owned(owner, slug)).files;

export async function file(owner, slug, relative) {
  await owned(owner, slug);
  return inside(path.join(SITES, slug), relative);
}

export const writeFileTo = (owner, slug, relative, stream) =>
  revise(owner, slug, async (stage) => {
    if (!ALLOWED.test(relative)) throw new PageError(400, 'ese tipo de archivo no se puede publicar');
    const target = inside(stage, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(stream, createWriteStream(target));
  });

export const removeFile = (owner, slug, relative) =>
  revise(owner, slug, async (stage) => {
    if (relative === 'index.html') throw new PageError(400, 'index.html no se puede borrar');
    await rm(inside(stage, relative), { force: true });
  });

// Crea o reemplaza una pagina entera desde un zip. Si el zip trae una sola carpeta raiz, se usa su contenido.
export async function fromZip(owner, wanted, stream) {
  const slug = slugify(wanted);
  const existing = (await sites())[slug];
  const stage = await mkdtemp(path.join(STAGING, 'zip-'));
  try {
    const archive = path.join(stage, 'upload.zip');
    await pipeline(stream, createWriteStream(archive));
    const root = path.join(stage, 'x');
    await new Promise((resolve, reject) => {
      const child = spawn('unzip', ['-qq', '-o', archive, '-d', root]);
      child.on('close', (code) => (code <= 1 ? resolve() : reject(new PageError(400, 'ese zip no se pudo abrir'))));
    });
    const entries = (await readdir(root, { withFileTypes: true })).filter((entry) => !SKIP(entry.name));
    const source = entries.length === 1 && entries[0].isDirectory() ? path.join(root, entries[0].name) : root;
    if (existing?.files && existing.owner === owner) return { ...(await deploy(slug, owner, source, existing)), updated: true };
    const { previous } = await claim(slug, owner, { exact: true });
    return { ...(await deploy(slug, owner, source, previous)), updated: false };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function renameSite(owner, slug, next) {
  const meta = await owned(owner, slug);
  const target = slugify(next);
  if (target === slug) return summary(slug, meta);
  const { previous } = await claim(target, owner, { exact: true });
  if (previous?.files) throw new PageError(409, 'ya tienes una pagina con ese nombre');
  const page = await deploy(target, owner, path.join(SITES, slug), { created: meta.created });
  await unpublish(owner, slug);
  return page;
}

export async function unpublish(owner, slug) {
  const meta = await owned(owner, slug);
  await kv('POST', '/bulk/delete', [`site:${slug}`, ...meta.files.map((item) => `file:${slug}/${item.path}`)]);
  await rm(path.join(SITES, slug), { recursive: true, force: true });
  delete (await sites())[slug];
  await commit();
  return true;
}

export const zipArgs = (owner, slug) => owned(owner, slug).then(() => ({ cwd: path.join(SITES, slug) }));
