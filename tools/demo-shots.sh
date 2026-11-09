#!/usr/bin/env bash
# Plays a simulated match with automation on and screenshots each scene from the headless test OBS.
set -e
cd "$(dirname "$0")/.."
code=$(python3 -I -c "import json; print(json.load(open('data/secrets.json'))['hostCode'])")
st() { curl -s -H "authorization: Bearer $code" http://127.0.0.1:${PORT:-8095}/api/state; }
phase() { st | python3 -I -c "import json,sys; d=json.load(sys.stdin); print(d['data']['match']['phase'], d['show']['scene'])"; }
waitfor() { for i in $(seq 1 300); do phase | grep -qE "$1" && return 0; sleep 0.5; done; echo "timeout waiting for $1"; return 1; }
A=tools/act.sh; S=tools/obsshot.sh
$A '{"action":"source","control":"reset"}' >/dev/null
$A '{"action":"auto","on":true}' >/dev/null
$A '{"action":"source","control":"speed","value":12}' >/dev/null
WAIT=3 $S shots/live-casters.png casters
WAIT=3 $S shots/live-brb.png brb
$A '{"action":"scene","scene":"casters"}' >/dev/null; sleep 1
$A '{"action":"source","control":"auto","on":true}' >/dev/null
waitfor "^picks picks"; sleep 6.5; $S shots/live-picks-mid.png; echo "picks mid: $(phase)"
waitfor "^playing match"; sleep 3; $S shots/live-match.png; echo "playing: $(phase)"
$A '{"action":"scene","scene":"focus-a"}' >/dev/null; sleep 2.5; $S shots/live-focus-a.png
$A '{"action":"scene","scene":"match"}' >/dev/null
waitfor "^finished"; sleep 1.5; $S shots/live-result.png; echo "result: $(phase)"
waitfor "^done results"; sleep 2.5; $S shots/live-results.png; echo "final: $(phase)"
