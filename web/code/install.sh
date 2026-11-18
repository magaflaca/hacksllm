#!/bin/sh
# Instalador de bichi code para macOS y Linux.
#   curl -fsSL https://llm.hacks.win/code/install.sh | sh
# Deja bichi en ~/.bichi/bin (y lo agrega al PATH). Si no hay Node 20 o mas nuevo, descarga uno
# portable en ~/.bichi/node sin tocar el sistema.
set -eu

SITE=https://llm.hacks.win
ROOT="$HOME/.bichi"
BIN="$ROOT/bin"

blue() { printf '\033[38;2;95;155;224m%s\033[0m' "$1"; }
soft() { printf '\033[38;2;138;144;178m%s\033[0m' "$1"; }
say() { printf '  %s\n' "$1"; }

printf '\n  %s  %s\n\n' "$(blue 'bichi code')" "$(soft 'instalando tu bicho programador')"
mkdir -p "$BIN"

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -v | sed 's/^v//; s/\..*//'
}

if [ "$(node_major)" -ge 20 ]; then
  say "$(soft "uso el Node que ya tienes ($(node -v))")"
elif [ -x "$ROOT/node/bin/node" ]; then
  say "$(soft 'uso el Node portable que ya estaba')"
else
  say 'no encontre Node 20+, descargo uno portable (solo para bichi)...'
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  [ "$os" = darwin ] || os=linux
  case $(uname -m) in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    *) echo "  arquitectura no soportada: $(uname -m); instala Node 20+ y vuelve a intentarlo" >&2; exit 1 ;;
  esac
  version=$(curl -fsSL https://nodejs.org/dist/index.json 2>/dev/null | tr '}' '\n' | grep '"lts":"' | head -n 1 | sed 's/.*"version":"\([^"]*\)".*/\1/')
  name="node-$version-$os-$arch"
  rm -rf "$ROOT/node" "$ROOT/$name"
  curl -fsSL "https://nodejs.org/dist/$version/$name.tar.gz" | tar -xz -C "$ROOT"
  mv "$ROOT/$name" "$ROOT/node"
  say "$(soft "Node $version listo")"
fi

say 'descargando bichi code...'
curl -fsSL "$SITE/code/bichi.mjs" -o "$BIN/bichi.mjs.new"
mv "$BIN/bichi.mjs.new" "$BIN/bichi.mjs"

cat > "$BIN/bichi" <<'LAUNCHER'
#!/bin/sh
DIR=$(dirname "$0")
if [ -x "$DIR/../node/bin/node" ]; then exec "$DIR/../node/bin/node" "$DIR/bichi.mjs" "$@"; fi
exec node "$DIR/bichi.mjs" "$@"
LAUNCHER
chmod +x "$BIN/bichi"

# PATH: en los archivos de arranque de la shell que existan (o en ~/.profile).
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    added=no
    for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
      if [ -f "$rc" ] && ! grep -q '.bichi/bin' "$rc"; then
        printf '\n# bichi code\nexport PATH="$HOME/.bichi/bin:$PATH"\n' >> "$rc"
        added=yes
      fi
    done
    if [ "$added" = no ] && ! grep -q '.bichi/bin' "$HOME/.profile" 2>/dev/null; then
      printf '\n# bichi code\nexport PATH="$HOME/.bichi/bin:$PATH"\n' >> "$HOME/.profile"
    fi
    ;;
esac

printf '\n  \033[38;2;127;209;176mbichi code %s instalado\033[0m\n\n' "$("$BIN/bichi" --version)"
say "$(soft 'para empezar, en la carpeta de tu proyecto:')"
say "  $(blue bichi)"
printf '\n'
say "$(soft '(si esta terminal no lo encuentra, abre una nueva o ejecuta: export PATH="$HOME/.bichi/bin:$PATH")')"
printf '\n'
