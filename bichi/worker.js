// bichi paginas: sirve las webs estaticas que publica bichi work, desde KV y sin tocar el VPS.
// Claves: site:<nombre> (metadatos) y file:<nombre>/<ruta> (contenido, con su tipo en los metadatos).
import { home, missing, favicon } from './shell.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const EDGE_TTL = 60;

const TYPES = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', xml: 'application/xml', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
  mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf', wasm: 'application/wasm', csv: 'text/csv; charset=utf-8',
};
const typeOf = (path) => TYPES[path.split('.').pop().toLowerCase()] ?? 'application/octet-stream';

const html = (status, body) => new Response(body, { status, headers: { 'content-type': TYPES.html, 'cache-control': 'public, max-age=300' } });
const icon = () => new Response(favicon, { headers: { 'content-type': TYPES.svg, 'cache-control': 'public, max-age=86400' } });

async function file(env, slug, path) {
  const { value, metadata } = await env.PAGES.getWithMetadata(`file:${slug}/${path}`, { type: 'stream', cacheTtl: EDGE_TTL });
  return value && { value, type: metadata?.type ?? typeOf(path) };
}

export default {
  async fetch(request, env) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('solo lectura', { status: 405 });
    const url = new URL(request.url);
    const [, slug = '', ...rest] = url.pathname.split('/');
    if (!slug) return html(200, home());
    if (slug === 'favicon.svg' || slug === 'favicon.ico') return icon();
    if (!SLUG.test(slug)) return html(404, missing(''));
    if (!rest.length) return Response.redirect(`${url.origin}/${slug}/${url.search}`, 301);

    let path;
    try {
      path = decodeURIComponent(rest.join('/'));
    } catch {
      return html(404, missing(slug));
    }
    if (!path || path.endsWith('/')) path += 'index.html';
    if (path.split('/').some((part) => part === '..' || part.startsWith('.'))) return html(404, missing(slug));

    const found = (await file(env, slug, path)) ?? (!/\.[a-z0-9]+$/i.test(path) && (await file(env, slug, `${path}/index.html`)));
    if (!found) {
      const custom = await file(env, slug, '404.html');
      return custom ? new Response(custom.value, { status: 404, headers: { 'content-type': custom.type } }) : html(404, missing(slug));
    }
    return new Response(request.method === 'HEAD' ? null : found.value, {
      headers: {
        'content-type': found.type,
        'cache-control': `public, max-age=${EDGE_TTL}`,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
      },
    });
  },
};
