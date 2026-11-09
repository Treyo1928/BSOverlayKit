#!/usr/bin/env bash
# Send an action to the running server:  tools/act.sh '{"action":"scene","scene":"match"}'
code=$(python3 -I -c "import json; print(json.load(open('$(dirname "$0")/../${KIT_DATA:-data}/secrets.json'))['hostCode'])")
curl -s -X POST -H "authorization: Bearer $code" -d "$1" "http://127.0.0.1:${PORT:-8095}/api/action"; echo
