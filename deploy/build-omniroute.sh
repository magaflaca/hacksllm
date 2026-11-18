#!/bin/bash
# Compila OmniRoute desde una etiqueta de GitHub (para versiones que aun no estan en npm) y deja el .tgz.
# Solo el backend: la API completa sin el panel, que es lo que no cabe en la memoria del VPS.
# Uso: deploy/build-omniroute.sh v3.8.54 ; despues: deploy/upgrade.sh /opt/hacksllm-build/omniroute-*.tgz
set -euo pipefail

TAG=${1:?indica la etiqueta, por ejemplo v3.8.54}
DIR=/opt/hacksllm-build
export PATH=/opt/hacksllm/runtime/bin:$PATH

[ -f /swap-build ] || { fallocate -l 4G /swap-build && chmod 600 /swap-build && mkswap -q /swap-build; }
swapon /swap-build 2>/dev/null || true
trap 'swapoff /swap-build 2>/dev/null || true' EXIT

if [ "$(git -C "$DIR" describe --tags 2>/dev/null)" != "$TAG" ]; then
  rm -rf "$DIR" && git clone -q --depth 1 --branch "$TAG" https://github.com/cheaper-inference/OmniRoute.git "$DIR"
fi
cd "$DIR"
git checkout -q -- src/app
[ -d node_modules ] || nice -n 15 ionice -c3 npm ci --no-audit --no-fund --loglevel=error
NODE_OPTIONS=--max-old-space-size=4096 nice -n 15 ionice -c3 npm run build:backend
npm run build:cli
npm pack --ignore-scripts
