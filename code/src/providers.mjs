// Proveedores compatibles con OpenAI, nombres camuflados de modelos y la cadena de modelos para el modo auto.
import { SITE } from './config.mjs';

// Modelos de hacksllm con su nombre bichi. El orden es el de la cadena auto (medido: rapidez y acierto con herramientas).
const HACKSLLM_MODELS = [
  { id: 'nemotron-3-ultra', alias: 'bichi-turbo', note: 'rapido y capaz, el primero del modo auto' },
  { id: 'deepseek-v4-pro', alias: 'bichi-max', note: 'el mas potente para razonar' },
  { id: 'kimi-k2.7', alias: 'bichihacks', note: 'muy agentico, algo mas lento' },
  { id: 'deepseek-v4.1', alias: 'bichilm', note: 'equilibrado, buen todoterreno' },
  { id: 'glm-5.2', alias: 'bichi-zen', note: 'fino y ordenado con el codigo' },
  { id: 'gpt-oss-120b', alias: 'bichi-mini', note: 'ligero, de reserva' },
  { id: 'gpt-5.6-luna', alias: 'bichi-luna', note: 'charla rapida, sin herramientas', chat: true },
  { id: 'claude-haiku-4.5', alias: 'bichi-veloz', note: 'charla rapida, sin herramientas', chat: true },
];

// toolMode: 'text' describe las herramientas en el prompt y las lee del texto (sirve con cualquier modelo);
// 'native' usa tool calling de la API. 'auto' prueba nativo y cae a texto si el modelo no lo soporta.
export const PRESETS = {
  hacksllm: {
    label: 'hacksllm',
    base: `${SITE}/v1`,
    keyUrl: `${SITE}/#/api`,
    toolMode: 'text',
    models: HACKSLLM_MODELS,
    context: 128000,
  },
  nvidia: {
    label: 'NVIDIA build',
    base: 'https://integrate.api.nvidia.com/v1',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    toolMode: 'auto',
    context: 128000,
  },
  mistral: {
    label: 'Mistral',
    base: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    toolMode: 'native',
    context: 128000,
  },
  groq: {
    label: 'Groq',
    base: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    toolMode: 'auto',
    context: 128000,
  },
  openrouter: {
    label: 'OpenRouter',
    base: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    toolMode: 'auto',
    context: 128000,
  },
  cerebras: {
    label: 'Cerebras',
    base: 'https://api.cerebras.ai/v1',
    keyUrl: 'https://cloud.cerebras.ai',
    toolMode: 'auto',
    context: 64000,
  },
  ollama: {
    label: 'Ollama (local)',
    base: 'http://127.0.0.1:11434/v1',
    keyUrl: '',
    toolMode: 'auto',
    context: 32000,
    keyless: true,
  },
};

// Preferencias para elegir modelos de proveedores con catalogos enormes: los de codigo y los grandes primero.
const RANKING = [
  /qwen.?3.*coder|devstral|codestral|kimi-k2|glm-?4\.[5-9]|glm-?5|deepseek-(v3|v4|r1|chat)|gpt-oss-120b|llama-4-maverick|mistral-large|magistral|nemotron.*ultra|qwen.?3.*(235|480)/i,
  /qwen.?3|llama-?3\.3-70b|llama-4|mistral-medium|gpt-oss|nemotron|mixtral|gemma-?3/i,
];
const SKIP = /embed|whisper|tts|guard|rerank|vision-only|image|audio|moderation|parse|ocr|clip|reward|safety|retriev|speech|transcri|nv-embed|bge|e5-|translate/i;

export function rankModels(ids) {
  const score = (id) => {
    const index = RANKING.findIndex((pattern) => pattern.test(id));
    return index < 0 ? RANKING.length : index;
  };
  return ids.filter((id) => !SKIP.test(id)).sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}

const WORDS = ['rayo', 'brisa', 'cometa', 'chispa', 'trueno', 'nube', 'luz', 'marea', 'cuarzo', 'pixel', 'neon', 'aurora', 'cobalto', 'eco', 'polen', 'nebula', 'turbo', 'astro', 'orbita', 'zafiro'];

function hash(text) {
  let h = 2166136261;
  for (const char of text) h = Math.imul(h ^ char.codePointAt(0), 16777619) >>> 0;
  return h;
}

export const providerOf = (config, name) => {
  const stored = config.providers[name];
  if (!stored) return null;
  const preset = PRESETS[name] ?? {};
  return { name, ...preset, ...stored, label: stored.label ?? preset.label ?? name, base: stored.base ?? preset.base };
};

export const activeProviders = (config) =>
  Object.keys(config.providers)
    .map((name) => providerOf(config, name))
    .filter((provider) => provider && provider.enabled !== false && (provider.key || provider.keyless) && provider.base);

// Todos los modelos elegibles, con nombre bichi unico.
export function catalog(config) {
  const taken = new Set();
  const list = [];
  for (const provider of activeProviders(config)) {
    const models = provider.models?.length ? provider.models : [];
    for (const entry of models) {
      const model = typeof entry === 'string' ? { id: entry } : entry;
      let alias = model.alias;
      if (!alias) {
        const base = `bichi-${WORDS[hash(`${provider.name}/${model.id}`) % WORDS.length]}`;
        alias = base;
        for (let n = 2; taken.has(alias); n++) alias = `${base}${n}`;
      }
      taken.add(alias);
      list.push({
        key: `${provider.name}/${model.id}`,
        provider,
        id: model.id,
        alias,
        note: model.note ?? provider.label,
        chat: !!model.chat,
        context: model.context ?? provider.context ?? 128000,
      });
    }
  }
  return list;
}

export const displayName = (config, entry) => (config.realNames ? `${entry.id}` : entry.alias);

export function findModel(config, wanted) {
  const list = catalog(config);
  const lower = String(wanted).toLowerCase();
  return list.find((entry) => entry.key.toLowerCase() === lower || entry.alias === lower || entry.id.toLowerCase() === lower) ?? null;
}

// Cadena para el modo auto: el elegido primero (si lo hay) y luego los demas con herramientas.
export function chain(config, selection = config.model) {
  const list = catalog(config).filter((entry) => !entry.chat);
  const order = config.autoChain?.length ? config.autoChain : null;
  const sorted = order ? [...list].sort((a, b) => indexOr(order, a.key) - indexOr(order, b.key)) : list;
  if (!selection || selection === 'auto') return sorted;
  const chosen = findModel(config, selection);
  return chosen ? [chosen, ...sorted.filter((entry) => entry.key !== chosen.key)] : sorted;
}

const indexOr = (list, value) => {
  const index = list.indexOf(value);
  return index < 0 ? list.length : index;
};

export async function fetchModels(provider) {
  const response = await fetch(`${provider.base.replace(/\/$/, '')}/models`, {
    headers: provider.key ? { authorization: `Bearer ${provider.key}` } : {},
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`${provider.label}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  const body = await response.json();
  return (body.data ?? body.models ?? []).map((model) => model.id ?? model.name).filter(Boolean);
}
