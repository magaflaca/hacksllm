# hacksllm

Gateway [OmniRoute](https://github.com/cheaper-inference/OmniRoute) con modelos grandes gratis y sin claves de
proveedor (DeepSeek, GLM, Kimi, Nemotron, GPT, Claude), expuesto como API compatible con OpenAI, y una web de chat
en pixel art para probarlo.

- Web y API: https://llm.hacks.win
- Base de la API: `https://llm.hacks.win/v1`
- Modelo por defecto: `deepseek-v4.1` (lista completa en `/v1/models`)

## Como funciona

```
navegador / tu PC                Cloudflare Pages                    VPS
-----------------  --->  llm.hacks.win  ----------------->  llm-origin.hacks.win (nginx, solo /v1)
                         web estatica + functions/v1             |
                                                                 v
                                                        OmniRoute :20128 (systemd hacksllm)
                                                                 |
                                     +---------------------------+---------------+-----------------+
                                     |                           |               |                 |
                          relay Bun -> OpenCode     Chromium -> Cloudflare    DuckDuckGo     Kilo (anonimo)
                                                    AI Playground             AI Chat
```

La funcion de Pages reenvia `/v1/*` al origen. Las peticiones de la propia web sin clave usan la clave `web`
(secreto `WEB_KEY` del proyecto de Pages); cualquier otro cliente necesita su propia clave.

## Modelos

Todos los proveedores son los que OmniRoute sabe usar sin clave ni cuenta:

| proveedor | que aporta | como entra |
|---|---|---|
| OpenCode (capa gratuita) | DeepSeek V4.1, Big Pickle, MiMo (imagenes) | relay Bun que imita al CLI de OpenCode |
| Cloudflare AI Playground | DeepSeek V4 Pro, GLM 5.2, Kimi K2.7, gpt-oss-120b | Chromium sin cabeza (Playwright) por WebSocket |
| DuckDuckGo AI Chat | GPT-5.6 Luna, GPT-5.4 mini, Claude Haiku 4.5 | sesion anonima con su reto JS |
| Kilo | Nemotron 3 Ultra 550B, Nemotron 3.5 VL (imagenes) | clave anonima de OpenRouter de Kilo |

Pollinations, UncloseAI y AI Horde tambien figuran como gratuitos en OmniRoute, pero hoy los dos primeros piden
clave y el tercero son modelos pequenos de voluntarios con colas de minutos, asi que no estan.

Los modelos publicos son combos de prioridad definidos en `deploy/models.mjs`: `deepseek-v4.1`, `deepseek-v4-pro`,
`glm-5.2`, `kimi-k2.7`, `nemotron-3-ultra`, `gpt-5.6-luna`, `claude-haiku-4.5` y `gpt-oss-120b`. Cada uno prueba
primero su modelo y despues una reserva comun (GLM, Kimi, Nemotron, Big Pickle, modelos con vision...), asi que si
una capa gratuita se agota o limita por IP la respuesta llega de otra. El campo `model` de la respuesta dice
quien contesto. Las imagenes acaban en un modelo con vision de la reserva.

Limites conocidos: la capa de OpenCode se agota a diario por IP; Cloudflare limita por minuto e ignora el prompt
de sistema del cliente; DuckDuckGo limita rapido con rafagas.

`deploy/patch-release.mjs` ajusta el build compilado de cada release (lo llama `install-release.sh`): el Playground
de Cloudflare arranca con un prompt que promete herramientas MCP que no tiene, y los modelos anunciaban que iban a
buscar algo y no respondian; el parche le pone un prompt neutro. Si una version nueva cambia ese codigo, avisa.

## bichi work

El tab `work` es un agente con espacio de trabajo propio: subes archivos, ejecuta codigo e instala dependencias
en el VPS y entrega los resultados como archivos (y un .zip con todo). Solo funciona con una clave de la API: la
funcion `functions/work` no pone la clave web.

```
web (#/work) -> Pages /work/* -> nginx /work/ -> hacksllm-work :20130 (usuario hacksllm)
                                                    |  sudo bichi-run (unico paso con root)
                                                    v
                                     systemd-run como hacksllm-work, sandbox por sesion
                                     agy  ->  agy (respaldo)  ->  opencode + OmniRoute
```

- Las sesiones viven en el navegador: la conversacion en `localStorage` (historial en la barra lateral, hasta 60)
  y una copia de las subidas y entregables en IndexedDB (hasta 25 MB por archivo y 400 MB en total). Se pueden
  descargar, tambien en .zip, aunque el servidor ya no tenga el espacio.
- En el servidor cada sesion tiene un espacio en `/srv/hacksllm-work/ws/<id>`, ligado al hash de la clave que lo
  creo, que se borra tras 48 h sin uso. Al seguir una sesion vieja se crea otro espacio, se le suben los archivos
  guardados en el navegador y el agente recibe los ultimos turnos como contexto.
- El sandbox solo ve su propia sesion: sin `/root`, `/opt`, `/home`, `/var/lib` ni las demas sesiones, con
  1.2 GB de RAM, 2 CPU, 25 min por turno y sin sudo. Puede instalar con pip `--user`, uv, venv o npm.
- Motores en orden: agy con el esfuerzo elegido (rapido, normal, a fondo), el respaldo de agy, y opencode contra
  el combo `nemotron-3-ultra` de OmniRoute con la clave `work`. Un motor que falla por cupo descansa 30 min.
  La web nunca muestra que modelo trabajo.
- Un turno a la vez (`WORK_CONCURRENCY`); los demas esperan en cola.
- Mientras trabaja se le puede escribir: el turno en curso se corta y empieza otro en la misma conversacion, con
  los archivos como quedaron y la nueva indicacion (agy no admite mensajes a mitad de turno).
- El agente necesita la sesion de Google de agy, asi que quien tenga una clave podria leerla desde su espacio:
  reparte claves solo a gente de confianza.

### bichi paginas

Webs estaticas en `https://bichi.hacks.win/<nombre>` que no caducan: viven hasta que su dueno (la clave que las
publico) las quita. Se crean desde bichi work (boton del globo o pidiendolo) o desde el panel.

```
bichi.hacks.win/<nombre>/...  ->  worker bichi/ (Cloudflare)  ->  KV bichi-pages     (el VPS no sirve nada)
bichi.hacks.win/              ->  portada del worker, con enlace al panel
llm.hacks.win/#/paginas       ->  panel: lista, nueva (zip, archivos o carpeta), editor, renombrar, zip, quitar
work y panel                  ->  /work/pages del VPS: copia fuente en data/bichi-sites y registro de duenos
```

- El panel vive en llm.hacks.win y no en bichi.hacks.win a proposito: las paginas publicadas ejecutan JavaScript
  de cualquiera en el origen bichi.hacks.win, asi que un panel ahi podria robar claves.
- "editar con bichi" abre la pagina en una sesion nueva de work (su codigo en `pagina/`) y el siguiente turno la
  vuelve a publicar en la misma direccion.
- Solo archivos estaticos (html, css, js, imagenes, fuentes, medios): hasta 300 archivos, 10 MB por archivo y 25 MB
  por pagina. Nunca se copian ni sirven enlaces simbolicos.
- A KV solo se suben los archivos que cambiaron (por hash): el plan gratis admite 1000 escrituras y 100k lecturas
  al dia. Cloudflare cachea 60 s, asi que un cambio puede tardar hasta un minuto en verse en cada region.
- Configuracion: `BICHI_ACCOUNT`, `BICHI_KV` y `BICHI_TOKEN` en `/opt/hacksllm/env` (el token se crea en Cloudflare
  con permisos Workers KV Storage Read y Write). El worker se despliega con `npm run deploy:bichi`.

## bichi code

Agente de programacion en la terminal (pestana **code** de la web). Un solo archivo de Node sin dependencias
(`dist/code/bichi.mjs`, unos 120 KB) que se instala con:

```bash
irm https://llm.hacks.win/code/install.ps1 | iex          # Windows (PowerShell)
curl -fsSL https://llm.hacks.win/code/install.sh | sh     # macOS y Linux
```

El instalador deja `bichi` en `~/.bichi/bin` (en el PATH) y, si no hay Node 20+, baja uno portable a
`~/.bichi/node`. La primera vez pide la api key de hacksllm; la config vive en `~/.bichi/config.json`.

- **Modelos**: nombres bichi (`bichi-turbo`, `bichi-max`, `bichihacks`...) con `/names` para ver los reales. En `auto`
  sigue la cadena de `code/src/providers.mjs` (ordenada midiendo rapidez y acierto) y salta al siguiente cuando uno
  se agota, falla o responde vacio; cada modelo descansa un rato segun el error.
- **Herramientas en texto**: casi todos los combos terminan en proveedores sin tool calling, asi que con hacksllm las
  herramientas se describen en el prompt y el modelo las llama con `<tool name="...">{json}</tool>`
  (`code/src/core/protocol.mjs`). Con otros proveedores usa tool calling nativo y cae a texto si no lo soportan.
  Requiere el parche del Playground de `deploy/patch-release.mjs` (respeta el mensaje de sistema del cliente).
- **Otros proveedores**: NVIDIA build, Mistral, Groq, OpenRouter, Cerebras, Ollama o cualquier api compatible
  desde `/config`.
- **App de pantalla completa**: historial con scroll y raton (seleccion que copia, links clicables), comandos y
  archivos sugeridos encima de la entrada, imagenes (alt+v o pegar una ruta; un modelo con vision las describe),
  esc esc para rebobinar conversacion y codigo, `/goal` para trabajar solo hasta cumplir algo, `/context`.
- **Traer conversaciones**: `/import` de Claude Code o Codex y `/tp` de bichi work (boton "llevar a bichi code",
  guardado en `/opt/hacksllm/data/transport` por clave). Las grandes se resumen por partes con los modelos gratis;
  en pantalla se ve la conversacion original completa.
- **Bichi paginas**: `/paginas` lista, abre, trae para editar o quita tus webs de bichi.hacks.win, y
  `/paginas publicar` sube una carpeta con index.html (zip contra `/work/pages/<nombre>`). El agente tiene
  `pages_list`, `page_publish` y `page_download`.
- **Contexto**: los resultados viejos de herramientas van recortados y al 75% la conversacion se resume sola
  (si resumir falla, recorta lo mas viejo).
- **Carpeta .bichi**: memoria `.bichi/BICHI.md`, ajustes, agentes, comandos y skills del proyecto (tambien lee
  `.claude/`, CLAUDE.md y AGENTS.md); sesiones por proyecto en `~/.bichi/projects`.
- **Lo demas**: modos con shift+tab (normal, acepta ediciones, plan, sin preguntas), permisos con diff, subagentes
  en paralelo (`task`), lista de tareas, memoria `BICHI.md` (`/init`, `#nota`), agentes y comandos propios en
  `.bichi/agents` y `.bichi/commands`, hooks y servidores MCP en `.bichi/settings.json`, `/undo`, `/resume`,
  `/compact` (y resumen automatico), `!comando`, `@archivo`, redirigir mientras trabaja y `bichi -p` sin interfaz.

`npm run build` empaqueta tambien bichi code; `node scripts/build-code.js` solo el CLI.

## Usarlo desde tu PC

```bash
curl https://llm.hacks.win/v1/chat/completions \
  -H "Authorization: Bearer $HACKSLLM_KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1","messages":[{"role":"user","content":"hola"}]}'
```

En opencode, `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "hacksllm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "hacksllm",
      "options": { "baseURL": "https://llm.hacks.win/v1", "apiKey": "{env:HACKSLLM_KEY}" },
      "models": { "deepseek-v4.1": { "name": "DeepSeek V4.1" } }
    }
  },
  "model": "hacksllm/deepseek-v4.1"
}
```

## Claves

Las crea `deploy/provision.sh` y quedan en el servidor en `/root/hacksllm-key-<nombre>.txt`. Para mas:

```bash
hacksllm-cli api api-keys post-api-keys --body '{"name":"otra"}'
hacksllm-cli keys list
```

El panel de OmniRoute no se publica. Para abrirlo: `ssh -L 20128:127.0.0.1:20128 root@servidor` y
http://localhost:20128 (la contrasena inicial esta en `INITIAL_PASSWORD` de `/opt/hacksllm/env`).

## Estructura

```
deploy/
  setup.sh             preparacion unica: usuario, Node 24, Bun, CLI de OmniRoute, systemd, nginx
  install-release.sh   instala el servidor de una version publicada y cambia /opt/hacksllm/current
  patch-release.mjs    parches al build de OmniRoute que aun no estan upstream
  provision.sh         proveedores, combos (models.mjs) y claves
  models.mjs           combos publicos y su reserva comun
  hacksllm-cli         CLI de OmniRoute con el entorno del servicio
  omniroute.env        plantilla de /opt/hacksllm/env (setup.sh anade las claves nuevas sin tocar las existentes)
  setup-work.sh        bichi work: usuario aislado, agy, opencode, sudoers, servicio
  bichi-run            lanza el agente en el sandbox (root, via sudo)
functions/             puentes same-origin de Pages: v1 (gateway) y work (agente)
lib/origin.js          reenvio comun de esos puentes
work/                  API de bichi work: sesiones, cola, motores y bichi paginas
bichi/                 worker de bichi.hacks.win que sirve las paginas desde KV
code/src/              bichi code: interfaz de terminal (ui/), agente y enrutado (core/), herramientas (tools/)
web/code/              instaladores de bichi code (el build agrega bichi.mjs y version.txt)
scripts/               build de la web y servidor de desarrollo
web/
  js/art/              sprites pixel a pixel: bichi, iconos, cursores, estanque
  js/core/             almacen, sonido, tema, cliente de la API, historial
  js/ui/               chat, work, markdown, pagina de la API, mascota
  css/                 tokens, base, cabecera, chat, documentacion
```

## Desarrollo

```bash
npm install
npm run dev                         # http://localhost:8800, /v1 va a produccion
DEV_KEY=sk-... npm run dev          # con clave para el chat local
npm run deploy:web                  # build y despliegue en Cloudflare Pages
npm run deploy:bichi                # worker de bichi paginas
```

## Servidor

```bash
deploy/setup.sh                  # una vez, como root (incluye Playwright y Chromium)
deploy/install-release.sh 3.8.54 # y cada vez que salga una version nueva
deploy/provision.sh              # y cada vez que cambie deploy/models.mjs
deploy/setup-work.sh             # bichi work; repetirlo actualiza work/ en el servidor
```

El servidor sale del paquete de escritorio de cada release de GitHub, que ya trae el build de Next compilado:
compilarlo en el VPS no cabe en su memoria. Las versiones quedan en `/opt/hacksllm/releases/<version>`, asi que
volver atras es repetir `install-release.sh` con la anterior. El CLI de npm solo se usa para administrar.
