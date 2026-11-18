// Como se ven en el historial los mensajes, las herramientas y sus resultados.
import { renderDiff } from './diff.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bold, c, dim, fg, hyperlink, italic, wrap } from './term.mjs';

const BAR = c.soft('╰');

export function userBlock(text, columns) {
  const lines = text.split('\n');
  const shown = lines.length > 12 ? [...lines.slice(0, 10), `… ${lines.length - 10} lineas mas`] : lines;
  return shown.flatMap((line, i) => wrap(line, columns - 3).map((part, k) => `${i === 0 && k === 0 ? c.brand('› ') : '  '}${c.ice(part)}`));
}

export function toolTitle(view, state = 'done') {
  const dot = state === 'error' ? c.err('●') : state === 'denied' ? c.warn('●') : state === 'running' ? c.brand('●') : c.ok('●');
  const text = view.label.arg ? c.soft(view.label.arg.length > 160 ? `${view.label.arg.slice(0, 160)}…` : view.label.arg) : '';
  // Las rutas de archivos son links: clic para abrirlas.
  const isFile = ['read', 'write', 'edit'].includes(view.tool?.name) && view.label.arg;
  const arg = text ? ` ${isFile ? hyperlink(pathToFileURL(path.resolve(view.label.arg)).href, text) : text}` : '';
  return `${dot} ${bold(view.label.title)}${arg}`;
}

const result = (lines) => lines.map((line, i) => `  ${i === 0 ? BAR : ' '}  ${line}`);

export function todoLines(todos) {
  return todos.map((item) =>
    item.status === 'completed'
      ? `${c.ok('■')} ${dim(item.content)}`
      : item.status === 'in_progress'
        ? `${c.brand('▣')} ${bold(c.sky(item.content))}`
        : `${c.soft('□')} ${item.content}`,
  );
}

// Bloque final de una herramienta: titulo y resumen del resultado.
export function toolBlock(view, outcome, { columns, verbose }) {
  const lines = [toolTitle(view, outcome.error ? 'error' : 'done')];
  if (outcome.error) {
    lines.push(...result(wrap(c.err(outcome.error), columns - 6).slice(0, 6)));
    return lines;
  }
  const name = view.tool.name;
  if (outcome.todos) {
    lines.push(...result(todoLines(outcome.todos)));
    return lines;
  }
  if (outcome.diff && (name === 'edit' || (name === 'write' && (!outcome.created || verbose)))) {
    lines.push(...result([c.soft(outcome.summary), ...renderDiff(outcome.diff, { columns: columns - 6, maxLines: verbose ? 2000 : 16 })]));
    return lines;
  }
  if (outcome.diff && name === 'write') {
    lines.push(...result([`${c.soft(outcome.summary)} ${dim('· clic para ver')}`]));
    return lines;
  }
  if (name === 'shell' && outcome.output !== undefined) {
    const output = outcome.output.split('\n').filter((line, i, all) => line || i < all.length - 1);
    const keep = verbose ? output.slice(-2000) : output.slice(0, 5);
    const body = keep.length ? keep.map((line) => dim(verbose ? line : line.length > columns - 8 ? `${line.slice(0, columns - 9)}…` : line)) : [dim('(sin salida)')];
    if (output.length > keep.length) body.push(c.soft(`… +${output.length - keep.length} lineas · clic para ver todo`));
    if (outcome.summary) body.push(outcome.exit ? c.warn(outcome.summary) : c.soft(outcome.summary));
    lines.push(...result(body));
    return lines;
  }
  if (verbose && typeof outcome.content === 'string' && name !== 'write') {
    const body = outcome.content.split('\n').slice(0, 2000).map((line) => dim(line));
    lines.push(...result(body));
    return lines;
  }
  const more = typeof outcome.content === 'string' && outcome.content.length > 80 && !outcome.todos ? ` ${dim('· clic para ver')}` : '';
  lines.push(...result([`${c.soft(outcome.summary ?? 'listo')}${more}`]));
  return lines;
}

export function deniedBlock(view, reason) {
  return [toolTitle(view, 'denied'), ...result([c.warn(reason)])];
}

// Razonamiento: plegado muestra cuanto penso; desplegado (clic o ctrl+o), lo que penso.
export function reasoningBlock(text, seconds, columns, expanded = false) {
  const hint = text?.trim() ? dim(expanded ? ' · clic para plegar' : ' · clic para ver') : '';
  const head = `${c.plum('»')} ${dim(italic(`penso ${seconds}s`))}${hint}`;
  if (!expanded || !text?.trim()) return [head];
  return [head, ...text.trim().split('\n').flatMap((line) => wrap(dim(italic(line)), columns - 4)).map((line) => `  ${line}`)];
}

const READ_VERBS = { read: ['leyo', 'archivo', 'archivos'], ls: ['listo', 'carpeta', 'carpetas'], glob: ['busco', 'patron', 'patrones'], grep: ['busco', 'texto', 'textos'], web_fetch: ['abrio', 'pagina', 'paginas'], web_search: ['busco en la web', 'vez', 'veces'] };

// Varias lecturas seguidas se agrupan en una linea ("leyo 4 archivos, busco 2 textos"); clic para verlas.
export function readGroupBlock(entries, columns, expanded) {
  const counts = new Map();
  for (const { view } of entries) counts.set(view.tool.name, (counts.get(view.tool.name) ?? 0) + 1);
  const parts = [...counts].map(([name, count]) => {
    const [verb, one, many] = READ_VERBS[name] ?? ['uso', name, name];
    return `${verb} ${count} ${count === 1 ? one : many}`;
  });
  const failed = entries.some(({ outcome }) => outcome.error);
  const head = `${failed ? c.warn('●') : c.ok('●')} ${bold(parts.join(', ').replace(/^./, (ch) => ch.toUpperCase()))}${dim(expanded ? ' · clic para plegar' : ' · clic para ver')}`;
  if (!expanded) return [head];
  return [head, ...entries.flatMap(({ view, outcome }) => result([`${view.label.title} ${c.soft(view.label.arg ?? '')} ${outcome.error ? c.err(outcome.error) : dim(`· ${outcome.summary ?? 'listo'}`)}`]))];
}

export const READ_TOOLS = new Set(Object.keys(READ_VERBS));

export const notice = (text, color = c.soft) => `${color('  ╰')}  ${color(text)}`;

export const sep = (columns) => c.soft('─'.repeat(Math.min(columns - 1, 100)));

export const keyHint = (keys, label) => `${fg('#a6d2ff')(keys)} ${c.soft(label)}`;
