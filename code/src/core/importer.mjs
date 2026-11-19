// Importar conversaciones de Claude Code (~/.claude/projects) y Codex (~/.codex/sessions).
// Se quedan los mensajes y un resumen de cada herramienta usada; si aun asi es enorme (charlas largas con modelos
// grandes), se resume por partes con los modelos gratis para que quepa con holgura en el contexto de bichi.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOURCES = {
  claude: { label: 'Claude Code', root: path.join(os.homedir(), '.claude', 'projects') },
  codex: { label: 'Codex', root: path.join(os.homedir(), '.codex', 'sessions') },
};

export const importSources = () => Object.entries(SOURCES).map(([id, source]) => ({ id, ...source, available: existsSync(source.root) }));

function walk(dir, depth = 0, out = []) {
  if (depth > 4 || !existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1, out);
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

const lines = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const short = (value, max = 160) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

// Texto de un contenido de Claude (string o lista de bloques).
function claudeParts(content) {
  if (typeof content === 'string') return { text: content, tools: [] };
  const text = [];
  const tools = [];
  for (const block of content ?? []) {
    if (block.type === 'text') text.push(block.text);
    else if (block.type === 'tool_use') tools.push(`${block.name} ${short(block.input?.file_path ?? block.input?.command ?? block.input?.pattern ?? block.input?.description ?? block.input, 120)}`);
  }
  return { text: text.join('\n'), tools };
}

function parseClaude(file) {
  const turns = [];
  let cwd = null;
  for (const entry of lines(file)) {
    cwd ??= entry.cwd ?? null;
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    if (entry.isMeta || entry.isSidechain) continue;
    const { text, tools } = claudeParts(entry.message?.content);
    const clean = text.replace(/<(command-[\w-]+|local-command-[\w-]+|system-reminder)>[\s\S]*?<\/\1>/g, '').trim();
    if (entry.type === 'user' && !clean) continue;
    turns.push({ role: entry.type, text: clean, tools });
  }
  return { cwd, turns };
}

function parseCodex(file) {
  const turns = [];
  let cwd = null;
  for (const entry of lines(file)) {
    const item = entry.payload ?? entry;
    if (entry.type === 'session_meta' || item.cwd) cwd ??= item.cwd ?? null;
    if (item.type === 'message') {
      const text = (item.content ?? []).map((part) => part.text ?? '').join('\n').trim();
      if (!text || text.startsWith('<environment_context>') || text.startsWith('<user_instructions>')) continue;
      if (item.role === 'user' || item.role === 'assistant') turns.push({ role: item.role, text, tools: [] });
    } else if (item.type === 'function_call' || item.type === 'local_shell_call' || item.type === 'custom_tool_call') {
      const last = turns.at(-1);
      const call = `${item.name ?? 'shell'} ${short(item.arguments ?? item.action?.command ?? item.input, 120)}`;
      if (last?.role === 'assistant') last.tools.push(call);
      else turns.push({ role: 'assistant', text: '', tools: [call] });
    }
  }
  return { cwd, turns };
}

function firstUser(turns) {
  return (turns.find((turn) => turn.role === 'user' && turn.text)?.text ?? '(sin titulo)').replace(/\s+/g, ' ').slice(0, 80);
}

// Conversaciones disponibles de una fuente, las de esta carpeta primero.
export function listImports(sourceId, cwd) {
  const source = SOURCES[sourceId];
  const files = walk(source.root)
    .map((file) => ({ file, time: statSync(file).mtimeMs, size: statSync(file).size }))
    .filter((entry) => entry.size > 200)
    .sort((a, b) => b.time - a.time)
    .slice(0, 80);
  return files
    .map((entry) => {
      try {
        const parsed = sourceId === 'claude' ? parseClaude(entry.file) : parseCodex(entry.file);
        if (!parsed.turns.some((turn) => turn.role === 'user')) return null;
        const here = parsed.cwd && path.resolve(parsed.cwd) === path.resolve(cwd);
        return { ...entry, cwd: parsed.cwd, title: firstUser(parsed.turns), turns: parsed.turns.length, here };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.here - a.here || b.time - a.time)
    .slice(0, 30);
}

// Turnos de una conversacion: {role, text, tools}.
export const turnsOf = (sourceId, file) => (sourceId === 'claude' ? parseClaude(file) : parseCodex(file)).turns;

// Los turnos como texto para el modelo (es lo que se reduce).
export function transcriptText(turns) {
  return turns
    .map((turn) => {
      const tools = turn.tools.length ? `\n[herramientas: ${turn.tools.slice(0, 12).join(' · ')}${turn.tools.length > 12 ? ` y ${turn.tools.length - 12} mas` : ''}]` : '';
      return `## ${turn.role === 'user' ? 'usuario' : 'asistente'}\n${turn.text}${tools}`.trim();
    })
    .join('\n\n');
}

const CHUNK = 60_000; // caracteres por parte al resumir
const DIRECT = 40_000; // hasta aqui se importa tal cual (unos 11k tokens)

// Reduce una conversacion importada a algo que quepa bien: tal cual si es corta, si no, resumen por partes.
export async function reduceTranscript(router, text, { signal, onProgress = () => {} } = {}) {
  if (text.length <= DIRECT) return { text, summarized: false };
  const parts = [];
  for (let at = 0; at < text.length; at += CHUNK) parts.push(text.slice(at, at + CHUNK));
  const notes = [];
  for (let i = 0; i < parts.length; i++) {
    onProgress(i + 1, parts.length);
    const result = await router.complete({
      messages: [
        { role: 'system', content: 'Resumes conversaciones de programacion para traspasarlas a otro asistente. Conservas lo importante y descartas el ruido.' },
        {
          role: 'user',
          content: `Parte ${i + 1} de ${parts.length} de una conversacion entre un usuario y un asistente de programacion. Resume en espanol: que se pidio, que se decidio, que archivos y comandos importan, que quedo hecho y que quedo pendiente. Conserva rutas, nombres y valores exactos. Maximo 400 palabras.\n\n${parts[i]}`,
        },
      ],
      tools: [],
      signal,
    });
    notes.push(`### parte ${i + 1}\n${result.text.trim()}`);
  }
  if (notes.join('\n\n').length <= DIRECT) return { text: notes.join('\n\n'), summarized: true };
  const merged = await router.complete({
    messages: [
      { role: 'system', content: 'Unes resumenes parciales en uno solo, claro y completo.' },
      { role: 'user', content: `Une estos resumenes en uno solo (maximo 800 palabras), conservando rutas, decisiones y pendientes:\n\n${notes.join('\n\n')}` },
    ],
    tools: [],
    signal,
  });
  return { text: merged.text.trim(), summarized: true };
}
