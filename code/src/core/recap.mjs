// Despues de un turno, un modelo gratis y rapido (de los de charla, nunca la cuota de codex ni de agy) mira lo que
// paso y devuelve, en una sola llamada: el recap (lo hecho y lo que sigue, para turnos largos) y una sugerencia de lo
// que el usuario probablemente escriba despues (como las de Claude Code). Si no hay nada claro, no sugiere nada.
import { streamChat } from './client.mjs';
import { catalog } from '../providers.mjs';

const PROMPT = `Eres el asistente de una terminal de programacion. Te paso el ultimo turno entre el usuario y el agente.
Responde SOLO un JSON: {"recap": "...", "next": "..."}
- recap: 1 o 2 frases (maximo 40 palabras) en el idioma del usuario: que quedo hecho y, si aplica, que le toca decidir o probar al usuario. Concreto, sin adornos.
- next: el mensaje que el usuario muy probablemente escribira ahora (maximo 8 palabras, en su idioma y su tono, como si lo escribiera el). Solo si es muy probable y util; si no, "".`;

// El modelo para esto: el primero de charla (rapido y gratis); si no hay, ninguno.
const cheapModel = (config) => catalog(config).find((entry) => entry.chat) ?? null;

// Lo esencial del turno: lo que pidio el usuario, lo que hizo el agente (herramientas) y su respuesta final.
function digest(messages, from) {
  const turn = messages.slice(from);
  const ask = turn.find((message) => message.role === 'user' && typeof message.content === 'string')?.content ?? '';
  const actions = turn
    .flatMap((message) => message.tool_calls ?? [])
    .map((call) => {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        /* argumentos rotos */
      }
      return `${call.function.name} ${String(args.path ?? args.command ?? args.pattern ?? args.url ?? '').slice(0, 80)}`.trim();
    })
    .slice(-25);
  const answer = [...turn].reverse().find((message) => message.role === 'assistant' && message.content)?.content ?? '';
  return `USUARIO:\n${String(ask).slice(-1500)}\n\nACCIONES DEL AGENTE:\n${actions.join('\n') || '(ninguna)'}\n\nRESPUESTA FINAL DEL AGENTE:\n${String(answer).slice(-2500)}`;
}

// -> { recap, next } (cadenas, quiza vacias) o null si no se pudo.
export async function recapTurn(config, messages, from) {
  const entry = cheapModel(config);
  if (!entry) return null;
  try {
    const result = await streamChat({
      provider: entry.provider,
      model: entry.id,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: digest(messages, from) },
      ],
      signal: AbortSignal.timeout(25_000),
    });
    const json = /\{[\s\S]*\}/.exec(result.text)?.[0];
    const parsed = JSON.parse(json ?? '{}');
    const clean = (text, max) => String(text ?? '').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
    return { recap: clean(parsed.recap, 400), next: clean(parsed.next, 80).replace(/^["'«]|["'»]$/g, '') };
  } catch {
    return null;
  }
}
