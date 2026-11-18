// Colores de sintaxis para bloques de codigo en el terminal. Un tokenizador por familia de lenguajes.
import { c, fg, italic } from './term.mjs';

const KEYWORDS = new Set(
  (
    'const let var function return if else for while do switch case break continue new class extends import export from default async await ' +
    'try catch finally throw typeof instanceof in of this super yield delete void static get set interface type enum implements public private ' +
    'protected readonly def lambda pass elif with as global nonlocal assert raise is not and or None True False self fn mut pub impl struct trait ' +
    'use mod match loop where func go defer chan package var range select map then fi done esac echo local export package goto'
  ).split(' '),
);
const LITERALS = new Set('true false null undefined nil NaN Infinity None True False'.split(' '));

const HASH_COMMENT = new Set(['py', 'python', 'sh', 'bash', 'zsh', 'shell', 'yaml', 'yml', 'toml', 'rb', 'ruby', 'ps1', 'powershell', 'r', 'dockerfile', 'makefile', 'ini', 'conf']);

const paint = {
  comment: (t) => italic(fg('#7f86aa')(t)),
  string: fg('#8fd6a8'),
  keyword: fg('#d29bf0'),
  literal: fg('#f2a76b'),
  number: fg('#f2a76b'),
  func: fg('#7fb8f0'),
  type: fg('#f3dd8f'),
  tag: fg('#f39ac0'),
  attr: fg('#c4a6f5'),
  prop: fg('#9fd8f2'),
};

function tokenizer(lang) {
  const hash = HASH_COMMENT.has(lang);
  const comment = hash ? String.raw`#[^\n]*` : String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->`;
  return new RegExp(
    [
      `(?<comment>${comment})`,
      String.raw`(?<string>\`(?:\\[\s\S]|[^\`\\])*\`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")`,
      String.raw`(?<tag></?[A-Za-z][\w-]*)`,
      String.raw`(?<number>\b0x[\da-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)`,
      String.raw`(?<word>[A-Za-z_$][\w$-]*)`,
    ].join('|'),
    'g',
  );
}

const cache = new Map();

export function highlight(code, lang = '') {
  lang = lang.toLowerCase();
  if (lang === 'diff' || lang === 'patch') {
    return code
      .split('\n')
      .map((line) => (line.startsWith('+') ? c.ok(line) : line.startsWith('-') ? c.err(line) : line.startsWith('@@') ? c.plum(line) : line))
      .join('\n');
  }
  if (!lang || lang === 'text' || lang === 'txt' || lang === 'plain') return code;
  if (!cache.has(lang)) cache.set(lang, tokenizer(lang));
  const pattern = cache.get(lang);
  const markup = /^(html|xml|svg|vue|jsx|tsx)$/.test(lang);
  let out = '';
  let last = 0;
  pattern.lastIndex = 0;
  for (const match of code.matchAll(pattern)) {
    out += code.slice(last, match.index);
    const text = match[0];
    const { comment, string, tag, number, word } = match.groups;
    if (comment !== undefined) out += paint.comment(text);
    else if (string !== undefined) out += paint.string(text);
    else if (tag !== undefined) out += markup ? paint.tag(text) : text;
    else if (number !== undefined) out += paint.number(text);
    else if (word !== undefined) {
      const after = code[match.index + text.length];
      const before = code[match.index - 1];
      if (KEYWORDS.has(word)) out += paint.keyword(text);
      else if (LITERALS.has(word)) out += paint.literal(text);
      else if (after === '(') out += paint.func(text);
      else if (before === '.') out += paint.prop(text);
      else if (markup && after === '=') out += paint.attr(text);
      else if (/^[A-Z][a-z]/.test(word)) out += paint.type(text);
      else out += text;
    }
    last = match.index + text.length;
  }
  return out + code.slice(last);
}
