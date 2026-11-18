#!/usr/bin/env node
// Empaqueta bichi code en un solo archivo sin dependencias (dist/code/bichi.mjs) junto a su version,
// para que los instaladores lo descarguen de llm.hacks.win/code/.
import { build } from 'esbuild';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

export async function buildCode(outdir = path.join(root, 'dist', 'code')) {
  const config = await readFile(path.join(root, 'code/src/config.mjs'), 'utf8');
  const version = /VERSION = '([^']+)'/.exec(config)[1];
  await mkdir(outdir, { recursive: true });
  const outfile = path.join(outdir, 'bichi.mjs');
  await build({
    entryPoints: [path.join(root, 'code/src/main.mjs')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    minify: true,
    legalComments: 'none',
    banner: { js: `#!/usr/bin/env node\n// bichi code ${version} - https://llm.hacks.win/#/code` },
    outfile,
    logLevel: 'warning',
  });
  await writeFile(path.join(outdir, 'version.txt'), `${version}\n`);
  const { size } = await stat(outfile);
  return { outfile, version, size };
}

if (process.argv[1] === import.meta.filename) {
  const { outfile, version, size } = await buildCode(process.argv[2]);
  console.log(`${outfile} ${version} ${Math.round(size / 1024)} KB`);
}
