#!/usr/bin/env bash
# Install the overlay's fonts for your user, so Inkscape shows the designs with the right letters.
# Linux and macOS:   tools/install-fonts.sh        (Windows: see README, "Fonts")
# Restart Inkscape afterwards. Nothing outside your own fonts folder is touched; run it again after pulling new fonts.
set -euo pipefail
cd "$(dirname "$0")/../design/fonts"
case "$(uname -s)" in
  Darwin) dest="$HOME/Library/Fonts" ;;
  *)      dest="${XDG_DATA_HOME:-$HOME/.local/share}/fonts/BSOverlayKit" ;;
esac
mkdir -p "$dest"
n=0
for f in *.ttf *.otf; do
  [ -e "$f" ] || continue
  cp -f "$f" "$dest/" && n=$((n + 1))
done
command -v fc-cache >/dev/null 2>&1 && fc-cache -f "$dest" >/dev/null 2>&1 || true
echo "Installed $n font files into $dest"
echo "Restart Inkscape, then check Text → Font: Shader, Geom Graphic, Oxanium, Inter and Squada One should be listed."
