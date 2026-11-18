#!/usr/bin/env node
// Empaqueta la web para Cloudflare Pages: un JS y un CSS minificados con huella de contenido,
// servidos con cache inmutable; el HTML siempre se revalida.
import { build } from 'esbuild';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCode } from './build-code.js';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'web');
const target = path.join(root, 'dist');
const BUNDLED = new Set(['js', 'css', 'index.html']);

const HEADERS = `/assets/*
  Cache-Control: public, max-age=31536000, immutable
/
  Cache-Control: no-cache
/code/*
  Cache-Control: no-cache
/code/install.ps1
  Content-Type: text/plain; charset=utf-8
/code/install.sh
  Content-Type: text/plain; charset=utf-8
/code/bichi.mjs
  Content-Type: text/javascript; charset=utf-8
/code/instalar-bichi.cmd
  Content-Disposition: attachment; filename="instalar-bichi.cmd"
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`;

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true, filter: (file) => !BUNDLED.has(path.relative(source, file).split(path.sep)[0]) });

const { metafile } = await build({
  entryPoints: { app: path.join(source, 'js/main.js'), style: path.join(source, 'css/main.css') },
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2022',
  outdir: path.join(target, 'assets'),
  entryNames: '[name]-[hash]',
  metafile: true,
  logLevel: 'warning',
});

const outputs = Object.entries(metafile.outputs).map(([file, { entryPoint }]) => ({
  url: `/${path.relative(target, path.resolve(root, file)).replaceAll(path.sep, '/')}`,
  entry: entryPoint && path.basename(entryPoint),
}));
const urlOf = (entry) => outputs.find((output) => output.entry === entry).url;

const html = (await readFile(path.join(source, 'index.html'), 'utf8'))
  .replace('/css/main.css', urlOf('main.css'))
  .replace('/js/main.js', urlOf('main.js'));
await writeFile(path.join(target, 'index.html'), html);
await writeFile(path.join(target, '_headers'), HEADERS);

const code = await buildCode(path.join(target, 'code'));
console.log([...outputs.map(({ url }) => url), `/code/bichi.mjs ${code.version} ${Math.round(code.size / 1024)} KB`].join('\n'));
