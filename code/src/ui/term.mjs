// Terminal: colores de la marca, ancho visible de texto (ansi y caracteres anchos) y ajuste de lineas.

const env = process.env;
const NO_COLOR = 'NO_COLOR' in env || env.TERM === 'dumb' || !process.stdout.isTTY;
const TRUECOLOR = !NO_COLOR && (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit' || 'WT_SESSION' in env || process.platform === 'win32' || /kitty|wezterm|iterm|vscode|ghostty|alacritty/i.test(env.TERM_PROGRAM ?? env.TERM ?? ''));

// Paleta azul de hacksllm, con tonos que se leen en fondo oscuro y claro.
export const PALETTE = {
  brand: '#5f9be0',
  sky: '#8cc4f2',
  ice: '#bfe0fb',
  deep: '#3d74c4',
  ink: '#2f3b6b',
  soft: '#8a90b2',
  mint: '#7fd1b0',
  butter: '#f3dd8f',
  blush: '#f39ac0',
  danger: '#ef8a8a',
  plum: '#b08ae0',
  white: '#ffffff',
  add: '#173d2c',
  del: '#4a1f2b',
};

const hex = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
const cube = (value) => {
  const [r, g, b] = hex(value).map((channel) => Math.round((channel / 255) * 5));
  return 16 + 36 * r + 6 * g + b;
};
const code = (open, close) => (text) => (NO_COLOR ? String(text) : `\x1b[${open}m${text}\x1b[${close}m`);
const rgb = (value, ground) => (TRUECOLOR ? `${ground};2;${hex(value).join(';')}` : `${ground};5;${cube(value)}`);

export const fg = (value) => code(rgb(PALETTE[value] ?? value, 38), 39);
export const bg = (value) => code(rgb(PALETTE[value] ?? value, 48), 49);
export const bold = code(1, 22);
export const dim = code(2, 22);
export const italic = code(3, 23);
export const underline = code(4, 24);
export const strike = code(9, 29);
export const inverse = code(7, 27);

export const c = {
  brand: fg('brand'),
  sky: fg('sky'),
  ice: fg('ice'),
  deep: fg('deep'),
  soft: fg('soft'),
  ok: fg('mint'),
  warn: fg('butter'),
  err: fg('danger'),
  pink: fg('blush'),
  plum: fg('plum'),
};

export const colorEnabled = !NO_COLOR;
export const truecolor = TRUECOLOR;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export const strip = (text) => String(text).replace(ANSI, '');

// Ancho de un caracter en celdas: 0 para marcas combinantes, 2 para anchos de Asia oriental y simbolos graficos.
export function charWidth(point) {
  if (point < 32 || (point >= 0x7f && point < 0xa0)) return 0;
  if ((point >= 0x300 && point <= 0x36f) || (point >= 0x200b && point <= 0x200f) || (point >= 0xfe00 && point <= 0xfe0f)) return 0;
  if (
    (point >= 0x1100 && point <= 0x115f) ||
    (point >= 0x2e80 && point <= 0xa4cf) ||
    (point >= 0xac00 && point <= 0xd7a3) ||
    (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe30 && point <= 0xfe4f) ||
    (point >= 0xff00 && point <= 0xff60) ||
    (point >= 0xffe0 && point <= 0xffe6) ||
    (point >= 0x1f300 && point <= 0x1faff) ||
    (point >= 0x20000 && point <= 0x3fffd)
  )
    return 2;
  return 1;
}

export function width(text) {
  let total = 0;
  for (const char of strip(text)) total += charWidth(char.codePointAt(0));
  return total;
}

// Recorre un texto con ansi entregando trozos {esc} o {char, w}.
function* units(text) {
  let last = 0;
  for (const match of String(text).matchAll(ANSI)) {
    for (const char of text.slice(last, match.index)) yield { char, w: charWidth(char.codePointAt(0)) };
    yield { esc: match[0] };
    last = match.index + match[0].length;
  }
  for (const char of String(text).slice(last)) yield { char, w: charWidth(char.codePointAt(0)) };
}

// Corta a un ancho visible conservando los codigos de color.
export function truncate(text, cols, tail = '…') {
  if (width(text) <= cols) return text;
  let out = '';
  let used = 0;
  for (const unit of units(text)) {
    if (unit.esc) out += unit.esc;
    else if (used + unit.w > cols - width(tail)) break;
    else (out += unit.char), (used += unit.w);
  }
  return `${out}\x1b[0m${tail}`;
}

export const pad = (text, cols) => text + ' '.repeat(Math.max(0, cols - width(text)));

// Ajusta una linea con ansi a un ancho, cortando por espacios; `indent` se antepone a las lineas siguientes.
export function wrap(text, cols, indent = '') {
  if (cols < 8 || width(text) <= cols) return [text];
  const lines = [];
  let line = '';
  let used = 0;
  let word = '';
  let wordWidth = 0;
  let active = '';
  const limit = () => cols - (lines.length ? width(indent) : 0);
  const flush = () => {
    lines.push(line);
    line = indent + active;
    used = 0;
  };
  const place = () => {
    if (used + wordWidth > limit() && used > 0) {
      line = line.replace(/ +$/, '');
      flush();
      word = word.replace(/^ +/, '');
      wordWidth = width(word);
    }
    while (wordWidth > limit()) {
      // Palabra mas larga que la linea: se parte a lo bruto.
      let piece = '';
      let pieceWidth = 0;
      for (const unit of units(word)) {
        if (unit.esc) piece += unit.esc;
        else if (pieceWidth + unit.w <= limit() - used) (piece += unit.char), (pieceWidth += unit.w);
        else break;
      }
      line += piece;
      flush();
      word = word.slice(piece.length);
      wordWidth = width(word);
    }
    line += word;
    used += wordWidth;
    word = '';
    wordWidth = 0;
  };
  for (const unit of units(text)) {
    if (unit.esc) {
      word += unit.esc;
      active = unit.esc === '\x1b[0m' ? '' : active + unit.esc;
      continue;
    }
    if (unit.char === ' ' && wordWidth > 0 && !word.endsWith(' ')) place();
    word += unit.char;
    wordWidth += unit.w;
  }
  place();
  lines.push(line);
  return lines;
}

export const cols = () => Math.max(20, process.stdout.columns || 100);
export const rows = () => Math.max(10, process.stdout.rows || 30);

// Degradado horizontal entre dos colores, letra a letra.
export function gradient(text, from = PALETTE.sky, to = PALETTE.deep) {
  if (NO_COLOR) return text;
  const [a, b] = [hex(from), hex(to)];
  const chars = [...text];
  return chars
    .map((char, index) => {
      const t = chars.length > 1 ? index / (chars.length - 1) : 0;
      const mix = a.map((channel, i) => Math.round(channel + (b[i] - channel) * t));
      return fg(`#${mix.map((n) => n.toString(16).padStart(2, '0')).join('')}`)(char);
    })
    .join('');
}

// Brillo que recorre el texto (para el indicador de trabajo).
export function shimmer(text, tick, base = PALETTE.brand, light = PALETTE.ice) {
  if (NO_COLOR) return text;
  const chars = [...text];
  const at = tick % (chars.length + 12) - 6;
  return chars.map((char, index) => fg(Math.abs(index - at) < 3 ? light : base)(char)).join('');
}

export function hyperlink(url, text = url) {
  return NO_COLOR ? text : `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

// Enlaces en texto plano: http(s)://... y tambien las direcciones de hacksllm sin el https (bichi.hacks.win/mi-web).
export const URL_SOURCE = String.raw`(?:https?:\/\/|\b(?:bichi|llm)\.hacks\.win)[^\s<>()\[\]` + '`"\']*';
const URL_PATTERN = new RegExp(URL_SOURCE, 'g');
export const isUrl = (text) => new RegExp(`^${URL_SOURCE}$`).test(text);
const trimUrl = (url) => url.replace(/[.,;:!?]+$/, ''); // el punto final de la frase no es parte del link
export const linkStyle = (url, label = url) => hyperlink(/^https?:/.test(url) ? url : `https://${url}`, c.sky(label));

// Pinta los links de un texto (azules, subrayados y clicables) y el resto con `color`.
export function linkify(text, color = (part) => part) {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (match.index > last) out += color(text.slice(last, match.index));
    out += linkStyle(url);
    last = match.index + url.length;
  }
  return out + (last < text.length ? color(text.slice(last)) : '');
}
