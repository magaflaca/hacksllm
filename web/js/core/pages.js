// Cliente del panel de bichi paginas (/work/pages). Todo con la clave del visitante.
import { authHeaders, failure } from './api.js';

const BASE = `${location.origin}/work/pages`;
const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');
const auth = () => {
  const { Authorization } = authHeaders();
  return Authorization ? { Authorization } : {};
};

async function call(path, options = {}) {
  const response = await fetch(BASE + path, { ...options, headers: { ...auth(), ...options.headers } });
  if (!response.ok) throw await failure(response);
  return response;
}
const json = (path, options) => call(path, options).then((response) => response.json());

export const sites = {
  list: () => json('').then(({ pages }) => pages),
  upload: (slug, zip) => json(`/${slug}`, { method: 'PUT', body: zip }),
  rename: (slug, next) => json(`/${slug}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: next }) }),
  remove: (slug) => json(`/${slug}`, { method: 'DELETE' }),
  files: (slug) => json(`/${slug}/files`).then(({ files }) => files),
  read: (slug, path) => call(`/${slug}/files/${encodePath(path)}`).then((response) => response.blob()),
  write: (slug, path, body) => json(`/${slug}/files/${encodePath(path)}`, { method: 'PUT', body }),
  removeFile: (slug, path) => json(`/${slug}/files/${encodePath(path)}`, { method: 'DELETE' }),
  zip: (slug) => call(`/${slug}/zip`).then((response) => response.blob()),
};

export const slugify = (text) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40);

export const PAGES_ORIGIN = 'https://bichi.hacks.win';
