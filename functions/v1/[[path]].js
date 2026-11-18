// /v1/* va al gateway OmniRoute. Las peticiones de la propia pagina sin clave usan la clave web.
import { forward } from '../../lib/origin.js';

export const onRequest = ({ request, env }) =>
  forward(request, env, (headers) => {
    const fromPage = request.headers.get('sec-fetch-site') === 'same-origin';
    if (!headers.has('authorization') && fromPage && env.WEB_KEY) headers.set('authorization', `Bearer ${env.WEB_KEY}`);
  });
