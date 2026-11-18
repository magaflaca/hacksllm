#!/bin/bash
# Compila OmniRoute desde una etiqueta de GitHub (para versiones que aun no estan en npm) y deja el .tgz.
# Uso: deploy/build-omniroute.sh v3.8.54 ; despues: deploy/upgrade.sh /opt/hacksllm-build/omniroute-*.tgz
set -euo pipefail

TAG=${1:?indica la etiqueta, por ejemplo v3.8.54}
DIR=/opt/hacksllm-build
export PATH=/opt/hacksllm/runtime/bin:$PATH

[ -f /swap-build ] || { fallocate -l 4G /swap-build && chmod 600 /swap-build && mkswap -q /swap-build; }
swapon /swap-build 2>/dev/null || true
trap 'swapoff /swap-build 2>/dev/null || true' EXIT

rm -rf "$DIR" && git clone -q --depth 1 --branch "$TAG" https://github.com/cheaper-inference/OmniRoute.git "$DIR"
cd "$DIR"
nice -n 15 ionice -c3 npm ci --no-audit --no-fund --loglevel=error
NODE_OPTIONS=--max-old-space-size=3072 nice -n 15 ionice -c3 npm run build
npm run build:cli
npm pack --ignore-scripts
