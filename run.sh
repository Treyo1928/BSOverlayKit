#!/usr/bin/env bash
# Start the overlay server. Prints the panel login and the OBS URL.
#   PORT=8095 ./run.sh
#   PORT=8096 KIT_DATA=data/test ./run.sh     a second instance with its own state (must be inside data/)
cd "$(dirname "$0")"
exec deno run --allow-net --allow-env --allow-read=. --allow-write=data server/main.ts
