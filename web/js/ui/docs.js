import { h } from '../core/dom.js';
import { sound } from '../core/sound.js';
import { API_BASE, DEFAULT_MODEL, listModels } from '../core/api.js';
import { codeBlock, inline } from './markdown.js';

const KEY = 'TU_CLAVE';

const SAMPLES = {
  curl: [
    'bash',
    `curl ${API_BASE}/chat/completions \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${DEFAULT_MODEL}",
    "messages": [{ "role": "user", "content": "hola" }],
    "stream": true
  }'`,
  ],
  python: [
    'python',
    `from openai import OpenAI

client = OpenAI(base_url="${API_BASE}", api_key="${KEY}")

stream = client.chat.completions.create(
    model="${DEFAULT_MODEL}",
    messages=[{"role": "user", "content": "hola"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)`,
  ],
  javascript: [
    'javascript',
    `import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${API_BASE}', apiKey: '${KEY}' });

const reply = await client.chat.completions.create({
  model: '${DEFAULT_MODEL}',
  messages: [{ role: 'user', content: 'hola' }],
});
console.log(reply.choices[0].message.content);`,
  ],
  opencode: [
    'json',
    `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "hacksllm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "hacksllm",
      "options": { "baseURL": "${API_BASE}", "apiKey": "${KEY}" },
      "models": {
        "${DEFAULT_MODEL}": { "name": "DeepSeek V4.1" },
        "glm-5.2": { "name": "GLM 5.2" },
        "kimi-k2.7": { "name": "Kimi K2.7" }
      }
    }
  },
  "model": "hacksllm/${DEFAULT_MODEL}"
}`,
  ],
};

const ENDPOINTS = [
  ['GET', '/v1/models', 'modelos disponibles para tu clave'],
  ['POST', '/v1/chat/completions', 'chat en formato OpenAI, con `stream: true` opcional'],
  ['POST', '/v1/responses', 'Responses API de OpenAI'],
  ['POST', '/v1/messages', 'formato de Anthropic, para clientes como Claude Code'],
];

const PARAMS = [
  ['model', 'texto', `\`${DEFAULT_MODEL}\` por defecto; mira \`/v1/models\``],
  ['messages', 'lista', 'turnos `{ role, content }` con `system`, `user` y `assistant`'],
  ['stream', 'booleano', 'eventos SSE con `delta.content` y `delta.reasoning_content`'],
  ['temperature', 'numero', '0 a 2'],
  ['max_tokens', 'entero', 'tope de la respuesta'],
  ['tools', 'lista', 'llamadas a funciones en formato OpenAI'],
];

const section = (title, ...children) => h('section.doc-section', {}, h('h3', {}, title), ...children);
const rows = (head, body) =>
  h(
    'div.table-wrap',
    {},
    h('table', {}, h('thead', {}, h('tr', {}, head.map((cell) => h('th', {}, cell)))), h('tbody', {}, body.map((row) => h('tr', {}, row.map((cell) => h('td', {}, ...inline(cell))))))),
  );

function samples() {
  const names = Object.keys(SAMPLES);
  const panel = h('div.sample-panel');
  const tabs = names.map((name) =>
    h('button.sample-tab', { type: 'button', role: 'tab', onclick: () => show(name) }, name),
  );
  function show(name) {
    tabs.forEach((tab, index) => tab.setAttribute('aria-selected', names[index] === name));
    const [language, code] = SAMPLES[name];
    panel.replaceChildren(codeBlock(code, language));
    if (name === 'opencode') panel.append(h('p.doc-note', {}, ...inline('guardalo como `opencode.json` en tu proyecto o en `~/.config/opencode/opencode.json`.')));
    sound.play('tap');
  }
  show(names[0]);
  return h('div.samples', {}, h('div.sample-tabs', { role: 'tablist' }, tabs), panel);
}

export function createDocs({ root }) {
  const modelList = h('ul.model-list', {}, h('li', {}, 'cargando...'));

  root.append(
    h(
      'article.docs.card.px',
      {},
      h('header.docs-head', {}, h('h2', {}, 'API'), h('p', {}, ...inline(`compatible con OpenAI. Apunta cualquier cliente a \`${API_BASE}\` y usa tu clave.`))),
      section('base', codeBlock(API_BASE, 'url')),
      section(
        'autenticacion',
        h('p', {}, ...inline('cada peticion lleva la cabecera `Authorization: Bearer TU_CLAVE`. Las claves se crean en el servidor (ver README).')),
      ),
      section('rutas', rows(['metodo', 'ruta', 'que hace'], ENDPOINTS)),
      section('cuerpo del chat', rows(['campo', 'tipo', 'notas'], PARAMS)),
      section('ejemplos', samples()),
      section(
        'modelos',
        h('p', {}, ...inline('cada modelo prueba primero el suyo y, si esta agotado u ocupado, pasa a otro bueno de la reserva; el campo `model` de la respuesta dice cual contesto.')),
        modelList,
      ),
      section(
        'errores',
        rows(
          ['codigo', 'significado'],
          [
            ['401', 'falta la clave o no es valida'],
            ['429', 'todos los proveedores estan ocupados; reintenta en unos segundos'],
            ['502', 'el proveedor respondio mal; el router ya probo los de reserva'],
          ],
        ),
      ),
    ),
  );

  const refresh = () =>
    listModels()
      .then((models) => modelList.replaceChildren(...models.map((id) => h('li', {}, h('code', {}, id)))))
      .catch(() => modelList.replaceChildren(h('li', {}, ...inline(`\`${DEFAULT_MODEL}\` (pon tu clave para ver la lista completa)`))));
  refresh();
  return { refresh };
}
