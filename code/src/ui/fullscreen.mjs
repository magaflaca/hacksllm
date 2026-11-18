// Pantalla completa: bichi toma la terminal entera (buffer alternativo) y la dibuja como una app.
// Cada cuadro es una lista de filas; solo se reescriben las que cambiaron.
import { cols, rows, truncate } from './term.mjs';

const SYNC_ON = '\x1b[?2026h';
const SYNC_OFF = '\x1b[?2026l';
const ENTER = '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[H\x1b[2J';
const LEAVE = '\x1b[?1004l\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?1049l';

export class FullScreen {
  constructor(out = process.stdout) {
    this.out = out;
    this.prev = [];
    this.active = false;
    this.onResize = () => {};
    out.on?.('resize', () => {
      this.prev = [];
      if (this.active) this.out.write('\x1b[2J');
      this.onResize();
    });
  }

  enter() {
    this.active = true;
    this.prev = [];
    this.out.write(ENTER);
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    this.out.write(LEAVE);
  }

  title(text) {
    this.out.write(`\x1b]0;${text}\x07`);
  }

  size() {
    return { width: cols(), height: rows() };
  }

  // frame: filas exactas de la pantalla; cursor: {row, col} o null.
  draw(frame, cursor) {
    if (!this.active) return;
    const width = cols();
    let out = `${SYNC_ON}\x1b[?25l`;
    for (let i = 0; i < frame.length; i++) {
      const line = truncate(frame[i] ?? '', width - 1);
      if (line === this.prev[i]) continue;
      out += `\x1b[${i + 1};1H\x1b[0m${line}\x1b[0m\x1b[K`;
      this.prev[i] = line;
    }
    for (let i = frame.length; i < this.prev.length; i++) out += `\x1b[${i + 1};1H\x1b[K`;
    this.prev.length = frame.length;
    if (cursor) out += `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h`;
    out += SYNC_OFF;
    this.out.write(out);
  }

  // Copia al portapapeles por OSC 52 (funciona tambien por ssh).
  copy(text) {
    this.out.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
  }
}

// Eventos de raton SGR: ESC [ < boton ; x ; y (M|m)
export function parseMouse(sequence) {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(sequence);
  if (!match) return null;
  const code = Number(match[1]);
  const x = Number(match[2]) - 1;
  const y = Number(match[3]) - 1;
  if (code & 64) return { type: code & 1 ? 'wheeldown' : 'wheelup', x, y };
  const button = code & 3;
  if (code & 32) return { type: 'drag', button, x, y };
  return { type: match[4] === 'M' ? 'press' : 'release', button, x, y };
}
