// bichi paginas: publica la carpeta pagina/ de una sesion en el KV que sirve bichi.hacks.win (worker en bichi/).
// Solo archivos estaticos; el VPS solo trabaja al publicar, nunca al servir. Quien es dueno de cada nombre lo
// decide el registro local (KV es eventualmente consistente y cachea las ausencias).
import { readdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';

const { BICHI_ACCOUNT, BICHI_KV, BICHI_TOKEN } = process.env;
const API = `https://api.cloudflare.com/client/v4/accounts/${BICHI_ACCOUNT}/storage/kv/namespaces/${BICHI_KV}`;
export const PUBLIC_BASE = 'https://bichi.hacks.win';
export const FOLDER = 'pagina';
export const MARKER = '.publicar';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const RESERVED = new Set(['api', 'www', 'admin', 'bichi', 'assets', 'static', 'login', 'hacksllm']);
const ALLOWED = /\.(html?|css|m?js|json|txt|md|xml|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp3|ogg|wav|mp4|webm|pdf|wasm|csv|webmanifest)$/i;
const MAX_FILES = 300;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_SITE = 25 * 1024 * 1024;

export const enabled = Boolean(BICHI_ACCOUNT && BICHI_KV && BICHI_TOKEN);

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

const REGISTRY = process.env.BICHI_REGISTRY ?? '/opt/hacksllm/data/bichi-pages.json';
let registry = null;
let writing = Promise.resolve();
const sites = async () => (registry ??= JSON.parse(await readFile(REGISTRY, 'utf8').catch(() => '{}')));
const commit = () => (writing = writing.then(() => writeFile(REGISTRY, JSON.stringify(registry))));

export const slugify = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');

async function collect(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const relative = path.relative(root, full).split(path.sep).join('/');
        if (!ALLOWED.test(relative)) throw new Error(`${relative} no es un archivo estatico permitido`);
        const { size } = await stat(full);
        if (size > MAX_FILE) throw new Error(`${relative} pasa de 10 MB`);
        files.push({ path: relative, full, size });
        if (files.length > MAX_FILES) throw new Error(`mas de ${MAX_FILES} archivos`);
      }
    }
  }
  await walk(root);
  if (!files.some((file) => file.path === 'index.html')) throw new Error('falta pagina/index.html');
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_SITE) throw new Error('la pagina pasa de 25 MB');
  return files;
}

// Primer nombre libre (o ya del mismo dueno) a partir del pedido: nombre, nombre-2, nombre-3...
async function claim(wanted, owner) {
  const all = await sites();
  const base = SLUG.test(wanted) && !RESERVED.has(wanted) ? wanted : `bichi-${Math.random().toString(36).slice(2, 8)}`;
  for (let n = 1; n <= 30; n++) {
    const slug = n === 1 ? base : `${base.slice(0, 36)}-${n}`;
    const previous = all[slug];
    if (!previous || previous.owner === owner) {
      all[slug] = { ...previous, owner, claimed: Date.now() };
      return { slug, previous };
    }
  }
  throw new Error('no encontre un nombre libre');
}

export async function publish({ owner, workspace, wanted }) {
  const root = path.join(workspace, FOLDER);
  const files = await collect(root);
  const { slug, previous } = await claim(slugify(wanted), owner);
  const pairs = await Promise.all(
    files.map(async (file) => ({
      key: `file:${slug}/${file.path}`,
      value: (await readFile(file.full)).toString('base64'),
      base64: true,
    })),
  );
  const meta = { owner, files: files.map(({ path, size }) => ({ path, size })), created: previous?.created ?? Date.now(), updated: Date.now() };
  try {
    await kv('PUT', '/bulk', [...pairs, { key: `site:${slug}`, value: JSON.stringify(meta) }]);
  } catch (error) {
    if (previous?.files) (await sites())[slug] = previous;
    else delete (await sites())[slug];
    await commit();
    throw error;
  }
  (await sites())[slug] = meta;
  await commit();
  const stale = (previous?.files ?? []).map((file) => file.path).filter((old) => !files.some((file) => file.path === old));
  if (stale.length) await kv('POST', '/bulk/delete', stale.map((old) => `file:${slug}/${old}`));
  await rm(path.join(root, MARKER), { force: true });
  return { slug, url: `${PUBLIC_BASE}/${slug}/`, files: files.length, updated: Boolean(previous?.files) };
}

export async function unpublish(owner, slug) {
  if (!SLUG.test(slug ?? '')) return false;
  const all = await sites();
  const meta = all[slug];
  if (!meta || meta.owner !== owner) return false;
  await kv('POST', '/bulk/delete', [`site:${slug}`, ...(meta.files ?? []).map((file) => `file:${slug}/${file.path}`)]);
  delete all[slug];
  await commit();
  return true;
}
