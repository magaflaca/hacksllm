// Pestaña code: instalar bichi code (comando para copiar o instalador descargable) y lo que sabe hacer.
import { BEETLE_FRAMES, BEETLE_PALETTES } from '../art/beetle.js';
import { LOGO_PALETTE, logoRows } from '../art/letters.js';
import { icon, spriteCanvas } from '../art/pixels.js';
import { copyText, h } from '../core/dom.js';
import { sound } from '../core/sound.js';
import { store } from '../core/store.js';
import { codeBlock, inline } from './markdown.js';

const SITE = 'https://llm.hacks.win';

const SYSTEMS = {
  windows: {
    label: 'windows',
    language: 'powershell',
    command: `irm ${SITE}/code/install.ps1 | iex`,
    where: 'en PowerShell',
    file: { href: '/code/instalar-bichi.cmd', name: 'instalar-bichi.cmd', label: 'descargar instalador' },
  },
  unix: {
    label: 'macos y linux',
    language: 'bash',
    command: `curl -fsSL ${SITE}/code/install.sh | sh`,
    where: 'en tu terminal',
    file: { href: '/code/install.sh', name: 'install.sh', label: 'descargar install.sh' },
  },
};

const FEATURES = [
  ['sky', 'trabaja en tu compu', 'lee el proyecto, edita archivos, ejecuta comandos y pruebas, busca en la web. te muestra cada cambio con su diff.'],
  ['mint', 'nunca se queda sin modelo', 'en auto empieza por el mas rapido y, si uno se agota, sigue con el siguiente sin que tengas que hacer nada.'],
  ['butter', 'tu decides cuanto pregunta', 'shift+tab cambia de modo: normal, acepta ediciones, plan (propone antes de tocar) o sin preguntas.'],
  ['blush', 'agentes en paralelo', 'lanza subagentes para investigar o hacer partes del trabajo a la vez, y lleva una lista de tareas.'],
  ['sky', 'memoria del proyecto', 'BICHI.md guarda como se trabaja en tu repo. /init lo crea solo; #nota agrega algo al vuelo.'],
  ['mint', 'tus claves, tus modelos', 'ademas de hacksllm puedes conectar NVIDIA build, Mistral, Groq, OpenRouter, Cerebras, Ollama o cualquier api compatible.'],
];

const KEYS = [
  ['shift+tab', 'cambiar de modo'],
  ['esc', 'interrumpir'],
  ['esc esc', 'volver a un mensaje anterior'],
  ['@archivo', 'adjuntar un archivo'],
  ['!comando', 'ejecutar en la shell'],
  ['#nota', 'guardar en la memoria'],
  ['ctrl+o', 'ver resultados completos'],
  ['alt+enter', 'nueva linea'],
];

const COMMANDS = [
  ['/model', 'elegir modelo o auto'],
  ['/effort', 'esfuerzo bajo, medio o alto'],
  ['/config', 'ajustes, proveedores y claves'],
  ['/resume', 'retomar una conversacion'],
  ['/undo', 'deshacer los ultimos cambios'],
  ['/compact', 'resumir para liberar contexto'],
  ['/init', 'crear BICHI.md'],
  ['/review', 'revisar los cambios del repo'],
];

// Terminal de muestra: una sesion corta de bichi que aparece linea a linea.
const SCRIPT = [
  ['user', '› arregla el test de login que falla'],
  ['tool', 'Leer', 'src/auth/login.test.ts'],
  ['res', '84 lineas'],
  ['tool', 'Shell', 'npm test -- login'],
  ['res', '1 fallo: esperaba 200 y llego 401', 'warn'],
  ['tool', 'Editar', 'src/auth/session.ts'],
  ['res', '1 linea nueva, 1 quitada'],
  ['del', '12 - if (token.exp < Date.now()) return null'],
  ['add', '12 + if (token.exp * 1000 < Date.now()) return null'],
  ['tool', 'Shell', 'npm test -- login'],
  ['res', '12 pasan', 'ok'],
  ['say', 'el token venia en segundos y se comparaba con milisegundos. ya pasa el test.'],
];

function terminal() {
  const beetle = spriteCanvas(BEETLE_FRAMES.happy, BEETLE_PALETTES.light, 3);
  beetle.className = 'term-beetle';
  const logo = spriteCanvas(logoRows('BICHI CODE'), LOGO_PALETTE, 3);
  logo.className = 'term-logo';
  const lines = SCRIPT.map(([kind, a, b], index) => {
    const style = `--i:${index}`;
    if (kind === 'user') return h('div.t-line.t-user', { style }, a);
    if (kind === 'tool') return h('div.t-line', { style }, h('span.t-dot', {}, '●'), ' ', h('b', {}, a), ' ', h('span.t-soft', {}, b));
    if (kind === 'res') return h('div.t-line.t-res', { style }, h('span.t-soft', {}, '⎿  '), h(`span.t-${b ?? 'soft'}`, {}, a));
    if (kind === 'say') return h('div.t-line.t-say', { style }, h('span.t-ice', {}, '● '), a);
    return h(`div.t-line.t-diff.t-${kind}`, { style }, a);
  });
  return h(
    'div.term.px',
    { 'aria-label': 'Ejemplo de bichi code trabajando', role: 'img' },
    h('div.term-bar', {}, h('i'), h('i'), h('i'), h('span', {}, 'bichi — ~/mi-proyecto')),
    h(
      'div.term-body',
      {},
      h('div.term-banner', {}, beetle, h('div', {}, logo, h('div.t-soft', {}, 'v1.0.0 · tu bicho programador'))),
      ...lines,
      h('div.term-input', { style: `--i:${SCRIPT.length}` }, h('span.t-brand', {}, '›'), h('span.term-caret')),
      h('div.term-status', { style: `--i:${SCRIPT.length}` }, h('span.t-plum', {}, '▸▸ acepta ediciones'), h('span.t-sky', {}, 'auto · bichi-turbo')),
    ),
  );
}

function installer() {
  const panel = h('div.install-panel');
  const names = Object.keys(SYSTEMS);
  const tabs = names.map((name) => h('button.sample-tab', { type: 'button', role: 'tab', onclick: () => show(name, true) }, SYSTEMS[name].label));
  function show(name, sound_ = false) {
    const system = SYSTEMS[name];
    tabs.forEach((tab, index) => tab.setAttribute('aria-selected', names[index] === name));
    panel.replaceChildren(
      h('p.install-where', {}, `copia esto ${system.where}:`),
      codeBlock(system.command, system.language),
      h(
        'div.install-actions',
        {},
        h('a.primary.px', { href: system.file.href, download: system.file.name, onclick: () => sound.play('select') }, icon('download'), system.file.label),
        h('span.install-or', {}, ...inline(name === 'windows' ? 'doble clic y listo, o el comando de arriba' : 'o el comando de arriba')),
      ),
    );
    if (sound_) sound.play('tap');
  }
  show(/windows/i.test(navigator.userAgent) ? 'windows' : 'unix');
  return h('div.install', {}, h('div.sample-tabs', { role: 'tablist' }, tabs), panel);
}

function keyRow(openKey) {
  const row = h('div.key-row');
  const paint = () => {
    const key = store.get('apiKey', '');
    if (!key) {
      row.replaceChildren(h('span', {}, 'la primera vez bichi te pide tu api key de hacksllm.'), h('button.ghost.px', { type: 'button', onclick: openKey }, icon('key'), 'poner mi clave'));
      return;
    }
    const copy = h('button.ghost.px', { type: 'button' }, icon('copy'), 'copiar mi clave');
    copy.addEventListener('click', async () => {
      await copyText(key);
      sound.play('copy');
      copy.replaceChildren(icon('check'), 'copiada');
      setTimeout(() => copy.replaceChildren(icon('copy'), 'copiar mi clave'), 1600);
    });
    row.replaceChildren(h('span', {}, 'la primera vez bichi te pide tu api key; pega la tuya:'), h('code', {}, `${key.slice(0, 6)}…${key.slice(-4)}`), copy);
  };
  paint();
  addEventListener('storage', paint);
  return { row, paint };
}

const table = (rows) =>
  h('div.table-wrap', {}, h('table', {}, h('tbody', {}, rows.map(([a, b]) => h('tr', {}, h('td', {}, h('code', {}, a)), h('td', {}, b))))));

export function createCode({ root, openKey }) {
  const key = keyRow(openKey);
  root.append(
    h(
      'article.code-page',
      {},
      h(
        'section.code-hero.card.px',
        {},
        h(
          'div.code-intro',
          {},
          h('h2', {}, 'bichi ', h('b', {}, 'code')),
          h('p', {}, 'tu bicho programador en la terminal. entiende tu proyecto, edita, ejecuta y prueba por ti, con los modelos de hacksllm.'),
          installer(),
          h('p.code-start', {}, ...inline('despues abre una terminal en tu proyecto y escribe `bichi`.')),
          key.row,
        ),
        terminal(),
      ),
      h(
        'section.code-features',
        {},
        FEATURES.map(([color, title, text]) => h('div.code-feature.card.px', {}, h(`i.dot-${color}`), h('b', {}, title), h('span', {}, text))),
      ),
      h(
        'section.code-ref.card.px',
        {},
        h('div', {}, h('h3', {}, 'atajos'), table(KEYS)),
        h('div', {}, h('h3', {}, 'comandos'), table(COMMANDS), h('p.doc-note', {}, ...inline('`/help` dentro de bichi muestra todos. tambien: `bichi -p "tarea"` sin interfaz, `bichi -c` para continuar y `bichi update`.'))),
      ),
    ),
  );
  return { refresh: key.paint };
}
