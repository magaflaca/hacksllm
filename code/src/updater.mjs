// Actualizaciones: bichi mira si hay una version nueva al arrancar y cada 6 horas, la descarga en segundo plano y
// reemplaza su archivo. La sesion actual sigue con la version cargada; la nueva se usa al volver a abrir bichi.
import { existsSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SITE, VERSION } from './config.mjs';

const EVERY = 6 * 3600 * 1000;

// Solo se actualiza la copia instalada (un bichi.mjs empaquetado), nunca el codigo fuente en desarrollo.
export const installedFile = () => {
  const file = process.argv[1] ?? '';
  return path.basename(file) === 'bichi.mjs' && existsSync(file) ? file : null;
};

const newer = (a, b) => {
  const [x, y] = [a, b].map((value) => value.split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

let downloaded = null;

// Devuelve la version instalada si hubo una nueva, null si no hacia falta.
export async function update({ force = false } = {}) {
  const file = installedFile();
  if (!file) throw new Error('esta copia de bichi no es la instalada (se actualiza sola solo la de ~/.bichi/bin)');
  const latest = (await (await fetch(`${SITE}/code/version.txt`, { cache: 'no-store', signal: AbortSignal.timeout(20000) })).text()).trim();
  if (!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error('no pude leer la ultima version');
  const current = downloaded ?? VERSION;
  if (!force && !newer(latest, current)) return null;
  const response = await fetch(`${SITE}/code/bichi.mjs`, { cache: 'no-store', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`no pude descargar: ${response.status}`);
  const code = await response.text();
  if (!code.includes('bichi code') || code.length < 50_000) throw new Error('la descarga no parece bichi code');
  await writeFile(`${file}.new`, code);
  await rename(`${file}.new`, file);
  downloaded = latest;
  return latest;
}

// En segundo plano: avisa con onUpdated(version) cuando deja instalada una nueva.
export function autoUpdate(config, onUpdated) {
  if (config.autoUpdate === false || !installedFile()) return;
  const check = () => update().then((version) => version && onUpdated(version)).catch(() => {});
  setTimeout(check, 4000).unref();
  setInterval(check, EVERY).unref();
}
