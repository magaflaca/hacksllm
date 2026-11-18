import { icon, mountIcons, spriteCanvas } from './art/pixels.js';
import { BEETLE_FRAMES, BEETLE_PALETTES } from './art/beetle.js';
import { startPond } from './art/pond.js';
import { installCursors } from './core/cursor.js';
import { sound } from './core/sound.js';
import { store } from './core/store.js';
import { theme } from './core/theme.js';
import { createMascot } from './ui/mascot.js';
import { createChat } from './ui/chat.js';
import { createDocs } from './ui/docs.js';
import { createWork } from './ui/work.js';
import { createPages } from './ui/pages.js';
import { createCode } from './ui/code.js';

const $ = (selector) => document.querySelector(selector);
const action = (name) => document.querySelectorAll(`[data-action="${name}"]`);
const VIEWS = { chat: '#/', work: '#/work', pages: '#/paginas', code: '#/code', docs: '#/api' };

installCursors();
mountIcons();
document.querySelector('#favicon').href = spriteCanvas(BEETLE_FRAMES.idle, BEETLE_PALETTES.light, 4).toDataURL();

const pond = startPond($('#pond'), () => theme.current);
const mascot = createMascot({ canvas: $('#mascot'), bubble: $('#bubble'), getTheme: () => theme.current });

const keyDialog = $('#key-dialog');
const keyInput = $('#key-input');
const openKey = () => {
  keyInput.value = store.get('apiKey', '');
  keyDialog.showModal();
  sound.play('select');
};

const chatView = $('#view-chat');
const chat = createChat({ root: chatView, mascot, openKey });
const workView = $('#view-work');
const workspace = createWork({ root: workView, mascot, openKey });
const docs = createDocs({ root: $('#view-docs') });
const codeView = createCode({ root: $('#view-code'), openKey });
const go = (name) => (history.replaceState(null, '', VIEWS[name]), showView(name));
const sitesPanel = createPages({
  root: $('#view-pages'),
  mascot,
  openKey,
  editWithBichi: (slug) => (go('work'), workspace.editPage(slug)),
});
const perch = $('.perch');

const activeView = () => document.querySelector('[data-view-panel]:not([hidden])');
const setDrawer = (open) => activeView()?.classList.toggle('drawer-open', open);
[chatView, workView].forEach((view) => view.addEventListener('chat:opened', () => setDrawer(false)));

function showView(name) {
  setDrawer(false);
  for (const panel of document.querySelectorAll('[data-view-panel]')) panel.hidden = panel.dataset.viewPanel !== name;
  for (const tab of document.querySelectorAll('[data-view]')) tab.setAttribute('aria-selected', tab.dataset.view === name);
  document.body.dataset.view = name;
  activeView().querySelector('.composer')?.prepend(perch);
  if (name === 'pages') sitesPanel.refresh();
  if (name === 'code') codeView.refresh();
}
const viewFromHash = () => Object.keys(VIEWS).find((name) => VIEWS[name] === location.hash) ?? 'chat';

document.querySelectorAll('[data-view]').forEach((tab) =>
  tab.addEventListener('click', () => {
    history.replaceState(null, '', VIEWS[tab.dataset.view]);
    showView(tab.dataset.view);
    sound.play('select');
  }),
);
addEventListener('hashchange', () => showView(viewFromHash()));
showView(viewFromHash());

const paintToggles = () => {
  action('sound').forEach((button) => button.replaceChildren(icon(sound.muted ? 'soundOff' : 'soundOn')));
  action('theme').forEach((button) => button.replaceChildren(icon(theme.current === 'dark' ? 'sun' : 'moon')));
};
paintToggles();

action('sound').forEach((button) => button.addEventListener('click', () => (sound.toggle() || mascot.say('la la la', 1600), paintToggles())));
action('theme').forEach((button) =>
  button.addEventListener('click', () => {
    theme.toggle();
    pond.repaint();
    mascot.redraw();
    paintToggles();
    sound.play(theme.current === 'dark' ? 'off' : 'on');
    mascot.say(theme.current === 'dark' ? 'buenas noches' : 'buenos dias', 1800);
  }),
);
action('drawer').forEach((button) => button.addEventListener('click', () => (setDrawer(!activeView().classList.contains('drawer-open')), sound.play('tap'))));
action('new').forEach((button) => button.addEventListener('click', chat.startNew));
action('key').forEach((button) => button.addEventListener('click', openKey));

keyDialog.addEventListener('close', () => {
  if (!keyDialog.returnValue) return;
  store.set('apiKey', keyDialog.returnValue === 'save' ? keyInput.value.trim() : '');
  sound.play('copy');
  mascot.say(keyDialog.returnValue === 'save' ? 'clave guardada' : 'clave quitada', 1800);
  chat.refreshModels();
  docs.refresh();
  workspace.refresh();
  sitesPanel.refresh();
  codeView.refresh();
});
keyDialog.addEventListener('click', (event) => event.target === keyDialog && keyDialog.close());

$('#mascot').addEventListener('click', () => {
  mascot.setMood('happy', 1200);
  mascot.say(['hola', 'bzz', 'que tal', 'aqui estoy'][Math.floor(Math.random() * 4)], 1600);
  sound.play('chirp');
});

setTimeout(() => mascot.say('hola, preguntame algo', 3200), 700);
