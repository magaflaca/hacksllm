// Herramientas de archivos: leer, escribir, editar y listar.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { diffLines, stats } from '../ui/diff.mjs';
import { invalidate } from './files.mjs';

export const resolvePath = (ctx, file) => path.resolve(ctx.cwd, String(file ?? '').replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || '~'));
export const shown = (ctx, file) => {
  const rel = path.relative(ctx.cwd, file);
  return (!rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file).replaceAll('\\', '/') || '.';
};

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const isBinary = (buffer) => buffer.subarray(0, 8000).includes(0);

export const read = {
  name: 'read',
  kind: 'read',
  description: 'Lee un archivo de texto y lo devuelve con numeros de linea. Para archivos grandes usa offset y limit.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'ruta del archivo (relativa al proyecto o absoluta)' },
      offset: { type: 'number', description: 'primera linea a leer (desde 1)' },
      limit: { type: 'number', description: 'cuantas lineas leer (por defecto 2000)' },
    },
    required: ['path'],
  },
  label: (input, ctx) => ({ title: 'Leer', arg: shown(ctx, resolvePath(ctx, input.path)) }),
  async run(input, ctx) {
    const file = resolvePath(ctx, input.path);
    const info = await stat(file).catch(() => null);
    if (!info) throw new Error(`no existe: ${input.path}`);
    if (info.isDirectory()) throw new Error(`${input.path} es una carpeta; usa ls o glob`);
    const buffer = await readFile(file);
    if (isBinary(buffer)) return { content: `(archivo binario de ${info.size} bytes)`, summary: 'binario' };
    const lines = buffer.toString('utf8').split(/\r?\n/);
    const offset = Math.max(1, Number(input.offset) || 1);
    const limit = Math.max(1, Number(input.limit) || 2000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    ctx.readFiles?.add(file);
    const width = String(offset + slice.length).length;
    const body = slice.map((line, i) => `${String(offset + i).padStart(width)}\t${line.length > 2000 ? `${line.slice(0, 2000)}…` : line}`).join('\n');
    const more = offset - 1 + slice.length < lines.length ? `\n(… quedan ${lines.length - (offset - 1 + slice.length)} lineas; usa offset para seguir)` : '';
    return { content: (body || '(archivo vacio)') + more, summary: count(slice.length, 'linea', 'lineas') };
  },
};

async function snapshot(ctx, file) {
  const before = existsSync(file) ? await readFile(file, 'utf8') : null;
  ctx.checkpoint?.(file, before);
  return before;
}

export const write = {
  name: 'write',
  kind: 'write',
  description: 'Crea o reemplaza un archivo completo con el contenido dado. Crea las carpetas que falten. Para cambios pequenos en archivos existentes usa edit.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'ruta del archivo' },
      content: { type: 'string', description: 'contenido completo del archivo' },
    },
    required: ['path', 'content'],
  },
  label: (input, ctx) => ({ title: 'Escribir', arg: shown(ctx, resolvePath(ctx, input.path)) }),
  async preview(input, ctx) {
    const file = resolvePath(ctx, input.path);
    const before = existsSync(file) ? await readFile(file, 'utf8').catch(() => '') : null;
    return { file: shown(ctx, file), ops: diffLines(before ?? '', String(input.content ?? '')), created: before === null };
  },
  async run(input, ctx) {
    const file = resolvePath(ctx, input.path);
    const content = String(input.content ?? '');
    const before = await snapshot(ctx, file);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    invalidate();
    const ops = diffLines(before ?? '', content);
    const lines = content.split('\n').length;
    return {
      content: before === null ? `archivo creado (${lines} lineas)` : `archivo reescrito (${lines} lineas)`,
      summary: before === null ? `creado, ${count(lines, 'linea', 'lineas')}` : `${count(stats(ops).added, 'linea nueva', 'lineas nuevas')}, ${count(stats(ops).removed, 'quitada', 'quitadas')}`,
      diff: ops,
      created: before === null,
    };
  },
};

// Coincidencia flexible: ignora espacios al final de linea y diferencias de saltos de linea.
function locate(content, needle) {
  const exact = [];
  for (let at = content.indexOf(needle); at >= 0; at = content.indexOf(needle, at + 1)) exact.push({ start: at, end: at + needle.length });
  if (exact.length) return exact;
  const lines = content.split('\n');
  const want = needle.split('\n').map((line) => line.replace(/\s+$/, ''));
  const found = [];
  const offsets = [];
  let total = 0;
  for (const line of lines) offsets.push(total), (total += line.length + 1);
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((line, k) => lines[i + k].replace(/\s+$/, '') === line)) {
      const end = offsets[i + want.length - 1] + lines[i + want.length - 1].length;
      found.push({ start: offsets[i], end });
    }
  }
  return found;
}

export const edit = {
  name: 'edit',
  kind: 'write',
  description:
    'Reemplaza un fragmento exacto de un archivo (old_string) por otro (new_string). old_string debe aparecer una sola vez, incluye lineas de contexto para que sea unico, o usa replace_all. Para crear archivos usa write.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'ruta del archivo' },
      old_string: { type: 'string', description: 'texto actual, tal cual aparece en el archivo' },
      new_string: { type: 'string', description: 'texto nuevo' },
      replace_all: { type: 'boolean', description: 'reemplazar todas las apariciones' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  label: (input, ctx) => ({ title: 'Editar', arg: shown(ctx, resolvePath(ctx, input.path)) }),
  async plan(input, ctx) {
    const file = resolvePath(ctx, input.path);
    if (!existsSync(file)) {
      if (!input.old_string) return { file, before: null, after: String(input.new_string ?? '') };
      throw new Error(`no existe: ${input.path}`);
    }
    const raw = await readFile(file, 'utf8');
    const crlf = raw.includes('\r\n');
    const content = crlf ? raw.replace(/\r\n/g, '\n') : raw;
    const oldText = String(input.old_string ?? '').replace(/\r\n/g, '\n');
    const newText = String(input.new_string ?? '').replace(/\r\n/g, '\n');
    if (!oldText) throw new Error('old_string vacio; para reescribir el archivo usa write');
    if (oldText === newText) throw new Error('old_string y new_string son iguales');
    const matches = locate(content, oldText);
    if (!matches.length) throw new Error('old_string no aparece en el archivo. lee el archivo de nuevo y copia el texto exacto.');
    if (matches.length > 1 && !input.replace_all) throw new Error(`old_string aparece ${matches.length} veces; agrega contexto para que sea unico o usa replace_all`);
    let after = '';
    let last = 0;
    for (const match of input.replace_all ? matches : matches.slice(0, 1)) {
      after += content.slice(last, match.start) + newText;
      last = match.end;
    }
    after += content.slice(last);
    return { file, before: content, after, crlf, count: input.replace_all ? matches.length : 1 };
  },
  async preview(input, ctx) {
    const planned = await this.plan(input, ctx);
    return { file: shown(ctx, planned.file), ops: diffLines(planned.before ?? '', planned.after) };
  },
  async run(input, ctx) {
    const planned = await this.plan(input, ctx);
    await snapshot(ctx, planned.file);
    if (planned.before === null) await mkdir(path.dirname(planned.file), { recursive: true });
    await writeFile(planned.file, planned.crlf ? planned.after.replace(/\n/g, '\r\n') : planned.after);
    invalidate();
    const ops = diffLines(planned.before ?? '', planned.after);
    const { added, removed } = stats(ops);
    return {
      content: `editado${planned.count > 1 ? ` (${planned.count} reemplazos)` : ''}`,
      summary: `${count(added, 'linea nueva', 'lineas nuevas')}, ${count(removed, 'quitada', 'quitadas')}`,
      diff: ops,
    };
  },
};

export const ls = {
  name: 'ls',
  kind: 'read',
  description: 'Lista el contenido de una carpeta (carpetas con / al final).',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'carpeta (por defecto la del proyecto)' } } },
  label: (input, ctx) => ({ title: 'Listar', arg: shown(ctx, resolvePath(ctx, input.path ?? '.')) }),
  async run(input, ctx) {
    const dir = resolvePath(ctx, input.path ?? '.');
    const entries = await readdir(dir, { withFileTypes: true });
    const names = entries
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => (b.endsWith('/') - a.endsWith('/')) || a.localeCompare(b));
    const shownNames = names.slice(0, 500);
    return { content: shownNames.join('\n') + (names.length > 500 ? `\n(… ${names.length - 500} mas)` : '') || '(vacia)', summary: `${names.length} entradas` };
  },
};
