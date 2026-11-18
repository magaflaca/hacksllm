// Protocolo de herramientas en texto, para modelos sin tool calling: las herramientas se describen en el prompt
// y el modelo las llama escribiendo <tool name="...">{json}</tool>. Tambien entiende variantes comunes.

export function describeTools(tools) {
  const lines = tools.map((tool) => {
    const { properties = {}, required = [] } = tool.parameters ?? {};
    const args = Object.entries(properties)
      .map(([name, spec]) => `    - ${name}${required.includes(name) ? '' : ' (opcional)'}: ${spec.type ?? 'any'}${spec.description ? `, ${spec.description}` : ''}`)
      .join('\n');
    return `## ${tool.name}\n${tool.description}\n${args ? `  argumentos:\n${args}` : '  sin argumentos'}`;
  });
  return `# Como usar herramientas
Para usar una herramienta escribe un bloque exactamente asi (los argumentos en JSON valido):

<tool name="read">
{"path": "src/app.js"}
</tool>

Puedes poner varios bloques seguidos en la misma respuesta si son independientes. Despues de tus bloques
deja de escribir: el resultado de cada herramienta te llegara en el siguiente mensaje dentro de <result>.
No inventes resultados ni escribas <result> tu mismo. Cuando ya no necesites herramientas, responde normal.

# Herramientas disponibles
${lines.join('\n\n')}`;
}

function parseArgs(raw) {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    try {
      // Comas colgantes y comillas simples: arreglos baratos.
      return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return { __raw: text };
    }
  }
}

// Busca llamadas en el texto. Devuelve {calls, text} con el texto antes de la primera llamada.
export function parseToolCalls(text, names) {
  const known = new Set(names);
  const calls = [];
  let first = Infinity;
  const take = (index, name, raw) => {
    first = Math.min(first, index);
    calls.push({ index, name, arguments: raw });
  };
  for (const match of text.matchAll(/<tool\s+name=["']?([\w.:-]+)["']?\s*>([\s\S]*?)<\/tool>/g)) take(match.index, match[1], match[2]);
  for (const match of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    const body = parseArgs(match[1]);
    if (body?.name) take(match.index, body.name, JSON.stringify(body.arguments ?? body.parameters ?? {}));
  }
  // <read>{...}</read> con el nombre de la herramienta como etiqueta.
  for (const match of text.matchAll(/<([\w.:-]+)>\s*(\{[\s\S]*?\})\s*<\/\1>/g)) {
    if (known.has(match[1]) && !calls.some((call) => call.index === match.index)) take(match.index, match[1], match[2]);
  }
  calls.sort((a, b) => a.index - b.index);
  return {
    calls: calls.map(({ name, arguments: raw }) => ({ name, arguments: typeof raw === 'string' ? raw : JSON.stringify(raw) })),
    text: calls.length ? text.slice(0, first).trimEnd() : text,
  };
}

export { parseArgs };

// Mientras llega el stream: hasta donde se puede mostrar el texto sin enseñar un bloque de herramienta a medias.
export function visiblePrefix(text) {
  const open = text.search(/<(tool|tool_call)[\s>]|<\w[\w.:-]*>\s*\{/);
  if (open >= 0) return text.slice(0, open);
  const partial = text.lastIndexOf('<');
  if (partial >= 0 && text.length - partial < 24 && !text.slice(partial).includes('>')) return text.slice(0, partial);
  return text;
}

// Convierte el historial canonico (formato OpenAI con tool_calls y role tool) a texto plano para el protocolo.
export function toTextMessages(messages) {
  const out = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const blocks = message.tool_calls.map((call) => `<tool name="${call.function.name}">\n${call.function.arguments || '{}'}\n</tool>`);
      out.push({ role: 'assistant', content: [message.content, ...blocks].filter(Boolean).join('\n\n') });
    } else if (message.role === 'tool') {
      const block = `<result name="${message.name ?? 'tool'}">\n${message.content}\n</result>`;
      const last = out.at(-1);
      if (last?.role === 'user' && last.toolResults) last.content += `\n\n${block}`;
      else out.push({ role: 'user', content: block, toolResults: true });
    } else if (message.role === 'user' && out.at(-1)?.toolResults) {
      out.at(-1).content += `\n\n${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`;
    } else out.push({ role: message.role, content: message.content ?? '' });
  }
  return out.map(({ role, content }) => ({ role, content }));
}
