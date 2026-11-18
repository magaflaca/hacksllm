#!/bin/bash
# Configuracion de OmniRoute: proveedores sin clave, combos y claves de acceso.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

hacksllm-cli providers list | grep -q opencode-zen ||
  hacksllm-cli providers add opencode-zen --name opencode-free --credential public --yes --default-model deepseek-v4.1-flash-free

(set -a && . /opt/hacksllm/env && /opt/hacksllm/runtime/bin/node "$HERE/models.mjs")

for name in personal web; do
  file=/root/hacksllm-key-$name.txt
  [ -s "$file" ] && continue
  hacksllm-cli api api-keys post-api-keys --body "{\"name\":\"$name\"}" | grep -oE "sk-[A-Za-z0-9_-]{20,}" | head -1 > "$file"
  chmod 600 "$file"
done
echo "claves en /root/hacksllm-key-*.txt"
