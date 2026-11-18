import { h, copyText } from '../core/dom.js';
import { icon } from '../art/pixels.js';
import { sound } from '../core/sound.js';
import { store } from '../core/store.js';
import { sites, slugify, PAGES_ORIGIN } from '../core/pages.js';
import { deliver } from '../core/work.js';
import { zipBlob } from '../core/zip.js';
import { codeEditor } from './code-editor.js';

const TEXT = /\.(html?|css|m?js|json|txt|md|xml|svg|csv|webmanifest)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|ico|svg)$/i;
const CONFIRM_MS = 3000;

const size = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function ago(time) {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return 'ahora mismo';
  if (minutes < 60) return `hace ${plural(minutes, 'minuto', 'minutos')}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${plural(hours, 'hora', 'horas')}`;
  return `hace ${plural(Math.round(hours / 24), 'dia', 'dias')}`;
}

// Ruta de cada archivo elegido: en una carpeta se quita su primer nivel, para que index.html quede en la raiz.
const entriesOf = (files) =>
  files.map((file) => ({ path: (file.webkitRelativePath || file.name).split('/').slice(file.webkitRelativePath ? 1 : 0).join('/'), blob: file }));

// Nombre sugerido: la carpeta elegida o el zip, sin extension.
const suggested = ([first]) =>
  first?.webkitRelativePath ? slugify(first.webkitRelativePath.split('/')[0]) : /\.zip$/i.test(first?.name ?? '') ? slugify(first.name.replace(/\.zip$/i, '')) : '';

async function zipOf(files) {
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) return files[0];
  return zipBlob(entriesOf(files));
}

const picker = (options) =>
  new Promise((resolve) => {
    const input = h('input', { type: 'file', multiple: true, ...options });
    input.addEventListener('change', () => resolve([...input.files]));
    input.click();
  });

// La miniatura es la pagina real a 1280px, escalada al ancho de su tarjeta.
const thumbs = new ResizeObserver((entries) => entries.forEach(({ target, contentRect }) => target.style.setProperty('--thumb-scale', contentRect.width / 1280)));

export function createPages({ root, mascot, openKey, editWithBichi }) {
  let list = [];
  let loading = false;

  const hasKey = () => Boolean(store.get('apiKey', ''));

  function fail(error, fallback) {
    mascot.say(error?.message || fallback, 2600);
    sound.play('error');
    if (error?.status === 401) openKey();
  }

  // Un toque arma el boton y el segundo, antes de 3 s, confirma.
  function armed(button, label, action) {
    let timer = 0;
    button.addEventListener('click', () => {
      if (!timer) {
        button.classList.add('is-armed');
        mascot.say(label, CONFIRM_MS);
        sound.play('tap');
        timer = setTimeout(() => (button.classList.remove('is-armed'), (timer = 0)), CONFIRM_MS);
        return;
      }
      clearTimeout(timer);
      timer = 0;
      button.classList.remove('is-armed');
      action();
    });
    return button;
  }

  const tool = (name, label, onclick) => h('button.site-tool', { type: 'button', 'aria-label': label, title: label, onclick }, icon(name));

  // ---- dialogos

  function dialog(className, ...children) {
    const node = h(`dialog.dialog.card.px.${className}`, {}, ...children);
    node.addEventListener('close', () => node.remove());
    node.addEventListener('click', (event) => event.target === node && node.close());
    document.body.append(node);
    node.showModal();
    sound.play('select');
    return node;
  }

  function createDialog(preset = []) {
    let chosen = preset;
    const name = h('input.input.px', { type: 'text', placeholder: 'mi-pagina', spellcheck: false, autocomplete: 'off' });
    const preview = h('p.site-preview', {});
    const drop = h('div.dropzone.px', {});
    const publish = h('button.primary.px', { type: 'submit' }, icon('globe'), 'publicar');
    const paint = () => {
      if (!name.value && chosen.length) name.value = suggested(chosen);
      const slug = slugify(name.value);
      preview.replaceChildren(h('span', {}, `${PAGES_ORIGIN.replace('https://', '')}/`), h('b', {}, slug || 'mi-pagina'));
      drop.replaceChildren(
        icon(chosen.length ? 'file' : 'upload'),
        h('p', {}, chosen.length ? plural(chosen.length, 'archivo listo', 'archivos listos') : 'suelta aqui un zip, archivos o una carpeta con index.html'),
        h(
          'div.drop-actions',
          {},
          h('button.ghost.px', { type: 'button', onclick: async () => ((chosen = await picker({})), paint()) }, icon('file'), 'archivos o zip'),
          h('button.ghost.px', { type: 'button', onclick: async () => ((chosen = await picker({ webkitdirectory: true })), paint()) }, icon('folder'), 'carpeta'),
        ),
      );
      publish.disabled = !chosen.length || slugify(name.value).length < 3;
    };
    drop.addEventListener('dragover', (event) => (event.preventDefault(), drop.classList.add('is-over')));
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('is-over');
      chosen = [...event.dataTransfer.files];
      paint();
    });
    name.addEventListener('input', paint);
    const form = h(
      'form.site-form',
      {
        method: 'dialog',
        onsubmit: async (event) => {
          event.preventDefault();
          publish.disabled = true;
          publish.replaceChildren(icon('sparkle'), 'publicando...');
          try {
            const site = await sites.upload(slugify(name.value), await zipOf(chosen));
            node.close();
            mascot.say('ya esta en linea', 2200);
            sound.play('chirp');
            await refresh();
            highlight(site.slug);
          } catch (error) {
            fail(error, 'no se pudo publicar');
            publish.replaceChildren(icon('globe'), 'publicar');
            paint();
          }
        },
      },
      h('h2', {}, 'nueva pagina'),
      h('label.field', {}, h('span', {}, 'nombre'), name),
      preview,
      drop,
      h('div.dialog-actions', {}, h('button.ghost.px', { type: 'button', onclick: () => node.close() }, 'cancelar'), publish),
    );
    const node = dialog('site-dialog', form);
    paint();
    name.focus();
  }

  function renameDialog(site) {
    const name = h('input.input.px', { type: 'text', value: site.slug, spellcheck: false, autocomplete: 'off' });
    const preview = h('p.site-preview', {});
    const save = h('button.primary.px', { type: 'submit' }, icon('tag'), 'renombrar');
    const paint = () => {
      preview.replaceChildren(h('span', {}, `${PAGES_ORIGIN.replace('https://', '')}/`), h('b', {}, slugify(name.value) || '...'));
      save.disabled = slugify(name.value).length < 3 || slugify(name.value) === site.slug;
    };
    name.addEventListener('input', paint);
    const node = dialog(
      'site-dialog',
      h(
        'form.site-form',
        {
          onsubmit: async (event) => {
            event.preventDefault();
            save.disabled = true;
            try {
              const renamed = await sites.rename(site.slug, slugify(name.value));
              node.close();
              mascot.say('nueva direccion lista', 2200);
              sound.play('chirp');
              await refresh();
              highlight(renamed.slug);
            } catch (error) {
              fail(error, 'no se pudo renombrar');
              paint();
            }
          },
        },
        h('h2', {}, 'cambiar direccion'),
        h('p.dialog-note', {}, 'la direccion vieja deja de funcionar.'),
        h('label.field', {}, h('span', {}, 'nombre'), name),
        preview,
        h('div.dialog-actions', {}, h('button.ghost.px', { type: 'button', onclick: () => node.close() }, 'cancelar'), save),
      ),
    );
    paint();
    name.select();
  }

  // Editor: lista de archivos y el contenido del elegido; guardar vuelve a publicar.
  function editor(site) {
    let files = [];
    let current = null;
    let objectUrl = '';
    const fileList = h('ul.editor-files', {});
    const pane = h('div.editor-pane', {});
    const title = h('a.editor-url', { href: site.url, target: '_blank', rel: 'noopener' }, site.url.replace('https://', ''));

    async function load(select) {
      files = await sites.files(site.slug);
      fileList.replaceChildren(
        ...files.map((file) =>
          h(
            'li.editor-file',
            { dataset: { active: file.path === current } },
            h('button.editor-open', { type: 'button', onclick: () => open(file.path) }, icon(IMAGE.test(file.path) ? 'eye' : 'file'), h('span', {}, file.path)),
            file.path === 'index.html'
              ? null
              : armed(h('button.site-tool', { type: 'button', 'aria-label': `Borrar ${file.path}`, title: 'Borrar' }, icon('trash')), `toca otra vez para borrar ${file.path}`, () =>
                  remove(file.path),
                ),
          ),
        ),
      );
      if (select) open(select);
    }

    async function open(path) {
      current = path;
      URL.revokeObjectURL(objectUrl);
      [...fileList.children].forEach((item) => (item.dataset.active = item.querySelector('span')?.textContent === path));
      pane.replaceChildren(h('p.editor-empty', {}, 'cargando...'));
      try {
        const blob = await sites.read(site.slug, path);
        if (TEXT.test(path)) {
          const save = h('button.primary.px', { type: 'button' }, icon('globe'), 'guardar y publicar');
          const editor = codeEditor(await blob.text(), path, { onSave: () => save.click() });
          save.addEventListener('click', async () => {
            save.disabled = true;
            try {
              await sites.write(site.slug, path, new Blob([editor.value]));
              mascot.say('guardado y publicado', 2000);
              sound.play('copy');
              refresh();
            } catch (error) {
              fail(error, 'no se pudo guardar');
            }
            save.disabled = false;
          });
          pane.replaceChildren(editor.root, h('div.editor-bar', {}, h('span.hint', {}, 'ctrl+s guarda'), save));
          editor.area.focus();
        } else if (IMAGE.test(path)) {
          objectUrl = URL.createObjectURL(blob);
          pane.replaceChildren(h('div.editor-image', {}, h('img', { src: objectUrl, alt: path })));
        } else {
          pane.replaceChildren(h('p.editor-empty', {}, `${path} no se edita como texto (${size(blob.size)}).`));
        }
      } catch (error) {
        fail(error, 'no pude abrir ese archivo');
      }
    }

    async function remove(path) {
      try {
        await sites.removeFile(site.slug, path);
        sound.play('remove');
        if (current === path) current = null;
        await load(current ?? 'index.html');
        refresh();
      } catch (error) {
        fail(error, 'no se pudo borrar');
      }
    }

    async function add(chosen) {
      if (!chosen.length) return;
      mascot.say('subiendo...', 1600);
      try {
        for (const entry of entriesOf(chosen)) await sites.write(site.slug, entry.path, entry.blob);
        sound.play('chirp');
        mascot.say('subido y publicado', 2000);
        await load(current);
        refresh();
      } catch (error) {
        fail(error, 'no se pudo subir');
      }
    }

    const node = dialog(
      'editor-dialog',
      h(
        'header.editor-head',
        {},
        h('div', {}, h('h2', {}, site.slug), title),
        h('button.icon-btn.px', { type: 'button', 'aria-label': 'Cerrar', title: 'Cerrar', onclick: () => node.close() }, icon('close')),
      ),
      h(
        'div.editor-body',
        {},
        h(
          'aside.editor-side',
          {},
          fileList,
          h(
            'div.editor-actions',
            {},
            h('button.ghost.px', { type: 'button', onclick: async () => add(await picker({})) }, icon('upload'), 'subir archivos'),
            h('button.ghost.px', { type: 'button', onclick: async () => add(await picker({ webkitdirectory: true })) }, icon('folder'), 'subir carpeta'),
          ),
        ),
        pane,
      ),
    );
    node.addEventListener('close', () => URL.revokeObjectURL(objectUrl));
    load('index.html').catch((error) => fail(error, 'no pude abrir la pagina'));
  }

  // ---- tarjetas

  async function download(site) {
    try {
      deliver(await sites.zip(site.slug), `${site.slug}.zip`);
      sound.play('copy');
    } catch (error) {
      fail(error, 'no se pudo descargar');
    }
  }

  async function remove(site) {
    try {
      await sites.remove(site.slug);
      mascot.say('pagina quitada', 1800);
      sound.play('remove');
      refresh();
    } catch (error) {
      fail(error, 'no se pudo quitar');
    }
  }

  function card(site) {
    const thumb = h(
      'a.site-thumb',
      { href: site.url, target: '_blank', rel: 'noopener', 'aria-label': `Abrir ${site.slug}` },
      h('iframe', { src: `${site.url}?v=${site.updated}`, loading: 'lazy', tabindex: -1, sandbox: 'allow-scripts', title: site.slug, 'aria-hidden': 'true' }),
    );
    thumbs.observe(thumb);
    const copy = tool('copy', 'Copiar enlace', async () => {
      await copyText(site.url);
      sound.play('copy');
      copy.replaceChildren(icon('check'));
      setTimeout(() => copy.replaceChildren(icon('copy')), 1400);
    });
    return h(
      'article.site-card.card.px',
      { dataset: { slug: site.slug } },
      thumb,
      h(
        'div.site-info',
        {},
        h('h3', {}, site.slug),
        h('a.site-url', { href: site.url, target: '_blank', rel: 'noopener' }, site.url.replace('https://', '')),
        h('p.site-meta', {}, `${plural(site.files, 'archivo', 'archivos')} · ${size(site.size)} · ${ago(site.updated)}`),
      ),
      h(
        'div.site-tools',
        {},
        h('button.ghost.px.site-bichi', { type: 'button', onclick: () => editWithBichi(site.slug) }, icon('sparkle'), 'editar con bichi'),
        tool('pencil', 'Editar archivos', () => editor(site)),
        copy,
        tool('tag', 'Cambiar direccion', () => renameDialog(site)),
        tool('download', 'Descargar en zip', () => download(site)),
        armed(h('button.site-tool', { type: 'button', 'aria-label': 'Quitar pagina', title: 'Quitar pagina' }, icon('trash')), `toca otra vez para quitar ${site.slug}`, () =>
          remove(site),
        ),
      ),
    );
  }

  function highlight(slug) {
    const node = root.querySelector(`[data-slug="${slug}"]`);
    node?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    node?.classList.add('is-new');
  }

  // ---- vista

  function render() {
    const head = h(
      'header.pages-head',
      {},
      h(
        'div',
        {},
        h('h2', {}, 'bichi ', h('b', {}, 'paginas')),
        h('p', {}, 'tus webs estaticas, en linea para siempre en ', h('code', {}, 'bichi.hacks.win/<nombre>'), '. Solo tu clave puede cambiarlas.'),
      ),
      hasKey() ? h('button.primary.px', { type: 'button', onclick: () => createDialog() }, icon('plus'), 'nueva pagina') : null,
    );
    let body;
    if (!hasKey()) {
      body = h('div.pages-empty.card.px', {}, icon('key'), h('p', {}, 'pon tu clave de la API para ver y cambiar tus paginas.'), h('button.primary.px', { type: 'button', onclick: openKey }, icon('key'), 'poner mi clave'));
    } else if (loading && !list.length) {
      body = h('div.pages-empty.card.px', {}, h('span.typing', {}, h('i'), h('i'), h('i')));
    } else if (!list.length) {
      body = h(
        'div.pages-empty.card.px',
        {},
        icon('globe'),
        h('p', {}, 'aun no tienes paginas. Sube una carpeta con index.html o pidele una a bichi en work.'),
        h('div.drop-actions', {}, h('button.primary.px', { type: 'button', onclick: () => createDialog() }, icon('plus'), 'nueva pagina'), h('a.ghost.px', { href: '#/work' }, icon('work'), 'ir a work')),
      );
    } else {
      body = h('div.site-grid', {}, list.map(card));
    }
    root.replaceChildren(h('div.pages', {}, head, body));
  }

  async function refresh() {
    if (!hasKey()) return render();
    loading = true;
    render();
    try {
      list = await sites.list();
    } catch (error) {
      list = [];
      if (error.status === 401) fail(error, 'esa clave no sirve');
    }
    loading = false;
    render();
  }

  root.addEventListener('dragover', (event) => hasKey() && event.preventDefault());
  root.addEventListener('drop', (event) => {
    if (!hasKey() || root.querySelector('dialog[open]') || !event.dataTransfer.files.length) return;
    event.preventDefault();
    createDialog([...event.dataTransfer.files]);
  });

  return { refresh };
}
