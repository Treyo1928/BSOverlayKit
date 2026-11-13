# Running the overlay on a server

The overlay server holds the show: which scene is on, the automation, the replay playlist's clock, the match it
follows. The panel only sends it commands, and the overlay page only draws what it is told. So the panel can be
closed or minimised, and several people can have it open: every change goes to the server and from there to every
open panel and to OBS.

Neither container draws anything. Scenes and replays are drawn by the browser that shows the overlay (OBS's Browser
Source on the stream PC). The overlay container idles at about 35 MB and a fraction of a percent of one CPU.

```
overlay.treyo.dev            the overlay server (this folder)       /            the panel, behind the login code
                                                                    /overlay     what OBS shows: no sign-in
v1…v5.viewer.treyo.dev       the replay viewer (ChroViewer, msu)    embedded by the overlay page, one address a box
```

## 1. Bring it up

On the server, with this folder and the `chroviewer` folder (branch `msu`) side by side:

```
cd overlay
cp .env.example .env        # fill in: HOST_CODE, BSCS_TOURNAMENT, BSCS_KEY, the addresses
docker compose --profile tls up -d --build      # with the bundled Caddy: HTTPS by itself
docker compose up -d --build                    # or behind your own proxy (see 3)
```

DNS: `overlay.treyo.dev` and `v1` … `v5.viewer.treyo.dev` (or one wildcard `*.viewer.treyo.dev`) pointing at the server.

The viewer image takes a few minutes and up to 8 GB of memory to build. Build it where there is room, or build it
elsewhere and `docker save | docker load` it.

## 2. Use it

- Panel: `https://overlay.treyo.dev`, sign in with `HOST_CODE`. Share the code with whoever runs the stream.
- OBS Browser Source: `https://overlay.treyo.dev/overlay`, 1920 × 1080, tick **Control audio via OBS**.
- The caster bot: `OVERLAY_URL=https://overlay.treyo.dev` and `OVERLAY_CODE=<HOST_CODE>` in `discord-bot/.env`.

Which tournament it follows is `BSCS_TOURNAMENT` in `.env` (`docker compose up -d` after changing it). Which match
of it is chosen in the panel.

## 3. Behind your own proxy

Both containers listen on 127.0.0.1 only (8095 and 4000). The proxy needs to:

- send `overlay.treyo.dev` to `127.0.0.1:8095`, passing WebSockets (`/ws/…`) through, and set `X-Forwarded-For`
  and `X-Forwarded-Proto` (the wrong-code limit counts per visitor address, and the sign-in cookie is marked
  Secure only when it sees `https`)
- send every viewer address to `127.0.0.1:4000`, unbuffered, and add the response header
  `Origin-Agent-Cluster: ?1` (see 5)

`docker/Caddyfile` is exactly that, for reference.

## 4. Who can do what

| | |
|---|---|
| `/overlay`, the scene files | anyone with the address. It only receives; nothing on it is secret that is not on the stream |
| the panel, `/api/state`, `/api/action` | the login code: typed in, or as `Authorization: Bearer <code>` for the bot and scripts |
| wrong codes | 8 from one address in ten minutes locks that address out for the rest of the ten minutes |
| signing in | lasts 30 days, survives a restart, and ends for everyone when `HOST_CODE` changes |

An overlay page may tell the server that its replay has loaded (that starts a replay a moment sooner). A replay's
real length and its end are believed only from a page that has the key: `https://overlay.treyo.dev/overlay?key=…`,
the key being `overlayKey` in the data volume's `secrets.json`. Without it the playlist runs on the server's clock
and BeatLeader's length for each replay, which is what a normal show needs; the key is there if a replay ever ends
visibly early or late.

## 5. Four replays, one browser

A browser runs every page from one site in one process, on one CPU core. On the stream PC the viewer was served on
127.0.0.1 to .6 so that each video box counted as a different site. A hosted viewer is one site, so:

- **`CHROVIEWER_URL=https://v{n}.viewer.treyo.dev`** gives each box its own address, and the proxy's
  `Origin-Agent-Cluster: ?1` header asks the browser to keep each apart. Desktop Chromium then gives each its own
  process when it has the memory. **Not yet measured in OBS**: check the frame rate with `&debug` on the OBS
  address during a four-player map.
- If it is not smooth: run the viewer on the stream PC as before (`./live.sh` starts it) and add
  `&viewer=http://127.0.0.1:4000` to the OBS address. Everything else still comes from the server.
- Or `&multiview`: one viewer page draws all four boxes with one renderer.

## 6. What is kept

The volume `overlay-data` (`/app/data`): the sign-in secrets, the show as last set in the panel (scene, texts,
mixer, playlist), which match is followed, cached covers. Scene designs are in the image: rebuild after changing
`design/` or `overlay.yaml`.

Updating: `git pull && docker compose up -d --build`.
