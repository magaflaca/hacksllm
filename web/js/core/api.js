import { store } from './store.js';

export const API_BASE = `${location.origin}/v1`;
export const DEFAULT_MODEL = 'deepseek-v4.1';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const headers = () => {
  const key = store.get('apiKey', '');
  return { 'Content-Type': 'application/json', ...(key && { Authorization: `Bearer ${key}` }) };
};

async function failure(response) {
  const body = await response.json().catch(() => null);
  const message = body?.error?.message ?? body?.message ?? response.statusText;
  return new ApiError(response.status, typeof message === 'string' ? message : JSON.stringify(message));
}

export async function listModels() {
  const response = await fetch(`${API_BASE}/models`, { headers: headers() });
  if (!response.ok) throw await failure(response);
  const { data } = await response.json();
  return data.map((model) => model.id);
}

async function* sseEvents(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data);
      } catch {}
    }
  }
}

// Emite { content, reasoning } por cada fragmento del stream.
export async function* streamChat({ model, messages, signal }) {
  const response = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!response.ok) throw await failure(response);
  for await (const event of sseEvents(response.body)) {
    if (event.error) throw new ApiError(500, event.error.message ?? 'error del modelo');
    const delta = event.choices?.[0]?.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning ?? '';
    if (delta.content || reasoning) yield { content: delta.content ?? '', reasoning };
  }
}
