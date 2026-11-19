// Editor de la caja de entrada: texto multilinea, cursor, historial y pegados grandes resumidos.
import { charWidth, width } from './term.mjs';

const BIG_PASTE = { chars: 1200, lines: 12 };

export class Editor {
  constructor(history = []) {
    this.text = '';
    this.cursor = 0;
    this.history = history;
    this.hIndex = history.length;
    this.draft = '';
    this.pastes = new Map();
  }

  set(text, cursor = text.length) {
    this.text = text;
    this.cursor = Math.max(0, Math.min(cursor, text.length));
    this.anchor = null;
  }

  // Seleccion: del ancla (donde empezo) al cursor. null si no hay.
  selection() {
    if (this.anchor === null || this.anchor === undefined || this.anchor === this.cursor) return null;
    return [Math.min(this.anchor, this.cursor), Math.max(this.anchor, this.cursor)];
  }

  selectedText() {
    const range = this.selection();
    return range ? this.text.slice(...range) : '';
  }

  deleteSelection() {
    const range = this.selection();
    this.anchor = null;
    if (!range) return false;
    this.text = this.text.slice(0, range[0]) + this.text.slice(range[1]);
    this.cursor = range[0];
    return true;
  }

  insert(text) {
    this.deleteSelection();
    this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    this.cursor += text.length;
  }

  // Un pegado largo se muestra como una marca y se expande al enviar.
  paste(text) {
    const lines = text.split('\n').length;
    if (text.length < BIG_PASTE.chars && lines < BIG_PASTE.lines) return this.insert(text);
    const tag = `[pegado #${this.pastes.size + 1} +${lines} lineas]`;
    this.pastes.set(tag, text);
    this.insert(tag);
  }

  value() {
    let out = this.text;
    for (const [tag, content] of this.pastes) out = out.replace(tag, content);
    return out;
  }

  clear() {
    this.set('');
    this.pastes.clear();
    this.hIndex = this.history.length;
  }

  backspace() {
    if (!this.cursor) return;
    // Borra una marca de pegado entera.
    for (const tag of this.pastes.keys()) {
      if (this.text.slice(0, this.cursor).endsWith(tag)) {
        this.text = this.text.slice(0, this.cursor - tag.length) + this.text.slice(this.cursor);
        this.cursor -= tag.length;
        this.pastes.delete(tag);
        return;
      }
    }
    const step = this.text.codePointAt(this.cursor - 2) > 0xffff ? 2 : 1;
    this.text = this.text.slice(0, this.cursor - step) + this.text.slice(this.cursor);
    this.cursor -= step;
  }

  del() {
    if (this.cursor >= this.text.length) return;
    this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
  }

  left() {
    this.cursor = Math.max(0, this.cursor - 1);
  }

  right() {
    this.cursor = Math.min(this.text.length, this.cursor + 1);
  }

  lineStart() {
    return this.text.lastIndexOf('\n', this.cursor - 1) + 1;
  }

  lineEnd() {
    const end = this.text.indexOf('\n', this.cursor);
    return end < 0 ? this.text.length : end;
  }

  home() {
    this.cursor = this.lineStart();
  }

  end() {
    this.cursor = this.lineEnd();
  }

  wordLeft() {
    const before = this.text.slice(0, this.cursor);
    const match = /\S+\s*$/.exec(before);
    this.cursor = match ? match.index : 0;
  }

  wordRight() {
    const match = /^\s*\S+/.exec(this.text.slice(this.cursor));
    this.cursor += match ? match[0].length : this.text.length - this.cursor;
  }

  deleteWord() {
    const end = this.cursor;
    this.wordLeft();
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
  }

  killToEnd() {
    this.text = this.text.slice(0, this.cursor) + this.text.slice(this.lineEnd());
  }

  killToStart() {
    const start = this.lineStart();
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }

  // Arriba/abajo se mueven entre lineas; en el borde devuelven false para pasar al historial.
  up() {
    const start = this.lineStart();
    if (!start) return false;
    const column = this.cursor - start;
    const prevStart = this.text.lastIndexOf('\n', start - 2) + 1;
    this.cursor = Math.min(prevStart + column, start - 1);
    return true;
  }

  down() {
    const end = this.lineEnd();
    if (end >= this.text.length) return false;
    const column = this.cursor - this.lineStart();
    const nextEnd = this.text.indexOf('\n', end + 1);
    this.cursor = Math.min(end + 1 + column, nextEnd < 0 ? this.text.length : nextEnd);
    return true;
  }

  historyPrev() {
    if (!this.hIndex) return;
    if (this.hIndex === this.history.length) this.draft = this.text;
    this.hIndex--;
    this.set(this.history[this.hIndex]);
  }

  historyNext() {
    if (this.hIndex >= this.history.length) return;
    this.hIndex++;
    this.set(this.hIndex === this.history.length ? this.draft : this.history[this.hIndex]);
  }

  remember(entry) {
    if (entry.trim() && this.history.at(-1) !== entry) this.history.push(entry);
    if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
    this.hIndex = this.history.length;
  }

  // Parte el texto en filas de `inner` columnas y ubica el cursor. Como un procesador de texto: si la ultima palabra
  // no cabe, baja entera a la fila siguiente (solo una palabra mas larga que la fila se parte).
  // Devuelve rows (texto), starts (indice donde empieza cada fila), ends (si la fila cierra su linea) y cursor.
  layout(inner) {
    const rows = [];
    const starts = [];
    const ends = [];
    let offset = 0;
    for (const line of this.text.split('\n')) {
      let rowStart = 0;
      let used = 0;
      let lastBreak = -1; // donde se puede cortar: justo despues del ultimo espacio de la fila
      for (let j = 0; j < line.length; ) {
        const point = line.codePointAt(j);
        const size = point > 0xffff ? 2 : 1;
        const w = charWidth(point);
        if (used + w > inner && used > 0) {
          // Un espacio que no cabe se queda colgando al final de la fila (no empieza la siguiente).
          const cut = line[j] === ' ' ? j + 1 : lastBreak > rowStart ? lastBreak : j;
          rows.push(line.slice(rowStart, cut));
          starts.push(offset + rowStart);
          ends.push(false);
          rowStart = cut;
          used = width(line.slice(rowStart, j));
          lastBreak = -1;
          if (cut === j + 1) {
            j = cut;
            continue;
          }
        }
        used += w;
        if (line[j] === ' ') lastBreak = j + 1;
        j += size;
      }
      rows.push(line.slice(rowStart));
      starts.push(offset + rowStart);
      ends.push(true);
      offset += line.length + 1;
    }
    // El cursor va en la fila que lo contiene; al final de una fila llena, en una fila nueva debajo.
    let cursor = { row: rows.length - 1, col: 0 };
    for (let r = 0; r < rows.length; r++) {
      const end = starts[r] + rows[r].length;
      if (this.cursor < starts[r] || this.cursor > end || (this.cursor === end && !ends[r])) continue;
      const col = width(this.text.slice(starts[r], this.cursor));
      if (col >= inner && ends[r]) {
        rows.splice(r + 1, 0, '');
        starts.splice(r + 1, 0, end);
        ends.splice(r, 2, false, true);
        cursor = { row: r + 1, col: 0 };
      } else cursor = { row: r, col };
      break;
    }
    return { rows, cursor, starts, ends };
  }

  // Indice del texto en la fila/columna visible de layout(inner) (para poner el cursor con un clic).
  // Se queda en el caracter cuya mitad izquierda se toco; mas alla del final de la fila, al final de la fila.
  positionAt(inner, targetRow, targetCol) {
    const { rows, starts, ends } = this.layout(inner);
    const r = Math.max(0, Math.min(rows.length - 1, targetRow));
    let used = 0;
    let index = starts[r];
    for (const char of rows[r]) {
      const w = charWidth(char.codePointAt(0));
      if (targetCol < used + Math.ceil(w / 2)) return index;
      used += w;
      index += char.length;
    }
    // Fila partida: el final de la fila es el principio de la siguiente, asi que el cursor se queda antes.
    return ends[r] ? index : Math.max(starts[r], index - 1);
  }

  // Palabra que se esta escribiendo (para completar /comandos y @archivos).
  token() {
    const before = this.text.slice(0, this.cursor);
    const match = /(^|\s)([/@][^\s]*)$/.exec(before);
    if (!match) return null;
    return { text: match[2], start: before.length - match[2].length, atStart: match[1] === '' && match.index === 0 };
  }

  replaceToken(token, replacement) {
    this.text = this.text.slice(0, token.start) + replacement + this.text.slice(this.cursor);
    this.cursor = token.start + replacement.length;
  }
}
