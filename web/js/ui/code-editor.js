import { h } from '../core/dom.js';
import { escape, highlighter } from '../core/highlight.js';

const MAX_HIGHLIGHT = 300_000;

// Editor con colores: un textarea transparente encima de un <pre> resaltado, con el mismo tamano y scroll.
// Escribir, seleccionar y deshacer siguen siendo los del navegador.
export function codeEditor(value, name, { onSave } = {}) {
  const paint = highlighter(name);
  const area = h('textarea.code-input', { spellcheck: false, autocapitalize: 'off', autocomplete: 'off', wrap: 'off', value });
  const view = h('pre.code-view', { 'aria-hidden': 'true' }, h('code'));
  const root = h('div.code-edit', {}, view, area);
  let frame = 0;

  const sync = () => {
    view.scrollTop = area.scrollTop;
    view.scrollLeft = area.scrollLeft;
  };
  const render = () => {
    frame = 0;
    const text = area.value;
    view.firstChild.innerHTML = `${paint && text.length < MAX_HIGHLIGHT ? paint(text) : escape(text)}\n`;
    sync();
  };

  area.addEventListener('input', () => (frame ||= requestAnimationFrame(render)));
  area.addEventListener('scroll', sync);
  area.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      onSave?.();
    } else if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
      render();
    }
  });
  render();
  return { root, area, get value() {
    return area.value;
  } };
}
