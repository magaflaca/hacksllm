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
  if (outcome.diff && (name === 'edit' || (name === 'write' && !outcome.created))) {
    lines.push(...result([c.soft(outcome.summary), ...renderDiff(outcome.diff, { columns: columns - 6, maxLines: verbose ? 400 : 24 })]));
    return lines;
  }
  if (name === 'shell' && outcome.output !== undefined) {
    const output = outcome.output.split('\n').filter((line, i, all) => line || i < all.length - 1);
    const keep = verbose ? output : output.slice(0, 5);
    const body = keep.length ? keep.map((line) => dim(line.length > columns - 8 ? `${line.slice(0, columns - 9)}…` : line)) : [dim('(sin salida)')];
    if (output.length > keep.length) body.push(c.soft(`… +${output.length - keep.length} lineas (ctrl+o para ver todo)`));
    if (outcome.summary) body.push(outcome.exit ? c.warn(outcome.summary) : c.soft(outcome.summary));
    lines.push(...result(body));
    return lines;
  }
  if (verbose && typeof outcome.content === 'string' && name !== 'write') {
    const body = outcome.content.split('\n').slice(0, 200).map((line) => dim(line));
    lines.push(...result(body));
    return lines;
  }
  lines.push(...result([c.soft(outcome.summary ?? 'listo')]));
  return lines;
}

export function deniedBlock(view, reason) {
  return [toolTitle(view, 'denied'), ...result([c.warn(reason)])];
}

export function reasoningBlock(text, seconds, columns) {
  const head = `${c.plum('»')} ${dim(italic(`penso ${seconds}s`))}`;
  if (!text) return [head];
  return [head, ...text.trim().split('\n').flatMap((line) => wrap(dim(italic(line)), columns - 4)).map((line) => `  ${line}`)];
}

export const notice = (text, color = c.soft) => `${color('  ╰')}  ${color(text)}`;

export const sep = (columns) => c.soft('─'.repeat(Math.min(columns - 1, 100)));

export const keyHint = (keys, label) => `${fg('#a6d2ff')(keys)} ${c.soft(label)}`;
