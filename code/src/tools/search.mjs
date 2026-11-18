// Busqueda: glob por nombre y grep por contenido (ripgrep si esta instalado, si no en JS).
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { globToRegex, listFiles, mtimes } from './files.mjs';
import { resolvePath, shown } from './fs.mjs';

let ripgrep;
const hasRipgrep = () =>
  (ripgrep ??= new Promise((resolve) => execFile('rg', ['--version'], { windowsHide: true }, (error) => resolve(!error))));

export const glob = {
  name: 'glob',
  kind: 'read',
  description: 'Busca archivos por patron de nombre (p.ej. "src/**/*.ts", "**/package.json"). Devuelve rutas ordenadas por fecha de cambio, las recientes primero.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'patron glob' },
      path: { type: 'string', description: 'carpeta donde buscar (por defecto el proyecto)' },
    },
    required: ['pattern'],
  },
  label: (input) => ({ title: 'Buscar', arg: input.pattern }),
  async run(input, ctx) {
    const root = resolvePath(ctx, input.path ?? '.');
    const pattern = String(input.pattern).replace(/^\.\//, '');
    const regex = globToRegex(pattern.includes('/') ? pattern : `**/${pattern}`);
    const files = (await listFiles(root)).filter((file) => regex.test(file));
    const sorted = (await mtimes(root, files.slice(0, 2000))).sort((a, b) => b.time - a.time).map(({ file }) => file);
    const prefix = shown(ctx, root);
    const list = sorted.slice(0, 200).map((file) => (prefix === '.' ? file : `${prefix}/${file}`));
    return {
      content: list.length ? list.join('\n') + (files.length > 200 ? `\n(… ${files.length - 200} mas; afina el patron)` : '') : 'sin coincidencias',
      summary: `${files.length} ${files.length === 1 ? 'archivo' : 'archivos'}`,
    };
  },
};

function runRipgrep(args, cwd, signal) {
  return new Promise((resolve) => {
    execFile('rg', args, { cwd, maxBuffer: 32 * 1024 * 1024, signal, windowsHide: true }, (error, stdout) => resolve(stdout ?? ''));
  });
}

export const grep = {
  name: 'grep',
  kind: 'read',
  description:
    'Busca texto o expresiones regulares dentro de los archivos. mode: "files" (solo rutas, por defecto), "content" (lineas con numero) o "count". Filtra con glob (p.ej. "*.py").',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'expresion regular' },
      path: { type: 'string', description: 'carpeta o archivo (por defecto el proyecto)' },
      glob: { type: 'string', description: 'filtro de archivos, p.ej. "*.ts" o "src/**/*.js"' },
      mode: { type: 'string', enum: ['files', 'content', 'count'] },
      ignore_case: { type: 'boolean' },
      context: { type: 'number', description: 'lineas de contexto en modo content' },
    },
    required: ['pattern'],
  },
  label: (input) => ({ title: 'Buscar', arg: `"${input.pattern}"${input.glob ? ` en ${input.glob}` : ''}` }),
  async run(input, ctx) {
    const target = resolvePath(ctx, input.path ?? '.');
    const mode = input.mode ?? 'files';
    const isFile = (await stat(target).catch(() => null))?.isFile();
    const root = isFile ? path.dirname(target) : target;
    let lines;
    if (await hasRipgrep()) {
      const args = ['--no-heading', '--color', 'never', '-e', String(input.pattern)];
      if (input.ignore_case) args.push('-i');
      if (input.glob) args.push('--glob', input.glob);
      if (mode === 'files') args.push('-l');
      else if (mode === 'count') args.push('-c');
      else {
        args.push('-n');
        if (input.context) args.push('-C', String(Math.min(10, input.context)));
      }
      args.push(isFile ? path.basename(target) : '.');
      lines = (await runRipgrep(args, root, ctx.signal)).split('\n').filter(Boolean).map((line) => line.replace(/^\.[\\/]/, '').replaceAll('\\', '/'));
    } else lines = await jsGrep(root, isFile ? [path.basename(target)] : null, input, mode);
    const prefix = shown(ctx, root);
    const fix = (line) => (prefix === '.' ? line : `${prefix}/${line}`);
    const total = lines.length;
    const shownLines = lines.slice(0, mode === 'content' ? 400 : 250).map(fix);
    const files = mode === 'files' ? total : new Set(lines.map((line) => line.split(':')[0])).size;
    return {
      content: total ? shownLines.join('\n') + (total > shownLines.length ? `\n(… ${total - shownLines.length} mas)` : '') : 'sin coincidencias',
      summary: mode === 'files' ? `${total} ${total === 1 ? 'archivo' : 'archivos'}` : `${total} resultados en ${files} archivos`,
    };
  },
};

async function jsGrep(root, only, input, mode) {
  const regex = new RegExp(input.pattern, input.ignore_case ? 'i' : '');
  const filter = input.glob ? globToRegex(input.glob.includes('/') ? input.glob : `**/${input.glob}`) : null;
  const files = (only ?? (await listFiles(root))).filter((file) => !filter || filter.test(file));
  const out = [];
  const context = Math.min(10, input.context ?? 0);
  for (const file of files) {
    if (out.length > 2000) break;
    let text;
    try {
      const buffer = await readFile(path.join(root, file));
      if (buffer.length > 2_000_000 || buffer.subarray(0, 4000).includes(0)) continue;
      text = buffer.toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const hits = lines.map((line, i) => (regex.test(line) ? i : -1)).filter((i) => i >= 0);
    if (!hits.length) continue;
    if (mode === 'files') out.push(file);
    else if (mode === 'count') out.push(`${file}:${hits.length}`);
    else {
      const keep = new Set();
      for (const hit of hits) for (let k = hit - context; k <= hit + context; k++) if (k >= 0 && k < lines.length) keep.add(k);
      for (const k of [...keep].sort((a, b) => a - b)) out.push(`${file}:${k + 1}${hits.includes(k) ? ':' : '-'}${lines[k]}`);
    }
  }
  return out;
}
