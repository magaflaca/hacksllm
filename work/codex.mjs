// bichi codex: los modelos de una cuenta de ChatGPT (la de Codex) para bichi code, compartida entre sus usuarios.
// bichi hace todo el trabajo en la PC (herramientas, permisos, historial) y aqui solo llegan las peticiones al modelo:
// este servicio les pone la sesion de la cuenta y las reenvia a la API de Codex tal como lo hace el Codex oficial.
// La sesion (auth.json de `codex login`) vive solo aqui y la renueva solo este servicio: el token rota en cada
// renovacion, asi que nadie mas debe usarlo (ni OmniRoute ni otro Codex).
//
//   POST /codex/responses   una respuesta en stream (API Responses; bichi manda historial, herramientas y su clave
//                           de cache por conversacion, como Codex)
//   GET  /codex/models      modelos de la cuenta con sus niveles de esfuerzo
//   GET  /codex/status      si hay cuenta conectada y como van sus limites
import { readFile, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { authorizer } from './auth.mjs';

const PORT = Number(process.env.CODEX_PORT ?? 20142);
const GATEWAY = process.env.WORK_GATEWAY ?? 'http://127.0.0.1:20128';
const HOME = process.env.CODEX_HOME ?? '/srv/hacksllm-codex';
const AUTH_FILE = path.join(HOME, 'auth.json');
const UPSTREAM = 'https://chatgpt.com/backend-api/codex';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = process.env.CODEX_CLIENT_ID ?? 'app_EMoamEEZ73f0CkXaXp7hrann';
const ORIGINATOR = 'codex_cli_rs';

const LIMITS = {
  body: 48 << 20, // una peticion (el historial con sus imagenes)
  perOwner: 6, // respuestas a la vez por usuario
  total: 12, // respuestas a la vez en total
  idle: 300_000, // sin datos del modelo en este tiempo, se corta
};
// Lo que bichi puede mandar a la API; lo demas se descarta.
const FIELDS = ['model', 'instructions', 'input', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'include', 'prompt_cache_key', 'text', 'service_tier'];

const authorize = authorizer(GATEWAY);

// ---- version del cliente: la API pide una reciente para los modelos nuevos

let version = process.env.CODEX_CLIENT_VERSION ?? '0.171.0';
async function refreshVersion() {
  if (process.env.CODEX_CLIENT_VERSION) return;
  const response = await fetch('https://registry.npmjs.org/@openai%2Fcodex/latest', { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  const latest = response?.ok ? (await response.json().catch(() => null))?.version : null;
  if (/^\d+\.\d+\.\d+$/.test(latest ?? '')) version = latest;
}
const headersFor = (session) => ({
  'user-agent': `${ORIGINATOR}/${version} (Linux; x86_64)`,
  originator: ORIGINATOR,
  version,
  ...(session ? { session_id: session } : {}),
});

// ---- la sesion de la cuenta

const claims = (jwt) => {
  try {
    return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
};

let auth = null; // contenido de auth.json
let refreshing = null;

async function loadAuth() {
  auth = JSON.parse(await readFile(AUTH_FILE, 'utf8').catch(() => 'null'));
  return auth?.tokens?.access_token ? auth : null;
}

const accountOf = (tokens) => tokens.account_id ?? claims(tokens.id_token)['https://api.openai.com/auth']?.chatgpt_account_id ?? null;
const planOf = (tokens) => claims(tokens.id_token)['https://api.openai.com/auth']?.chatgpt_plan_type ?? null;
const expiresAt = (tokens) => (claims(tokens.access_token).exp ?? 0) * 1000;

// Renueva el token (una sola renovacion a la vez) y lo guarda como lo guarda Codex.
function refresh() {
  refreshing ??= (async () => {
    try {
      const current = auth?.tokens;
      if (!current?.refresh_token) throw new Error('la cuenta de codex no esta conectada');
      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': `${ORIGINATOR}/${version}`, originator: ORIGINATOR },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refresh_token, client_id: auth.tokens.oauth_provenance?.client_id ?? CLIENT_ID }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.access_token) throw new Error(`no se pudo renovar la sesion de codex (${response.status} ${body.error?.code ?? body.error ?? ''})`);
      auth.tokens = { ...current, access_token: body.access_token, refresh_token: body.refresh_token ?? current.refresh_token, id_token: body.id_token ?? current.id_token };
      auth.last_refresh = new Date().toISOString();
      const temp = `${AUTH_FILE}.tmp`;
      await writeFile(temp, JSON.stringify(auth, null, 2), { mode: 0o600 });
      await rename(temp, AUTH_FILE);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// El token listo para usar: se renueva cinco minutos antes de caducar.
async function token() {
  if (!auth?.tokens?.access_token && !(await loadAuth())) throw Object.assign(new Error('codex aun no tiene una cuenta de ChatGPT conectada'), { status: 503 });
  if (expiresAt(auth.tokens) - Date.now() < 5 * 60_000) await refresh();
  return auth.tokens;
}

// Llamada a la API de Codex con la sesion; si dice 401 se renueva una vez y se repite.
async function upstream(pathname, init = {}, session = null) {
  for (let attempt = 0; ; attempt++) {
    const tokens = await token();
    const account = accountOf(tokens);
    const response = await fetch(`${UPSTREAM}${pathname}`, {
      ...init,
      headers: { ...init.headers, ...headersFor(session), authorization: `Bearer ${tokens.access_token}`, ...(account ? { 'chatgpt-account-id': account } : {}) },
    });
    if (response.status !== 401 || attempt) return response;
    await response.body?.cancel().catch(() => {});
    await refresh();
  }
}

// ---- limites de la cuenta (lo que dicen las cabeceras de la ultima respuesta)

let limits = null;
function remember(headers) {
  const read = (name) => headers.get(`x-codex-${name}`);
  if (read('primary-used-percent') === null) return;
  const window = (kind) => ({ used: Number(read(`${kind}-used-percent`)), minutes: Number(read(`${kind}-window-minutes`)), resets: Number(read(`${kind}-reset-at`)) || null });
  limits = { primary: window('primary'), secondary: read('secondary-used-percent') === null ? null : window('secondary'), at: Date.now() };
}

// Uso actual de la cuenta (como /status de Codex). Solo se quedan los porcentajes y cuando se renueva cada ventana:
// esa respuesta trae tambien el correo y el id de la cuenta, que nunca salen de aqui.
async function freshLimits() {
  if (limits && Date.now() - limits.at < 60_000) return limits;
  const response = await upstream('/usage', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  const rate = response?.ok ? (await response.json().catch(() => null))?.rate_limit : null;
  if (!rate?.primary_window) return limits;
  const window = (w) => (w ? { used: Number(w.used_percent) || 0, minutes: Math.round((w.limit_window_seconds ?? 0) / 60), resets: w.reset_at ?? null } : null);
  limits = { primary: window(rate.primary_window), secondary: window(rate.secondary_window), reached: !!rate.limit_reached, at: Date.now() };
  return limits;
}

// ---- modelos

let models = { list: null, at: 0 };
async function listModels() {
  if (models.list && Date.now() - models.at < 10 * 60_000) return models.list;
  const response = await upstream(`/models?client_version=${version}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw Object.assign(new Error(`la lista de modelos de codex fallo (${response.status})`), { status: 502 });
  const body = await response.json();
  const list = (body.models ?? [])
    .filter((model) => model.slug && model.visibility !== 'hide' && model.visibility !== 'hidden')
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((model) => ({
      id: model.slug,
      name: model.display_name ?? model.slug,
      description: model.description ?? '',
      efforts: (model.supported_reasoning_levels ?? []).map((level) => ({ effort: level.effort, description: level.description ?? '' })),
      effort: model.default_reasoning_level ?? 'medium',
      context: model.context_window ?? null,
      default: !!model.is_default,
    }));
  models = { list, at: Date.now() };
  return list;
}

// ---- turnos a la vez

const active = new Map(); // owner -> cuantas
let total = 0;
function take(owner) {
  const mine = active.get(owner) ?? 0;
  if (mine >= LIMITS.perOwner) throw Object.assign(new Error('ya tienes varias respuestas de codex en marcha; espera a que acaben'), { status: 429 });
  if (total >= LIMITS.total) throw Object.assign(new Error('codex esta ocupado ahora mismo; prueba en unos segundos'), { status: 429 });
  active.set(owner, mine + 1);
  total++;
  return () => {
    total--;
    const left = (active.get(owner) ?? 1) - 1;
    if (left) active.set(owner, left);
    else active.delete(owner);
  };
}

// ---- http

// Nada de la cuenta (correo, nombre, ids) sale nunca de aqui: los textos que vienen de OpenAI se limpian.
const scrub = (text) =>
  String(text ?? '')
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g, '(cuenta)')
    .replace(/(user|account|org)-[A-Za-z0-9]{8,}/g, '(cuenta)')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '(cuenta)');

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (res, status, message) => send(res, status, { error: { message } });

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMITS.body) throw Object.assign(new Error('peticion demasiado grande'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function respond(req, res, owner) {
  const raw = await readJson(req);
  if (typeof raw.model !== 'string' || !Array.isArray(raw.input)) return fail(res, 400, 'falta model o input');
  const body = Object.fromEntries(FIELDS.filter((field) => raw[field] !== undefined).map((field) => [field, raw[field]]));
  // Como Codex: sin guardar nada alla y siempre en stream. La clave de cache es la de la conversacion de bichi
  // (prefijada por usuario, para que dos personas nunca compartan cache).
  body.store = false;
  body.stream = true;
  const session = /^[A-Za-z0-9._:-]{1,120}$/.test(raw.prompt_cache_key ?? '') ? `${owner.slice(0, 8)}-${raw.prompt_cache_key}` : null;
  if (session) body.prompt_cache_key = session;
  else delete body.prompt_cache_key;

  const release = take(owner);
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const response = await upstream('/responses', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), signal: controller.signal }, session);
    remember(response.headers);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = text.slice(0, 600);
      let until = null;
      try {
        const parsed = JSON.parse(text);
        const error = parsed.error ?? {};
        message = error.message ?? parsed.detail?.message ?? parsed.detail ?? message;
        // Limite de uso de la cuenta: hasta cuando (el cliente lo dice en su hora local).
        until = error.resets_at ? error.resets_at * 1000 : error.resets_in_seconds ? Date.now() + error.resets_in_seconds * 1000 : null;
        if (response.status === 429 && (until || /usage_limit/.test(error.type ?? ''))) message = 'la cuenta de ChatGPT llego a su limite de uso';
      } catch {
        /* no era json */
      }
      const after = Number(response.headers.get('retry-after'));
      until ??= after ? Date.now() + after * 1000 : null;
      return send(res, response.status, { error: { message: scrub(message) || `error ${response.status}`, until } });
    }
    // Los porcentajes de uso de la cuenta viajan con la respuesta (bichi avisa cuando se acerca al limite).
    const usage = {};
    for (const [name, value] of response.headers) if (name.startsWith('x-codex-')) usage[name] = value;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', ...usage });
    let timer = null;
    const idle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), LIMITS.idle);
    };
    idle();
    try {
      for await (const chunk of response.body) {
        idle();
        if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
      }
    } finally {
      clearTimeout(timer);
    }
    res.end();
  } finally {
    release();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    const [, scope, action] = url.pathname.split('/');
    if (scope !== 'codex') return fail(res, 404, 'no existe');
    const owner = await authorize(req);
    if (!owner) return fail(res, 401, 'hace falta una clave de la API valida');
    if (req.method === 'POST' && action === 'responses') return await respond(req, res, owner);
    if (req.method === 'GET' && action === 'models') return send(res, 200, { models: await listModels() });
    if (req.method === 'GET' && action === 'status') {
      const ready = !!(auth?.tokens?.access_token || (await loadAuth()));
      return send(res, 200, { ready, plan: ready ? planOf(auth.tokens) : null, limits: ready ? await freshLimits() : null });
    }
    fail(res, 404, 'no existe');
  } catch (error) {
    if (error.name === 'AbortError') return res.destroy();
    if (!res.headersSent) fail(res, error.status ?? 500, scrub(error.status ? error.message : `error interno: ${error.message}`));
    else res.end();
  }
});

await refreshVersion();
setInterval(refreshVersion, 6 * 60 * 60_000).unref();
server.listen(PORT, '127.0.0.1', () => console.log(`[codex] escuchando en ${PORT}`));
