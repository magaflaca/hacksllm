// Markdown a terminal, linea a linea para poder pintar mientras llega el stream.
import { highlight } from './highlight.mjs';
import { bold, c, dim, fg, italic, strike, underline, width, wrap } from './term.mjs';

const codeInline = fg('#a6d2ff');

export function inline(text) {
  const spans = [];
  // Primero el codigo en linea, para que su contenido no se interprete.
  let out = text.replace(/`([^`\n]+)`/g, (_, code) => {
    spans.push(codeInline(code));
    return `\u0000${spans.length - 1}\u0000`;
  });
  out = out
    .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_, a, b) => bold(a ?? b))
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, (_, pre, body) => pre + italic(body))
    .replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, (_, pre, body) => pre + italic(body))
    .replace(/~~([^~\n]+)~~/g, (_, body) => strike(body))
    .replace(/!?\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, url) => `${underline(c.sky(label))} ${dim(`(${url})`)}`)
    .replace(/(^|\s)(https?:\/\/[^\s)]+)/g, (_, pre, url) => pre + underline(c.sky(url)));
  return out.replace(/\u0000(\d+)\u0000/g, (_, index) => spans[Number(index)]);
}

function table(rows, columns) {
  const cells = rows
    .filter((row) => !/^\s*\|?\s*:?-{2,}/.test(row))
    .map((row) =>
      row
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => inline(cell.trim())),
    );
  const count = Math.max(...cells.map((row) => row.length));
  const widths = Array.from({ length: count }, (_, i) => Math.max(3, ...cells.map((row) => width(row[i] ?? ''))));
  const total = widths.reduce((a, b) => a + b + 3, 1);
  if (total > columns) {
    // No cabe: una ficha por fila.
    const head = cells[0];
    return cells.slice(1).flatMap((row) => [...row.map((cell, i) => `  ${c.soft(`${head[i] ?? ''}:`)} ${cell}`), '']);
  }
  const line = (l, m, r) => c.soft(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
  const render = (row, head) => c.soft('│') + widths.map((w, i) => ` ${head ? bold(row[i] ?? '') : (row[i] ?? '')}${' '.repeat(w - width(row[i] ?? ''))} `).join(c.soft('│')) + c.soft('│');
  return [line('┌', '┬', '┐'), render(cells[0], true), line('├', '┼', '┤'), ...cells.slice(1).map((row) => render(row)), line('└', '┴', '┘')];
}

export class Markdown {
  constructor(columns) {
    this.columns = columns;
    this.buffer = '';
    this.fence = null;
    this.tableRows = [];
  }

  // Lineas listas a partir de un trozo nuevo del stream.
  push(text) {
    this.buffer += text;
    const out = [];
    let at;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      out.push(...this.line(this.buffer.slice(0, at)));
      this.buffer = this.buffer.slice(at + 1);
    }
    return out;
  }

  // Lo que queda (linea a medias y tabla pendiente) al terminar.
  end() {
    const out = this.buffer ? this.line(this.buffer) : [];
    this.buffer = '';
    if (this.tableRows.length) out.push(...table(this.tableRows.splice(0), this.columns));
    if (this.fence) {
      this.fence = null;
      out.push(c.soft('╰──'));
    }
    return out;
  }

  // Vista previa de la linea a medias (sin guardarla).
  partial() {
    if (!this.buffer) return '';
    return this.fence ? `${c.soft('│')} ${this.buffer}` : inline(this.buffer);
  }

  line(raw) {
    const out = [];
    const columns = this.columns;
    if (this.tableRows.length && !/^\s*\|/.test(raw)) out.push(...table(this.tableRows.splice(0), columns));
    const fence = /^(\s*)(```|~~~)\s*([\w+-]*)/.exec(raw);
    if (this.fence) {
      if (fence && fence[2] === this.fence.mark) {
        this.fence = null;
        out.push(c.soft('╰──'));
        return out;
      }
      out.push(`${c.soft('│')} ${highlight(raw, this.fence.lang)}`);
      return out;
    }
    if (fence) {
      this.fence = { mark: fence[2], lang: fence[3] };
      out.push(c.soft(`╭── ${fence[3] || 'codigo'}`));
      return out;
    }
    if (/^\s*\|/.test(raw)) {
      this.tableRows.push(raw);
      return out;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      const text = inline(heading[2]);
      out.push(heading[1].length === 1 ? bold(c.brand(text.toUpperCase())) : heading[1].length === 2 ? bold(c.sky(text)) : bold(text));
      return out;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push(c.soft('─'.repeat(Math.min(columns - 2, 48))));
      return out;
    }
    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      out.push(...wrap(inline(quote[1]), columns - 4).map((line) => `${c.soft('▌')} ${italic(line)}`));
      return out;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(raw);
    if (item) {
      const depth = Math.floor(item[1].length / 2);
      const indent = '  '.repeat(depth);
      const ordered = /\d/.test(item[2]);
      let bullet = ordered ? c.brand(item[2]) : c.brand(['•', '◦', '▪'][depth % 3]);
      if (item[3]) bullet = /x/i.test(item[3]) ? c.ok('[x]') : c.soft('[ ]');
      const lead = `${indent}${bullet} `;
      out.push(...wrap(lead + inline(item[4]), columns - 1, ' '.repeat(width(lead))));
      return out;
    }
    out.push(...wrap(inline(raw), columns - 1));
    return out;
  }
}

// Render completo de un texto ya terminado.
export function renderMarkdown(text, columns) {
  const md = new Markdown(columns);
  return [...md.push(`${text}\n`), ...md.end()];
}
