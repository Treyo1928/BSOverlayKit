#!/usr/bin/env bash
# Screenshot the overlay in headless Chromium:  tools/shot.sh <out.png> [wait ms]
out=$(realpath -m "$1")
cd "$(dirname "$0")/.."
key=$(python3 -I -c "import json; print(json.load(open('data/secrets.json'))['overlayKey'])")
prof=$(mktemp -d "${TMPDIR:-/tmp}/kitshot.XXXX")
timeout 30 chromium --headless=new --disable-gpu --user-data-dir="$prof" --enable-logging=stderr --v=0 \
  --virtual-time-budget="${2:-3000}" --window-size=1920,1080 --hide-scrollbars --screenshot="$out" \
  "http://127.0.0.1:${PORT:-8095}/overlay?key=$key&debug" 2>&1 | grep -E "CONSOLE|written" | sed -E 's/^.*CONSOLE:[0-9]+\] //' | head -8
