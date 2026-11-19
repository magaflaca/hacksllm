// Herramientas de bichi paginas: el agente puede publicar una web estatica, ver las tuyas y traer una para editarla.
import path from 'node:path';
import { invalidate } from './files.mjs';
import { downloadPage, listPages, PUBLIC_BASE, publishFolder, slugify } from '../core/pages.mjs';

const ago = (time) => new Date(time).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' });

export const pagesList = {
  name: 'pages_list',
  kind: 'net',
  description: `Lista las bichi paginas del usuario (webs estaticas publicadas en ${PUBLIC_BASE}/<nombre>/) con su url, archivos y fecha.`,
  parameters: { type: 'object', properties: {} },
  label: () => ({ title: 'Bichi paginas', arg: '' }),
  async run(_input, ctx) {
    const pages = await listPages(ctx.config, { signal: ctx.signal });
    if (!pages.length) return { content: 'el usuario no tiene paginas publicadas', summary: 'ninguna' };
    return {
      content: pages.map((page) => `${page.slug}  ${page.url}  (${page.files} archivos, ${Math.round(page.size / 1024)} KB, actualizada ${ago(page.updated)})`).join('\n'),
      summary: `${pages.length} ${pages.length === 1 ? 'pagina' : 'paginas'}`,
    };
  },
};

export const pagePublish = {
  name: 'page_publish',
  kind: 'exec',
  description: `Publica una carpeta local como bichi pagina en ${PUBLIC_BASE}/<nombre>/ (o la reemplaza si ya es del usuario). La carpeta debe tener index.html en su raiz y solo archivos estaticos (html, css, js, imagenes, fuentes, json...), sin servidor: todo corre en el navegador. Maximo 25 MB y 300 archivos. Publica solo si el usuario lo pide.`,
  parameters: {
    type: 'object',
    properties: {
      folder: { type: 'string', description: 'carpeta con index.html, relativa al proyecto' },
      name: { type: 'string', description: 'nombre de la pagina: 3 a 40 minusculas, numeros o guiones' },
    },
    required: ['folder', 'name'],
  },
  label: (input) => ({ title: 'Publicar pagina', arg: `${input.folder ?? ''} → ${PUBLIC_BASE.replace('https://', '')}/${slugify(input.name)}/` }),
  async run(input, ctx) {
    const page = await publishFolder(ctx.config, path.resolve(ctx.cwd, String(input.folder ?? '.')), input.name, { signal: ctx.signal });
    const skipped = page.skipped?.length ? ` · sin subir (no son de una web estatica): ${page.skipped.slice(0, 20).join(', ')}${page.skipped.length > 20 ? '…' : ''}` : '';
    return { content: `${page.updated ? 'actualizada' : 'publicada'}: ${page.url} (${page.count} archivos)${skipped}`, summary: page.url };
  },
};

export const pageDownload = {
  name: 'page_download',
  kind: 'write',
  description: 'Trae los archivos de una bichi pagina del usuario a una carpeta local para editarla; despues se vuelve a publicar con page_publish y el mismo nombre.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'nombre de la pagina (slug)' },
      folder: { type: 'string', description: 'carpeta destino, relativa al proyecto (por defecto el nombre de la pagina)' },
    },
    required: ['name'],
  },
  label: (input) => ({ title: 'Traer pagina', arg: `${input.name} → ${input.folder ?? input.name}` }),
  async run(input, ctx) {
    const folder = path.resolve(ctx.cwd, String(input.folder || input.name));
    const saved = await downloadPage(ctx.config, slugify(input.name), folder, { signal: ctx.signal });
    invalidate();
    return { content: `${saved.length} archivos en ${path.relative(ctx.cwd, folder) || '.'}: ${saved.slice(0, 80).join(', ')}`, summary: `${saved.length} archivos` };
  },
};

export const PAGE_TOOLS = [pagesList, pagePublish, pageDownload];
