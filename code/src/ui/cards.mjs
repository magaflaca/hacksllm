// Tarjetas para avisos con peso (entrar en un modo, quedarse sin cuota, el recap): una barra de color a la izquierda,
// un titulo y unas pocas filas. Mas vistosas que una nota suelta, sin llegar a ser una caja que ocupe media pantalla.
import { bold, c, italic, wrap } from './term.mjs';

// card(color, titulo, filas, columnas) -> lineas. Las filas largas se parten respetando la barra.
export function card(color, title, rows = [], columns = 100) {
  const bar = color('▍');
  const out = [`  ${bar} ${bold(color(title))}`];
  for (const row of rows.filter(Boolean)) out.push(...wrap(row, Math.max(20, columns - 6)).map((line) => `  ${bar} ${line}`));
  return out;
}

// Medidor de uso: ▰▰▰▱▱▱▱▱▱▱ 30%, en verde, amarillo o rojo segun lo lleno que va.
export function gauge(percent, size = 10) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  const full = Math.round((value / 100) * size);
  const color = value >= 90 ? c.err : value >= 70 ? c.warn : c.ok;
  return `${color('▰'.repeat(full))}${c.soft('▱'.repeat(size - full))} ${color(`${value}%`)}`;
}

// Fila de atajos: "/model cambia de modelo · /effort el esfuerzo".
export const keys = (pairs) => pairs.map(([key, label]) => `${c.sky(key)} ${c.soft(label)}`).join(c.soft('  ·  '));

// El recap de un turno largo (como el de Claude Code): "◆ recap: lo hecho y lo que sigue", tenue y en cursiva.
export function recapLines(text, columns, first) {
  const body = `${text}${first ? ' (los recaps se quitan en /config)' : ''}`;
  const [head, ...rest] = wrap(`recap: ${body}`, Math.max(20, columns - 6));
  return [`  ${c.plum('◆')} ${c.plum(italic(head.slice(0, 6)))}${c.soft(italic(head.slice(6)))}`, ...rest.map((line) => `    ${c.soft(italic(line))}`)];
}
