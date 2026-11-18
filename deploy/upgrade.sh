#!/bin/bash
# Instala o actualiza OmniRoute en el runtime propio y reinicia el servicio.
set -euo pipefail

ROOT=/opt/hacksllm
export PATH=$ROOT/runtime/bin:$PATH
npm install -g --no-audit --no-fund --loglevel=error "omniroute@${1:-latest}"
systemctl restart hacksllm
sleep 8 && systemctl is-active hacksllm
