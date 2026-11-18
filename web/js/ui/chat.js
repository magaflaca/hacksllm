import { h, copyText } from '../core/dom.js';
import { icon } from '../art/pixels.js';
import { sound } from '../core/sound.js';
import { store } from '../core/store.js';
import { history } from '../core/chats.js';
import { streamChat, listModels, DEFAULT_MODEL } from '../core/api.js';
import { markdown } from './markdown.js';

const SUGGESTIONS = [
  'explicame los closures de javascript con un ejemplo corto',
  'escribe un haiku sobre un estanque de noche',
  'dame un script de bash que renombre fotos por fecha',
  'que diferencia hay entre TCP y UDP, en una tabla',
];

const CHEERS = ['listo', 'ahi va', 'tachan', 'hecho con carino'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export function createChat({ root, mascot, openKey }) {
  const thread = root.querySelector('#thread');
  const list = root.querySelector('#chat-list');
  const form = root.querySelector('#composer');
  const prompt = root.querySelector('#prompt');
  const send = root.querySelector('#send');
  const modelPicker = root.querySelector('#model');

  let chat = history.create({ model: store.get('model', DEFAULT_MODEL) });
  let controller = null;

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

  function renderModels(models) {
    const ids = [...new Set([DEFAULT_MODEL, chat.model, ...models])];
    modelPicker.replaceChildren(...ids.map((id) => h('option', { value: id, selected: id === chat.model }, id)));
  }

  function renderList() {
    const chats = history.all();
    list.replaceChildren(
      ...chats.map((item) =>
        h(
          'li.chat-item',
          { dataset: { active: item.id === chat.id } },
          h('button.chat-open', { type: 'button', onclick: () => open(item.id) }, h('span', {}, item.title || 'sin titulo')),
          h('button.chat-remove', { type: 'button', 'aria-label': 'Borrar conversacion', title: 'Borrar', onclick: () => remove(item.id) }, icon('trash')),
        ),
      ),
    );
    if (!chats.length) list.append(h('li.chat-empty', {}, 'aun no hay conversaciones'));
  }

  function emptyState() {
    return h(
      'div.welcome',
      {},
      h('h2', {}, 'hola, soy ', h('b', {}, 'bichi')),
      h('p', {}, 'preguntame lo que quieras. intentaré responderte y darlo todo'),
      h(
        'div.suggestions',
        {},
        SUGGESTIONS.map((text) =>
          h('button.suggestion.px', { type: 'button', onclick: () => ((prompt.value = text), resize(), sound.play('select'), prompt.focus()) }, text),
        ),
      ),
    );
  }

  function messageActions(message, index) {
    const copy = h('button.msg-action', { type: 'button', 'aria-label': 'Copiar respuesta', title: 'Copiar' }, icon('copy'));
    copy.addEventListener('click', async () => {
      await copyText(message.content);
      sound.play('copy');
      copy.replaceChildren(icon('check'));
      setTimeout(() => copy.replaceChildren(icon('copy')), 1400);
    });
    const last = index === chat.messages.length - 1;
    const retry = last && h('button.msg-action', { type: 'button', 'aria-label': 'Repetir respuesta', title: 'Repetir', onclick: regenerate }, icon('retry'));
    return h('div.msg-actions', {}, copy, retry);
  }

  function reasoningBlock(text, live) {
    return h(
      'details.reasoning',
      { open: live },
      h('summary', {}, icon('sparkle'), h('span', {}, live ? 'pensando' : 'pensamiento'), icon('chevron')),
      h('div.reasoning-body', {}, text),
    );
  }

  function messageNode(message, index, live = false) {
    if (message.role === 'user') return h('article.msg.msg-user', {}, h('div.msg-body.px', {}, message.content));
    const body = h('div.msg-body');
    const node = h('article.msg.msg-bot', {}, body);
    fillAnswer(node, message, live);
    if (!live && !message.error) node.append(messageActions(message, index));
    return node;
  }

  function fillAnswer(node, message, live) {
    const body = node.querySelector('.msg-body');
    const parts = [];
    if (message.reasoning) parts.push(reasoningBlock(message.reasoning, live && !message.content));
    if (message.content) parts.push(...markdown(message.content));
    else if (live) parts.push(h('span.typing', {}, h('i'), h('i'), h('i')));
    if (message.error) parts.push(h('p.msg-error.px', {}, message.error));
    body.replaceChildren(...parts);
  }

  function failedNode(text) {
    const retry = h('button.msg-action', { type: 'button', 'aria-label': 'Reintentar', title: 'Reintentar', onclick: retryFailed }, icon('retry'));
    return h('article.msg.msg-bot', {}, h('div.msg-body', {}, h('p.msg-error.px', {}, text)), h('div.msg-actions', {}, retry));
  }

  function renderThread() {
    thread.replaceChildren(...(chat.messages.length ? chat.messages.map((message, index) => messageNode(message, index)) : [emptyState()]));
    scrollDown(true);
  }

  function open(id) {
    if (controller) controller.abort();
    chat = history.find(id) ?? chat;
    renderModels([...modelPicker.options].map((option) => option.value));
    renderThread();
    renderList();
    sound.play('tap');
    root.dispatchEvent(new CustomEvent('chat:opened'));
  }

  function startNew() {
    if (controller) controller.abort();
    chat = history.create({ model: modelPicker.value || DEFAULT_MODEL });
    renderThread();
    renderList();
    sound.play('select');
    prompt.focus();
    root.dispatchEvent(new CustomEvent('chat:opened'));
  }

  function remove(id) {
    history.remove(id);
    sound.play('remove');
    if (id === chat.id) chat = history.create({ model: chat.model });
    renderThread();
    renderList();
  }

  async function answer() {
    const reply = { role: 'assistant', content: '', reasoning: '' };
    const node = messageNode(reply, chat.messages.length, true);
    thread.append(node);
    scrollDown(true);
    controller = new AbortController();
    setBusy(true);
    mascot.setMood('thinking');
    let painted = 0;
    let first = true;
    const paint = () => {
      painted = 0;
      fillAnswer(node, reply, true);
      scrollDown();
    };
    try {
      const messages = chat.messages.map(({ role, content }) => ({ role, content }));
      for await (const { content, reasoning } of streamChat({ model: chat.model, messages, signal: controller.signal })) {
        if (first && content) {
          first = false;
          sound.play('reply');
        }
        reply.content += content;
        reply.reasoning += reasoning;
        painted ||= requestAnimationFrame(paint);
      }
      mascot.setMood('happy', 1600);
      mascot.say(pick(CHEERS), 1800);
      sound.play('done');
    } catch (error) {
      if (error.name === 'AbortError') {
        mascot.setMood('idle');
      } else {
        reply.error = error.status === 401 ? 'la clave de la API no es valida' : `algo fallo: ${error.message}`;
        mascot.setMood('sad', 2600);
        mascot.say('uy, no pude responder', 2600);
        sound.play('error');
        if (error.status === 401) openKey();
      }
    } finally {
      cancelAnimationFrame(painted);
      controller = null;
      setBusy(false);
      if (reply.content || reply.reasoning) {
        history.push(chat, reply);
        node.replaceWith(messageNode(reply, chat.messages.length - 1));
      } else if (reply.error) {
        node.replaceWith(failedNode(reply.error));
      } else {
        node.remove();
      }
      renderList();
    }
  }

  function retryFailed() {
    thread.lastElementChild.remove();
    answer();
  }

  function regenerate() {
    if (controller || chat.messages.at(-1)?.role !== 'assistant') return;
    chat.messages.pop();
    history.touch(chat);
    renderThread();
    answer();
  }

  function submit(event) {
    event.preventDefault();
    if (controller) return controller.abort();
    const content = prompt.value.trim();
    if (!content) {
      mascot.say('escribe algo primero', 2000);
      return sound.play('tap');
    }
    if (!chat.messages.length) thread.replaceChildren();
    history.push(chat, { role: 'user', content });
    thread.append(messageNode({ role: 'user', content }, chat.messages.length - 1));
    prompt.value = '';
    resize();
    sound.play('send');
    renderList();
    answer();
  }

  form.addEventListener('submit', submit);
  prompt.addEventListener('input', resize);
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(pointer: fine)').matches) submit(event);
  });
  modelPicker.addEventListener('change', () => {
    chat.model = modelPicker.value;
    store.set('model', chat.model);
    if (chat.messages.length) history.touch(chat);
    sound.play('select');
  });
  history.onChange(renderList);

  const refreshModels = () =>
    listModels()
      .then(renderModels)
      .catch(() => renderModels([]));

  renderModels([]);
  renderThread();
  renderList();
  refreshModels();

  return { startNew, refreshModels };
}
