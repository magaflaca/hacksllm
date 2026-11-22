// El modo codex dentro de la app: /codex entra y sale, y mientras esta activo /model y /effort eligen entre los
// modelos de la cuenta de ChatGPT y sus niveles de esfuerzo (core/codex.mjs). El trabajo lo hace el agente de siempre.
import { saveConfig } from './config.mjs';
import { CODEX, codexEntry, codexModels, isCodex } from './core/codex.mjs';
import { notice } from './ui/blocks.mjs';
import { c, dim } from './ui/term.mjs';

export const CODEX_HINT = 'los modelos de ChatGPT, con su propio esfuerzo';

// Nombres de los niveles de esfuerzo de la cuenta.
const LEVELS = { none: 'sin razonar', minimal: 'minimo', low: 'bajo', medium: 'medio', high: 'alto', xhigh: 'muy alto', max: 'maximo', ultra: 'ultra' };
export const levelName = (effort) => LEVELS[effort] ?? effort;

const entry = (app) => codexEntry(app.config, app.state.codexModels?.list);

// Como se ve en la barra: "bichi-codex · gpt-6.1-sol" y el esfuerzo aparte.
export const codexLabel = (app) => `bichi-codex · ${entry(app).id}`;
export const codexEffort = (app) => entry(app).effort;

// Entrar o salir del modo. Al entrar se cargan los modelos de la cuenta (y se avisa si aun no hay cuenta).
export async function setCodex(app, on) {
  if (!on) {
    app.config.model = 'auto';
    app.router.current = null;
    saveConfig(app.config);
    return app.print(notice(`modelo: ${app.modelLabel()}`, c.ok));
  }
  let models;
  try {
    models = await codexModels(app);
  } catch (error) {
    return app.print(notice(`bichi-codex no esta disponible: ${error.message}`, c.warn));
  }
  if (!models.length) return app.print(notice('bichi-codex no esta disponible: la cuenta no tiene modelos', c.warn));
  app.config.model = CODEX;
  app.config.codex ??= {};
  if (!models.some((model) => model.id === app.config.codex.model)) app.config.codex.model = (models.find((model) => model.default) ?? models[0]).id;
  app.router.current = entry(app);
  saveConfig(app.config);
  app.print(notice(`modo codex · ${entry(app).id} · esfuerzo ${levelName(codexEffort(app))} · /codex para volver`, c.ok));
}

// /model en modo codex: los modelos de la cuenta (o volver a los de bichi).
export async function pickCodexModel(app, wanted) {
  const models = await codexModels(app, { fresh: !wanted }).catch((error) => (app.print(notice(error.message, c.warn)), null));
  if (!models) return;
  let choice = wanted ? models.find((model) => model.id === wanted || model.name.toLowerCase() === wanted.toLowerCase())?.id : null;
  if (wanted && !choice) return app.print(notice(`la cuenta no tiene "${wanted}"`, c.warn));
  if (!choice) {
    choice = await app.choose({
      title: 'modelo · bichi-codex',
      body: [dim('modelos de la cuenta de ChatGPT; el esfuerzo se elige con /effort.')],
      options: [
        ...models.map((model) => ({ label: model.id, hint: model.description || model.name, value: model.id, selected: model.id === entry(app).id })),
        { label: 'volver a los modelos de bichi', hint: 'sale del modo codex', value: '-' },
      ],
      escape: null,
    });
    if (!choice) return;
    if (choice === '-') return setCodex(app, false);
  }
  const model = models.find((item) => item.id === choice);
  app.config.codex = { model: choice, effort: model.efforts.some((level) => level.effort === app.config.codex?.effort) ? app.config.codex.effort : model.effort };
  app.router.current = entry(app);
  saveConfig(app.config);
  app.print(notice(`modelo: ${choice} · esfuerzo ${levelName(codexEffort(app))}`, c.ok));
}

// /effort en modo codex: los niveles que admite el modelo elegido.
export async function pickCodexEffort(app, wanted) {
  const models = await codexModels(app).catch(() => []);
  const model = models.find((item) => item.id === entry(app).id);
  const levels = model?.efforts?.length ? model.efforts : ['low', 'medium', 'high'].map((effort) => ({ effort, description: '' }));
  const byName = Object.fromEntries(Object.entries(LEVELS).map(([key, name]) => [name, key]));
  let choice = wanted ? levels.find((level) => level.effort === wanted || level.effort === byName[wanted])?.effort : null;
  if (!choice) {
    choice = await app.choose({
      title: `esfuerzo · ${entry(app).id}`,
      options: levels.map((level) => ({ label: levelName(level.effort), hint: level.description, value: level.effort, selected: level.effort === codexEffort(app) })),
      escape: null,
    });
    if (!choice) return;
  }
  app.config.codex = { ...app.config.codex, model: entry(app).id, effort: choice };
  app.router.current = entry(app);
  saveConfig(app.config);
  app.print(notice(`esfuerzo ${levelName(choice)}`, c.ok));
}

export { isCodex };
