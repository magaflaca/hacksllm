#!/bin/bash
# bichi codex (como root, con bichi work ya instalado): carpeta de la sesion de ChatGPT, el CLI de Codex solo para
# iniciar sesion, servicio y ruta /codex/ en nginx. Idempotente; repetirlo actualiza el codigo. No toca bichi work
# ni bichi agy. Despues: bichi-codex-login (una vez) para conectar la cuenta.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT=/opt/hacksllm
C=/srv/hacksllm-codex

install -d -o hacksllm -g hacksllm -m 700 $C
# El CLI de Codex (solo para `codex login`; quien usa y renueva la sesion es el servicio).
PATH=$ROOT/runtime/bin:$PATH npm install -g --prefix $ROOT/codex-cli @openai/codex@latest >/dev/null
cat > /usr/local/bin/bichi-codex-login <<SH
#!/bin/bash
# Conecta la cuenta de ChatGPT de bichi codex (codigo de dispositivo: se abre el link en cualquier navegador).
cd $C && exec sudo -u hacksllm env HOME=$C CODEX_HOME=$C PATH=$ROOT/runtime/bin:/usr/bin:/bin $ROOT/codex-cli/bin/codex login --device-auth "\$@"
SH
chmod 755 /usr/local/bin/bichi-codex-login

install -d -o hacksllm -g hacksllm $ROOT/work
install -o hacksllm -g hacksllm -m 644 "$HERE"/../work/codex.mjs "$HERE"/../work/auth.mjs $ROOT/work/
install -m 644 "$HERE/hacksllm-codex.service" /etc/systemd/system/hacksllm-codex.service
systemctl daemon-reload
systemctl enable hacksllm-codex >/dev/null
systemctl restart hacksllm-codex

# Ruta /codex/ en nginx (se anade al sitio que ya hay, sin reemplazarlo).
SITE=/etc/nginx/sites-available/hacksllm
if ! grep -q 'location /codex/' $SITE; then
  python3 - $SITE <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
block = """    location /codex/ {
        proxy_pass http://127.0.0.1:20142;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        client_max_body_size 64m;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 900s;
        proxy_send_timeout 600s;
    }

"""
marker = "    location /work/ {"
assert marker in text, "no encontre location /work/"
open(path, "w").write(text.replace(marker, block + marker, 1))
PY
fi
nginx -t && systemctl reload nginx
