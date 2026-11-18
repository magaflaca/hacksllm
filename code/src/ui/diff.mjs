// Diffs de lineas para mostrar los cambios que hace el agente en los archivos.
import { bg, c, dim, fg } from './term.mjs';

// LCS por programacion dinamica con recorte del prefijo y sufijo comunes; suficiente para cambios de una edicion.
export function diffLines(before, after) {
  // Un archivo vacio o nuevo no tiene lineas (no una linea vacia que coincida con las del otro lado).
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ type: ' ', text: a[i], a: i + 1, b: i + 1 });
  if (midA.length * midB.length > 4_000_000) {
    midA.forEach((text, i) => ops.push({ type: '-', text, a: start + i + 1 }));
    midB.forEach((text, i) => ops.push({ type: '+', text, b: start + i + 1 }));
  } else {
    const n = midA.length;
    const m = midB.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) ops.push({ type: ' ', text: midA[i], a: start + ++i, b: start + ++j });
      else if (i < n && (j >= m || table[i + 1][j] >= table[i][j + 1])) ops.push({ type: '-', text: midA[i], a: start + ++i });
      else ops.push({ type: '+', text: midB[j], b: start + ++j });
    }
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push({ type: ' ', text: a[i], a: i + 1, b: j + 1 });
  return ops;
}

export function stats(ops) {
  return { added: ops.filter((op) => op.type === '+').length, removed: ops.filter((op) => op.type === '-').length };
}

const addLine = (text) => bg('add')(fg('#bff0d4')(text));
const delLine = (text) => bg('del')(fg('#ffd0dc')(text));

// Bloques con contexto alrededor de los cambios, con numero de linea.
export function renderDiff(ops, { context = 2, maxLines = 40, columns = 100 } = {}) {
  const changed = ops.map((op, index) => (op.type === ' ' ? -1 : index)).filter((index) => index >= 0);
  if (!changed.length) return [dim('  (sin cambios)')];
  const keep = new Set();
  for (const index of changed) for (let k = index - context; k <= index + context; k++) if (k >= 0 && k < ops.length) keep.add(k);
  const numberWidth = String(ops.length).length + 1;
  const lines = [];
  let last = -1;
  for (const index of [...keep].sort((x, y) => x - y)) {
    if (last >= 0 && index > last + 1) lines.push(c.soft(`${' '.repeat(numberWidth)}  ⋮`));
    last = index;
    const op = ops[index];
    const number = String(op.type === '+' ? op.b : op.a).padStart(numberWidth);
    const body = op.text.replace(/\t/g, '  ').slice(0, Math.max(10, columns - numberWidth - 6));
    if (op.type === '+') lines.push(`${c.soft(number)} ${addLine(`+ ${body}`)}`);
    else if (op.type === '-') lines.push(`${c.soft(number)} ${delLine(`- ${body}`)}`);
    else lines.push(`${c.soft(number)}   ${dim(body)}`);
  }
  if (lines.length > maxLines) {
    const hidden = lines.length - maxLines;
    return [...lines.slice(0, maxLines), c.soft(`${' '.repeat(numberWidth)}  … ${hidden} lineas mas`)];
  }
  return lines;
}
