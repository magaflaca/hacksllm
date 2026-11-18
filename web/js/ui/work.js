import { h } from '../core/dom.js';
import { icon } from '../art/pixels.js';
import { sound } from '../core/sound.js';
import { work } from '../core/work.js';
import { markdown } from './markdown.js';

const SAVED = 'hacksllm:work';
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

// Los enlaces a rutas del espacio se descargan con las tarjetas; en el texto quedan como codigo.
const LOCAL_LINK = /\[([^\]\n]+)\]\((?!https?:)[^)\s]+\)(\s*\(`?[^)\n]*`?\))?/g;
const tidy = (text) => text.replace(LOCAL_LINK, '`$1`');
const size = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
const baseName = (path) => path.split('/').pop();

function readSaved() {
  try {
    return JSON.parse(sessionStorage.getItem(SAVED)) ?? {};
  } catch {
    return {};
  }
}

export function createWork({ root, mascot, openKey }) {
  const thread = root.querySelector('#work-thread');
  const fileList = root.querySelector('#work-files');
  const form = root.querySelector('#work-composer');
  const prompt = root.querySelector('#work-prompt');
  const send = root.querySelector('#work-send');
  const effort = root.querySelector('#work-effort');
  const picker = root.querySelector('#work-file');
  const tray = root.querySelector('#work-attachments');

  let state = { id: null, messages: [], effort: 'medium', ...readSaved() };
  let pending = [];
  let controller = null;

  const persist = () => {
    try {
      sessionStorage.setItem(SAVED, JSON.stringify(state));
    } catch {}
  };

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

  async function save(path) {
    try {
      sound.play('tap');
      await work.save(state.id, path, path ? baseName(path) : 'bichi-work.zip');
      sound.play('copy');
    } catch (error) {
      mascot.say(error.status === 404 ? 'ese archivo ya no esta' : 'no pude descargarlo', 2200);
      sound.play('error');
    }
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

  // ---- sesion

  async function ensureSession() {
    if (state.id) return state.id;
    state.id = await work.create();
    persist();
    return state.id;
  }

  async function refreshFiles() {
    if (!work.hasKey() || !state.id) return renderFiles([]);
    try {
      renderFiles(await work.files(state.id));
    } catch (error) {
      if (error.status === 404) {
        state = { ...state, id: null, messages: [] };
        persist();
        renderThread();
      }
      renderFiles([]);
    }
  }

  function renderFiles(files) {
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
    root.querySelector('[data-action="work-zip"]').disabled = !files.length;
  }

  async function startNew() {
    if (controller) return;
    if (state.id) work.remove(state.id);
    state = { id: null, messages: [], effort: state.effort };
    pending = [];
    persist();
    renderTray();
    renderThread();
    renderFiles([]);
    sound.play('select');
    root.dispatchEvent(new CustomEvent('chat:opened'));
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
    let id;
    try {
      id = await ensureSession();
    } catch (error) {
      return report(error);
    }
    sound.play('select');
    await Promise.all(
      [...files].map(async (file) => {
        const item = { name: file.name, state: 'up', progress: 0 };
        pending.push(item);
        renderTray();
        try {
          const { path } = await work.upload(id, file, (progress) => ((item.progress = progress), renderTray()));
          Object.assign(item, { name: path, state: 'ok' });
        } catch (error) {
          Object.assign(item, { state: 'error' });
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
    if (!work.hasKey()) {
      return h(
        'div.welcome',
        {},
        h('h2', {}, 'bichi ', h('b', {}, 'work')),
        h('p', {}, 'un espacio de trabajo de verdad: subes archivos, ejecuto codigo, instalo lo que haga falta y te entrego los resultados. Funciona con tu clave de la API.'),
        h('div.welcome-actions', {}, h('button.primary.px', { type: 'button', onclick: openKey }, icon('key'), 'poner mi clave')),
      );
    }
    return h(
      'div.welcome',
      {},
      h('h2', {}, 'bichi ', h('b', {}, 'work')),
      h('p', {}, 'sube lo que quieras y pideme algo: lo construyo, lo pruebo y te lo entrego en archivos.'),
      h(
        'div.suggestions',
        {},
        SUGGESTIONS.map((text) => h('button.suggestion.px', { type: 'button', onclick: () => ((prompt.value = text), resize(), sound.play('select'), prompt.focus()) }, text)),
      ),
    );
  }

  function stepsBlock(steps, live, status) {
    if (!steps.length && !live) return null;
    const label = live ? status || 'trabajando' : `${steps.length} ${steps.length === 1 ? 'paso' : 'pasos'}`;
    return h(
      'details.reasoning.steps',
      { open: live },
      h('summary', {}, icon('sparkle'), h('span', {}, label), icon('chevron')),
      h(
        'ol.step-list',
        {},
        steps.map((step) =>
          h('li.step', { dataset: { state: step.state } }, icon(STEP_ICONS[step.kind] ?? 'sparkle'), h('span.step-verb', {}, STEP_VERBS[step.kind] ?? 'usa'), h('code', {}, step.label)),
        ),
      ),
    );
  }

  function deliverables(files) {
    if (!files?.length) return null;
    const zip = files.length > 1 && h('button.file-card.is-zip.px', { type: 'button', onclick: () => save() }, icon('download'), h('span.file-name', {}, 'todo el espacio en .zip'));
    return h('div.deliverables', {}, files.map(fileCard), zip);
  }

  function botNode(message, live = false) {
    const body = h('div.msg-body');
    const node = h('article.msg.msg-bot', {}, body);
    paint(node, message, live);
    return node;
  }

  function paint(node, message, live) {
    const parts = [stepsBlock(message.steps, live, message.status)];
    if (message.content) parts.push(...markdown(tidy(message.content)));
    else if (live) parts.push(h('span.typing', {}, h('i'), h('i'), h('i')));
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
    const nodes = state.messages.map((message) => (message.role === 'user' ? userNode(message) : botNode(message)));
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

  async function answer(message, uploads) {
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
      for await (const event of work.run(state.id, { message, effort: state.effort, uploads }, controller.signal)) {
        if (event.type === 'status') reply.status = event.text;
        else if (event.type === 'text') reply.content += event.delta;
        else if (event.type === 'step') {
          const index = reply.steps.findIndex((step) => step.id === event.id);
          const step = { id: event.id, kind: event.kind, label: event.label, state: event.state };
          if (index < 0) reply.steps.push(step), sound.play('tap');
          else reply.steps[index] = step;
        } else if (event.type === 'files') reply.files = event.files;
        else if (event.type === 'done') reply.content = event.text || reply.content;
        else if (event.type === 'error') reply.error = event.message;
        repaint();
      }
      if (reply.error) throw new Error(reply.error);
      mascot.setMood('happy', 1800);
      mascot.say(reply.files.length ? 'aqui tienes' : 'listo', 1800);
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
      state.messages.push(reply);
      persist();
      node.replaceWith(botNode(reply));
      refreshFiles();
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (controller) {
      work.stop(state.id);
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
      await ensureSession();
    } catch (error) {
      return report(error);
    }
    const uploads = pending.filter((item) => item.state === 'ok').map((item) => item.name);
    pending = [];
    renderTray();
    const message = { role: 'user', content, uploads };
    if (!state.messages.length) thread.replaceChildren();
    state.messages.push(message);
    persist();
    thread.append(userNode(message));
    prompt.value = '';
    resize();
    sound.play('send');
    answer(content, uploads);
  }

  effort.replaceChildren(...EFFORTS.map(([value, label]) => h('option', { value, selected: value === state.effort }, label)));
  effort.addEventListener('change', () => ((state.effort = effort.value), persist(), sound.play('select')));
  form.addEventListener('submit', submit);
  prompt.addEventListener('input', resize);
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(pointer: fine)').matches) submit(event);
  });
  picker.addEventListener('change', () => (attach([...picker.files]), (picker.value = '')));
  root.querySelector('[data-action="work-attach"]').addEventListener('click', () => (work.hasKey() ? picker.click() : locked()));
  root.querySelector('[data-action="work-new"]').addEventListener('click', startNew);
  root.querySelector('[data-action="work-zip"]').addEventListener('click', () => save());
  root.addEventListener('dragover', (event) => (event.preventDefault(), root.classList.add('is-dropping')));
  root.addEventListener('dragleave', (event) => event.target === root && root.classList.remove('is-dropping'));
  root.addEventListener('drop', (event) => {
    event.preventDefault();
    root.classList.remove('is-dropping');
    if (event.dataTransfer.files.length) attach([...event.dataTransfer.files]);
  });

  const refresh = () => (renderThread(), refreshFiles());
  renderTray();
  refresh();
  return { refresh };
}
