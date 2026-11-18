#!/usr/bin/env node
// Ajustes al build compilado de OmniRoute que todavia no estan upstream. Idempotente; si una version nueva
// cambia el codigo y un parche ya no encaja, avisa y sigue. Uso: node patch-release.mjs <dir de la release>
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Cloudflare AI Playground arranca cada sala con un prompt de sistema que promete herramientas MCP que no tiene
// conectadas: los modelos anuncian que van a buscar algo y terminan sin respuesta. Se reemplaza por uno neutro,
// salvo que el cliente mande su propio mensaje de sistema (bichi code, por ejemplo), que OmniRoute descartaba.
const PLAYGROUND_SYSTEM =
  'You are a helpful assistant. You have no tools and no internet access, so answer directly from your own knowledge. ' +
  'When something depends on live data such as prices, exchange rates or news, give your best known estimate and say it may be outdated. ' +
  'Reply in the language of the user.';

const CLIENT_SYSTEM =
  'system:(f.messages||[]).filter(x=>x&&(x.role==="system"||x.role==="developer"))' +
  '.map(x=>"string"==typeof x.content?x.content:(x.content||[]).map(y=>"string"==typeof y?y:y?.text??"").join("\\n")).join("\\n\\n")';

const PATCHES = [
  {
    name: 'cloudflare-playground: prompt de sistema del cliente o uno neutro',
    find: ['args:[{model:c,temperature:e,stream:!0}]', `args:[{model:c,temperature:e,stream:!0,system:${JSON.stringify(PLAYGROUND_SYSTEM)}}]`],
    replace: `args:[{model:c,temperature:e,stream:!0,system:a.system||${JSON.stringify(PLAYGROUND_SYSTEM)}}]`,
  },
  {
    name: 'cloudflare-playground: pasar los mensajes de sistema al navegador',
    find: ['messages:m(f.messages||[]),temperature:k,signal:c'],
    replace: `messages:m(f.messages||[]),${CLIENT_SYSTEM},temperature:k,signal:c`,
  },
];

const [release] = process.argv.slice(2);
if (!release) throw new Error('uso: patch-release.mjs <dir de la release>');
const chunks = path.join(release, '.build/next/server/chunks');
const files = (await readdir(chunks)).filter((name) => name.endsWith('.js')).map((name) => path.join(chunks, name));

for (const patch of PATCHES) {
  let applied = 0;
  let present = 0;
  for (const file of files) {
    let source = await readFile(file, 'utf8');
    if (source.includes(patch.replace)) {
      present++;
      continue;
    }
    const found = patch.find.filter((text) => source.includes(text));
    if (!found.length) continue;
    for (const text of found) source = source.replaceAll(text, patch.replace);
    await writeFile(file, source);
    applied++;
  }
  const state = applied ? `aplicado en ${applied}` : present ? 'ya estaba' : 'NO ENCAJA, revisar en esta version';
  console.log(`${patch.name}: ${state}`);
}
