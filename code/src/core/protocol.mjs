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

// Saltos de linea y tabs literales dentro de strings JSON (los modelos los meten al escribir codigo) se escapan.
function escapeControls(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString && char === '\\') {
      out += char + (text[++i] ?? '');
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString && char < ' ') out += { '\n': '\\n', '\r': '\\r', '\t': '\\t' }[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return out;
}

function parseArgs(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .replace(/<\/?t?o?o?l?>?$/, '') // un </tool> a medias al final
    .trim();
  if (!text) return {};
  const balanced = text.startsWith('{') ? text.slice(0, objectEnd(text, 0)) : '';
  const attempts = [
    ...(balanced ? [balanced, escapeControls(balanced)] : []),
    text,
    text.replace(/,\s*([}\]])/g, '$1'), // comas colgantes
    escapeControls(text),
    text.slice(0, text.lastIndexOf('}') + 1), // basura despues del objeto
    escapeControls(text.slice(0, text.lastIndexOf('}') + 1)),
  ];
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt);
      if (value && typeof value === 'object') return value;
    } catch {
      /* siguiente arreglo */
    }
  }
  return { __raw: text };
}

// Un objeto JSON balanceado que empieza en `start` (respeta strings). Devuelve su fin o -1.
function objectEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

// Busca llamadas en el texto. Devuelve {calls, text} con el texto antes de la primera llamada.
// Ademas del formato pedido entiende las variantes que se ven en la practica: <tool_call>{name, arguments}</tool_call>,
// <write>{...}</write>, <function=write><parameter=path>..., JSON suelto {"name": ..., "arguments": ...} y un
// bloque sin cerrar al final de la respuesta.
export function parseToolCalls(text, names) {
  const known = new Set(names);
  const calls = [];
  let first = Infinity;
  const taken = [];
  const free = (index) => !taken.some(([from, to]) => index >= from && index < to);
  const take = (index, end, name, raw) => {
    if (!free(index)) return;
    first = Math.min(first, index);
    taken.push([index, end]);
    calls.push({ index, name, arguments: raw });
  };
  for (const match of text.matchAll(/<tool\s+name=["']?([\w.:-]+)["']?\s*>([\s\S]*?)<\/tool>/g)) take(match.index, match.index + match[0].length, match[1], match[2]);
  for (const match of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g)) {
    const body = parseArgs(match[1]);
    if (body?.name) take(match.index, match.index + match[0].length, body.name, JSON.stringify(body.arguments ?? body.parameters ?? {}));
  }
  // <read>{...}</read> con el nombre de la herramienta como etiqueta.
  for (const match of text.matchAll(/<([\w.:-]+)>\s*(\{[\s\S]*?\})\s*<\/\1>/g)) {
    if (known.has(match[1])) take(match.index, match.index + match[0].length, match[1], match[2]);
  }
  // Estilo Qwen: <function=write><parameter=path>a.py</parameter>...</function>
  for (const match of text.matchAll(/<function=([\w.:-]+)>([\s\S]*?)(?:<\/function>|$)/g)) {
    const args = {};
    for (const param of match[2].matchAll(/<parameter=([\w-]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) args[param[1]] = param[2];
    if (known.has(match[1])) take(match.index, match.index + match[0].length, match[1], JSON.stringify(args));
  }
  // Un <tool name="x"> que nunca se cerro (el modelo paro antes de </tool>): todo lo que sigue son sus argumentos.
  for (const match of text.matchAll(/<tool\s+name=["']?([\w.:-]+)["']?\s*>/g)) {
    if (!free(match.index)) continue;
    const start = text.indexOf('{', match.index);
    if (start < 0) continue;
    const end = objectEnd(text, start);
    take(match.index, end < 0 ? text.length : end, match[1], text.slice(start, end < 0 ? text.length : end));
  }
  // JSON suelto (o en ```json) con nombre y argumentos de una herramienta conocida.
  for (const match of text.matchAll(/\{\s*"(?:name|tool)"\s*:\s*"([\w.:-]+)"/g)) {
    if (!known.has(match[1]) || !free(match.index)) continue;
    const end = objectEnd(text, match.index);
    const body = parseArgs(text.slice(match.index, end < 0 ? text.length : end));
    const args = body.arguments ?? body.parameters ?? body.input ?? body.args;
    if (args !== undefined) take(match.index, end < 0 ? text.length : end, match[1], typeof args === 'string' ? args : JSON.stringify(args));
  }
  calls.sort((a, b) => a.index - b.index);
  return {
    calls: calls.map(({ name, arguments: raw }) => ({ name, arguments: typeof raw === 'string' ? raw : JSON.stringify(raw) })),
    text: calls.length ? text.slice(0, first).replace(/```(?:json)?\s*$/, '').trimEnd() : text,
  };
}

// Una respuesta sin llamadas que aun asi parece una llamada rota (bloque de herramienta o argumentos JSON de
// edit/write/shell): mejor pedirle al modelo que la repita que mostrarla como respuesta.
export function looksLikeCall(text) {
  return /<tool[\s>]|<tool_call>|<function=/.test(text) || /"(content|old_string|new_string|command|file_path)"\s*:\s*"/.test(text);
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
    } else if (message.role === 'user' && out.at(-1)?.toolResults && typeof message.content === 'string') {
      // Con imagenes (contenido en partes) va como mensaje aparte para no volcar la imagen en el texto.
      out.at(-1).content += `\n\n${message.content}`;
    } else out.push({ role: message.role, content: message.content ?? '' });
  }
  return out.map(({ role, content }) => ({ role, content }));
}
