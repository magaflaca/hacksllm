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
de sistema; DuckDuckGo limita rapido con rafagas.

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

- Una sesion por visita (se guarda en `sessionStorage`), ligada al hash de la clave que la creo. El espacio vive
  en `/srv/hacksllm-work/ws/<id>` y se borra tras 6 h sin uso.
- El sandbox solo ve su propia sesion: sin `/root`, `/opt`, `/home`, `/var/lib` ni las demas sesiones, con
  1.2 GB de RAM, 2 CPU, 25 min por turno y sin sudo. Puede instalar con pip `--user`, uv, venv o npm.
- Motores en orden: agy con el esfuerzo elegido (rapido, normal, a fondo), el respaldo de agy, y opencode contra
  el combo `nemotron-3-ultra` de OmniRoute con la clave `work`. Un motor que falla por cupo descansa 30 min.
  La web nunca muestra que modelo trabajo.
- Un turno a la vez (`WORK_CONCURRENCY`); los demas esperan en cola.
- El agente necesita la sesion de Google de agy, asi que quien tenga una clave podria leerla desde su espacio:
  reparte claves solo a gente de confianza.

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
  provision.sh         proveedores, combos (models.mjs) y claves
  models.mjs           combos publicos y su reserva comun
  hacksllm-cli         CLI de OmniRoute con el entorno del servicio
  omniroute.env        plantilla de /opt/hacksllm/env (setup.sh anade las claves nuevas sin tocar las existentes)
  setup-work.sh        bichi work: usuario aislado, agy, opencode, sudoers, servicio
  bichi-run            lanza el agente en el sandbox (root, via sudo)
functions/             puentes same-origin de Pages: v1 (gateway) y work (agente)
lib/origin.js          reenvio comun de esos puentes
work/                  API de bichi work: sesiones, cola y motores
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
