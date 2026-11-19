// Pantalla de `bichi --resume`: ocupa toda la terminal, con buscador y la lista de conversaciones para retomar.
// Escribir filtra, flechas o raton eligen, enter retoma, ctrl+a alterna entre esta carpeta y todos los proyectos.
import { ago } from '../core/sessions.mjs';
import { Editor } from './editor.mjs';
import { bold, c, dim, pad, truncate, width } from './term.mjs';

const size = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

export class ResumePicker {
  constructor({ here, all, cwd }) {
    Object.assign(this, { here, all, cwd });
    this.everything = !here.length;
    this.search = new Editor();
    this.index = 0;
    this.scroll = 0;
    this.rows = [];
    this.done = null;
    this.promise = new Promise((resolve) => (this.done = resolve));
  }

  list() {
    const query = this.search.text.toLowerCase();
    const source = this.everything ? this.all : this.here;
    return source.filter((session) => !query || `${session.title} ${session.cwd}`.toLowerCase().includes(query));
  }

  key(key) {
    const list = this.list();
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return this.done(null);
    if (key.name === 'enter') return list[this.index] ? this.done(list[this.index].id) : null;
    if (key.name === 'up') this.index = Math.max(0, this.index - 1);
    else if (key.name === 'down') this.index = Math.min(list.length - 1, this.index + 1);
    else if (key.name === 'pageup') this.index = Math.max(0, this.index - 5);
    else if (key.name === 'pagedown') this.index = Math.min(list.length - 1, this.index + 5);
    else if (key.ctrl && key.name === 'a') {
      this.everything = !this.everything;
      this.index = 0;
    } else if (key.name === 'backspace') {
      this.search.backspace();
      this.index = 0;
    } else if (key.ctrl && key.name === 'u') {
      this.search.clear();
      this.index = 0;
    } else if (key.name === 'paste') this.search.insert(key.paste.replace(/\s+/g, ' '));
    else if (key.text && !key.ctrl && !key.meta) {
      this.search.insert(key.text);
      this.index = 0;
    }
  }

  // Fila de pantalla -> conversacion (para clic y raton encima).
  at(row) {
    return this.rows.find((entry) => row >= entry.from && row <= entry.to)?.index ?? -1;
  }

  render(W, H) {
    const lines = [''];
    lines.push(`  ${bold(c.brand('Retomar conversacion'))}${c.soft(this.everything ? '  · todos los proyectos' : '  · esta carpeta')}`);
    const boxWidth = Math.min(W - 4, 100);
    const query = this.search.text;
    lines.push(`  ${c.soft(`╭${'─'.repeat(boxWidth - 2)}╮`)}`);
    const searchRow = lines.length;
    lines.push(`  ${c.soft('│')} ${c.brand('›')} ${query ? truncate(query, boxWidth - 8) : dim('Buscar…')}${' '.repeat(Math.max(0, boxWidth - 5 - width(query || 'Buscar…')))}${c.soft('│')}`);
    lines.push(`  ${c.soft(`╰${'─'.repeat(boxWidth - 2)}╯`)}`);
    lines.push('');
    const list = this.list();
    this.index = Math.max(0, Math.min(this.index, list.length - 1));
    const room = Math.max(3, Math.floor((H - lines.length - 3) / 3));
    if (this.index < this.scroll) this.scroll = this.index;
    if (this.index >= this.scroll + room) this.scroll = this.index - room + 1;
    this.rows = [];
    if (!list.length) lines.push(`    ${dim(this.search.text ? 'nada coincide' : this.everything ? 'aun no hay conversaciones' : 'no hay conversaciones en esta carpeta · ctrl+a para ver todas')}`);
    list.slice(this.scroll, this.scroll + room).forEach((session, offset) => {
      const index = this.scroll + offset;
      const active = index === this.index;
      const from = lines.length;
      lines.push(`  ${active ? c.brand('❯') : ' '} ${active ? bold(c.sky(truncate(session.title ?? session.id, W - 8))) : truncate(session.title ?? session.id, W - 8)}`);
      const where = this.everything ? ` · ${session.cwd ?? ''}` : '';
      lines.push(`    ${dim(truncate(`${ago(session.updated)} · ${session.count} mensajes · ${size(session.size ?? 0)}${where}`, W - 8))}`);
      lines.push('');
      this.rows.push({ index, from, to: from + 1 });
    });
    if (list.length > this.scroll + room) lines.push(`    ${dim(`… ${list.length - this.scroll - room} mas (flechas o rueda)`)}`);
    while (lines.length < H - 1) lines.push('');
    lines.length = H - 1;
    lines.push(`  ${dim(`ctrl+a ${this.everything ? 'solo esta carpeta' : 'todos los proyectos'} · enter retomar · esc conversacion nueva`)}`);
    return { lines: lines.map((line) => pad(line, 0)), cursor: { row: searchRow, col: 6 + width(query) } };
  }
}
