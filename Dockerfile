# The overlay server: scenes, the caster panel, and the page OBS shows. It holds the show's state and runs the
# automation; it draws nothing itself (the scenes and replays are drawn by whoever opens the overlay page).
#   docker build -t msu-overlay .
FROM denoland/deno:alpine-2.5.6

WORKDIR /app
COPY server ./server
# fetch what the server imports now, so the container starts without the network
RUN deno cache server/main.ts
COPY web ./web
COPY design ./design
COPY overlay.yaml overlay.starter.yaml ./
# the simulator's sample pool (source: sim); the rest of data/ is runtime state, on a volume
COPY data/pool.json ./pool.sample.json

ENV HOST=0.0.0.0 PORT=8095 KIT_DATA=data
EXPOSE 8095
VOLUME /app/data
# state (sign-in secrets, the show as set in the panel, cached covers) lives in /app/data: keep it on a volume
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD deno eval "const r = await fetch('http://127.0.0.1:' + (Deno.env.get('PORT') ?? '8095') + '/healthz'); Deno.exit(r.ok ? 0 : 1)"
# read: the app's own folder; write: only its state; net: the site it follows, BeatLeader (replay info), the panel
CMD ["sh", "-c", "[ -e data/pool.json ] || cp pool.sample.json data/pool.json; exec deno run --allow-net --allow-env --allow-read=. --allow-write=data server/main.ts"]
