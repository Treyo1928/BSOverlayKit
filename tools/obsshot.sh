#!/usr/bin/env bash
# Screenshot the overlay as rendered by the headless test OBS from ~/DevStuff/BSOverlay
# (start it with ../test-obs/run-obs-headless.sh).   tools/obsshot.sh <out.png> [scene to switch to]
set -e
out=$(realpath -m "$1")
cd "$(dirname "$0")/.."
OBS="$(cd "$(dirname "$0")/../../test-obs" && pwd)/tools/obs.mjs"
key=$(python3 -I -c "import json; print(json.load(open('${KIT_DATA:-data}/secrets.json'))['overlayKey'])")
url="http://127.0.0.1:${PORT:-8095}/overlay?key=$key&debug${EXTRA:-}"
# create the scene and source the first time (errors just mean they exist already)
node $OBS call CreateScene '{"sceneName":"BSOverlayKit"}' >/dev/null 2>&1 || true
if node $OBS call CreateInput "{\"sceneName\":\"BSOverlayKit\",\"inputName\":\"Kit overlay\",\"inputKind\":\"browser_source\",\"inputSettings\":{\"url\":\"$url\",\"width\":1920,\"height\":1080,\"reroute_audio\":true}}" >/dev/null 2>&1; then sleep 4; fi
node $OBS call SetInputSettings "{\"inputName\":\"Kit overlay\",\"inputSettings\":{\"url\":\"$url\"}}" >/dev/null
node $OBS call SetCurrentProgramScene '{"sceneName":"BSOverlayKit"}' >/dev/null
if [ -n "$2" ]; then tools/act.sh "{\"action\":\"scene\",\"scene\":\"$2\"}" >/dev/null; sleep "${WAIT:-2}"; fi
node $OBS shot BSOverlayKit "$out" "${WIDTH:-1280}"
