#!/bin/bash
# Preparacion unica del servidor (como root): usuario, runtimes, OmniRoute, systemd y nginx.
set -euo pipefail

ROOT=/opt/hacksllm
NODE_VERSION=v24.22.3
HERE="$(cd "$(dirname "$0")" && pwd)"

id hacksllm >/dev/null 2>&1 || useradd --system --home-dir "$ROOT/home" --shell /usr/sbin/nologin hacksllm
install -d -o hacksllm -g hacksllm "$ROOT" "$ROOT/home" "$ROOT/data"

if [ ! -x "$ROOT/runtime/bin/node" ]; then
  mkdir -p "$ROOT/runtime"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" | tar -xJ --strip-components=1 -C "$ROOT/runtime"
fi
[ -x "$ROOT/bun/bin/bun" ] || curl -fsSL https://bun.sh/install | BUN_INSTALL="$ROOT/bun" bash >/dev/null

if [ ! -f "$ROOT/env" ]; then
  sed -e "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')|" \
      -e "s|^API_KEY_SECRET=.*|API_KEY_SECRET=$(openssl rand -hex 32)|" \
      -e "s|^INITIAL_PASSWORD=.*|INITIAL_PASSWORD=$(openssl rand -hex 12)|" \
      "$HERE/omniroute.env" > "$ROOT/env"
  chown root:hacksllm "$ROOT/env" && chmod 640 "$ROOT/env"
fi

install -m 644 "$HERE/hacksllm.service" /etc/systemd/system/hacksllm.service
install -m 644 "$HERE/nginx.conf" /etc/nginx/sites-available/hacksllm
ln -sf /etc/nginx/sites-available/hacksllm /etc/nginx/sites-enabled/hacksllm

systemctl daemon-reload
systemctl enable hacksllm >/dev/null
nginx -t && systemctl reload nginx
