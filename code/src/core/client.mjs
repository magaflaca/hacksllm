// Cliente de chat/completions en stream (OpenAI compatible): texto, razonamiento, llamadas a herramientas y uso.

export class ApiError extends Error {
  constructor(status, body, provider) {
    super(`${provider}: ${status} ${String(body).slice(0, 400)}`);
    this.status = status;
    this.body = String(body);
  }
}

const IDLE_MS = 120_000;

export async function* sse(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      let timer;
      const idle = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ApiError(504, 'el modelo dejo de responder', 'stream')), IDLE_MS);
      });
      const { value, done } = await Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
      if (done) break;
      if (signal?.aborted) break;
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data);
        } catch {
          /* linea rota: se ignora */
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// Llama al modelo y va avisando por onDelta({type: 'text'|'reasoning', text}). Devuelve el mensaje completo.
export async function streamChat({ provider, model, messages, tools, params = {}, signal, onDelta = () => {} }) {
  const body = { model, messages, stream: true, ...params };
  if (tools?.length) body.tools = tools;
  const response = await fetch(`${provider.base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(provider.key ? { authorization: `Bearer ${provider.key}` } : {}),
      'user-agent': 'bichi-code',
      ...(provider.name === 'openrouter' ? { 'x-title': 'bichi code' } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new ApiError(response.status, await response.text().catch(() => ''), provider.label);

  let text = '';
  let reasoning = '';
  let finish = null;
  let usage = null;
  let served = null;
  const calls = [];
  // Algunos modelos piensan dentro de <think>...</think> en el propio texto.
  let thinking = false;
  const emitText = (chunk) => {
    let rest = chunk;
    while (rest) {
      if (thinking) {
        const end = rest.indexOf('</think>');
        const part = end < 0 ? rest : rest.slice(0, end);
        reasoning += part;
        if (part) onDelta({ type: 'reasoning', text: part });
        if (end < 0) return;
        thinking = false;
        rest = rest.slice(end + 8);
      } else {
        const start = rest.indexOf('<think>');
        const part = start < 0 ? rest : rest.slice(0, start);
        if (part && (text || part.trim())) {
          text += part;
          onDelta({ type: 'text', text: part });
        }
        if (start < 0) return;
        thinking = true;
        rest = rest.slice(start + 7);
      }
    }
  };

  for await (const chunk of sse(response, signal)) {
    if (chunk.error) throw new ApiError(chunk.error.code ?? 500, chunk.error.message ?? JSON.stringify(chunk.error), provider.label);
    served ??= chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? choice.message ?? {};
    const thought = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
    if (typeof thought === 'string' && thought) {
      reasoning += thought;
      onDelta({ type: 'reasoning', text: thought });
    }
    if (typeof delta.content === 'string' && delta.content) emitText(delta.content);
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? calls.length;
      calls[index] ??= { id: call.id, name: '', arguments: '' };
      if (call.id) calls[index].id = call.id;
      if (call.function?.name) calls[index].name += call.function.name;
      if (call.function?.arguments) calls[index].arguments += call.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  if (signal?.aborted) throw Object.assign(new Error('interrumpido'), { name: 'AbortError' });
  return { text, reasoning, calls: calls.filter((call) => call?.name), finish, usage, served };
}
