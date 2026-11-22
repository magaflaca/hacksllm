// Motores del agente, en orden de preferencia. Cada uno traduce su salida a eventos comunes:
// { type: 'resume', id } | { type: 'step', id, kind, label, state } | { type: 'text', delta } | { type: 'final', text }
// | { type: 'fail', message }. Ningun evento nombra el modelo.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const RUNNER = ['sudo', '-n', '/usr/local/bin/bichi-run'];
export const QUOTA = /quota|exhaust|rate.?limit|429|resource_exhausted|capacity|too many/i;

// Cuanto falta para que vuelva la cuota, si el mensaje lo dice ("reset after 2h17m46s", "retry in 41.2s",
// "retry-after: 120", "resets in 3 hours"). Devuelve ms o null.
export function waitFrom(text) {
  const source = String(text ?? '');
  const span = /(?:reset|retry|try again|available)\w*\s+(?:after|in)\s+((?:\d+(?:\.\d+)?\s*(?:h|hours?|m|min(?:utes?)?|s|sec(?:onds?)?)\s*,?\s*(?:and\s*)?)+)/i.exec(source);
  if (span) {
    let ms = 0;
    for (const [, amount, unit] of span[1].matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s)/gi)) ms += Number(amount) * { h: 3600_000, m: 60_000, s: 1000 }[unit.toLowerCase()];
    if (ms) return ms;
  }
  const after = /retry-after\D{0,4}(\d+)/i.exec(source);
  return after ? Number(after[1]) * 1000 : null;
}

const AGY_KINDS = [
  [/browser|url|web/, 'web'],
  [/write|create_file/, 'write'],
  [/edit|replace|patch/, 'edit'],
  [/read|view/, 'read'],
  [/command|terminal|shell/, 'run'],
  [/list|find|grep|search|glob/, 'search'],
];
const OPENCODE_KINDS = { write: 'write', edit: 'edit', patch: 'edit', multiedit: 'edit', read: 'read', bash: 'run', glob: 'search', grep: 'search', list: 'search', webfetch: 'web', websearch: 'web' };

const kindOf = (name) => AGY_KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? 'other';
const labelOf = (input = {}) => input.CommandLine ?? input.command ?? input.Path ?? input.filePath ?? input.AbsolutePath ?? input.path ?? input.Url ?? input.url ?? input.pattern ?? input.Query ?? '';

export function* parseAgy(event) {
  if (event.event === 'init') return yield { type: 'resume', id: event.conversation_id };
  if (event.event === 'result') {
    const { status, response } = event.result;
    // agy a veces cierra con ERROR aunque termino y contesto (un paso suyo fallo por el camino): si hay respuesta y
    // no es de cuota, vale como final. Repetirlo con otro modelo haria el trabajo dos veces.
    const usable = status === 'SUCCESS' || (String(response ?? '').trim() && !QUOTA.test(response));
    return yield usable ? { type: 'final', text: response ?? '' } : { type: 'fail', message: `${status} ${response ?? ''}` };
  }
  if (event.event === 'error' || event.error) return yield { type: 'fail', message: JSON.stringify(event.error ?? event) };
  const step = event.step_update;
  if (!step) return;
  if (step.step_type === 'agent_response' && step.text_delta) yield { type: 'text', delta: step.text_delta };
  const label = labelOf(step.tool_info?.parameters);
  if (step.step_type === 'tool' && label) {
    yield {
      type: 'step',
      id: `a${step.step_index}`,
      kind: kindOf(step.tool_name),
      label,
      state: step.state === 'DONE' ? 'done' : step.state === 'ACTIVE' ? 'active' : 'failed',
    };
  }
}

function* parseOpencode(event) {
  if (event.sessionID) yield { type: 'resume', id: event.sessionID };
  const part = event.part ?? {};
  if (event.type === 'text' && part.text) yield { type: 'text', delta: `${part.text}\n\n` };
  if (event.type === 'tool_use') {
    const status = part.state?.status;
    yield {
      type: 'step',
      id: part.id,
      kind: OPENCODE_KINDS[part.tool] ?? 'other',
      label: labelOf(part.state?.input),
      state: status === 'completed' ? 'done' : status === 'error' ? 'failed' : 'active',
    };
  }
  if (event.type === 'error') yield { type: 'fail', message: JSON.stringify(event.error ?? event) };
}

export const ENGINES = [
  { key: 'flash', runner: 'agy', model: (effort) => `gemini-3.8-flash-${effort}`, parse: parseAgy },
  { key: 'oss', runner: 'agy', model: () => 'gpt-oss-120b-medium', parse: parseAgy },
  { key: 'omni', runner: 'opencode', model: () => 'hacksllm/nemotron-3-ultra', parse: parseOpencode, collectsFinal: true },
];

const cooldown = new Map();
export const available = () => ENGINES.filter((engine) => (cooldown.get(engine.key) ?? 0) < Date.now());
export const rest = (engine, quota) => cooldown.set(engine.key, Date.now() + (quota ? 30 : 3) * 60_000);

export const runner = (...args) => spawn(RUNNER[0], [...RUNNER.slice(1), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });

// Corre un turno con un motor. Devuelve { ok, final, quota } y emite los eventos por onEvent.
export function runEngine(engine, { session, effort, resume, prompt, onEvent, signal }) {
  return new Promise((resolve) => {
    const child = runner(engine.runner, session, engine.model(effort), resume ?? '-');
    child.stdin.end(prompt);
    let final = null;
    let failure = '';
    let text = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      for (const out of engine.parse(event)) {
        if (out.type === 'final') final = out.text;
        else if (out.type === 'fail') failure = out.message;
        else {
          if (out.type === 'text') text += out.delta;
          onEvent(out);
        }
      }
    });
    const abort = () => runner('stop', session);
    signal.addEventListener('abort', abort, { once: true });
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (engine.collectsFinal && !failure && code === 0) final = text.trim();
      const ok = final !== null && !failure && code === 0;
      const reason = failure || stderr || `salida ${code}`;
      resolve({ ok, final: final ?? text, reason, quota: QUOTA.test(reason) });
    });
  });
}
