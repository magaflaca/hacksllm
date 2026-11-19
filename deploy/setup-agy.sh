#!/bin/bash
# bichi agy (como root, con bichi work ya instalado y agy logueado como root): usuario propio para el agente, disco
# FUSE, bash falsa, wrapper con sudo, servicio y ruta /agy/ en nginx. Idempotente; repetirlo actualiza el codigo.
# No toca ni reinicia bichi work.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT=/opt/hacksllm
A=/srv/hacksllm-agy

DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fuse3 python3-venv >/dev/null
id hacksllm-agy >/dev/null 2>&1 || useradd --system --no-create-home --home-dir $A/home --shell /usr/sbin/nologin hacksllm-agy
install -d -o root -g root -m 755 $A $A/bin $A/io $A/.local $A/.local/bin
install -d -o hacksllm -g hacksllm -m 755 $A/t
install -d -o hacksllm-agy -g hacksllm-agy -m 700 $A/home $A/home/.gemini $A/home/.gemini/antigravity-cli

# agy con la sesion de Google de root, y la bash falsa delante de todo en su PATH.
install -m 755 /root/.local/bin/agy $A/.local/bin/agy
install -o hacksllm-agy -g hacksllm-agy -m 600 /root/.gemini/antigravity-cli/antigravity-oauth-token $A/home/.gemini/antigravity-cli/
echo '{"trustedWorkspaces":["/pc"]}' > $A/home/.gemini/antigravity-cli/settings.json
chown hacksllm-agy:hacksllm-agy $A/home/.gemini/antigravity-cli/settings.json
install -m 755 "$HERE/../work/agy-shim.py" $A/bin/bash

# FUSE: el servicio monta el disco y root (systemd) lo ata dentro del sandbox, asi que hace falta allow_other.
grep -q '^user_allow_other' /etc/fuse.conf || echo user_allow_other >> /etc/fuse.conf
[ -x $ROOT/agy-venv/bin/python ] || python3 -m venv $ROOT/agy-venv
$ROOT/agy-venv/bin/pip install -q --upgrade mfusepy

install -m 755 "$HERE/bichi-agy-run" /usr/local/bin/bichi-agy-run
echo 'hacksllm ALL=(root) NOPASSWD: /usr/local/bin/bichi-agy-run' > /etc/sudoers.d/hacksllm-agy
chmod 440 /etc/sudoers.d/hacksllm-agy && visudo -cq

install -d -o hacksllm -g hacksllm $ROOT/work
install -o hacksllm -g hacksllm -m 644 "$HERE"/../work/*.mjs "$HERE/../work/agy-fs.py" $ROOT/work/
printf 'AGY_UID=%s\nAGY_GID=%s\n' "$(id -u hacksllm-agy)" "$(id -g hacksllm-agy)" > $ROOT/agy.env
install -m 644 "$HERE/hacksllm-agy.service" /etc/systemd/system/hacksllm-agy.service
systemctl daemon-reload
systemctl enable hacksllm-agy >/dev/null
systemctl restart hacksllm-agy

# Ruta /agy/ en nginx (se anade al sitio que ya hay, sin reemplazarlo).
SITE=/etc/nginx/sites-available/hacksllm
if ! grep -q 'location /agy/' $SITE; then
  python3 - $SITE <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
block = """    location /agy/ {
        proxy_pass http://127.0.0.1:20140;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        client_max_body_size 64m;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1800s;
        proxy_send_timeout 600s;
    }

"""
marker = "    location /work/ {"
assert marker in text, "no encontre location /work/"
open(path, "w").write(text.replace(marker, block + marker, 1))
PY
fi
nginx -t && systemctl reload nginx
