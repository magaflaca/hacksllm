import { h, copyText } from '../core/dom.js';
import { icon } from '../art/pixels.js';
import { sound } from '../core/sound.js';

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))/g;
const BLOCK_START = /^(```|#{1,6}\s|>\s?|\s*[-*+]\s|\s*\d+[.)]\s|\|.*\|\s*$|-{3,}\s*$)/;

export function inline(text) {
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    nodes.push(text.slice(last, match.index));
    const [token, code, bold, italic, link, href] = match;
    if (code) nodes.push(h('code', {}, code.slice(1, -1)));
    else if (bold) nodes.push(h('strong', {}, ...inline(bold.slice(2, -2))));
    else if (italic) nodes.push(h('em', {}, italic.slice(1, -1)));
    else if (link) nodes.push(h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, link.slice(1, link.indexOf(']('))));
    last = match.index + token.length;
  }
  nodes.push(text.slice(last));
  return nodes.filter(Boolean);
}

export function codeBlock(code, language = '') {
  const copy = h('button.code-copy', { type: 'button', 'aria-label': 'Copiar codigo', title: 'Copiar' }, icon('copy'));
  copy.addEventListener('click', async () => {
    await copyText(code);
    sound.play('copy');
    copy.replaceChildren(icon('check'));
    setTimeout(() => copy.replaceChildren(icon('copy')), 1400);
  });
  return h('figure.code.px', {}, h('figcaption', {}, h('span', {}, language || 'texto'), copy), h('pre', {}, h('code', {}, code)));
}

const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());

function table(lines) {
  const [head, , ...rows] = lines;
  return h(
    'div.table-wrap',
    {},
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, cells(head).map((cell) => h('th', {}, ...inline(cell))))),
      h('tbody', {}, rows.map((row) => h('tr', {}, cells(row).map((cell) => h('td', {}, ...inline(cell)))))),
    ),
  );
}

const takeWhile = (lines, start, test) => {
  let end = start;
  while (end < lines.length && test(lines[end])) end++;
  return [lines.slice(start, end), end];
};

export function markdown(source) {
  const lines = source.replace(/\r/g, '').split('\n');
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    if (line.startsWith('```')) {
      const [body, end] = takeWhile(lines, index + 1, (next) => !next.startsWith('```'));
      blocks.push(codeBlock(body.join('\n'), line.slice(3).trim()));
      index = end + 1;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push(h(`h${Math.min(6, heading[1].length + 2)}`, {}, ...inline(heading[2])));
      index++;
      continue;
    }
    if (/^-{3,}\s*$/.test(line)) {
      blocks.push(h('hr'));
      index++;
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && /^\|?[\s:-]+\|/.test(lines[index + 1] ?? '')) {
      const [rows, end] = takeWhile(lines, index, (next) => /^\|.*\|\s*$/.test(next));
      blocks.push(table(rows));
      index = end;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const [quoted, end] = takeWhile(lines, index, (next) => /^>\s?/.test(next));
      blocks.push(h('blockquote', {}, ...markdown(quoted.map((next) => next.replace(/^>\s?/, '')).join('\n'))));
      index = end;
      continue;
    }
    const ordered = /^\s*\d+[.)]\s/.test(line);
    if (ordered || /^\s*[-*+]\s/.test(line)) {
      const marker = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      const [items, end] = takeWhile(lines, index, (next) => marker.test(next) || (/^\s{2,}\S/.test(next) && !BLOCK_START.test(next.trim())));
      const grouped = items.reduce((list, next) => (marker.test(next) ? list.push(next.replace(marker, '')) : (list[list.length - 1] += ` ${next.trim()}`), list), []);
      blocks.push(h(ordered ? 'ol' : 'ul', {}, grouped.map((item) => h('li', {}, ...inline(item)))));
      index = end;
      continue;
    }
    const [paragraph, end] = takeWhile(lines, index, (next) => next.trim() && !BLOCK_START.test(next));
    const body = (paragraph.length ? paragraph : [line]).flatMap((next, at) => (at ? [h('br'), ...inline(next)] : inline(next)));
    blocks.push(h('p', {}, ...body));
    index = Math.max(end, index + 1);
  }
  return blocks;
}
