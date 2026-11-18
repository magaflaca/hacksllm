// Cliente de bichi work (/work/sessions). Todo requiere la clave del visitante.
import { authHeaders, failure, sseEvents, ApiError } from './api.js';
import { store } from './store.js';

const BASE = `${location.origin}/work/sessions`;

async function call(path, options = {}) {
  const response = await fetch(BASE + path, { ...options, headers: { ...authHeaders(), ...options.headers } });
  if (!response.ok) throw await failure(response);
  return response.json();
}

export const work = {
  hasKey: () => Boolean(store.get('apiKey', '')),
  create: () => call('', { method: 'POST' }).then(({ id }) => id),
  get: (id) => call(`/${id}`),
  files: (id) => call(`/${id}/files`).then(({ files }) => files),
  stop: (id) => call(`/${id}/stop`, { method: 'POST' }).catch(() => {}),
  remove: (id) => call(`/${id}`, { method: 'DELETE' }).catch(() => {}),

  upload(id, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${BASE}/${id}/files/${encodeURIComponent(file.name)}`);
      for (const [name, value] of Object.entries(authHeaders())) if (name !== 'Content-Type') xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(event.loaded / event.total);
      xhr.onload = () => {
        const body = JSON.parse(xhr.responseText || '{}');
        xhr.status < 300 ? resolve(body) : reject(new ApiError(xhr.status, body.error?.message ?? 'no se pudo subir'));
      };
      xhr.onerror = () => reject(new ApiError(0, 'sin conexion'));
      xhr.send(file);
    });
  },

  async *run(id, body, signal) {
    const response = await fetch(`${BASE}/${id}/run`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body), signal });
    if (!response.ok) throw await failure(response);
    yield* sseEvents(response.body);
  },

  async save(id, path, name) {
    const response = await fetch(path ? `${BASE}/${id}/files/${path.split('/').map(encodeURIComponent).join('/')}` : `${BASE}/${id}/zip`, { headers: authHeaders() });
    if (!response.ok) throw await failure(response);
    const url = URL.createObjectURL(await response.blob());
    const link = Object.assign(document.createElement('a'), { href: url, download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  },
};
