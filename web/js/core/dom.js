import { icon } from '../art/pixels.js';

// h('button.icon-btn.px', { type: 'button', onclick }, ...hijos)
export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node && key !== 'style') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((child) => child != null && child !== false));
  return node;
}

export const iconButton = (name, label, onclick, extra = '') =>
  h(`button.icon-btn${extra}`, { type: 'button', 'aria-label': label, title: label, onclick }, icon(name));

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const field = h('textarea', { value: text, style: 'position:fixed;opacity:0' });
    document.body.append(field);
    field.select();
    document.execCommand('copy');
    field.remove();
  }
}
