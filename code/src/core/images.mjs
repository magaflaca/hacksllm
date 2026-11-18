// Imagenes: pegadas como ruta, arrastradas a la terminal o con alt+v desde el portapapeles. Se guardan en
// ~/.bichi/images y un modelo con vision las describe una vez; la descripcion acompana al mensaje, asi que
// sirve con cualquier modelo (aunque solo lea texto).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME, saveState } from '../config.mjs';

const DIR = path.join(HOME, 'images');
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
const MAX_BYTES = 8 * 1024 * 1024;

// Si un texto pegado es la ruta de una imagen, devuelve la ruta limpia.
export function imagePath(text, cwd) {
  let candidate = text.trim().replace(/^["']|["']$/g, '').replace(/^file:\/\//, '');
  if (!candidate || candidate.includes('\n') || !TYPES[path.extname(candidate).toLowerCase()]) return null;
  candidate = candidate.replace(/\\ /g, ' ');
  const full = path.resolve(cwd, candidate);
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

// Copia la imagen a ~/.bichi/images con su hash como nombre.
export function storeImage(file) {
  const data = readFileSync(file);
  if (data.length > MAX_BYTES) throw new Error('la imagen pesa mas de 8 MB');
  const hash = createHash('sha1').update(data).digest('hex').slice(0, 16);
  mkdirSync(DIR, { recursive: true });
  const ext = path.extname(file).toLowerCase() || '.png';
  const target = path.join(DIR, `${hash}${ext}`);
  if (!existsSync(target)) copyFileSync(file, target);
  return { hash, file: target, name: path.basename(file) };
}

const run = (command, args) =>
  new Promise((resolve) => execFile(command, args, { windowsHide: true, timeout: 10000 }, (error, stdout) => resolve(error ? null : String(stdout))));

// Imagen del portapapeles a un png temporal (alt+v).
export async function clipboardImage() {
  const temp = path.join(os.tmpdir(), `bichi-clip-${process.pid}-${Date.now()}.png`);
  if (process.platform === 'win32') {
    const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $i = [Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${temp}', [Drawing.Imaging.ImageFormat]::Png); 'ok' }`;
    await run('powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
  } else if (process.platform === 'darwin') {
    await run('osascript', ['-e', `set f to open for access POSIX file "${temp}" with write permission`, '-e', 'write (the clipboard as «class PNGf») to f', '-e', 'close access f']);
  } else {
    const data = (await run('sh', ['-c', `wl-paste --type image/png > '${temp}' 2>/dev/null || xclip -selection clipboard -t image/png -o > '${temp}'`])) ?? '';
    void data;
  }
  if (!existsSync(temp) || statSync(temp).size === 0) return null;
  const stored = storeImage(temp);
  unlinkSync(temp);
  return { ...stored, name: 'portapapeles' };
}

export const dataUrl = (image) => `data:${TYPES[path.extname(image.file).toLowerCase()] ?? 'image/png'};base64,${readFileSync(image.file).toString('base64')}`;

const PROMPT =
  'Describe esta imagen con todo el detalle util para un programador: transcribe exactamente cualquier texto, codigo, mensajes de error o datos que aparezcan; describe la interfaz, el diseno, los colores y la disposicion si es una captura o un mockup. Responde solo con la descripcion, en espanol.';

// Descripcion de la imagen (una vez por imagen; se recuerda en el estado).
export async function describe(router, image, signal) {
  const notes = (router.state.imageNotes ??= {});
  if (notes[image.hash]) return notes[image.hash];
  const result = await router.complete({
    messages: [
      { role: 'system', content: 'Eres un asistente que describe imagenes con precision.' },
      { role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: dataUrl(image) } }] },
    ],
    tools: [],
    signal,
  });
  notes[image.hash] = result.text.trim();
  saveState(router.state);
  return notes[image.hash];
}
