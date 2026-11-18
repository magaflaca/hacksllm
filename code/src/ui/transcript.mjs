// Historial de la app: bloques que se pintan segun el ancho (se reacomodan al cambiar el tamano), con scroll,
// seleccion con el raton y links clicables.
import { charWidth, inverse, strip, wrap } from './term.mjs';

export class Transcript {
  constructor() {
    this.items = [];
    this.version = 0;
    this.cache = { width: 0, version: -1, lines: [] };
  }

  // render(width) devuelve lineas; gap: lineas en blanco antes del bloque.
  add(render, { gap = 1 } = {}) {
    const item = { render, gap, version: 0, cache: null };
    item.update = () => {
      item.version++;
      this.version++;
    };
    item.remove = () => {
      this.items = this.items.filter((other) => other !== item);
      this.version++;
    };
    this.items.push(item);
    this.version++;
    return item;
  }

  clear() {
    this.items = [];
    this.version++;
  }

  // Bloque que ocupa una linea del historial (para los clics).
  itemAt(line) {
    return this.ranges?.find((range) => line >= range.start && line < range.end)?.item ?? null;
  }

  lines(width) {
    if (this.cache.width === width && this.cache.version === this.version) return this.cache.lines;
    const out = [];
    this.ranges = [];
    for (const item of this.items) {
      if (!item.cache || item.cache.width !== width || item.cache.version !== item.version) {
        let lines;
        try {
          lines = item.render(width) ?? [];
        } catch (error) {
          lines = [`(error al pintar: ${error.message})`];
        }
        // Nada puede pasar del ancho: se parte aqui por si un bloque no lo hizo.
        // Sin caracteres de control sueltos (un \r o un tab romperian la pantalla).
        const clean = (line) => String(line).replace(/\t/g, '  ').replace(/[\x00-\x06\x08\x0b-\x1a\x1c-\x1f\x7f]/g, ''); // \x07 y ESC se quedan: cierran los links
        item.cache = { width, version: item.version, lines: lines.flatMap((line) => wrap(clean(line), width - 1)) };
      }
      if (!item.cache.lines.length) continue;
      if (out.length) for (let i = 0; i < item.gap; i++) out.push('');
      this.ranges.push({ item, start: out.length, end: out.length + item.cache.lines.length });
      out.push(...item.cache.lines);
    }
    this.cache = { width, version: this.version, lines: out };
    return out;
  }
}

// Columna visible -> indice en el texto plano.
function columnIndex(plain, column) {
  let used = 0;
  let index = 0;
  for (const char of plain) {
    if (used >= column) break;
    used += charWidth(char.codePointAt(0));
    index += char.length;
  }
  return index;
}

const ordered = (a, b) => (a.line < b.line || (a.line === b.line && a.col <= b.col) ? [a, b] : [b, a]);

// Pinta la seleccion en negativo (la linea pierde sus colores mientras esta seleccionada).
export function paintSelection(line, lineIndex, selection) {
  if (!selection) return line;
  const [start, end] = ordered(selection.start, selection.end);
  if (lineIndex < start.line || lineIndex > end.line) return line;
  const plain = strip(line);
  const from = lineIndex === start.line ? columnIndex(plain, start.col) : 0;
  const to = lineIndex === end.line ? columnIndex(plain, end.col + 1) : plain.length;
  if (to <= from) return line;
  return plain.slice(0, from) + inverse(plain.slice(from, to)) + plain.slice(to);
}

export function selectedText(lines, selection) {
  const [start, end] = ordered(selection.start, selection.end);
  const out = [];
  for (let i = start.line; i <= end.line; i++) {
    const plain = strip(lines[i] ?? '');
    const from = i === start.line ? columnIndex(plain, start.col) : 0;
    const to = i === end.line ? columnIndex(plain, end.col + 1) : plain.length;
    out.push(plain.slice(from, to).replace(/\s+$/, ''));
  }
  return out.join('\n');
}

// Links OSC 8 de una linea: [{from, to, url}] en columnas.
export function linksIn(line) {
  const links = [];
  let column = 0;
  let current = null;
  const pattern = /\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
  let last = 0;
  const advance = (text) => {
    for (const char of text) column += charWidth(char.codePointAt(0));
  };
  for (const match of line.matchAll(pattern)) {
    advance(line.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[1] === undefined) continue;
    if (match[1]) current = { from: column, url: match[1] };
    else if (current) {
      links.push({ ...current, to: column });
      current = null;
    }
  }
  return links;
}
