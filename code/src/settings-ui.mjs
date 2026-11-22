// Menus de configuracion: elegir modelo, ajustes generales y proveedores con sus claves.
import { AGY_HINT, setAgy } from './agy-mode.mjs';
import { CODEX_HINT, setCodex } from './codex-mode.mjs';
import { saveConfig } from './config.mjs';
import { ago } from './core/sessions.mjs';
import { catalog, displayName, fetchModels, PRESETS, providerOf, rankModels } from './providers.mjs';
import { notice } from './ui/blocks.mjs';
import { c, dim } from './ui/term.mjs';

const EFFORTS = ['low', 'medium', 'high'];
const EFFORT_NAMES = { low: 'bajo', medium: 'medio', high: 'alto' };
const SHELLS = ['auto', 'bash', 'powershell'];
const MODES = ['normal', 'edits', 'plan', 'yolo'];
const MODE_NAMES = { normal: 'normal', edits: 'acepta ediciones', plan: 'plan', yolo: 'sin preguntas' };

const cycle = (list, value, step = 1) => list[(list.indexOf(value) + step + list.length) % list.length];

export async function pickModel(app) {
  const { config, router } = app;
  const entries = catalog(config);
  const restingNote = (entry) => {
    const until = router.state.cooldowns[entry.key] ?? 0;
    return until > Date.now() ? ` · descansa ${Math.ceil((until - Date.now()) / 60000)} min` : '';
  };
  const options = [
    { label: `auto`, hint: 'empieza por el mejor y cambia solo cuando uno se agota', value: 'auto', selected: config.model === 'auto' },
    { label: 'bichi-agy', hint: AGY_HINT, value: 'agy', selected: config.model === 'agy' },
    { label: 'bichi-codex', hint: CODEX_HINT, value: 'codex', selected: config.model === 'codex' },
    ...entries.map((entry) => ({
      label: displayName(config, entry),
      hint: `${config.realNames ? entry.provider.label : entry.note}${entry.provider.name !== 'hacksllm' && !config.realNames ? ` · ${entry.provider.label}` : ''}${restingNote(entry)}`,
      value: entry.key,
      selected: config.model === entry.key,
    })),
  ];
  if (!entries.length) return app.print(notice('no hay modelos: configura una api key con /config', c.warn));
  const choice = await app.choose({ title: 'modelo', body: [dim('si el elegido se queda sin cuota, bichi sigue con el siguiente de la lista.')], options, escape: null, footer: '/names muestra los nombres reales' });
  if (!choice) return;
  if (choice === 'agy') return setAgy(app, true);
  if (choice === 'codex') return setCodex(app, true);
  config.model = choice;
  router.current = choice === 'auto' ? null : entries.find((entry) => entry.key === choice);
  saveConfig(config);
  app.print(notice(`modelo: ${app.modelLabel()}`, c.ok));
}

export async function pickEffort(app, value) {
  const { config } = app;
  if (EFFORTS.includes(value)) config.effort = value;
  else {
    const choice = await app.choose({
      title: 'esfuerzo',
      options: [
        { label: 'bajo', hint: 'rapido y directo', value: 'low', selected: config.effort === 'low' },
        { label: 'medio', hint: 'equilibrado (recomendado)', value: 'medium', selected: config.effort === 'medium' },
        { label: 'alto', hint: 'piensa mas, revisa y prueba a fondo', value: 'high', selected: config.effort === 'high' },
      ],
      escape: null,
    });
    if (!choice) return;
    config.effort = choice;
  }
  saveConfig(config);
  app.print(notice(`esfuerzo ${EFFORT_NAMES[config.effort]}`, c.ok));
}

export async function openConfig(app) {
  const { config } = app;
  while (true) {
    const choice = await app.choose({
      title: 'configuracion',
      body: [dim('enter para cambiar, ← → para alternar, esc para salir')],
      options: [
        { label: () => `modelo: ${c.sky(app.modelLabel())}`, value: 'model' },
        { label: () => `esfuerzo: ${c.sky(EFFORT_NAMES[config.effort])}`, value: 'effort', onSide: (step) => ((config.effort = cycle(EFFORTS, config.effort, step)), saveConfig(config)) },
        { label: () => `proveedores y claves`, hint: 'hacksllm, NVIDIA, Mistral, Groq, OpenRouter y mas', value: 'providers' },
        { label: () => `nombres reales de los modelos: ${c.sky(config.realNames ? 'si' : 'no')}`, value: 'names', onSide: () => ((config.realNames = !config.realNames), saveConfig(config)) },
        { label: () => `modo al empezar: ${c.sky(MODE_NAMES[config.mode] ?? config.mode)}`, value: 'mode', onSide: (step) => ((config.mode = cycle(MODES, config.mode, step)), saveConfig(config)) },
        { label: () => `resumir solo cuando se llena el contexto: ${c.sky(config.autoCompact !== false ? 'si' : 'no')}`, value: 'compact', onSide: () => ((config.autoCompact = config.autoCompact === false), saveConfig(config)) },
        { label: () => `shell: ${c.sky(config.shell)}`, value: 'shell', onSide: (step) => ((config.shell = cycle(SHELLS, config.shell, step)), saveConfig(config)) },
        { label: () => `detalle (resultados completos): ${c.sky(config.verbose ? 'si' : 'no')}`, value: 'verbose', onSide: () => ((config.verbose = !config.verbose), saveConfig(config)) },
        { label: () => `actualizar solo: ${c.sky(config.autoUpdate !== false ? 'si' : 'no')}`, value: 'autoUpdate', onSide: () => ((config.autoUpdate = config.autoUpdate === false), saveConfig(config)) },
        { label: () => `recap al terminar un turno largo: ${c.sky(config.recaps !== false ? 'si' : 'no')}`, value: 'recaps', onSide: () => ((config.recaps = config.recaps === false), saveConfig(config)) },
        { label: () => `sugerir el siguiente mensaje: ${c.sky(config.suggestions !== false ? 'si' : 'no')}`, value: 'suggestions', onSide: () => ((config.suggestions = config.suggestions === false), saveConfig(config)) },
      ],
      escape: null,
    });
    if (!choice) return;
    if (choice === 'model') await pickModel(app);
    else if (choice === 'effort') await pickEffort(app);
    else if (choice === 'providers') await providersMenu(app);
    else if (choice === 'names') config.realNames = !config.realNames;
    else if (choice === 'mode') config.mode = cycle(MODES, config.mode);
    else if (choice === 'compact') config.autoCompact = config.autoCompact === false;
    else if (choice === 'shell') config.shell = cycle(SHELLS, config.shell);
    else if (choice === 'verbose') config.verbose = !config.verbose;
    else if (choice === 'autoUpdate') config.autoUpdate = config.autoUpdate === false;
    else if (choice === 'recaps') config.recaps = config.recaps === false;
    else if (choice === 'suggestions') config.suggestions = config.suggestions === false;
    saveConfig(config);
  }
}

function providerStatus(app, name) {
  const stored = app.config.providers[name];
  if (!stored) return dim('sin configurar');
  if (stored.enabled === false) return c.warn('desactivado');
  if (!stored.key && !PRESETS[name]?.keyless) return dim('sin clave');
  const models = providerOf(app.config, name)?.models?.length ?? 0;
  return c.ok(`conectado · ${models} modelos`);
}

export async function providersMenu(app) {
  while (true) {
    const custom = Object.keys(app.config.providers).filter((name) => !PRESETS[name]);
    const choice = await app.choose({
      title: 'proveedores',
      body: [dim('bichi usa todos los conectados: cuando uno se agota pasa al siguiente.')],
      options: [
        ...Object.entries(PRESETS).map(([name, preset]) => ({ label: preset.label, hint: providerStatus(app, name), value: name })),
        ...custom.map((name) => ({ label: app.config.providers[name].label ?? name, hint: providerStatus(app, name), value: name })),
        { label: 'agregar uno compatible con OpenAI', hint: 'cualquier url /v1', value: '\u0000custom' },
      ],
      escape: null,
    });
    if (!choice) return;
    if (choice === '\u0000custom') await addCustom(app);
    else await providerMenu(app, choice);
  }
}

async function providerMenu(app, name) {
  const preset = PRESETS[name] ?? {};
  const stored = app.config.providers[name];
  const label = stored?.label ?? preset.label ?? name;
  const options = [{ label: stored?.key ? 'cambiar la clave' : 'poner la clave', value: 'key' }];
  if (stored) {
    if (name !== 'hacksllm') options.push({ label: 'elegir modelos', hint: `${stored.models?.length ?? 0} activos`, value: 'models' });
    options.push({ label: stored.enabled === false ? 'activar' : 'desactivar', value: 'toggle' });
    options.push({ label: 'quitar', value: 'remove' });
  }
  const body = preset.keyUrl ? [`consigue la clave en ${c.sky(preset.keyUrl)}`] : [];
  const choice = await app.choose({ title: label, body, options, escape: null });
  if (!choice) return;
  if (choice === 'key') await setKey(app, name);
  else if (choice === 'models') await chooseModels(app, name);
  else if (choice === 'toggle') stored.enabled = stored.enabled === false;
  else if (choice === 'remove') delete app.config.providers[name];
  saveConfig(app.config);
}

// Guarda la clave de un proveedor, la prueba y elige sus modelos.
export async function setKey(app, name, { key: given } = {}) {
  const preset = PRESETS[name] ?? {};
  const label = app.config.providers[name]?.label ?? preset.label ?? name;
  const key = given ?? (await app.field({ title: `clave de ${label}`, hint: preset.keyUrl ? `la consigues en ${preset.keyUrl}` : '', secret: true }));
  if (key === null || (!key && !preset.keyless)) return false;
  const provider = { ...providerOf(app.config, name), ...(PRESETS[name] ?? {}), ...app.config.providers[name], name, key, label };
  app.print(notice(`probando ${label}…`));
  let ids;
  try {
    ids = await fetchModels(provider);
  } catch (error) {
    app.print(notice(`no funciono: ${error.message}`, c.err));
    return false;
  }
  app.config.providers[name] = { ...app.config.providers[name], key, enabled: true };
  if (name !== 'hacksllm' && !preset.models) {
    const ranked = rankModels(ids);
    app.config.providers[name].models = app.config.providers[name].models?.length ? app.config.providers[name].models : ranked.slice(0, 6);
  }
  saveConfig(app.config);
  app.print(notice(`${label} conectado${name === 'hacksllm' ? '' : ` · ${app.config.providers[name].models?.length ?? 0} modelos activos (cambialos en /config)`}`, c.ok));
  return true;
}

async function chooseModels(app, name) {
  const provider = providerOf(app.config, name);
  let ids;
  try {
    ids = rankModels(await fetchModels(provider));
  } catch (error) {
    return app.print(notice(error.message, c.err));
  }
  const active = new Set(provider.models ?? []);
  while (true) {
    const options = [
      { label: c.ok('listo'), value: '\u0000done' },
      ...ids.slice(0, 60).map((id) => ({ label: `${active.has(id) ? c.ok('■') : c.soft('□')} ${id}`, value: id })),
    ];
    const choice = await app.choose({ title: `modelos de ${provider.label}`, body: [dim('enter marca o desmarca; los de arriba son los mejores para programar')], options, escape: '\u0000done' });
    if (choice === '\u0000done') break;
    active.has(choice) ? active.delete(choice) : active.add(choice);
  }
  app.config.providers[name].models = ids.filter((id) => active.has(id));
  saveConfig(app.config);
}

async function addCustom(app) {
  const label = await app.field({ title: 'nombre del proveedor', hint: 'p.ej. mi-servidor' });
  if (!label) return;
  const base = await app.field({ title: 'url base', hint: 'la de la api compatible con OpenAI, p.ej. https://api.ejemplo.com/v1' });
  if (!base) return;
  const name = label.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  app.config.providers[name] = { label, base: base.replace(/\/$/, ''), toolMode: 'auto', models: [] };
  saveConfig(app.config);
  await setKey(app, name);
}

export function sessionOptions(sessions) {
  return sessions.map((session) => ({ label: session.title ?? session.id, hint: `${ago(session.updated)} · ${session.count} mensajes`, value: session.id }));
}
