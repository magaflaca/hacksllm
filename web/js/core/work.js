// Cliente de bichi work (/work/sessions). Todo requiere la clave del visitante.
import { authHeaders, failure, sseEvents, ApiError } from './api.js';
import { store } from './store.js';

const BASE = `${location.origin}/work/sessions`;
const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

async function call(path, options = {}) {
  const response = await fetch(BASE + path, { ...options, headers: { ...authHeaders(), ...options.headers } });
  if (!response.ok) throw await failure(response);
  return response.json();
}

export const work = {
  hasKey: () => Boolean(store.get('apiKey', '')),
  // Deja la conversacion en el servidor para abrirla en bichi code con /tp.
  transport: (session) =>
    fetch(`${location.origin}/work/tp`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: session.title,
        remote: session.remote,
        messages: session.messages.map(({ role, content, files }) => ({
          role,
          content: `${content ?? ''}${files?.length ? `

(archivos entregados: ${files.map((file) => file.path).join(', ')})` : ''}`,
        })),
      }),
    }).then(async (response) => {
      if (!response.ok) throw await failure(response);
      return response.json();
    }),
  create: () => call('', { method: 'POST' }).then(({ id }) => id),
  get: (id) => call(`/${id}`),
  files: (id) => call(`/${id}/files`).then(({ files }) => files),
  stop: (id) => call(`/${id}/stop`, { method: 'POST' }).catch(() => {}),
  remove: (id) => call(`/${id}`, { method: 'DELETE' }).catch(() => {}),
  checkout: (id, slug) => call(`/${id}/pages/${slug}`, { method: 'POST' }),
  unpublish: (slug) =>
    fetch(`${location.origin}/work/pages/${slug}`, { method: 'DELETE', headers: authHeaders() }).then((response) => response.ok || response.status === 404),

  // file puede ser un File o { name, blob } con una ruta relativa como nombre.
  upload(id, file, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${BASE}/${id}/files/${encodePath(file.name)}`);
      for (const [name, value] of Object.entries(authHeaders())) if (name !== 'Content-Type') xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(event.loaded / event.total);
      xhr.onload = () => {
        const body = JSON.parse(xhr.responseText || '{}');
        xhr.status < 300 ? resolve(body) : reject(new ApiError(xhr.status, body.error?.message ?? 'no se pudo subir'));
      };
      xhr.onerror = () => reject(new ApiError(0, 'sin conexion'));
      xhr.send(file.blob ?? file);
    });
  },

  // Tras cortar un turno, el servidor tarda unos segundos en soltar la sesion: el 409 se reintenta.
  async *run(id, body, signal) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${BASE}/${id}/run`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body), signal });
      if (response.status === 409 && attempt < 40) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        continue;
      }
      if (!response.ok) throw await failure(response);
      return yield* sseEvents(response.body);
    }
  },

  // Un archivo del espacio, o el zip de todo si no se pasa ruta.
  async blob(id, path) {
    const response = await fetch(path ? `${BASE}/${id}/files/${encodePath(path)}` : `${BASE}/${id}/zip`, { headers: authHeaders() });
    if (!response.ok) throw await failure(response);
    return response.blob();
  },
};

export function deliver(blob, name) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
