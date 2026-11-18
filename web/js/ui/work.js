import { h, copyText } from '../core/dom.js';
import { icon } from '../art/pixels.js';
import { sound } from '../core/sound.js';
import { store } from '../core/store.js';
import { createHistory } from '../core/chats.js';
import { work, deliver } from '../core/work.js';
import { vault, MAX_FILE } from '../core/vault.js';
import { zipBlob } from '../core/zip.js';
import { markdown } from './markdown.js';

const EFFORTS = [
  ['low', 'rapido'],
  ['medium', 'normal'],
  ['high', 'a fondo'],
];
const STEP_ICONS = { write: 'pencil', edit: 'pencil', read: 'eye', run: 'terminal', search: 'lens', web: 'globe', other: 'sparkle' };
const STEP_VERBS = { write: 'escribe', edit: 'edita', read: 'lee', run: 'ejecuta', search: 'busca', web: 'consulta', other: 'usa' };
const SUGGESTIONS = [
  'hazme una landing en html y css para una cafeteria y entregamela en un zip',
  'analiza el csv que te subo y hazme un informe con graficos',
  'escribe un script de python que pase imagenes a webp y pruebalo',
  'crea una api pequena en node con un endpoint de tareas y sus tests',
];
const CONTEXT_TURNS = 6;
const MAX_STEPS = 80;

// Los enlaces a rutas del espacio se descargan con las tarjetas; en el texto quedan como codigo.
const LOCAL_LINK = /\[([^\]\n]+)\]\((?!https?:)[^)\s]+\)(\s*\(`?[^)\n]*`?\))?/g;
const tidy = (text) => text.replace(LOCAL_LINK, '`$1`');
const size = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
const baseName = (path) => path.split('/').pop();
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// Sesiones guardadas en este navegador; al expulsar una vieja se va tambien su copia de archivos.
const sessions = createHistory('work', { limit: 60, onEvict: (item) => vault.drop(item.id) });

export function createWork({ root, mascot, openKey }) {
  const thread = root.querySelector('#work-thread');
  const sessionList = root.querySelector('#work-sessions');
  const fileList = root.querySelector('#work-files');
  const form = root.querySelector('#work-composer');
  const prompt = root.querySelector('#work-prompt');
  const send = root.querySelector('#work-send');
  const effort = root.querySelector('#work-effort');
  const picker = root.querySelector('#work-file');
  const tray = root.querySelector('#work-attachments');
  const zipButton = root.querySelector('[data-action="work-zip"]');
  const publishButton = root.querySelector('[data-action="work-publish"]');
  const pageList = root.querySelector('#work-pages');
  const pageLabel = root.querySelector('#work-pages-label');

  const blank = () => sessions.create({ remote: null });
  let current = sessions.all()[0] ?? blank();
  let pending = [];
  let controller = null;
  let publishing = false;
  const alive = new Set();

  const setPublishing = (on) => {
    publishing = on;
    publishButton.setAttribute('aria-pressed', on);
  };

  const stored = () => Boolean(sessions.find(current.id));
  const persist = () => stored() && sessions.touch(current);

  const setBusy = (busy) => {
    send.replaceChildren(icon(busy ? 'stop' : 'send'));
    send.setAttribute('aria-label', busy ? 'Detener' : 'Enviar');
    send.classList.toggle('is-stop', busy);
    root.classList.toggle('is-busy', busy);
  };

  const resize = () => {
    prompt.style.height = 'auto';
    prompt.style.height = `${Math.min(prompt.scrollHeight, 200)}px`;
  };

  const scrollDown = (force) => {
    const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
    if (force || near) thread.scrollTop = thread.scrollHeight;
  };

  // ---- espacio en el servidor

  // Devuelve el id del espacio remoto; si el servidor ya lo borro, crea otro y le devuelve la copia local.
  async function ensureRemote() {
    if (current.remote && alive.has(current.remote)) return current.remote;
    if (current.remote) {
      try {
        await work.get(current.remote);
        alive.add(current.remote);
        return current.remote;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    current.remote = await work.create();
    alive.add(current.remote);
    persist();
    const copies = await vault.list(current.id);
    if (copies.length) {
      mascot.say('recupero tus archivos', 2400);
      await Promise.all(copies.map((copy) => work.upload(current.remote, { name: copy.path, blob: copy.blob }).catch(() => {})));
    }
    return current.remote;
  }

  async function remoteFiles() {
    if (!work.hasKey() || !current.remote) return null;
    try {
      const files = await work.files(current.remote);
      alive.add(current.remote);
      return files;
    } catch {
      alive.delete(current.remote);
      return null;
    }
  }

  // Guarda en el navegador los archivos que cambio el turno, para que sobrevivan al servidor.
  async function keep(session, files) {
    for (const file of files.filter((item) => item.size <= MAX_FILE)) {
      try {
        await vault.put(session.id, file.path, await work.blob(session.remote, file.path));
      } catch {}
    }
  }

  async function save(path) {
    sound.play('tap');
    try {
      let blob = path ? (await vault.get(current.id, path))?.blob : null;
      if (!blob) {
        try {
          blob = await work.blob(current.remote, path);
        } catch (error) {
          if (path) throw error;
          const copies = await vault.list(current.id);
          if (!copies.length) throw error;
          blob = await zipBlob(copies);
        }
      }
      deliver(blob, path ? baseName(path) : `${slug(current.title) || 'bichi-work'}.zip`);
      sound.play('copy');
    } catch {
      mascot.say('ese archivo ya no esta', 2200);
      sound.play('error');
    }
  }

  // ---- barra lateral

  function renderSessions() {
    const items = sessions.all();
    sessionList.replaceChildren(
      ...items.map((item) =>
        h(
          'li.chat-item',
          { dataset: { active: item.id === current.id } },
          h('button.chat-open', { type: 'button', onclick: () => open(item.id) }, h('span', {}, item.title || 'sin titulo')),
          h('button.chat-remove', { type: 'button', 'aria-label': 'Borrar sesion', title: 'Borrar', onclick: () => remove(item.id) }, icon('trash')),
        ),
      ),
    );
    if (!items.length) sessionList.append(h('li.chat-empty', {}, 'aun no hay sesiones'));
  }

  function renderPages() {
    const list = current.pages ?? [];
    pageList.hidden = pageLabel.hidden = !list.length;
    pageList.replaceChildren(
      ...list.map((page) =>
        h(
          'li.chat-item',
          {},
          h('a.chat-open.page-open', { href: page.url, target: '_blank', rel: 'noopener', title: page.url }, icon('globe'), h('span', {}, page.slug)),
          h('button.chat-remove', { type: 'button', 'aria-label': `Despublicar ${page.slug}`, title: 'Despublicar', onclick: () => unpublish(page.slug) }, icon('trash')),
        ),
      ),
    );
  }

  async function unpublish(slug) {
    if (!(await work.unpublish(slug).catch(() => false))) {
      mascot.say('no pude quitarla', 2200);
      return sound.play('error');
    }
    current.pages = (current.pages ?? []).filter((page) => page.slug !== slug);
    persist();
    renderPages();
    mascot.say('pagina quitada', 1800);
    sound.play('remove');
  }

  function rememberPage(session, page) {
    session.pages = [{ slug: page.slug, url: page.url }, ...(session.pages ?? []).filter((item) => item.slug !== page.slug)];
    if (session === current) renderPages();
  }

  async function refreshFiles() {
    const session = current;
    const files = (await remoteFiles()) ?? (await vault.list(session.id)).map(({ path, size }) => ({ path, size }));
    if (session !== current) return;
    fileList.replaceChildren(
      ...files.map((file) =>
        h(
          'li.file-item',
          {},
          h('button.file-open', { type: 'button', title: `Descargar ${file.path}`, onclick: () => save(file.path) }, icon('file'), h('span', {}, file.path)),
          h('span.file-size', {}, size(file.size)),
        ),
      ),
    );
    if (!files.length) fileList.append(h('li.chat-empty', {}, 'aun no hay archivos'));
    zipButton.disabled = !files.length;
  }

  function show(session) {
    current = session;
    pending = [];
    renderTray();
    renderThread();
    renderSessions();
    renderPages();
    refreshFiles();
    root.dispatchEvent(new CustomEvent('chat:opened'));
  }

  function open(id) {
    if (controller) return mascot.say('espera que termine', 2000);
    show(sessions.find(id) ?? current);
    sound.play('tap');
  }

  // Una sesion sin mensajes no se guarda: si se abandona, se limpia su espacio.
  function discardBlank() {
    if (stored()) return;
    vault.drop(current.id);
    if (current.remote) work.remove(current.remote);
  }

  function startNew() {
    if (controller) return mascot.say('espera que termine', 2000);
    discardBlank();
    show(blank());
    sound.play('select');
    prompt.focus();
  }

  function remove(id) {
    if (controller) return mascot.say('espera que termine', 2000);
    const item = sessions.find(id);
    if (!item) return;
    sessions.remove(id);
    vault.drop(id);
    if (item.remote) work.remove(item.remote);
    sound.play('remove');
    if (id === current.id) show(sessions.all()[0] ?? blank());
    else renderSessions();
  }

  // ---- adjuntos

  function renderTray() {
    tray.replaceChildren(
      ...pending.map((item) =>
        h(
          'span.chip.px',
          { dataset: { state: item.state } },
          icon(item.state === 'error' ? 'close' : 'file'),
          h('span', {}, item.name),
          item.state === 'up' ? h('i.chip-bar', { style: `--done:${Math.round(item.progress * 100)}%` }) : null,
          h('button.chip-x', { type: 'button', 'aria-label': `Quitar ${item.name}`, onclick: () => ((pending = pending.filter((p) => p !== item)), renderTray()) }, icon('close')),
        ),
      ),
    );
    tray.hidden = !pending.length;
  }

  async function attach(files) {
    if (!work.hasKey()) return locked();
    const session = current;
    let id;
    try {
      id = await ensureRemote();
    } catch (error) {
      return report(error);
    }
    sound.play('select');
    await Promise.all(
      files.map(async (file) => {
        const item = { name: file.name, state: 'up', progress: 0 };
        pending.push(item);
        renderTray();
        try {
          const { path } = await work.upload(id, file, (progress) => ((item.progress = progress), renderTray()));
          Object.assign(item, { name: path, state: 'ok' });
          vault.put(session.id, path, file);
        } catch (error) {
          item.state = 'error';
          mascot.say(error.message, 2600);
          sound.play('error');
        }
        renderTray();
      }),
    );
    refreshFiles();
  }

  // ---- hilo

  function welcome() {
    const title = h('h2', {}, 'bichi ', h('b', {}, 'work'));
    if (!work.hasKey()) {
      return h(
        'div.welcome',
        {},
        title,
        h('p', {}, 'un espacio de trabajo de verdad: subes archivos, ejecuto codigo, instalo lo que haga falta y te entrego los resultados. Funciona con tu clave de la API.'),
        h('div.welcome-actions', {}, h('button.primary.px', { type: 'button', onclick: openKey }, icon('key'), 'poner mi clave')),
      );
    }
    return h(
      'div.welcome',
      {},
      title,
      h('p', {}, 'sube lo que quieras y pideme algo: lo construyo, lo pruebo y te lo entrego en archivos. Tus sesiones y archivos se guardan en este navegador.'),
      h(
        'div.suggestions',
        {},
        SUGGESTIONS.map((text) => h('button.suggestion.px', { type: 'button', onclick: () => ((prompt.value = text), resize(), sound.play('select'), prompt.focus()) }, text)),
      ),
    );
  }

  function stepsBlock(steps, live, status) {
    if (!steps?.length && !live) return null;
    const label = live ? status || 'trabajando' : `${steps.length} ${steps.length === 1 ? 'paso' : 'pasos'}`;
    return h(
      'details.reasoning.steps',
      { open: live },
      h('summary', {}, icon('sparkle'), h('span', {}, label), icon('chevron')),
      h(
        'ol.step-list',
        {},
        (steps ?? []).map((step) =>
          h('li.step', { dataset: { state: step.state } }, icon(STEP_ICONS[step.kind] ?? 'sparkle'), h('span.step-verb', {}, STEP_VERBS[step.kind] ?? 'usa'), h('code', {}, step.label)),
        ),
      ),
    );
  }

  const fileCard = (file) =>
    h(
      'button.file-card.px',
      { type: 'button', title: `Descargar ${file.path}`, onclick: () => save(file.path) },
      icon('file'),
      h('span.file-name', {}, file.path),
      h('span.file-size', {}, size(file.size)),
      icon('download'),
    );

  function pageCard(page) {
    const copy = h('button.page-copy', { type: 'button', 'aria-label': 'Copiar enlace', title: 'Copiar enlace' }, icon('copy'));
    copy.addEventListener('click', async () => {
      await copyText(page.url);
      sound.play('copy');
      copy.replaceChildren(icon('check'));
      setTimeout(() => copy.replaceChildren(icon('copy')), 1400);
    });
    return h(
      'div.page-card.px',
      {},
      icon('globe'),
      h(
        'div.page-text',
        {},
        h('span.page-kicker', {}, page.updated ? 'bichi pagina actualizada' : 'bichi pagina publicada'),
        h('a.page-link', { href: page.url, target: '_blank', rel: 'noopener' }, page.url.replace(/^https:\/\//, '')),
      ),
      copy,
    );
  }

  function deliverables(files) {
    if (!files?.length) return null;
    const zip = files.length > 1 && h('button.file-card.is-zip.px', { type: 'button', onclick: () => save() }, icon('download'), h('span.file-name', {}, 'todo el espacio en .zip'));
    return h('div.deliverables', {}, files.map(fileCard), zip);
  }

  function botNode(message, live = false) {
    const node = h('article.msg.msg-bot', {}, h('div.msg-body'));
    paint(node, message, live);
    return node;
  }

  function paint(node, message, live) {
    const parts = [stepsBlock(message.steps, live, message.status)];
    if (message.content) parts.push(...markdown(tidy(message.content)));
    else if (live) parts.push(h('span.typing', {}, h('i'), h('i'), h('i')));
    if (message.page) parts.push(pageCard(message.page));
    if (message.notice) parts.push(h('p.msg-note.px', {}, message.notice));
    parts.push(deliverables(message.files));
    if (message.error) parts.push(h('p.msg-error.px', {}, message.error));
    node.querySelector('.msg-body').replaceChildren(...parts.filter(Boolean));
  }

  const userNode = (message) =>
    h(
      'article.msg.msg-user',
      {},
      h('div.msg-body.px', {}, message.content, message.uploads?.length ? h('div.msg-uploads', {}, message.uploads.map((name) => h('span.chip.px', {}, icon('file'), h('span', {}, name)))) : null),
    );

  function renderThread() {
    const nodes = current.messages.map((message) => (message.role === 'user' ? userNode(message) : botNode(message)));
    thread.replaceChildren(...(nodes.length ? nodes : [welcome()]));
    scrollDown(true);
  }

  // ---- turno

  function report(error) {
    if (error.status === 401) {
      mascot.say('esa clave no sirve aqui', 2600);
      openKey();
    } else mascot.say(error.message || 'algo fallo', 2600);
    sound.play('error');
  }

  function locked() {
    mascot.say('primero pon tu clave', 2200);
    sound.play('tap');
    openKey();
  }

  // Ultimos turnos de esta sesion, por si el servidor empieza un espacio nuevo sin memoria.
  const context = () =>
    current.messages
      .slice(0, -1)
      .filter((message) => message.content)
      .slice(-CONTEXT_TURNS)
      .map(({ role, content }) => ({ role, text: content.slice(0, 2000) }));

  async function answer(message, uploads, publish) {
    const session = current;
    const reply = { role: 'assistant', content: '', steps: [], files: [], status: '' };
    const node = botNode(reply, true);
    thread.append(node);
    scrollDown(true);
    controller = new AbortController();
    setBusy(true);
    mascot.setMood('thinking');
    let frame = 0;
    const repaint = () => (frame ||= requestAnimationFrame(() => ((frame = 0), paint(node, reply, true), scrollDown())));
    try {
      const body = { message, effort: effort.value, uploads, context: context(), publish, page: session.pages?.[0]?.slug };
      for await (const event of work.run(session.remote, body, controller.signal)) {
        if (event.type === 'status') reply.status = event.text;
        else if (event.type === 'text') reply.content += event.delta;
        else if (event.type === 'step') {
          const index = reply.steps.findIndex((step) => step.id === event.id);
          const step = { id: event.id, kind: event.kind, label: event.label, state: event.state };
          if (index >= 0) reply.steps[index] = step;
          else if (reply.steps.length < MAX_STEPS) reply.steps.push(step), sound.play('tap');
        } else if (event.type === 'files') reply.files = event.files.map(({ path, size }) => ({ path, size }));
        else if (event.type === 'done') reply.content = event.text || reply.content;
        else if (event.type === 'notice') reply.notice = event.message;
        else if (event.type === 'page') {
          reply.page = { slug: event.slug, url: event.url, updated: event.updated };
          rememberPage(session, event);
          sound.play('chirp');
        }
        else if (event.type === 'error') reply.error = event.message;
        repaint();
      }
      if (reply.error) throw new Error(reply.error);
      mascot.setMood('happy', 1800);
      mascot.say(reply.page ? 'ya esta en linea' : reply.files.length ? 'aqui tienes' : 'listo', 1800);
      sound.play('done');
    } catch (error) {
      if (error.name === 'AbortError') mascot.setMood('idle');
      else {
        reply.error ||= error.status === 401 ? 'la clave de la API no es valida' : `algo fallo: ${error.message}`;
        mascot.setMood('sad', 2600);
        report(error);
      }
    } finally {
      cancelAnimationFrame(frame);
      controller = null;
      setBusy(false);
      delete reply.status;
      sessions.push(session, reply);
      if (session === current) node.replaceWith(botNode(reply));
      await keep(session, reply.files);
      if (session === current) refreshFiles();
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (controller) {
      work.stop(current.remote);
      return controller.abort();
    }
    if (!work.hasKey()) return locked();
    const content = prompt.value.trim();
    if (!content) {
      mascot.say('cuentame que hacemos', 2000);
      return sound.play('tap');
    }
    if (pending.some((item) => item.state === 'up')) return mascot.say('espera, aun subo archivos', 2000);
    try {
      await ensureRemote();
    } catch (error) {
      return report(error);
    }
    const uploads = pending.filter((item) => item.state === 'ok').map((item) => item.name);
    pending = [];
    renderTray();
    const message = { role: 'user', content, uploads };
    if (!current.messages.length) thread.replaceChildren();
    sessions.push(current, message);
    thread.append(userNode(message));
    prompt.value = '';
    resize();
    sound.play('send');
    const publish = publishing;
    setPublishing(false);
    answer(content, uploads, publish);
  }

  effort.replaceChildren(...EFFORTS.map(([value, label]) => h('option', { value, selected: value === store.get('workEffort', 'medium') }, label)));
  effort.addEventListener('change', () => (store.set('workEffort', effort.value), sound.play('select')));
  form.addEventListener('submit', submit);
  prompt.addEventListener('input', resize);
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(pointer: fine)').matches) submit(event);
  });
  picker.addEventListener('change', () => (attach([...picker.files]), (picker.value = '')));
  root.querySelector('[data-action="work-attach"]').addEventListener('click', () => (work.hasKey() ? picker.click() : locked()));
  root.querySelector('[data-action="work-new"]').addEventListener('click', startNew);
  zipButton.addEventListener('click', () => save());
  publishButton.addEventListener('click', () => {
    if (!work.hasKey()) return locked();
    setPublishing(!publishing);
    sound.play(publishing ? 'on' : 'off');
    if (publishing) mascot.say('lo publico como bichi pagina', 2200);
  });
  root.addEventListener('dragover', (event) => (event.preventDefault(), root.classList.add('is-dropping')));
  root.addEventListener('dragleave', (event) => event.target === root && root.classList.remove('is-dropping'));
  root.addEventListener('drop', (event) => {
    event.preventDefault();
    root.classList.remove('is-dropping');
    if (event.dataTransfer.files.length) attach([...event.dataTransfer.files]);
  });
  sessions.onChange(renderSessions);

  const refresh = () => (renderThread(), renderSessions(), renderPages(), refreshFiles());
  renderTray();
  refresh();
  return { refresh };
}
