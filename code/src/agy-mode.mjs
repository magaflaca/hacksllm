// El modo agy dentro de la app: un turno de Antigravity (core/agy.mjs) contado con los mismos bloques de siempre.
// Las escrituras y los comandos que pide agy pasan por los permisos de bichi (y por /undo); el contexto, la memoria
// de la conversacion y como se reparte el trabajo los lleva agy, que retoma su propia conversacion en cada turno.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deleteTool, projectProblem, runAgyTurn, translator } from './core/agy.mjs';
import { write } from './tools/fs.mjs';
import { invalidate } from './tools/files.mjs';
import { detectShell, shell } from './tools/shell.mjs';
import { saveConfig } from './config.mjs';
import { notice } from './ui/blocks.mjs';
import { c } from './ui/term.mjs';

export const AGY_HINT = 'Antigravity · Gemini 3.8 Flash';

// Entrar o salir del modo agy. Al salir se vuelve a auto (los modelos de siempre siguen con la misma conversacion).
export function setAgy(app, on) {
  app.config.model = on ? 'agy' : 'auto';
  app.router.current = null;
  saveConfig(app.config);
  app.print(notice(on ? 'modo agy · /agy para volver' : `modelo: ${app.modelLabel()}`, c.ok));
}

// Una conversacion sin carpeta de proyecto (bichi abierto en la carpeta de usuario o en la raiz del disco): se
// ofrece crear una con el nombre de la conversacion y pasar a trabajar ahi.
async function ensureProject(app) {
  const problem = projectProblem(app.cwd);
  if (!problem) return true;
  if (problem.reason === 'system') throw new Error(problem.message);
  const base = problem.reason === 'home' ? app.cwd : os.homedir();
  const name = (app.session.title ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^(work|importada): /, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'proyecto-bichi';
  let suggested = path.join(base, name);
  for (let n = 2; existsSync(suggested); n++) suggested = path.join(base, `${name}-${n}`);
  const choice = await app.choose({
    title: 'esta conversacion no tiene carpeta de proyecto',
    options: [
      { label: `crear ${suggested}`, value: 'create' },
      { label: 'crearla con otro nombre', value: 'name' },
      { label: 'cancelar', value: null },
    ],
    escape: null,
  });
  if (!choice) return false;
  let target = suggested;
  if (choice === 'name') {
    const typed = await app.field({ title: 'nombre de la carpeta', initial: path.basename(suggested), hint: `se crea dentro de ${base}` });
    if (!typed?.trim()) return false;
    target = path.resolve(base, typed.trim());
  }
  await mkdir(target, { recursive: true });
  app.moveTo(target);
  return true;
}

const STEPS = {
  read: { tool: 'read', title: 'Leer' },
  search: { tool: 'grep', title: 'Buscar' },
  web: { tool: 'web_fetch', title: 'Web' },
  other: { tool: 'agy', title: 'Paso' },
};
const CONTEXT = 30_000;

// La conversacion que habia antes de pasar a agy, para que no empiece de cero.
const transcript = (messages) =>
  messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string' && message.content.trim())
    .map((message) => `${message.role === 'user' ? 'usuario' : 'bichi'}: ${message.content}`)
    .join('\n\n')
    .slice(-CONTEXT);

export async function runAgy(app, content) {
  // Sin carpeta y sin crear una: el mensaje vuelve a la entrada como si se hubiera cancelado.
  if (!(await ensureProject(app))) throw Object.assign(new Error('cancelado'), { name: 'AbortError' });
  const { agent } = app;
  const ui = agent.ui;
  agent.controller = new AbortController();
  const { signal } = agent.controller;
  const index = agent.messages.length;
  const fresh = !app.session.agy || !Object.values(app.session.agy).some(Boolean);
  const context = fresh ? transcript(agent.messages) : '';
  agent.messages.push({ role: 'user', content });
  const turn = { index, files: new Map(), acted: false };
  agent.turns.push(turn);
  // En cuanto agy hace o dice algo, el turno ya no se puede deshacer con un esc rapido (ver unsent en app.mjs).
  const acted = () => (turn.acted = true);
  const ctx = (rel = '') => ({ ...agent.context(signal, { id: 'agy' }), cwd: path.resolve(app.cwd, rel) });
  const tr = translator(app.cwd);
  const steps = new Map();
  const notes = []; // rechazos con comentario: agy los lee en la siguiente salida de un comando
  let streamed = '';
  let n = 0;

  const step = (event) => {
    const spec = STEPS[event.kind];
    if (!spec) return; // escrituras y comandos se cuentan desde lo que piden (con su diff y su salida)
    const label = { title: spec.title, arg: tr.display(event.label) };
    let view = steps.get(event.id);
    if (!view) {
      view = { id: `agy-${event.id}`, tool: { name: spec.tool }, input: {}, label, sub: null };
      steps.set(event.id, view);
      ui.onToolStart?.(view);
    }
    if (event.state === 'done') (ui.onToolEnd?.(view, { summary: 'listo' }), steps.delete(event.id));
    else if (event.state === 'failed') (ui.onToolEnd?.(view, { error: 'no pudo' }), steps.delete(event.id));
  };

  const hooks = {
    shellName: () => detectShell(app.config.shell).name,
    onEvent(event) {
      acted();
      if (event.type === 'text') {
        const text = tr.display(event.delta);
        streamed += text;
        ui.onText?.(text);
      } else if (event.type === 'thinking') ui.onReasoning?.(event.delta);
      else if (event.type === 'step') step(event);
    },
    onStatus: (text) => app.note(text, c.plum),
    onRetry: (info) => ui.onRetry?.(info),

    // Escribir un archivo: con su diff, su permiso y su checkpoint para /undo.
    async put(rel, data) {
      acted();
      if (app.mode === 'plan') return 13;
      const file = path.resolve(app.cwd, rel);
      const exists = existsSync(file);
      const binary = data.includes(0);
      const input = { path: rel, content: binary ? '' : data.toString('utf8') };
      const tool = { ...write, name: exists ? 'edit' : 'write' };
      const view = { id: `agy-w${++n}`, tool, input, label: { title: exists ? 'Editar' : 'Crear', arg: rel }, sub: null };
      const refusal = await agent.permit(tool, input, view, ctx());
      if (refusal) {
        if (refusal.includes('dice:')) notes.push(`(bichi: no se escribio ${rel}. ${refusal})`);
        return 13;
      }
      ui.onToolStart?.(view);
      if (binary) {
        agent.checkpoint(file, existsSync(file) ? await readFile(file) : null);
        await writeFile(file, data);
        invalidate();
        ui.onToolEnd?.(view, { summary: `${data.length} bytes` });
        return 0;
      }
      const result = await write.run(input, ctx());
      ui.onToolEnd?.(view, result);
      return 0;
    },

    // Comando en la terminal: el mismo permiso y el mismo bloque que la herramienta shell.
    async run(command, rel) {
      acted();
      if (app.mode === 'plan') return { out: 'modo plan: todavia no se ejecutan comandos; presenta el plan primero\n', code: 1 };
      const input = { command, timeout: 600 };
      const view = { id: `agy-r${++n}`, tool: shell, input, label: shell.label(input), sub: null };
      const refusal = await agent.permit(shell, input, view, ctx(rel));
      if (refusal) return { out: `${refusal}\n`, code: 1 };
      ui.onToolStart?.(view);
      const result = await shell.run(input, ctx(rel)).catch((error) => ({ content: error.message, output: error.message, exit: 1 }));
      ui.onToolEnd?.(view, result);
      const extra = notes.splice(0).join('\n');
      return { out: `${result.output ?? result.content ?? ''}${extra ? `\n${extra}` : ''}`, code: result.exit ?? (result.summary === 'tiempo agotado' ? 124 : 0) };
    },

    // Borrar: pide permiso como una edicion.
    async remove(rel, dir) {
      acted();
      if (app.mode === 'plan') return 13;
      const input = { path: rel };
      const view = { id: `agy-d${++n}`, tool: deleteTool, input, label: deleteTool.label(input), sub: null };
      const refusal = await agent.permit(deleteTool, input, view, ctx());
      if (refusal) return 13;
      ui.onToolStart?.(view);
      const file = path.resolve(app.cwd, rel);
      if (!dir && existsSync(file)) agent.checkpoint(file, await readFile(file));
      await (dir ? rmdir(file) : rm(file));
      invalidate();
      ui.onToolEnd?.(view, { summary: 'borrado' });
      return 0;
    },
  };

  try {
    const result = await runAgyTurn({
      config: app.config,
      cwd: app.cwd,
      message: content,
      context,
      effort: app.config.effort,
      mode: app.mode === 'plan' ? 'plan' : 'auto',
      resume: app.session.agy ?? {},
      signal,
      hooks,
    });
    app.session.agy = result.resume;
    if (!result.ok) throw new Error(result.text);
    if (!streamed.trim() && result.text) ui.onText?.(result.text);
    ui.onAssistantEnd?.({ text: result.text, calls: 0 });
    agent.messages.push({ role: 'assistant', content: result.text || streamed });
  } catch (error) {
    // Interrumpido con trabajo hecho: queda en el historial lo que alcanzo a decir.
    if (error.name === 'AbortError' && turn.acted) agent.messages.push({ role: 'assistant', content: streamed || '(interrumpido)' });
    throw error;
  } finally {
    for (const view of steps.values()) ui.onToolEnd?.(view, { summary: 'listo' });
    agent.controller = null;
  }
}
