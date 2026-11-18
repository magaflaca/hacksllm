// Decodifica la entrada cruda del terminal en teclas: {name, ctrl, meta, shift, text} o {paste}.

const CSI = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'tab',
  '1~': 'home',
  '7~': 'home',
  '4~': 'end',
  '8~': 'end',
  '3~': 'delete',
  '2~': 'insert',
  '5~': 'pageup',
  '6~': 'pagedown',
};

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export function createDecoder(emit) {
  let pasting = null;
  let pending = '';

  function key(name, extra = {}) {
    emit({ name, ctrl: false, meta: false, shift: false, ...extra });
  }

  function csi(body, meta) {
    // body sin el ESC[ inicial, p.ej. "1;5C" o "3~" o "13;2u".
    const final = body.at(-1);
    const params = body.slice(0, -1).split(';');
    const mod = Number(params[1] ?? 1) - 1;
    const flags = { shift: !!(mod & 1), meta: meta || !!(mod & 2), ctrl: !!(mod & 4) };
    if (final === 'u') {
      // Protocolo de teclado extendido (kitty): codigo;modificadores u
      const point = Number(params[0]);
      const names = { 13: 'enter', 9: 'tab', 27: 'escape', 127: 'backspace' };
      if (names[point]) return key(names[point], flags);
      return key(String.fromCodePoint(point), { ...flags, text: flags.ctrl ? '' : String.fromCodePoint(point) });
    }
    if (final === 'Z') return key('tab', { ...flags, shift: true });
    if (final === '~') {
      const name = CSI[`${params[0]}~`];
      if (name) return key(name, flags);
      if (params[0] === '27') {
        // xterm modifyOtherKeys: 27;mod;codigo~
        const point = Number(params[2]);
        const extra = { shift: !!((Number(params[1]) - 1) & 1), ctrl: !!((Number(params[1]) - 1) & 4) };
        if (point === 13) return key('enter', extra);
      }
      return;
    }
    if (CSI[final]) key(CSI[final], flags);
  }

  function feed(data) {
    // Terminales sin modo pegado (consola de Windows): un trozo con saltos de linea y texto detras es un pegado.
    if (pasting === null && !pending && data.length > 2 && !data.includes('\x1b') && /[\r\n][^\r\n]/.test(data)) {
      emit({ name: 'paste', paste: data.replace(/\r\n?/g, '\n') });
      return;
    }
    let input = pending + data;
    pending = '';
    let i = 0;
    while (i < input.length) {
      if (pasting !== null) {
        const end = input.indexOf(PASTE_END, i);
        if (end < 0) {
          pasting += input.slice(i);
          return;
        }
        pasting += input.slice(i, end);
        emit({ name: 'paste', paste: pasting.replace(/\r\n?/g, '\n') });
        pasting = null;
        i = end + PASTE_END.length;
        continue;
      }
      const ch = input[i];
      if (ch === '\x1b') {
        if (input.startsWith(PASTE_START, i)) {
          pasting = '';
          i += PASTE_START.length;
          continue;
        }
        const next = input[i + 1];
        if (next === undefined) {
          key('escape');
          i++;
          continue;
        }
        if (next === '[' || next === 'O') {
          const match = /^[\d;:?]*[A-Za-z~]/.exec(input.slice(i + 2));
          if (!match) {
            // Secuencia incompleta: se espera al siguiente trozo.
            if (input.length - i < 8) {
              pending = input.slice(i);
              return;
            }
            key('escape');
            i++;
            continue;
          }
          csi(match[0], false);
          i += 2 + match[0].length;
          continue;
        }
        if (next === '\x1b') {
          key('escape');
          i++;
          continue;
        }
        // Alt + tecla
        if (next === '\r' || next === '\n') key('enter', { meta: true });
        else if (next === '\x7f' || next === '\b') key('backspace', { meta: true });
        else key(next, { meta: true, text: '' });
        i += 2;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (ch === '\r') key('enter');
      else if (ch === '\n') key('enter', { ctrl: true, name: 'enter' });
      else if (ch === '\t') key('tab');
      else if (ch === '\x7f' || ch === '\b') key('backspace');
      else if (code < 32) key(String.fromCharCode(code + 96), { ctrl: true });
      else {
        // Texto normal: se agrupa lo que viene seguido (escritura rapida o pegado sin modo pegado).
        let j = i;
        while (j < input.length && input.charCodeAt(j) >= 32 && input[j] !== '\x1b' && input[j] !== '\x7f') j++;
        const text = input.slice(i, j);
        emit({ name: text.length === 1 ? text : 'text', text, ctrl: false, meta: false, shift: false });
        i = j;
        continue;
      }
      i++;
    }
  }

  return { feed };
}

export const ENABLE_PASTE = '\x1b[?2004h';
export const DISABLE_PASTE = '\x1b[?2004l';
