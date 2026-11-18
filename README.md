# hacksllm

Gateway [OmniRoute](https://github.com/cheaper-inference/OmniRoute) con DeepSeek V4.1 gratis, expuesto como API
compatible con OpenAI, y una web de chat en pixel art para probarlo.

- Web y API: https://llm.hacks.win
- Base de la API: `https://llm.hacks.win/v1`
- Modelo: `deepseek-v4.1`

## Como funciona

```
navegador / tu PC                Cloudflare Pages                    VPS
-----------------  --->  llm.hacks.win  ----------------->  llm-origin.hacks.win (nginx, solo /v1)
                         web estatica + functions/v1             |
                                                                 v
                                                        OmniRoute :20128 (systemd hacksllm)
                                                                 |
                                                        relay Bun :20199 -> opencode.ai (capa gratuita)
```

`deepseek-v4.1` es un combo de OmniRoute con prioridad: primero `deepseek-v4.1-flash-free` y, si falla o se
agota, `big-pickle`, `mimo-v2.6-flash-free` y `nemotron-3-ultra-free`, todos de la capa gratuita de OpenCode.
La capa gratuita solo responde a Bun imitando al CLI de OpenCode; de eso se encarga el relay que trae OmniRoute
desde la v3.8.54 y que el servidor arranca solo.

### Sesiones y salidas

- Cada conversacion tiene su propia sesion de OpenCode: OmniRoute la deriva del contenido de la conversacion
  (o usa la `x-opencode-session` que mande el cliente) y cada peticion lleva un id nuevo.
- Cada proxy de `deploy/proxies.mjs` es una conexion aparte. Si una salida falla, el router pasa a la siguiente
  y la conversacion conserva su sesion; tras 3 fallos seguidos el proxy se retira (`PROXY_AUTO_DISABLE`).
- Un 429 de la capa gratuita es cupo, no conectividad: hoy llega a la vez por todas las salidas con la misma
  hora de reinicio, asi que cambiar de proxy no lo resuelve. Para seguir sirviendo hace falta un respaldo de
  otro proveedor en el combo.

La funcion de Pages reenvia `/v1/*` al origen. Las peticiones de la propia web sin clave usan la clave `web`
(secreto `WEB_KEY` del proyecto de Pages); cualquier otro cliente necesita su propia clave.

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
  provision.sh         proveedor, combo y claves
  hacksllm-cli         CLI de OmniRoute con el entorno del servicio
  omniroute.env        plantilla de /opt/hacksllm/env (setup.sh anade las claves nuevas sin tocar las existentes)
functions/v1/          puente same-origin de Pages hacia el gateway
scripts/               build de la web y servidor de desarrollo
web/
  js/art/              sprites pixel a pixel: bichi, iconos, cursores, estanque
  js/core/             almacen, sonido, tema, cliente de la API, historial
  js/ui/               chat, markdown, pagina de la API, mascota
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
deploy/setup.sh                  # una vez, como root
deploy/install-release.sh 3.8.54 # y cada vez que salga una version nueva
deploy/provision.sh
```

El servidor sale del paquete de escritorio de cada release de GitHub, que ya trae el build de Next compilado:
compilarlo en el VPS no cabe en su memoria. Las versiones quedan en `/opt/hacksllm/releases/<version>`, asi que
volver atras es repetir `install-release.sh` con la anterior. El CLI de npm solo se usa para administrar.
