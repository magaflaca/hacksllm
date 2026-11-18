#!/bin/bash
# bichi work (como root, despues de provision.sh y con agy ya logueado como root): usuario aislado, herramientas
# del agente, motor de respaldo con OmniRoute, wrapper con sudo, servicio y nginx. Idempotente; repetirlo
# actualiza el codigo del servidor.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT=/opt/hacksllm
H=/srv/hacksllm-work
AS_WORK=(sudo -u hacksllm-work -H env HOME=$H PATH=$H/.local/npm/bin:$H/.local/bin:/usr/bin:/bin)

DEBIAN_FRONTEND=noninteractive apt-get install -y -qq zip unzip python3-venv >/dev/null
id hacksllm-work >/dev/null 2>&1 || useradd --system --home-dir $H --shell /bin/bash hacksllm-work
install -d -o hacksllm-work -g hacksllm-work -m 711 $H
install -d -o root -g hacksllm -m 750 $H/ws
install -d -o hacksllm-work -g hacksllm-work -m 700 $H/.gemini/antigravity-cli $H/.config/opencode
install -d -o hacksllm-work -g hacksllm-work $H/.local $H/.local/bin

# agy con la sesion de Google de root; el agente la necesita para trabajar.
install -o hacksllm-work -g hacksllm-work -m 755 /root/.local/bin/agy $H/.local/bin/agy
install -o hacksllm-work -g hacksllm-work -m 600 /root/.gemini/antigravity-cli/antigravity-oauth-token $H/.gemini/antigravity-cli/
echo '{"trustedWorkspaces":["/srv/hacksllm-work/ws"]}' > $H/.gemini/antigravity-cli/settings.json

# Node 24 con npm propio y opencode como motor de respaldo sobre OmniRoute.
[ -x $H/.local/node/bin/node ] || cp -a $ROOT/runtime $H/.local/node
for bin in node npm npx; do ln -sf ../node/bin/$bin $H/.local/bin/$bin; done
chown -R hacksllm-work:hacksllm-work $H/.local $H/.gemini
"${AS_WORK[@]}" npm config set prefix $H/.local/npm
[ -x $H/.local/npm/bin/opencode ] || "${AS_WORK[@]}" npm install -g --no-audit --no-fund --loglevel=error opencode-ai

KEY=/root/hacksllm-key-work.txt
[ -s $KEY ] || { hacksllm-cli api api-keys post-api-keys --body '{"name":"work"}' | grep -oE "sk-[A-Za-z0-9_-]{20,}" | head -1 > $KEY; chmod 600 $KEY; }
python3 - "$(cat $KEY)" > $H/.config/opencode/opencode.json <<'PY'
import json, sys
models = ["nemotron-3-ultra", "deepseek-v4.1", "glm-5.2", "kimi-k2.7", "gpt-oss-120b"]
print(json.dumps({
    "$schema": "https://opencode.ai/config.json", "autoupdate": False, "share": "disabled",
    "enabled_providers": ["hacksllm"], "model": "hacksllm/nemotron-3-ultra",
    "provider": {"hacksllm": {"npm": "@ai-sdk/openai-compatible", "name": "hacksllm",
        "options": {"baseURL": "http://127.0.0.1:20128/v1", "apiKey": sys.argv[1]},
        "models": {m: {"name": m} for m in models}}},
}, indent=2))
PY
chown -R hacksllm-work:hacksllm-work $H/.config && chmod 600 $H/.config/opencode/opencode.json

install -m 755 "$HERE/bichi-run" /usr/local/bin/bichi-run
echo 'hacksllm ALL=(root) NOPASSWD: /usr/local/bin/bichi-run' > /etc/sudoers.d/hacksllm-work
chmod 440 /etc/sudoers.d/hacksllm-work && visudo -cq

install -d -o hacksllm -g hacksllm $ROOT/work $ROOT/data/work
install -o hacksllm -g hacksllm -m 644 "$HERE"/../work/*.mjs $ROOT/work/
install -m 644 "$HERE/hacksllm-work.service" /etc/systemd/system/hacksllm-work.service
install -m 644 "$HERE/nginx.conf" /etc/nginx/sites-available/hacksllm
systemctl daemon-reload
systemctl enable --now hacksllm-work >/dev/null
systemctl restart hacksllm-work
nginx -t && systemctl reload nginx
