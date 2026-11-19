// bichi paginas desde bichi code: publicar una carpeta en bichi.hacks.win/<nombre>, ver las tuyas y traer una
// para editarla aqui. Es la misma api que usa el panel de la web; la carpeta viaja como zip.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { workApi } from './work.mjs';

export const PUBLIC_BASE = 'https://bichi.hacks.win';
const ALLOWED = /\.(html?|css|m?js|json|txt|md|xml|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp3|ogg|wav|mp4|webm|pdf|wasm|csv|webmanifest)$/i;
const SKIP = (name) => name.startsWith('.') || name === 'node_modules' || name === '__MACOSX';
const MAX_FILE = 10 * 1024 * 1024;
const MAX_SITE = 25 * 1024 * 1024;
const MAX_FILES = 300;

export const slugify = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');

// Archivos publicables de una carpeta, con los mismos limites que el servidor. Lo que no es de una web (codigo de
// servidor, archivos de mas de 10 MB) no se sube y queda en files.skipped, sin tocar la carpeta.
export function siteFiles(root) {
  const files = [];
  files.skipped = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const relative = path.relative(root, full).split(path.sep).join('/');
        const { size } = statSync(full);
        if (!ALLOWED.test(relative) || size > MAX_FILE) {
          files.skipped.push(relative);
          continue;
        }
        files.push({ path: relative, full, size });
        if (files.length > MAX_FILES) throw new Error(`mas de ${MAX_FILES} archivos`);
      }
    }
  };
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`no existe la carpeta ${root}`);
  walk(root);
  if (!files.some((file) => file.path === 'index.html')) throw new Error('falta index.html en la raiz de la carpeta');
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_SITE) throw new Error('la pagina pasa de 25 MB');
  return files;
}

// ---- zip minimo (deflate), sin dependencias

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (data) => {
  let c = 0xffffffff;
  for (const byte of data) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const { name, data } of entries) {
    const packed = deflateRawSync(data);
    const stored = packed.length >= data.length;
    const body = stored ? data : packed;
    const nameBytes = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // nombres en utf-8
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    head.copy(entry, 8, 6, 28); // flags, metodo, hora, fecha, crc, tamanos y largo del nombre: igual que el local
    entry.writeUInt32LE(offset, 42);
    locals.push(head, nameBytes, body);
    central.push(entry, nameBytes);
    offset += head.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// ---- api

const route = (slug, ...rest) => ['pages', encodeURIComponent(slug), ...rest].join('/');

export async function listPages(config, { signal } = {}) {
  const { pages } = await workApi(config)('pages', { signal });
  return pages;
}

// Publica (o reemplaza, si ya es tuya) la carpeta como bichi.hacks.win/<nombre>/.
export async function publishFolder(config, folder, name, { signal } = {}) {
  const slug = slugify(name);
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug)) throw new Error('el nombre lleva de 3 a 40 minusculas, numeros o guiones');
  const files = siteFiles(folder);
  const body = zip(files.map((file) => ({ name: file.path, data: readFileSync(file.full) })));
  const page = await workApi(config)(route(slug), { method: 'PUT', body, type: 'application/zip', timeout: 180000, signal });
  return { ...page, count: files.length, skipped: files.skipped };
}

// Baja la copia fuente de una de tus paginas a una carpeta local (sobrescribe lo que coincida).
export async function downloadPage(config, slug, target, { signal, onFile = () => {} } = {}) {
  const api = workApi(config);
  const { files } = await api(route(slug, 'files'), { signal });
  const root = path.resolve(target);
  const saved = [];
  for (const file of files) {
    const destination = path.resolve(root, file.path);
    if (!destination.startsWith(root + path.sep)) continue;
    const data = await api(route(slug, 'files', ...file.path.split('/').map(encodeURIComponent)), { raw: true, signal });
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, data);
    saved.push(file.path);
    onFile(saved.length, files.length);
  }
  return saved;
}

export const removePage = (config, slug) => workApi(config)(route(slug), { method: 'DELETE' });
