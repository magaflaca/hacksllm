// Arte de bichi code: el mismo escarabajo pixel de la web y un logo pixel, pintados con medios bloques.
import { BEETLE_FRAMES, BEETLE_PALETTES } from '../../../web/js/art/beetle.js';
import { LOGO_PALETTE, logoRows } from '../../../web/js/art/letters.js';
import { colorEnabled } from './term.mjs';

const hex = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16)).join(';');
const fgOf = (color) => `\x1b[38;2;${hex(color)}m`;
const bgOf = (color) => `\x1b[48;2;${hex(color)}m`;
const RESET = '\x1b[0m';

// Dos filas de pixeles por linea: la de arriba es el color del caracter y la de abajo el fondo.
export function pixels(rows, colorOf) {
  const lines = [];
  for (let y = 0; y < rows.length; y += 2) {
    let line = '';
    for (let x = 0; x < rows[y].length; x++) {
      const top = colorOf(rows[y][x]);
      const bottom = colorOf(rows[y + 1]?.[x]);
      if (!colorEnabled) line += top || bottom ? '#' : ' ';
      else if (top && bottom) line += `${fgOf(top)}${bgOf(bottom)}▀${RESET}`;
      else if (top) line += `${fgOf(top)}▀${RESET}`;
      else if (bottom) line += `${fgOf(bottom)}▄${RESET}`;
      else line += ' ';
    }
    lines.push(line);
  }
  return lines;
}

export const beetle = (frame = 'idle') => {
  const palette = BEETLE_PALETTES.light;
  return pixels(BEETLE_FRAMES[frame] ?? BEETLE_FRAMES.idle, (key) => (key && key !== '.' ? palette[key] : null));
};

// Logo con degradado vertical (cielo arriba, azul profundo abajo) y sombra de un pixel.
export const logo = (text = 'BICHI CODE') => pixels(logoRows(text), (key) => (key && key !== '.' ? LOGO_PALETTE[key] : null));
