// Pantalla: lo impreso queda fijo arriba (historial del terminal) y una zona viva abajo se redibuja
// (indicador de trabajo, linea parcial del stream, caja de entrada, barra de estado).
import { cols, rows, truncate, width } from './term.mjs';

const SYNC_ON = '\x1b[?2026h';
const SYNC_OFF = '\x1b[?2026l';
const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';

export class Screen {
  constructor(stream = process.stdout) {
    this.out = stream;
    this.renderer = null;
    this.widths = []; // ancho visible de cada linea viva dibujada
    this.cursorRow = 0; // fila (dentro de la zona viva) donde quedo el cursor
    this.drawnCols = cols();
    this.timer = null;
    this.paused = false;
    stream.on?.('resize', () => this.render());
  }

  // Filas reales que ocupan las lineas dibujadas con el ancho actual (si el terminal se achico, se partieron).
  rowsAbove() {
    const now = cols();
    let total = 0;
    for (let i = 0; i < this.cursorRow; i++) total += Math.max(1, Math.ceil(this.widths[i] / now) || 1);
    return total;
  }

  eraseCode() {
    if (!this.widths.length) return '';
    const up = this.rowsAbove();
    return `\r${up ? `\x1b[${up}A` : ''}\x1b[J`;
  }

  frame() {
    if (!this.renderer || this.paused) return { text: '', widths: [], cursorRow: 0, cursor: null };
    const columns = cols();
    const { lines = [], cursor = null } = this.renderer(columns) ?? {};
    const max = Math.max(3, rows() - 2);
    const start = Math.max(0, lines.length - max);
    const shown = lines.slice(start).map((line) => truncate(line, columns - 1));
    let text = shown.join('\r\n');
    let cursorRow = shown.length - 1;
    if (cursor && cursor.row - start >= 0) {
      const row = cursor.row - start;
      const back = shown.length - 1 - row;
      text += `${back ? `\x1b[${back}A` : ''}\r${cursor.col ? `\x1b[${cursor.col}C` : ''}`;
      cursorRow = row;
    }
    return { text, widths: shown.map((line) => width(line)), cursorRow, cursor };
  }

  write(before = '') {
    const frame = this.frame();
    const payload = `${SYNC_ON}${HIDE}${this.eraseCode()}${before}${frame.text}${frame.cursor ? SHOW : ''}${SYNC_OFF}`;
    this.widths = frame.widths;
    this.cursorRow = frame.cursorRow;
    this.out.write(payload);
  }

  setLive(renderer) {
    this.renderer = renderer;
    this.render();
  }

  render() {
    clearTimeout(this.timer);
    this.timer = null;
    this.write();
  }

  // Redibujo agrupado: muchas actualizaciones seguidas (stream) se pintan como mucho cada 50 ms.
  schedule() {
    if (!this.timer) this.timer = setTimeout(() => this.render(), 50);
  }

  // Imprime por encima de la zona viva.
  print(text = '') {
    clearTimeout(this.timer);
    this.timer = null;
    const body = String(text).replace(/\r?\n/g, '\r\n');
    this.write(`${body}\x1b[0m\r\n`);
  }

  // Suelta el terminal (para un editor externo o al salir): borra la zona viva y deja el cursor visible.
  release() {
    clearTimeout(this.timer);
    this.out.write(`${this.eraseCode()}${SHOW}`);
    this.widths = [];
    this.cursorRow = 0;
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.render();
  }

  clear() {
    this.out.write('\x1b[2J\x1b[3J\x1b[H');
    this.widths = [];
    this.cursorRow = 0;
    this.render();
  }
}
