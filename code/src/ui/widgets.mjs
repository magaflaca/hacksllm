// Piezas de interfaz: cajas redondeadas, menus de opciones y campos de texto dentro de la zona viva.
import { Editor } from './editor.mjs';
import { bold, c, dim, fg, pad, truncate, width, wrap } from './term.mjs';

export function box(lines, columns, { title = '', color = c.brand, padX = 1 } = {}) {
  const inner = columns - 2 - padX * 2;
  const top = title ? `╭─ ${title} ${'─'.repeat(Math.max(0, columns - 5 - width(title)))}╮` : `╭${'─'.repeat(columns - 2)}╮`;
  const body = lines.map((line) => `${color('│')}${' '.repeat(padX)}${pad(truncate(line, inner), inner)}${' '.repeat(padX)}${color('│')}`);
  return [color(top.replace(title, '\u0000')).replace('\u0000', bold(title)), ...body, color(`╰${'─'.repeat(columns - 2)}╯`)];
}

// Menu de opciones con flechas, numeros, enter y esc. Resuelve con el valor elegido.
export class Menu {
  constructor({ title = '', body = [], options, escape = null, color = c.brand, footer = '' }) {
    Object.assign(this, { title, body, options, escape, color, footer });
    this.index = Math.max(0, options.findIndex((option) => option.selected));
    this.done = null;
    this.promise = new Promise((resolve) => (this.done = resolve));
  }

  key(key) {
    const count = this.options.length;
    if (key.name === 'up' || (key.ctrl && key.name === 'p')) this.index = (this.index - 1 + count) % count;
    else if (key.name === 'down' || (key.ctrl && key.name === 'n') || key.name === 'tab') this.index = (this.index + 1) % count;
    else if (key.name === 'enter') this.done(this.options[this.index].value);
    else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) this.done(this.escape);
    else if (/^[1-9]$/.test(key.name ?? '') && Number(key.name) <= count) {
      this.index = Number(key.name) - 1;
      this.done(this.options[this.index].value);
    } else if (key.name === 'left' || key.name === 'right') {
      const option = this.options[this.index];
      option.onSide?.(key.name === 'right' ? 1 : -1);
    }
  }

  render(columns) {
    const w = Math.min(columns - 1, 100);
    const inner = w - 4;
    const lines = [];
    for (const line of this.body) lines.push(...wrap(line, inner));
    if (this.body.length) lines.push('');
    this.options.forEach((option, i) => {
      const active = i === this.index;
      const number = c.soft(`${i + 1}.`);
      const label = typeof option.label === 'function' ? option.label() : option.label;
      const text = `${active ? c.brand('❯') : ' '} ${number} ${active ? bold(c.sky(label)) : label}${option.hint ? `  ${dim(option.hint)}` : ''}`;
      lines.push(text);
    });
    if (this.footer) lines.push('', dim(this.footer));
    return box(lines, w, { title: this.title, color: this.color });
  }
}

// Campo de texto de una linea (o secreto) dentro de una caja.
export class Field {
  constructor({ title, hint = '', secret = false, initial = '', color = c.brand }) {
    Object.assign(this, { title, hint, secret, color });
    this.editor = new Editor();
    this.editor.set(initial);
    this.done = null;
    this.promise = new Promise((resolve) => (this.done = resolve));
  }

  key(key) {
    const editor = this.editor;
    if (key.name === 'enter') return this.done(editor.value().trim());
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return this.done(null);
    if (key.name === 'paste') return editor.insert(key.paste.replace(/\n/g, ' ').trim());
    if (key.name === 'backspace') return editor.backspace();
    if (key.name === 'delete') return editor.del();
    if (key.name === 'left') return editor.left();
    if (key.name === 'right') return editor.right();
    if (key.name === 'home' || (key.ctrl && key.name === 'a')) return editor.home();
    if (key.name === 'end' || (key.ctrl && key.name === 'e')) return editor.end();
    if (key.ctrl && key.name === 'u') return editor.killToStart();
    if (key.text && !key.ctrl && !key.meta) editor.insert(key.text);
  }

  render(columns) {
    const w = Math.min(columns - 1, 100);
    const inner = w - 6;
    const shownText = this.secret ? '•'.repeat(Math.min(this.editor.text.length, inner - 1)) : this.editor.text;
    const visible = shownText.length > inner - 1 ? shownText.slice(shownText.length - inner + 1) : shownText;
    const cursorCol = Math.min(this.secret ? this.editor.cursor : width(this.editor.text.slice(0, this.editor.cursor)), inner - 1);
    const lines = [];
    if (this.hint) lines.push(...wrap(dim(this.hint), w - 4), '');
    const inputRow = lines.length + 1;
    lines.push(`${c.brand('›')} ${visible}`);
    lines.push('', dim('enter para aceptar · esc para cancelar'));
    return { lines: box(lines, w, { title: this.title, color: this.color }), cursor: { row: inputRow, col: 4 + cursorCol } };
  }
}

export const tag = (text, color = 'brand') => fg(color === 'brand' ? '#5f9be0' : color)(text);
