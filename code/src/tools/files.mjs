// Indice de archivos del proyecto (git si hay, si no un recorrido), compartido por glob, grep y la completacion @.
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const IGNORED = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', '.turbo', 'target', '.gradle', '.idea', '.pytest_cache', '.mypy_cache', 'dist-newstyle', '.svelte-kit']);
const LIMIT = 50_000;

const git = (cwd, args) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout));
  });

async function walk(root) {
  const files = [];
  const queue = [''];
  while (queue.length && files.length < LIMIT) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name)) queue.push(rel);
      } else if (entry.isFile()) files.push(rel);
    }
  }
  return files;
}

const cache = new Map();

// Rutas relativas con '/', sin lo ignorado por git. Cache corta: el agente cambia archivos todo el rato.
export async function listFiles(root, { fresh = false } = {}) {
  const hit = cache.get(root);
  if (!fresh && hit && Date.now() - hit.at < 3000) return hit.files;
  const out = await git(root, ['ls-files', '-co', '--exclude-standard', '--full-name', '--', '.']);
  let files;
  if (out !== null) {
    const prefix = (await git(root, ['rev-parse', '--show-prefix']))?.trim() ?? '';
    files = out
      .split('\n')
      .filter(Boolean)
      .map((file) => (prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file))
      .slice(0, LIMIT);
  } else files = await walk(root);
  cache.set(root, { at: Date.now(), files });
  return files;
}

export function invalidate() {
  cache.clear();
}

// Glob a regex: **, *, ?, {a,b} y [abc].
export function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else if (ch === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) out += '\\{';
      else {
        out += `(?:${glob
          .slice(i + 1, end)
          .split(',')
          .map((part) => globToRegex(part).source.slice(1, -1))
          .join('|')})`;
        i = end;
      }
    } else if (ch === '[') {
      const end = glob.indexOf(']', i);
      if (end < 0) out += '\\[';
      else {
        out += glob.slice(i, end + 1);
        i = end;
      }
    } else out += /[.+^$()|\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '');
}

export async function mtimes(root, files) {
  return Promise.all(
    files.map(async (file) => {
      try {
        return { file, time: (await stat(path.join(root, file))).mtimeMs };
      } catch {
        return { file, time: 0 };
      }
    }),
  );
}
