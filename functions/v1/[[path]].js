// Puente same-origin: /v1/* de la web va al gateway OmniRoute del servidor. Las peticiones
// de la propia pagina sin clave usan la clave web, guardada como secreto del proyecto.
const HOP_HEADERS = ['host', 'cookie', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip'];

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, env.ORIGIN_URL);
  const headers = new Headers(request.headers);
  HOP_HEADERS.forEach((name) => headers.delete(name));

  const fromPage = request.headers.get('sec-fetch-site') === 'same-origin';
  if (!headers.has('authorization') && fromPage && env.WEB_KEY) headers.set('authorization', `Bearer ${env.WEB_KEY}`);

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  });
  const reply = new Headers(upstream.headers);
  reply.set('cache-control', 'no-store');
  reply.set('access-control-allow-origin', '*');
  return new Response(upstream.body, { status: upstream.status, headers: reply });
}
