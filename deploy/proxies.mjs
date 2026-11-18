#!/usr/bin/env node
// Da a cada proxy propio (lineas ip:puerto:usuario:contrasena) su propia conexion gratuita de OpenCode,
// para que una salida caida (timeout, 407) solo aparte esa conexion y el router siga por otra.
// OmniRoute distingue conexiones por su credencial y la capa gratuita envia siempre el literal anonimo,
// asi que cada una guarda una credencial propia (public-<ip>). La sesion de OpenCode se deriva de la
// conversacion, no de la conexion, asi que se mantiene al cambiar de salida.
// Tambien deja una conexion directa por la IP del servidor. Idempotente.
// Uso: node proxies.mjs <archivo>
import { readFileSync } from 'node:fs';

const PROVIDER = 'opencode-zen';
const MODEL = 'deepseek-v4.1-flash-free';
const BASE = `http://127.0.0.1:${process.env.PORT ?? 20128}`;
const [file] = process.argv.slice(2);
if (!file) throw new Error('uso: proxies.mjs <archivo>');

let cookie = '';

async function call(method, path, body) {
  const response = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', cookie, origin: BASE },
    body: body && JSON.stringify(body),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((entry) => entry.split(';')[0]).join('; ');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

const listOf = (data, ...keys) => keys.map((key) => data[key]).find(Array.isArray) ?? (Array.isArray(data) ? data : []);

const entries = [
  ...new Map(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim().split(':'))
      .filter((parts) => parts.length === 4)
      .map(([host, port, username, password]) => [`${host}:${port}`, { host, port: Number(port), username, password }]),
  ).values(),
];

await call('POST', '/api/auth/login', { password: process.env.INITIAL_PASSWORD });

const proxies = new Map(
  listOf(await call('GET', '/api/v1/management/proxies?limit=500'), 'items', 'proxies', 'data').map((proxy) => [`${proxy.host}:${proxy.port}`, proxy.id]),
);
const connections = new Map(
  listOf(await call('GET', '/api/providers?limit=5000'), 'connections', 'providers', 'data')
    .filter((connection) => connection.provider === PROVIDER)
    .map((connection) => [connection.name, connection.id]),
);

const providerPool = await call('GET', `/api/settings/proxies/pool?scope=provider&scopeId=${PROVIDER}`);
for (const member of providerPool.members) {
  await call('DELETE', '/api/settings/proxies/pool', { scope: 'provider', scopeId: PROVIDER, proxyId: member.proxyId ?? member.id });
}

async function ensureConnection(name, apiKey) {
  if (connections.has(name)) return connections.get(name);
  const result = await call('POST', '/api/providers', { provider: PROVIDER, name, apiKey, defaultModel: MODEL });
  const id = result.connection?.id ?? result.id;
  connections.set(name, id);
  created++;
  return id;
}

let created = 0;
await ensureConnection('opencode-free directo', 'public-direct');
for (const entry of entries) {
  const key = `${entry.host}:${entry.port}`;
  const proxyId =
    proxies.get(key) ?? (await call('POST', '/api/v1/management/proxies', { name: `webshare ${key}`, type: 'http', ...entry })).id;
  const connectionId = await ensureConnection(`opencode-free ${entry.host}`, `public-${entry.host}`);
  await call('PUT', '/api/v1/management/proxies/assignments', { scope: 'account', scopeId: connectionId, proxyId });
}

console.log(`${entries.length} proxies, ${created} conexiones nuevas, pool del proveedor vaciado (${providerPool.members.length})`);
