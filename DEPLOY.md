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
viewer1…5.treyo.dev          the replay viewer (ChroViewer, msu)    embedded by the overlay page, one address a box
```

## 1. Bring it up

On the server, with this folder and the `chroviewer` folder (branch `msu`) side by side:

```
cd overlay
cp .env.example .env        # fill in: HOST_CODE, BSCS_TOURNAMENT, BSCS_KEY, the addresses
docker compose --profile tls up -d --build      # with the bundled Caddy: HTTPS by itself
docker compose up -d --build                    # or behind your own proxy (see 3)
```

DNS: `overlay.treyo.dev` and `viewer1` … `viewer5.treyo.dev` pointing at the server (one level deep, so a wildcard certificate for `*.treyo.dev` covers them).

The viewer image takes a few minutes and up to 8 GB of memory to build. Build it where there is room, or build it
elsewhere (`docker build -t msu-chroviewer --build-arg VITE_BEATLEADER_API_URL=https://viewer1.treyo.dev/bl-api chroviewer`)
and `docker save msu-chroviewer | ssh server docker load`: compose then uses it and builds only the overlay.

## 2. Use it

- Panel: `https://overlay.treyo.dev`, sign in with `HOST_CODE`. Share the code with whoever runs the stream.
- OBS Browser Source: the address in the panel's OBS card (it has OBS's own key in it), 1920 × 1080, tick
  **Control audio via OBS**. `https://overlay.treyo.dev/overlay` without the key shows the same picture and is the
  one to hand to anyone else.
- The caster bot runs beside the overlay (the `casters` service). Put `DISCORD_TOKEN=<the bot's token>` in `.env` and
  `docker compose up -d`; then pick the voice channel in the panel's Casters card. Making the bot:
  [`discord-bot/README.md`](discord-bot/README.md). Without a token it idles.

Which tournament it follows to begin with is `BSCS_TOURNAMENT` in `.env`. When the API key works in more than one
tournament, the panel's BSCompStats card has a Tournament list to switch between them; the choice is kept over a
restart, until `BSCS_TOURNAMENT` itself is changed. Which match is followed is chosen in the panel.

### Signing in with a BSCompStats account

Instead of passing the login code around, people can sign in to the panel with their account on the site:

1. On the site, **API keys**: open the overlay's key ("Tournaments, sign-in and people") and set its sign-in address
   to this overlay's address, exactly as people open it (`https://overlay.treyo.dev`).
2. Within half a minute the panel's login page shows **Sign in with BSCompStats**. The key's owner is let straight in.
3. Anyone else who presses it is shown a page on the site where they ask to be let in. The request appears on the
   owner's API keys page, with **Let in** and **Turn down**. Once let in, the same button signs them in.
4. **Remove** on that page takes someone out again: the panel stops answering them within a minute.

The login code keeps working (scripts and the caster bot use it), and is the way in if the site is down. The site
only ever sends a sign-in back to the address written on the key, and the overlay learns a name and a picture,
nothing else.

## 3. Behind your own proxy

Both containers listen on 127.0.0.1 only (8095 and 4000) unless `OVERLAY_BIND` / `VIEWER_BIND` in `.env` say otherwise (a proxy in another container or on another machine needs `OVERLAY_BIND=8095`, `VIEWER_BIND=4000`). The proxy needs to:

- send `overlay.treyo.dev` to `127.0.0.1:8095`, passing WebSockets (`/ws/…`) through, keep the visitor's `Host`
  header, and set `X-Forwarded-For` and `X-Forwarded-Proto` (the wrong-code limit counts per visitor address, and
  the sign-in cookie is marked Secure only when it sees `https`)
- `TRUST_PROXY` in `.env` is how many proxies are in front (1 by default). The overlay reads the visitor's address
  that many from the END of `X-Forwarded-For`, so nothing a visitor writes into that header themselves is believed.
  With `OVERLAY_BIND=8095` the port is also open to your own network directly, where that header is not checked by
  any proxy: keep that network to machines you trust, or bind to the proxy's address only.
- send every viewer address to `127.0.0.1:4000`, unbuffered, and add the response header
  `Origin-Agent-Cluster: ?1` (see 5)

`docker/Caddyfile` is exactly that, for reference.

## 4. Who can do what

| | |
|---|---|
| `/overlay`, the scene files | anyone with the address. It only receives; nothing on it is secret that is not on the stream |
| `/overlay?staged=1` (what is staged, before it is on air) | only the panel's own preview (signed in) or a page with the key |
| how many may watch | 200 pages in all and 40 from one address; OBS (its key) and signed-in panels are never counted out |
| the panel, `/api/state`, `/api/action` | the login code (typed in, or as `Authorization: Bearer <code>` for the bot and scripts), or a BSCompStats account the key's owner let in. Requests a browser makes from another site are refused |
| wrong codes | 8 from one address in ten minutes locks that address out for the rest of the ten minutes |
| signing in | lasts 30 days, survives a restart, and ends for everyone when `HOST_CODE` changes |

An overlay page may tell the server that its replay has loaded (that starts a replay a moment sooner), and how long
a replay is when the server does not know (a ScoreSaber or file replay has no length until a viewer opens it). A
known length is corrected, and a replay's end believed, only from a page that has the key: the address in the
panel's OBS card. Without a keyed page the playlist runs on the server's clock and the lengths it has.

## 5. Four replays, one browser

A browser runs every page from one site in one process, on one CPU core. On the stream PC the viewer was served on
127.0.0.1 to .6 so that each video box counted as a different site. A hosted viewer is one site, so:

- **`CHROVIEWER_URL=https://viewer{n}.treyo.dev`** gives each box its own address, and the proxy's
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
