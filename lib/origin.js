// Reenvio same-origin de Pages hacia el servidor (ORIGIN_URL), sin las cabeceras del visitante.
const HOP_HEADERS = ['host', 'cookie', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip'];

export async function forward(request, env, adjust = () => {}) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  HOP_HEADERS.forEach((name) => headers.delete(name));
  adjust(headers);
  const upstream = await fetch(new URL(url.pathname + url.search, env.ORIGIN_URL), {
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
