// Resaltado de sintaxis minimo para html, css y js. Devuelve html escapado con <span class="tk-...">.

export const escape = (text) => text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
const span = (kind, text) => (kind ? `<span class="tk-${kind}">${escape(text)}</span>` : escape(text));

// Recorre el texto con una regex de grupos con nombre; cada grupo es un tipo de token.
function scan(code, pattern, classify) {
  let out = '';
  let last = 0;
  for (const match of code.matchAll(pattern)) {
    out += escape(code.slice(last, match.index));
    const [kind] = Object.entries(match.groups).find(([, value]) => value !== undefined) ?? [];
    out += span(classify ? classify(kind, match) : kind, match[0]);
    last = match.index + match[0].length;
  }
  return out + escape(code.slice(last));
}

const JS_KEYWORDS =
  'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|super|yield|delete|void|static|get|set';

const JS = new RegExp(
  [
    String.raw`(?<comment>\/\/[^\n]*|\/\*[\s\S]*?\*\/)`,
    String.raw`(?<string>\`(?:\\[\s\S]|[^\`\\])*\`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")`,
    String.raw`(?<keyword>\b(?:${JS_KEYWORDS})\b)`,
    String.raw`(?<literal>\b(?:true|false|null|undefined|NaN|Infinity)\b)`,
    String.raw`(?<number>\b0x[\da-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)`,
    String.raw`(?<func>\b[A-Za-z_$][\w$]*(?=\s*\())`,
    String.raw`(?<prop>(?<=\.)[A-Za-z_$][\w$]*)`,
    String.raw`(?<punct>[{}()[\];,.<>=+\-*/%!&|?:^~])`,
  ].join('|'),
  'g',
);

export const js = (code) => scan(code, JS);

const CSS = new RegExp(
  [
    String.raw`(?<comment>\/\*[\s\S]*?\*\/)`,
    String.raw`(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`,
    String.raw`(?<at>@[\w-]+)`,
    String.raw`(?<color>#[\da-fA-F]{3,8}\b)`,
    String.raw`(?<prop>[\w-]+(?=\s*:[^;{}]*[;}]))`,
    String.raw`(?<number>-?\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|dvh)?\b)`,
    String.raw`(?<important>!important)`,
    String.raw`(?<open>\{)`,
    String.raw`(?<close>\})`,
    String.raw`(?<word>[.#]?[\w-]+)`,
    String.raw`(?<punct>[:;,()>+~*])`,
  ].join('|'),
  'g',
);

// En css las palabras son selectores salvo dentro de una regla, donde son valores. Los bloques de @media,
// @supports y similares contienen reglas, no declaraciones.
export function css(code) {
  const blocks = [];
  let afterAt = false;
  return scan(code, CSS, (kind) => {
    const inRule = blocks.at(-1) === 'rule';
    if (kind === 'at') afterAt = true;
    if (kind === 'open') {
      blocks.push(afterAt ? 'group' : 'rule');
      afterAt = false;
      return 'punct';
    }
    if (kind === 'close') return blocks.pop(), 'punct';
    if (kind === 'word') return inRule ? 'value' : afterAt ? 'value' : 'selector';
    if (kind === 'number') return inRule || afterAt ? 'number' : 'selector';
    if (kind === 'important') return 'keyword';
    return kind;
  });
}

const ATTRS = /(?<attr>[^\s=>"'/]+)(?:(?<eq>\s*=\s*)(?<value>"[^"]*"|'[^']*'|[^\s>]+))?/g;
const TAG = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([\w-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/gi;

function attributes(text) {
  let out = '';
  let last = 0;
  for (const { index, 0: whole, groups } of text.matchAll(ATTRS)) {
    out += escape(text.slice(last, index)) + span('attr', groups.attr);
    if (groups.eq) out += escape(groups.eq) + span('string', groups.value);
    last = index + whole.length;
  }
  return out + escape(text.slice(last));
}

// html con su css y js internos resaltados con su propio lenguaje.
export function html(code) {
  let out = '';
  let last = 0;
  TAG.lastIndex = 0;
  for (let match; (match = TAG.exec(code)); ) {
    out += escape(code.slice(last, match.index));
    const [whole, slash, name, attrs = '', selfClose] = match;
    if (!name) out += span(whole.startsWith('<!--') ? 'comment' : 'keyword', whole);
    else out += `${span('punct', `<${slash}`)}${span('tag', name)}${attributes(attrs)}${span('punct', `${selfClose}>`)}`;
    last = TAG.lastIndex;
    const inner = !slash && /^(style|script)$/i.test(name ?? '') && name.toLowerCase();
    if (inner) {
      const end = code.toLowerCase().indexOf(`</${inner}`, last);
      const body = code.slice(last, end < 0 ? code.length : end);
      out += inner === 'style' ? css(body) : js(body);
      last += body.length;
      TAG.lastIndex = last;
    }
  }
  return out + escape(code.slice(last));
}

const LANGUAGES = { html, htm: html, xml: html, svg: html, css, js, mjs: js, javascript: js, json: js, ts: js, typescript: js };

// Lenguaje por extension de archivo o nombre de bloque de codigo; null si no se resalta.
export const highlighter = (name = '') => LANGUAGES[name.toLowerCase().split('.').pop()] ?? null;
