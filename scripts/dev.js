#!/usr/bin/env node
// Servidor de desarrollo: sirve web/ tal cual y reenvia /v1 y /work al servidor (DEV_API, por defecto produccion).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'web');
const api = process.env.DEV_API ?? 'https://llm.hacks.win';
const port = Number(process.env.PORT ?? 8800);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function proxy(request, response) {
  const body = request.method === 'GET' ? undefined : await new Response(request).arrayBuffer().catch(() => undefined);
  const headers = { 'content-type': request.headers['content-type'] ?? 'application/json' };
  if (request.headers.authorization) headers.authorization = request.headers.authorization;
  if (process.env.DEV_KEY && !headers.authorization) headers.authorization = `Bearer ${process.env.DEV_KEY}`;
  const upstream = await fetch(api + request.url, { method: request.method, headers, body });
  response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
  for await (const chunk of upstream.body ?? []) response.write(chunk);
  response.end();
}

createServer(async (request, response) => {
  if (/^\/(v1|work)\//.test(request.url)) return proxy(request, response).catch(() => response.end());
  const relative = path.normalize(decodeURIComponent(request.url.split('?')[0])).replace(/^[/\\]+/, '');
  const file = path.join(root, relative || 'index.html');
  if (!file.startsWith(root)) return response.writeHead(403).end();
  try {
    const data = await readFile(file.endsWith(path.sep) ? path.join(file, 'index.html') : file);
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'text/html', 'cache-control': 'no-store' }).end(data);
  } catch {
    response.writeHead(404).end('no encontrado');
  }
}).listen(port, () => console.log(`http://localhost:${port}`));
