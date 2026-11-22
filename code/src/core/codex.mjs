// bichi codex: los modelos de la cuenta de ChatGPT compartida (servicio /codex del VPS, ver work/codex.mjs). Van
// aparte de los de bichi: en modo codex solo se usa el modelo elegido de la cuenta, con su esfuerzo, y bichi hace el
// resto (herramientas, permisos, historial) como siempre. Cada conversacion tiene su clave de cache, asi que el
// modelo retoma lo ya leido en vez de empezar de cero en cada peticion (como Codex).
import { SITE } from '../config.mjs';

export const CODEX = 'codex'; // valor de config.model en modo codex
export const isCodex = (model) => model === CODEX || model === 'bichi-codex';

const hacksKey = (config) => config.providers?.hacksllm?.key ?? '';

export const codexProvider = (config) => ({
  name: 'codex',
  label: 'bichi-codex',
  base: `${SITE}/codex`,
  key: hacksKey(config),
  wire: 'responses',
  toolMode: 'native',
});

// Lo elegido dentro del modo: { model, effort }. Sin modelo aun, el que la cuenta marque por defecto.
export const codexChoice = (config) => config.codex ?? {};

// La entrada de modelo para el router (una sola: en modo codex no se salta a otros modelos).
export function codexEntry(config, models = []) {
  const choice = codexChoice(config);
  const known = models.find((model) => model.id === choice.model) ?? models.find((model) => model.default) ?? models[0];
  const id = choice.model ?? known?.id ?? 'gpt-6.1-sol';
  return {
    key: `codex/${id}`,
    provider: codexProvider(config),
    id,
    alias: 'bichi-codex',
    note: 'modelos de la cuenta de ChatGPT',
    chat: false,
    context: known?.context ?? 272000,
    effort: choice.effort ?? known?.effort ?? 'medium',
  };
}

async function get(config, pathname) {
  const key = hacksKey(config);
  if (!key) throw new Error('bichi-codex necesita tu api key de hacksllm (/key)');
  const response = await fetch(`${SITE}/codex/${pathname}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message ?? `codex: error ${response.status}`);
  return body;
}

// Modelos de la cuenta: [{ id, name, description, efforts:[{effort, description}], effort, context, default }].
// Se recuerdan en el estado para que el selector abra al instante y funcione aunque la red falle un momento.
export async function codexModels(app, { fresh = false } = {}) {
  const cached = app.state.codexModels;
  if (!fresh && cached?.list?.length && Date.now() - cached.at < 30 * 60_000) return cached.list;
  try {
    const { models } = await get(app.config, 'models');
    app.state.codexModels = { list: models, at: Date.now() };
    return models;
  } catch (error) {
    if (cached?.list?.length) return cached.list;
    throw error;
  }
}

export const codexStatus = (config) => get(config, 'status');
