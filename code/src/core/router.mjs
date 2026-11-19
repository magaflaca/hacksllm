// Enrutado entre modelos: prueba la cadena en orden y salta al siguiente cuando uno se queda sin cuota, falla o
// devuelve vacio. Recuerda descansos por modelo, el modo de herramientas que funciona y parametros que no acepta.
import { saveState } from '../config.mjs';
import { chain, displayName } from '../providers.mjs';
import { ApiError, streamChat } from './client.mjs';
import { describeTools, parseToolCalls, toTextMessages } from './protocol.mjs';
import { backoff, RETRIES, sleep } from './retry.mjs';

const MINUTE = 60_000;
const OPTIONAL_PARAMS = ['reasoning_effort', 'stream_options', 'parallel_tool_calls', 'max_tokens'];

export class ContextError extends Error {}

export const callId = () => Array.from({ length: 9 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');

function classify(error) {
  const status = error.status ?? 0;
  const text = (error.body ?? error.message ?? '').toLowerCase();
  if (/context|too long|maximum.*tokens|token limit|reduce the length|prompt is too/.test(text) && (status === 400 || status === 413 || status === 422)) return { kind: 'context' };
  const param = OPTIONAL_PARAMS.find((name) => text.includes(name) || (name === 'reasoning_effort' && /reasoning/.test(text)));
  if ((status === 400 || status === 422) && param) return { kind: 'param', param };
  if ((status === 400 || status === 422) && /tool|function/.test(text)) return { kind: 'tools' };
  if (status === 401 || status === 403) return { kind: 'auth', rest: 60 * MINUTE, reason: 'clave rechazada' };
  if (status === 404) return { kind: 'rest', rest: 6 * 60 * MINUTE, reason: 'modelo no disponible' };
  if (status === 402 || status === 429 || /quota|rate.?limit|exhaust|insufficient|credit|too many/.test(text)) return { kind: 'rest', rest: 30 * MINUTE, reason: 'sin cuota' };
  if (status >= 500 || !status) return { kind: 'rest', rest: 2 * MINUTE, reason: status ? `error ${status}` : 'sin conexion' };
  return { kind: 'rest', rest: 5 * MINUTE, reason: `error ${status}` };
}

export class Router {
  constructor({ config, state }) {
    this.config = config;
    this.state = state;
    this.current = null;
  }

  resting(key) {
    return (this.state.cooldowns[key] ?? 0) > Date.now();
  }

  rest(key, ms) {
    this.state.cooldowns[key] = Date.now() + ms;
    saveState(this.state);
  }

  candidates(selection) {
    const list = chain(this.config, selection);
    const awake = list.filter((entry) => !this.resting(entry.key));
    return { list, awake };
  }

  name(entry) {
    return displayName(this.config, entry);
  }

  // messages: historial canonico con el system primero. tools: [{name, description, parameters}].
  // Si todos los modelos fallan por algo pasajero (red, servidor, cuota del momento), se espera y se vuelve a
  // intentar con espera creciente, como Claude Code; onRetry lo cuenta.
  async complete(options) {
    for (let round = 0; ; round++) {
      try {
        return await this.attempt(options);
      } catch (error) {
        if (!error.passing || round >= RETRIES - 1 || options.signal?.aborted) throw error;
        const wait = backoff(round);
        options.onRetry?.({ attempt: round + 1, of: RETRIES, wait, reason: error.reason });
        await sleep(wait, options.signal);
      }
    }
  }

  async attempt({ messages, tools, effort, signal, model, onStart = () => {}, onDelta = () => {}, onSwitch = () => {} }) {
    const { list, awake } = this.candidates(model ?? this.config.model);
    if (!list.length) throw new Error('no hay modelos configurados. usa /config para poner una api key.');
    const queue = awake.length ? awake : [...list].sort((a, b) => (this.state.cooldowns[a.key] ?? 0) - (this.state.cooldowns[b.key] ?? 0)).slice(0, 1);
    const failures = [];
    let passing = true; // todos los fallos fueron pasajeros (no clave mala ni modelo inexistente)
    for (let index = 0; index < queue.length; index++) {
      const entry = queue[index];
      let attempts = 0;
      while (attempts++ < 4) {
        const mode = this.toolMode(entry);
        let streamed = false;
        onStart({ entry, mode, name: this.name(entry) });
        try {
          const result = await this.once({ entry, mode, messages, tools, effort, signal, onDelta: (delta) => ((streamed = true), onDelta(delta)) });
          if (!result.text.trim() && !result.calls.length) throw Object.assign(new ApiError(502, 'respuesta vacia', entry.provider.label), { empty: true });
          this.current = entry;
          return { ...result, entry, name: this.name(entry) };
        } catch (error) {
          if (error.name === 'AbortError' || signal?.aborted) throw Object.assign(new Error('interrumpido'), { name: 'AbortError' });
          const verdict = error.empty ? { kind: 'rest', rest: MINUTE, reason: 'respuesta vacia' } : classify(error);
          const key = entry.key;
          if (verdict.kind === 'context') throw new ContextError(error.message);
          if (verdict.kind === 'param') {
            (this.state.dropped[key] ??= []).push(verdict.param);
            saveState(this.state);
            if (streamed) onSwitch({ from: entry, to: entry, reason: 'reintento', reset: true });
            continue;
          }
          if (verdict.kind === 'tools' && mode === 'native') {
            this.state.toolModes[key] = 'text';
            saveState(this.state);
            if (streamed) onSwitch({ from: entry, to: entry, reason: 'reintento', reset: true });
            continue;
          }
          if (verdict.kind === 'auth' || verdict.reason === 'modelo no disponible') passing = false;
          if (verdict.kind === 'auth') for (const other of list.filter((item) => item.provider.name === entry.provider.name)) this.rest(other.key, verdict.rest);
          else this.rest(key, verdict.rest);
          failures.push(`${this.name(entry)}: ${verdict.reason ?? error.message}`);
          const next = queue.slice(index + 1).find((item) => !this.resting(item.key));
          onSwitch({ from: entry, to: next ?? null, reason: verdict.reason ?? 'fallo', reset: streamed, detail: error.message });
          break;
        }
      }
    }
    throw Object.assign(new Error(`ningun modelo respondio. ${failures.join(' · ')}`), { passing: passing && failures.length > 0, reason: failures.at(-1)?.split(': ').pop() ?? 'fallo' });
  }

  toolMode(entry) {
    const stored = this.state.toolModes[entry.key];
    if (stored) return stored;
    const mode = entry.provider.toolMode ?? 'auto';
    return mode === 'auto' ? 'native' : mode;
  }

  async once({ entry, mode, messages, tools, effort, signal, onDelta }) {
    const dropped = new Set(this.state.dropped[entry.key] ?? []);
    const params = {};
    if (!dropped.has('stream_options')) params.stream_options = { include_usage: true };
    if (effort && !dropped.has('reasoning_effort') && entry.provider.effort !== false) params.reasoning_effort = effort;
    const names = tools.map((tool) => tool.name);
    let payload;
    let toolDefs;
    if (mode === 'text' && tools.length) {
      const [system, ...rest] = messages;
      payload = [{ role: 'system', content: `${system.content}\n\n${describeTools(tools)}` }, ...toTextMessages(rest)];
    } else {
      payload = messages.map((message) =>
        message.role === 'tool' ? { role: 'tool', tool_call_id: message.tool_call_id, content: message.content } : message,
      );
      toolDefs = tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    }
    const result = await streamChat({ provider: entry.provider, model: entry.id, messages: payload, tools: toolDefs, params, signal, onDelta });
    let calls = result.calls;
    let text = result.text;
    // En texto, o si un modelo nativo escribio las llamadas en el texto, se leen de ahi.
    if (!calls.length) {
      const parsed = parseToolCalls(text, names);
      if (parsed.calls.length) {
        calls = parsed.calls;
        text = parsed.text;
      }
    }
    return {
      text,
      reasoning: result.reasoning,
      calls: calls.map((call) => ({ id: callId(), name: call.name, arguments: call.arguments || '{}' })),
      usage: result.usage,
      mode,
      finish: result.finish,
    };
  }
}
