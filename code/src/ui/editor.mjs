// Editor de la caja de entrada: texto multilinea, cursor, historial y pegados grandes resumidos.
import { charWidth } from './term.mjs';

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

  // Parte el texto en filas de `inner` columnas y ubica el cursor.
  layout(inner) {
    const rows = [];
    const starts = []; // indice del texto donde empieza cada fila
    let cursor = { row: 0, col: 0 };
    let offset = 0;
    for (const line of this.text.split('\n')) {
      let row = '';
      let used = 0;
      let index = offset;
      const place = () => {
        if (index === this.cursor) cursor = { row: rows.length, col: used };
      };
      for (const char of line) {
        const w = charWidth(char.codePointAt(0));
        if (used + w > inner) {
          rows.push(row);
          starts.push(index - row.length);
          row = '';
          used = 0;
        }
        place();
        row += char;
        used += w;
        index += char.length;
      }
      if (used >= inner && index === this.cursor) {
        rows.push(row);
        starts.push(index - row.length);
        row = '';
        used = 0;
      }
      place();
      rows.push(row);
      starts.push(index - row.length);
      offset = index + 1;
    }
    return { rows, cursor, starts };
  }

  // Indice del texto en la fila/columna visible de layout(inner) (para poner el cursor con un clic).
  // Se queda en el caracter cuya mitad izquierda se toco; mas alla del final de la fila, al final de la fila.
  positionAt(inner, targetRow, targetCol) {
    let row = 0;
    let offset = 0;
    let best = null;
    for (const line of this.text.split('\n')) {
      let used = 0;
      let index = offset;
      for (const char of line) {
        const w = charWidth(char.codePointAt(0));
        if (used + w > inner) {
          if (row === targetRow) return index;
          row++;
          used = 0;
        }
        if (row === targetRow && targetCol < used + Math.ceil(w / 2)) return index;
        used += w;
        index += char.length;
      }
      if (row === targetRow) return index;
      if (used >= inner && index === this.cursor) row++; // igual que layout: fila extra solo con el cursor ahi
      best = index;
      row++;
      offset = index + 1;
    }
    return best ?? this.text.length;
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
