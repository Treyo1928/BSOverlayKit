# BSOverlayKit

A Beat Saber tournament stream overlay you **design in Inkscape**. No CSS, no JavaScript.

- Each scene is an SVG file in `design/`. Layer names like `{a.name}`, `img:map.cover`, `bar:tug` or
  `show:match.phase=playing` make it live.
- Motion goes in a small YAML rules file per scene (`enter:`, `on: mapBan`, `loop:`…).
- Streamers add **one OBS Browser Source**. Casters switch scenes from a web panel, or let the automation
  rules switch on match events.
- Match data comes from a **data source**. Today that's a built-in **simulator** (a full Bo5 with picks,
  bans, live scores and results); next it's **BeatKhana** (see "Next steps").

**MSU Esports:** `overlay.yaml` runs the MSU scenes in `design/msu/` (Starting Soon, Intermission, Be Right Back,
Casters, Picks & Bans, Getting Ready, Match, Bracket, Final) with frosted-glass panels and live gold-dust particles. The generic starter scenes still work:
`OVERLAY=overlay.starter.yaml ./run.sh`. Where the MSU art came from: `design/msu/SOURCES.md`.

**Designing:** read [`docs/DESIGNING.md`](docs/DESIGNING.md). It's the complete reference: layer names,
data, filters, rules, animations and Inkscape tips.

## Run it

```bash
cd ~/DevStuff/BSOverlayKit
./run.sh                       # prints the panel login code and the OBS URL
```

- **Panel:** http://127.0.0.1:8095 (log in with the printed code, or open the printed `/login/<code>` link).
  `HOST_CODE=yourcode ./run.sh` sets the code.
- **OBS:** Sources → + → Browser, paste the printed URL, 1920 × 1080, tick **Control audio via OBS**.
- **Design loop:** open `design/match.svg` in Inkscape, change something, Ctrl+S. The panel preview updates
  within a second.
- **Simulator:** in the panel, use *Next step* (one step at a time) or *Auto-play match*. Turn on
  *Auto-switch* to see the automation rules from `overlay.yaml`.

## What's in the box

```
overlay.yaml               scene list, side colours, crossfade, automatic scene switching (MSU)
overlay.starter.yaml       the same for the generic starter scenes
design/                    ← what you edit
  msu/                     MSU scenes + their art (background, logo), see msu/SOURCES.md
  casters/brb/picks/match/focus/results .svg   starter scenes
  *.rules.yaml             their animations and reactions
  logo.svg                 placeholder logo (replace it)
  fonts/                   Oxanium, Inter, Squada One (OFL); Shader, Geom Graphic (from the MSU designer);
                           all installed in ~/.local/share/fonts/BSOverlayKit
docs/DESIGNING.md          the designer's reference
server/                    Deno server (you don't need to touch it)
  main.ts                  HTTP/WebSocket, panel, design watching, automation, stream delay
  model.ts                 the data contract, i.e. every value designs can bind to
  sources/sim.ts           the match simulator
web/                       the overlay engine and panel (you don't need to touch it)
  engine/bind.js           layer names → live bindings
  engine/anim.js           animations and presets
  engine/fx.js             fx:dust / fx:glitter particle layers (WebGL shaders)
  engine/scene.js          loading scenes, rules, events
  overlay.js / panel.js    the OBS page and the caster panel
tools/                     act.sh (send panel actions), obsshot.sh / demo-shots.sh (headless OBS tests)
data/                      runtime state: panel settings, secrets (login code, overlay key), map pool cache
```

## HTTP API (Stream Deck, scripts)

`POST /api/action` with header `Authorization: Bearer <login code>` and a JSON body:

| Body | Does |
|---|---|
| `{"action":"scene","scene":"match"}` | switch scene |
| `{"action":"auto","on":true}` | automation on/off |
| `{"action":"scene","scene":"brb","staged":true}` | stage it instead of putting it on air. `"staged": true` works on `scene`, `header`, `upNext`, `brb`, `casters`, `castersFrom`, `ticker` (and turns staging on) |
| `{"action":"take"}` / `{"action":"discardStaged"}` | put everything staged on air in one step / throw it away |
| `{"action":"staging","on":false}` | staging mode on/off (off also throws away what was staged) |
| `{"action":"brb","minutes":5}` | BRB countdown |
| `{"action":"upNext","a":"Team 1","b":"Team 2","text":"Winners Final"}` | the Casters scene's "up next" block (`{"action":"upNext"}` hides it) |
| `{"action":"live","phase":"playing","time":12,"duration":180,"players":{"a":[{"acc":0.97,"score":1,"combo":1,"misses":0,"finished":false}],"b":[…]}}` | live gameplay from a TA bridge (`phase`: `loading` / `playing` / `null` = over) |
| `{"action":"source","control":"next"}` | simulator step (`reset`, `auto`, `speed`) |

Environment: `PORT`, `HOST_CODE`, `OVERLAY`, `KIT_DATA` (see `server/main.ts`), `KIT_SOURCE` / `BSCS_URL` /
`BSCS_TOURNAMENT` / `BSCS_KEY` for the BSCompStats source, `CHROVIEWER_URL` (the replay viewer as the browser reaches
it), and `KIT_TA_RELAY_HOST` (`host:port` of the TA server as the replay viewer reaches it, when that is not the
address in the match; the local test stack sets `msu-ta-server:8676`).

**TA-mode matches** need nothing posted to the overlay: the BSCompStats source reads each map's TA status (loading /
ready / playing / finished) and the live scores from the match's events stream, and every lineup player's video hole
becomes a replay viewer following that player's TA live replay. The `live` action above still works, for tools.

`GET /api/state` (same header) returns the current data, `show` (what is on air), `staging` (the mode), `staged`
(the staged copy, or `null` when nothing is staged) and `stagedDiffers`. Calls without `"staged"` act on air, as
they always did.

## Staging: look before it goes on air

Tick **Staging** at the top of the panel (it works like OBS's Studio Mode). From then on the scene buttons and the
text cards (top bar, casters, up next, be right back, ticker: the ones with an amber edge) edit **Next**, not what
viewers see. The panel shows two previews, **On air** (red) and **Next** (amber); **Go live** puts the whole staged
set on air in one step with the normal crossfade, **Discard** throws it away. An amber bar across the top says
whether changes are waiting.

- Not staged, always immediate: match data, the replay playlist (it runs on a live clock), video links, stream
  delay and the replay settings.
- **Auto-switch only ever acts on air.** If a rule changes the on-air scene while you have something staged, Next
  stays exactly as you set it; the bar says that the on-air scene has changed since you started.
- **Emergency:** the Scene card has "Switch on air now", which skips staging. Unticking Staging goes back to one
  click = on air.
- "Back in N min" staged for Be Right Back starts counting when it goes live.
- The Next preview is the overlay page with `&staged=1`. It never draws replays: its video boxes show pictures of
  the on-air replays, or stay dark. `tools/act.sh '<json>'` is a shortcut.

## How it works (one paragraph)

The server gets match data from the source, holds it back by the panel's stream delay, and pushes it to
the overlay page over a WebSocket, along with what's on stream: scene, casters, BRB, ticker. The page loads
every scene's SVG once, splits it into a `back` layer (under the video) and a front layer (over it), and
reads every layer name into a binding. Each update re-applies the bindings, then runs the rules: data
changes and match events trigger animations. Switching scenes is a crossfade plus the new scene's `enter`
animations. Video holes (`feed:`, `cam:`) are real iframes kept loaded across scene changes, and they glide
between positions when the layout changes.

## Next steps

1. **BeatKhana source** (`server/sources/beatkhana.ts`): follow a BeatKhana overlay and match with an API
   key and fill the same data contract, so the designs work unchanged. Needs a BeatKhana test tournament
   where you're staff.
2. **Bracket scene**: a bracket is awkward to draw as repeats, so it'll probably be a built-in widget you
   place with `widget:bracket`.
3. Ideas: a lower-third scene layered on top of others, stingers, a caster "speaking" indicator.

Testing notes: every starter scene was rendered through Inkscape 1.4.4 (CLI export) and through OBS 32's
Browser Source during a full simulated match with automation on (`tools/demo-shots.sh`; screenshots in
`shots/`). Not yet tested: Figma-exported SVGs (the engine reads layer names from `id` attributes for that),
and real Twitch/VDO.Ninja feeds in the video holes.
