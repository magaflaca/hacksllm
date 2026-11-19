// Bucle del agente: pide al modelo, ejecuta las herramientas que pida (con permisos) y repite hasta la respuesta final.
import { rm, writeFile } from 'node:fs/promises';
import { invalidate } from '../tools/files.mjs';
import { schema, toolset } from '../tools/index.mjs';
import { runHooks } from './hooks.mjs';
import { decide, ruleFor } from './permissions.mjs';
import { loadAgents } from './project.mjs';
import { looksLikeCall, parseArgs, toTextMessages, visiblePrefix } from './protocol.mjs';
import { systemPrompt } from './prompt.mjs';
import { ContextError } from './router.mjs';
import { skillTool } from './skills.mjs';

const MAX_STEPS = 150;
const MAX_RESULT = 30_000;
const KEEP_RESULTS = 8; // resultados de herramientas recientes que van completos al modelo
const OLD_RESULT = 1_500; // los mas viejos se recortan a esto
const PARALLEL = new Set(['read', 'net']);

const clip = (text) => (text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n(… recortado, ${text.length} caracteres)` : text);
export const estimateTokens = (messages) => Math.ceil(JSON.stringify(messages).length / 3.6);

export class Agent {
  constructor({ config, state, router, cwd, ui = {}, settings = {}, extraTools = [], sub = null, mode = () => 'normal', sessionRules = new Set() }) {
    Object.assign(this, { config, state, router, cwd, ui, settings, extraTools, sub, sessionRules });
    this.getMode = mode;
    this.messages = [];
    this.todos = [];
    this.queue = [];
    this.turns = []; // por turno: {index del mensaje, archivos antes de cambiarlos} para /undo y rebobinar
    this.goal = null; // {text, done, rounds}
    this.subagents = 0;
    this.usage = { prompt: 0, completion: 0, lastPrompt: 0 };
    this.readFiles = new Set();
    this.busy = false;
    this.controller = null;
  }

  tools() {
    const allow = this.sub?.tools ?? null;
    const extra = [...this.extraTools, skillTool, ...(this.goal && !this.goal.done && !this.sub ? [goalDone] : [])];
    return toolset({ extra, sub: !!this.sub, allow, plan: this.getMode() === 'plan' });
  }

  system() {
    return systemPrompt({ cwd: this.cwd, effort: this.config.effort, mode: this.getMode(), sub: this.sub, goal: this.sub ? null : this.goal });
  }

  contextLimit() {
    return this.router.current?.context ?? 128000;
  }

  contextUsed() {
    return this.usage.lastPrompt || estimateTokens(this.payload()) + 3500;
  }

  // Un mensaje mientras trabaja: entra en el siguiente paso (redirigir sin cortar).
  steer(text) {
    this.queue.push(text);
  }

  interrupt() {
    this.controller?.abort();
  }

  async send(content) {
    this.messages.push({ role: 'user', content });
    this.turns.push({ index: this.messages.length - 1, files: new Map() });
    this.busy = true;
    this.controller = new AbortController();
    try {
      return await this.loop(this.controller.signal);
    } finally {
      this.busy = false;
      this.controller = null;
    }
  }

  checkpoint(file, before) {
    const turn = this.turns.at(-1);
    if (turn && !turn.files.has(file)) turn.files.set(file, before);
  }

  async restore(turns) {
    const touched = new Set();
    for (const turn of [...turns].reverse()) {
      for (const [file, before] of turn.files) {
        if (before === null) await rm(file, { force: true });
        else await writeFile(file, before);
        touched.add(file);
      }
    }
    invalidate();
    return [...touched];
  }

  // Deshace los cambios en archivos del ultimo turno que toco archivos.
  async undo() {
    while (this.turns.length) {
      const turn = this.turns.pop();
      if (turn.files.size) return this.restore([turn]);
    }
    return [];
  }

  // Archivos cambiados desde el mensaje `index` (para ofrecer restaurar el codigo al rebobinar).
  changedSince(index) {
    return this.turns.filter((turn) => turn.index >= index && turn.files.size);
  }

  // Vuelve la conversacion (y si se pide, el codigo) al punto antes del mensaje `index`.
  async rewind(index, { code = false } = {}) {
    const later = this.turns.filter((turn) => turn.index >= index);
    const files = code ? await this.restore(later) : [];
    this.turns = this.turns.filter((turn) => turn.index < index);
    this.messages.splice(index);
    this.usage.lastPrompt = 0;
    return files;
  }

  async loop(signal) {
    let compacted = false;
    let malformed = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.queue.length) {
        const text = this.queue.splice(0).join('\n\n');
        this.ui.onSteer?.(text);
        this.messages.push({ role: 'user', content: `(mensaje del usuario mientras trabajabas; tenlo en cuenta desde ya)\n${text}` });
      }
      if (!this.sub && this.config.autoCompact !== false && this.contextUsed() > this.contextLimit() * 0.75) {
        await this.compact('', signal);
      }
      const tools = this.tools();
      let result;
      try {
        result = await this.request(tools, signal);
      } catch (error) {
        if (error instanceof ContextError && !compacted) {
          compacted = true;
          await this.compact('', signal);
          step--;
          continue;
        }
        throw error;
      }
      const { text, calls } = result;
      if (result.malformed && malformed++ < 2) {
        this.ui.onNotice?.('la llamada a la herramienta llego mal escrita; se la pido de nuevo al modelo');
        this.messages.push(
          { role: 'assistant', content: text.length > 1500 ? `${text.slice(0, 600)}\n…\n${text.slice(-400)}` : text },
          {
            role: 'user',
            content:
              '(nota del sistema) Tu ultima respuesta parece una llamada a herramienta pero no se pudo leer (JSON invalido, bloque sin cerrar o formato distinto), asi que NO se ejecuto nada y el archivo sigue igual. Repite la llamada con el formato exacto: <tool name="...">{json valido}</tool>, con los saltos de linea escapados como \\n dentro de los strings. Si el archivo es largo, usa edit con cambios pequenos en vez de reescribirlo entero. Si no querias llamar a ninguna herramienta, responde de nuevo en texto normal.',
          },
        );
        step--;
        continue;
      }
      if (result.malformed) {
        // Ya se pidio dos veces: se ensena tal cual para que el usuario vea que paso.
        this.ui.onText?.(text);
        this.ui.onAssistantEnd?.({ text, calls: 0 });
      }
      this.messages.push({
        role: 'assistant',
        content: text || (calls.length ? '' : '(sin respuesta)'),
        ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}),
      });
      if (!calls.length) {
        if (this.queue.length) continue;
        if (!this.sub) {
          const stop = await runHooks(this.settings, 'stop', { text }, this.cwd);
          if (stop.blocked) {
            this.messages.push({ role: 'user', content: `(hook stop) ${stop.blocked}` });
            continue;
          }
        }
        return { text, steps: step };
      }
      await this.runCalls(calls, tools, signal);
      if (signal.aborted) throw Object.assign(new Error('interrumpido'), { name: 'AbortError' });
    }
    this.ui.onNotice?.('llegue al limite de pasos seguidos; escribe "sigue" para continuar.');
    return { text: '', steps: MAX_STEPS };
  }

  // Lo que va al modelo: los resultados de herramientas viejos van recortados (el historial guarda todo).
  payload() {
    const toolIndexes = this.messages.map((message, index) => (message.role === 'tool' ? index : -1)).filter((index) => index >= 0);
    const old = new Set(toolIndexes.slice(0, -KEEP_RESULTS));
    return this.messages.map((message, index) =>
      old.has(index) && message.content.length > OLD_RESULT
        ? { ...message, content: `${message.content.slice(0, OLD_RESULT)}
(… resultado antiguo recortado para ahorrar contexto; vuelve a ejecutar la herramienta si lo necesitas)` }
        : message,
    );
  }

  async request(tools, signal) {
    const messages = [{ role: 'system', content: this.system() }, ...this.payload()];
    let shown = 0;
    let raw = '';
    const result = await this.router.complete({
      messages,
      tools: tools.map(schema),
      effort: this.config.effort,
      signal,
      model: this.sub?.model ?? undefined,
      onStart: (info) => {
        raw = '';
        shown = 0;
        this.ui.onModel?.(info);
      },
      onSwitch: (info) => {
        raw = '';
        shown = 0;
        this.ui.onSwitch?.(info);
      },
      onRetry: (info) => this.ui.onRetry?.(info),
      onDelta: (delta) => {
        if (delta.type === 'reasoning') return this.ui.onReasoning?.(delta.text);
        raw += delta.text;
        // Solo se muestra el texto que no es parte de un bloque de herramienta.
        const visible = visiblePrefix(raw);
        if (visible.length > shown) {
          this.ui.onText?.(visible.slice(shown));
          shown = visible.length;
        }
      },
    });
    if (result.usage) {
      this.usage.prompt += result.usage.prompt_tokens ?? 0;
      this.usage.completion += result.usage.completion_tokens ?? 0;
      this.usage.lastPrompt = result.usage.prompt_tokens ?? 0;
    } else this.usage.lastPrompt = 0;
    // Una llamada a herramienta que no se pudo leer no se ensena como respuesta: se quita lo mostrado y se pide otra vez.
    if (!result.calls.length && looksLikeCall(result.text)) {
      this.ui.onSwitch?.({ from: result.entry, to: result.entry, reason: 'reintento', reset: true });
      return { ...result, malformed: true };
    }
    // Si el texto final (sin llamadas) es mas largo que lo mostrado, se completa.
    if (result.text.length > shown) this.ui.onText?.(result.text.slice(shown));
    this.ui.onAssistantEnd?.({ text: result.text, calls: result.calls.length });
    return result;
  }

  async runCalls(calls, tools, signal) {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const results = new Array(calls.length);
    let index = 0;
    while (index < calls.length) {
      // Lecturas y subagentes seguidos van en paralelo; lo demas de uno en uno.
      const tool = byName.get(calls[index].name);
      const parallel = tool && (PARALLEL.has(tool.kind) || tool.name === 'task');
      let end = index + 1;
      if (parallel) while (end < calls.length && (PARALLEL.has(byName.get(calls[end].name)?.kind) || calls[end].name === 'task')) end++;
      const batch = calls.slice(index, end).map((call, offset) => this.execute(call, byName, signal).then((value) => (results[index + offset] = value)));
      await Promise.all(batch);
      index = end;
      if (signal.aborted) break;
    }
    calls.forEach((call, i) => {
      this.messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: results[i] ?? '(interrumpido por el usuario)' });
    });
  }

  async execute(call, byName, signal) {
    const tool = byName.get(call.name);
    const input = parseArgs(call.arguments);
    if (!tool) {
      const names = [...byName.keys()].join(', ');
      return `error: no existe la herramienta "${call.name}". disponibles: ${names}`;
    }
    if (input.__raw !== undefined) return `error: los argumentos no son JSON valido: ${input.__raw.slice(0, 200)}`;
    const ctx = this.context(signal, call);
    const view = { id: call.id, tool, input, label: safeLabel(tool, input, ctx), sub: this.sub?.label ?? null };
    const refusal = await this.permit(tool, input, view, ctx);
    if (refusal) return refusal;

    this.ui.onToolStart?.(view);
    const started = Date.now();
    try {
      const result = await tool.run(input, ctx);
      const post = await runHooks(this.settings, 'post_tool', { tool: tool.name, input }, this.cwd);
      this.ui.onToolEnd?.(view, { ...result, ms: Date.now() - started });
      return clip(String(result.content ?? '') + (post.output ? `\n\n(hook) ${post.output}` : ''));
    } catch (error) {
      if (signal.aborted) {
        this.ui.onToolEnd?.(view, { error: 'interrumpido', ms: Date.now() - started });
        return '(interrumpido por el usuario)';
      }
      this.ui.onToolEnd?.(view, { error: error.message, ms: Date.now() - started });
      return `error: ${error.message}`;
    }
  }

  // Hooks y permisos de una accion (herramientas del modelo y lo que pide agy en su modo). Devuelve null si se puede
  // hacer, o el motivo para el modelo si no.
  async permit(tool, input, view, ctx) {
    const pre = await runHooks(this.settings, 'pre_tool', { tool: tool.name, input }, this.cwd);
    if (pre.blocked) {
      this.ui.onToolDenied?.(view, pre.blocked);
      return `bloqueado por un hook: ${pre.blocked}`;
    }
    const { verdict, reason } = decide({ tool, input, mode: this.getMode(), settings: this.settings, session: this.sessionRules });
    if (verdict === 'deny') {
      this.ui.onToolDenied?.(view, reason);
      return `no permitido: ${reason}`;
    }
    if (verdict !== 'ask') return null;
    if (!this.ui.permission) return 'no permitido: no hay nadie para aprobarlo (usa --yolo o el modo edits)';
    const preview = tool.preview ? await tool.preview(input, ctx).catch(() => null) : null;
    const answer = await this.ui.permission(view, preview, ruleFor(tool, input));
    if (answer.choice === 'always') this.sessionRules.add(ruleFor(tool, input));
    if (answer.choice === 'project') this.ui.allowProject?.(ruleFor(tool, input));
    if (answer.choice !== 'no') return null;
    this.ui.onToolDenied?.(view, answer.feedback ? `no: ${answer.feedback}` : 'el usuario dijo que no');
    return answer.feedback ? `el usuario rechazo esta accion y dice: ${answer.feedback}` : 'el usuario rechazo esta accion. pregunta que prefiere o sigue por otro camino.';
  }

  context(signal, call) {
    return {
      cwd: this.cwd,
      signal,
      config: this.config,
      agent: this,
      readFiles: this.readFiles,
      checkpoint: (file, before) => this.checkpoint(file, before),
      progress: (output) => this.ui.onToolProgress?.(call.id, output),
      ui: this.ui,
      spawn: (spec) => this.spawn(spec, call, signal),
    };
  }

  // Subagente con su propio historial; comparte permisos, modo y checkpoints con este.
  async spawn({ prompt, agent: kind, description }, call, signal) {
    const custom = kind && kind !== 'general' ? loadAgents(this.cwd).find((agent) => agent.name === kind) : null;
    const label = description ?? custom?.name ?? 'subagente';
    let tools = 0;
    const started = Date.now();
    const parentUi = this.ui;
    const child = new Agent({
      config: this.config,
      state: this.state,
      router: this.router,
      cwd: this.cwd,
      settings: this.settings,
      extraTools: this.extraTools,
      mode: this.getMode,
      sessionRules: this.sessionRules,
      sub: { label, prompt: custom?.prompt ?? '', tools: custom?.tools ?? null, model: custom?.model ?? null },
      ui: {
        permission: parentUi.permission,
        allowProject: parentUi.allowProject,
        onToolStart: (view) => {
          tools++;
          parentUi.onSubActivity?.(call.id, view);
        },
        onToolEnd: () => {},
        onToolDenied: (view, reason) => parentUi.onSubActivity?.(call.id, view, reason),
        onSwitch: (info) => parentUi.onSwitch?.({ ...info, quiet: true }),
      },
    });
    child.turns = this.turns;
    child.messages.push({ role: 'user', content: prompt });
    child.controller = { abort() {} };
    this.subagents++;
    this.ui.onSubagents?.(this.subagents);
    let result;
    try {
      result = await child.loop(signal);
    } finally {
      this.subagents--;
      this.ui.onSubagents?.(this.subagents);
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    return { text: result.text, summary: `${tools} ${tools === 1 ? 'herramienta' : 'herramientas'} · ${seconds}s` };
  }

  // Resume la conversacion para liberar contexto, con los modelos gratis de la cadena. Si resumir falla, recorta
  // lo mas viejo para que el trabajo nunca se quede atascado por falta de contexto.
  async compact(instructions = '', signal) {
    if (this.messages.length < 3) return false;
    this.ui.onCompact?.('start');
    const lastUser = this.messages.findLastIndex((message) => message.role === 'user' && typeof message.content === 'string');
    const keepFrom = lastUser > 0 && JSON.stringify(this.messages.slice(lastUser)).length < 40_000 ? lastUser : this.messages.length;
    const older = this.payload().slice(0, keepFrom);
    let transcript = toTextMessages(older)
      .map((message) => `## ${message.role === 'user' ? 'usuario' : 'bichi'}\n${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`)
      .join('\n\n');
    if (transcript.length > 220_000) transcript = `${transcript.slice(0, 30_000)}\n\n(… parte intermedia omitida …)\n\n${transcript.slice(-180_000)}`;
    const request = `Resume esta conversacion de programacion para continuarla sin perder nada importante: objetivo del usuario, decisiones tomadas, archivos tocados (con rutas) y su estado, comandos utiles, errores pendientes y el siguiente paso. Se concreto y completo, en el idioma de la conversacion.${instructions ? ` Ademas: ${instructions}` : ''}\n\n<conversacion>\n${transcript}\n</conversacion>`;
    let summary;
    try {
      const result = await this.router.complete({
        messages: [{ role: 'system', content: 'Eres un asistente que resume conversaciones de programacion con precision.' }, { role: 'user', content: request }],
        tools: [],
        signal: signal ?? new AbortController().signal,
      });
      summary = result.text.trim();
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      summary = null;
    }
    const todos = this.todos.length ? `\n\nLista de tareas actual:\n${this.todos.map((item) => `- [${item.status}] ${item.content}`).join('\n')}` : '';
    const recent = this.messages.slice(keepFrom);
    if (summary) {
      this.messages = [
        { role: 'user', content: `(Esta conversacion se resumio para liberar contexto. Resumen:)

${summary}${todos}` },
        { role: 'assistant', content: 'Entendido, sigo desde aqui.' },
        ...recent,
      ];
    } else {
      // Sin resumen: se queda el primer pedido y el ultimo tercio, cortando en un mensaje del usuario.
      const first = this.messages.find((message) => message.role === 'user');
      const cut = this.messages.findIndex((message, index) => index >= Math.floor(this.messages.length * 0.66) && message.role === 'user' && typeof message.content === 'string');
      const tail = cut > 0 ? this.messages.slice(cut) : recent;
      this.messages = [
        { role: 'user', content: `(Se recorto la conversacion para liberar contexto. El pedido original era:)

${typeof first?.content === 'string' ? first.content.slice(0, 4000) : ''}${todos}` },
        { role: 'assistant', content: 'Entendido, sigo desde aqui.' },
        ...tail,
      ];
    }
    this.turns = [];
    this.usage.lastPrompt = 0;
    this.ui.onCompact?.('end', summary);
    return true;
  }
}

// Herramienta para cerrar un objetivo de /goal.
const goalDone = {
  name: 'goal_done',
  kind: 'meta',
  description: 'Marca como cumplido el objetivo activo (/goal). Llamala solo cuando este completo y verificado, con un resumen de lo logrado.',
  parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  label: () => ({ title: 'Objetivo cumplido', arg: '' }),
  async run(input, ctx) {
    if (ctx.agent.goal) ctx.agent.goal.done = String(input.summary ?? '');
    return { content: 'objetivo marcado como cumplido', summary: String(input.summary ?? '').slice(0, 160) || 'listo' };
  },
};

function safeLabel(tool, input, ctx) {
  try {
    return tool.label(input, ctx);
  } catch {
    return { title: tool.name, arg: '' };
  }
}
