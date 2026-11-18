#!/bin/bash
# Configuracion inicial de OmniRoute: proveedor gratuito de OpenCode, combo con reservas y claves.
set -euo pipefail

COMBO=deepseek-v4.1
MODELS=opencode-zen/deepseek-v4.1-flash-free,opencode-zen/big-pickle,opencode-zen/mimo-v2.6-flash-free,opencode-zen/nemotron-3-ultra-free

hacksllm-cli providers list | grep -q opencode-zen ||
  hacksllm-cli providers add opencode-zen --name opencode-free --credential public --yes --default-model deepseek-v4.1-flash-free

hacksllm-cli combo list | grep -q "$COMBO" ||
  hacksllm-cli combo create "$COMBO" --strategy priority --models "$MODELS"

for name in personal web; do
  file=/root/hacksllm-key-$name.txt
  [ -s "$file" ] && continue
  hacksllm-cli api api-keys post-api-keys --body "{\"name\":\"$name\"}" | grep -oE "sk-[A-Za-z0-9_-]{20,}" | head -1 > "$file"
  chmod 600 "$file"
done
echo "claves en /root/hacksllm-key-*.txt"
