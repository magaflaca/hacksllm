#!/bin/bash
# Instala el servidor de una version publicada de OmniRoute a partir de su paquete de escritorio,
# que ya trae el build de Next compilado, mas el relay de Bun de la misma etiqueta. Uso: install-release.sh 3.8.54
set -euo pipefail

VERSION=${1:?indica la version, por ejemplo 3.8.54}
ROOT=/opt/hacksllm
REPO=https://github.com/cheaper-inference/OmniRoute
TARGET=$ROOT/releases/$VERSION
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

if [ ! -f "$TARGET/server.js" ]; then
  curl -fsSL -o "$WORK/app.deb" "$REPO/releases/download/v$VERSION/omniroute-desktop_${VERSION}_amd64.deb"
  dpkg-deb -x "$WORK/app.deb" "$WORK/x"
  mkdir -p "$ROOT/releases"
  rm -rf "$TARGET" && mv "$WORK/x/opt/OmniRoute/resources/app" "$TARGET"
  rm -f "$TARGET/.env"
  install -D -m 644 <(curl -fsSL "https://raw.githubusercontent.com/cheaper-inference/OmniRoute/v$VERSION/scripts/ops/opencode-free-relay.ts") \
    "$TARGET/scripts/ops/opencode-free-relay.ts"
fi

"$ROOT/runtime/bin/node" "$(dirname "$0")/patch-release.mjs" "$TARGET"
ln -sfn "$TARGET" "$ROOT/current"
systemctl restart hacksllm
sleep 15 && systemctl is-active hacksllm
