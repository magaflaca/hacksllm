#!/usr/bin/env node
// Combos publicos de hacksllm, todos de proveedores sin clave. Cada combo prueba primero su modelo y despues
// la reserva comun, asi que siempre responde alguien aunque una capa gratuita se agote. Idempotente.
// Uso: node models.mjs
const BASE = `http://127.0.0.1:${process.env.PORT ?? 20128}`;

const OPENCODE = 'opencode-zen';
const PLAYGROUND = 'cloudflare-playground';
const DUCK = 'duckduckgo-web';
const KILO = 'kilocode';

const RESERVE = [
  `${PLAYGROUND}/zai-org/glm-5.2`,
  `${PLAYGROUND}/moonshotai/kimi-k2.7-code`,
  `${KILO}/nvidia/nemotron-3-ultra-550b-a55b:free`,
  `${OPENCODE}/big-pickle`,
  `${OPENCODE}/mimo-v2.6-flash-free`,
  `${KILO}/nvidia/nemotron-3.5-super-vl:free`,
  `${PLAYGROUND}/deepseek-ai/deepseek-v4-flash-0731`,
  `${DUCK}/gpt-5.4-mini`,
  `${KILO}/kilo-auto/free`,
];

const COMBOS = {
  'deepseek-v4.1': [`${OPENCODE}/deepseek-v4.1-flash-free`, `${PLAYGROUND}/deepseek-ai/deepseek-v4-pro-0813`],
  'deepseek-v4-pro': [`${PLAYGROUND}/deepseek-ai/deepseek-v4-pro-0813`, `${OPENCODE}/deepseek-v4.1-flash-free`],
  'glm-5.2': [`${PLAYGROUND}/zai-org/glm-5.2`],
  'kimi-k2.7': [`${PLAYGROUND}/moonshotai/kimi-k2.7-code`, `${PLAYGROUND}/moonshotai/kimi-k2.6`],
  'nemotron-3-ultra': [`${KILO}/nvidia/nemotron-3-ultra-550b-a55b:free`, `${OPENCODE}/nemotron-3-ultra-free`],
  'gpt-5.6-luna': [`${DUCK}/gpt-5.6-luna`],
  'claude-haiku-4.5': [`${DUCK}/claude-haiku-4-5`],
  'gpt-oss-120b': [`${PLAYGROUND}/openai/gpt-oss-120b`, `${DUCK}/tinfoil/gpt-oss-120b`],
};

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

await call('POST', '/api/auth/login', { password: process.env.INITIAL_PASSWORD });

const { connections } = await call('GET', '/api/providers?limit=5000');
const missing = [DUCK, PLAYGROUND].filter((provider) => !connections.some((connection) => connection.provider === provider));
if (missing.length) await call('POST', '/api/providers/free-onboarding', { providerIds: missing, confirmed: true });

const existing = new Map((await call('GET', '/api/combos')).combos.map((combo) => [combo.name, combo.id]));
for (const [name, head] of Object.entries(COMBOS)) {
  const models = [...new Set([...head, ...RESERVE])];
  const body = { name, strategy: 'priority', models };
  if (existing.has(name)) await call('PUT', `/api/combos/${existing.get(name)}`, body);
  else await call('POST', '/api/combos', body);
  console.log(`${name}: ${models.length} modelos`);
}
