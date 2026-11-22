// Cliente de la API Responses en stream (la que usa Codex). Recibe el historial canonico de bichi (formato de chat
// con tool_calls y role tool) y lo traduce a items de Responses; devuelve lo mismo que streamChat, mas `replay`: el
// razonamiento cifrado del modelo, que se guarda con el mensaje y se le devuelve en las siguientes peticiones para
// que siga el hilo de lo que pensaba (como hace Codex, sin guardar nada en el servidor).
import { ApiError, sse } from './client.mjs';

const userParts = (content) =>
  typeof content === 'string'
    ? [{ type: 'input_text', text: content }]
    : content.map((part) => (part.type === 'image_url' ? { type: 'input_image', image_url: part.image_url?.url ?? part.image_url } : { type: 'input_text', text: String(part.text ?? '') }));

// Historial de bichi -> { instructions, input }.
export function toResponses(messages) {
  let instructions = '';
  const input = [];
  for (const message of messages) {
    if (message.role === 'system') instructions += (instructions ? '\n\n' : '') + message.content;
    else if (message.role === 'user') input.push({ type: 'message', role: 'user', content: userParts(message.content) });
    else if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: String(message.content ?? '') });
    else if (message.role === 'assistant') {
      input.push(...(message.replay ?? []));
      if (message.content) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: String(message.content) }] });
      for (const call of message.tool_calls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments || '{}' });
    }
  }
  return { instructions, input };
}

export async function streamResponses({ provider, model, messages, tools, effort, cacheKey, signal, onDelta = () => {} }) {
  const { instructions, input } = toResponses(messages);
  const body = {
    model,
    instructions,
    input,
    tools: (tools ?? []).map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { effort: effort ?? 'medium', summary: 'auto' },
    include: ['reasoning.encrypted_content'],
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
  };
  const response = await fetch(`${provider.base.replace(/\/$/, '')}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.key}`, 'user-agent': 'bichi-code' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message = text;
    try {
      message = JSON.parse(text).error?.message ?? text;
    } catch {
      /* no era json */
    }
    throw new ApiError(response.status, message, provider.label);
  }

  let text = '';
  let reasoning = '';
  let usage = null;
  let finish = 'stop';
  let served = null;
  const calls = [];
  const replay = [];
  let summaryIndex = -1;
  for await (const event of sse(response, signal)) {
    switch (event.type) {
      case 'response.output_text.delta':
        text += event.delta;
        onDelta({ type: 'text', text: event.delta });
        break;
      case 'response.reasoning_summary_text.delta': {
        // Cada parte del resumen del razonamiento empieza en un parrafo nuevo.
        const lead = event.summary_index !== summaryIndex && reasoning ? '\n\n' : '';
        summaryIndex = event.summary_index;
        reasoning += lead + event.delta;
        onDelta({ type: 'reasoning', text: lead + event.delta });
        break;
      }
      case 'response.output_item.done': {
        const item = event.item ?? {};
        if (item.type === 'function_call') calls.push({ id: item.call_id, name: item.name, arguments: item.arguments ?? '{}' });
        else if (item.type === 'reasoning' && item.encrypted_content) replay.push({ type: 'reasoning', summary: item.summary ?? [], encrypted_content: item.encrypted_content });
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const done = event.response ?? {};
        served = done.model ?? served;
        if (event.type === 'response.incomplete') finish = 'length';
        const used = done.usage;
        if (used) usage = { prompt_tokens: used.input_tokens ?? 0, completion_tokens: used.output_tokens ?? 0, cached_tokens: used.input_tokens_details?.cached_tokens ?? 0 };
        break;
      }
      case 'response.failed':
        throw new ApiError(500, event.response?.error?.message ?? 'la respuesta fallo', provider.label);
      case 'error':
        throw new ApiError(event.status ?? 500, event.message ?? event.error?.message ?? 'error del modelo', provider.label);
      default:
        break;
    }
  }
  if (signal?.aborted) throw Object.assign(new Error('interrumpido'), { name: 'AbortError' });
  if (calls.length) finish = 'tool_calls';
  return { text, reasoning, calls, finish, usage, served, replay };
}
