# BSOverlayKit

A Beat Saber tournament stream overlay that is **designed in Inkscape**. Every scene is an SVG file. Layer names
like `{a.name}`, `img:map.cover` or `show:match.phase=playing` make the picture live; you never write CSS or
JavaScript. This repository holds the MSU Esports scenes (`design/msu/`) and the small server that shows them.

- **You want to change how the overlay looks:** read "Editing the designs" below. That is all you need.
- **You run the stream:** "Running a show", further down.
- **You host it on a server:** [`DEPLOY.md`](DEPLOY.md).

---

## Editing the designs (start here)

You edit the SVG files in `design/msu/` with Inkscape, save, and a preview in your browser updates within a second.
A built-in simulator plays a whole match with made-up teams, so you can see every scene in every state without a
tournament, a game or anyone else.

### What you need

| | |
|---|---|
| **Inkscape** 1.3 or newer | <https://inkscape.org>. The scenes were made and checked with 1.4 |
| **Deno** (runs the preview server) | <https://deno.com>. Linux / macOS: `curl -fsSL https://deno.land/install.sh \| sh`. Windows (PowerShell): `irm https://deno.land/install.ps1 \| iex`. Open a new terminal afterwards |
| **This folder** | `git clone https://github.com/Treyo1928/BSOverlayKit.git`, or a zip of it |
| **The fonts** | see the next step |

Nothing else: no account, no API key, no game. Chrome, Edge or Firefox for the preview.

### 1. Install the fonts

The scenes use the fonts in `design/fonts/` (Shader, Geom Graphic, Oxanium, Inter, Squada One). Inkscape only shows
them if they are installed on your computer; without them your text looks different from the stream's.

- **Linux / macOS:** `tools/install-fonts.sh`
- **Windows:** open `design\fonts`, select every `.ttf` file, right-click, **Install**.

Restart Inkscape afterwards. (The stream itself always uses the files in `design/fonts/`, whatever is installed.)

### 2. Start the preview

- **Linux / macOS:** `./run.sh`
- **Windows:** double-click `run.bat`

It prints a link like `http://127.0.0.1:8095/login/abc123`. Open it: that is the **panel**. Leave the terminal
window open while you work; close it (or Ctrl+C) to stop.

In the panel:

- The **preview** at the top right is the overlay, exactly as OBS shows it. **open** (next to it) gives you the
  overlay alone in a tab, full size, on a checkered background where the stream would show through.
- **Scene** buttons switch scene. Untick **Auto-switch** so scenes stay where you put them.
- **Simulator** card: **Next step** walks a match forward one step at a time (each ban, each pick, loading, playing,
  result); **Auto-play match** runs the whole thing; **Reset** starts over. Use it to see each scene in every state:
  a banned map, a map being played, a lead changing, a winner.

### 3. Edit, save, look

1. Open a scene from `design/msu/` in Inkscape (table below).
2. Change it. Save with plain **Ctrl+S** (Inkscape SVG, the default).
3. The preview reloads by itself. If you broke something, the panel shows the problem in red; nothing bad reaches a
   stream.

| File in `design/msu/` | Scene | What it shows |
|---|---|---|
| `starting.svg` | Starting Soon | title, big replay box, "now playing" card |
| `intermission.svg` | Intermission | the same, between matches |
| `brb.svg` | Be Right Back | message, countdown, replay box |
| `casters.svg` | Casters | caster names and pictures, "up next" |
| `picks.svg` | Picks & Bans | the map pool: banned, picked, played, who won each; 5 to 11 maps |
| `ready.svg` | Getting Ready | the two lineups, the next map, a replay box |
| `match.svg` | Match | the gameplay videos, scores, the "who is winning" bar. It holds **two layouts**: `solo` (a 1v1: two videos) and `team` (duos: four videos). Only one shows at a time |
| `bracket.svg` | Bracket | the bracket, single or double elimination |
| `final.svg` | Final | the winner and final score |

Each scene may have a `<name>.rules.yaml` beside it: its animations (what slides in, what pulses when a score
changes). Plain text; you only need it if you want to change motion.

To look at layouts the simulator does not show by default, edit the `sim:` block in `overlay.yaml` and restart:
`players: 1` for the 1v1 layout, `maps: 11` for a finals-size pool, `a:` / `b:` and the rosters for long names.

### The one rule: layer names are the wiring

Open **Layers and Objects** in Inkscape (`Ctrl+Shift+L`). Many objects have names such as:

```
{a.name | upper} fit:560        img:map.cover        show:map.pickedBy        state:item.state        feed:a1
```

Those names are how live data reaches the picture. **Move, restyle, recolour, resize anything you like, but keep
the name on the object** (or put the same name on whatever replaces it). An object whose name you delete goes
static; nothing else breaks.

- Text between `{ }` is replaced by live data. The words you see in Inkscape ("MSU MAROON", "97.43%") are
  placeholders.
- `show:` / `hide:` / `when:` objects are switched on and off by the overlay. Hiding them with the eye icon while
  you work is fine; the overlay shows the right one anyway.
- A group named `repeat:…` holds **one** card; the overlay copies it for every map, player or match.
- `feed:…` rectangles are holes where a video goes. Move and resize them freely; the coloured frame drawn around a
  hole is a separate shape, so move that with it (`docs/DESIGNING.md`, Tips, has the detail).
- Keep live text as text: do not use *Path → Object to Path* on it.
- Keep the page 1920 × 1080.
- New pictures: save them next to the scene (in `design/msu/`) and import them **linked** or embedded; both work.

Everything a name can do, and every piece of data there is, is in **[`docs/DESIGNING.md`](docs/DESIGNING.md)**.

### Sending your changes back

- **With git:** commit the files you changed under `design/` (and `overlay.yaml`, if you touched it) on a branch and
  push it, or open a pull request.
- **Without git:** zip the `design/msu/` folder and send it.

The `data/` folder is your own preview's settings and is never part of what you send.

### When something looks wrong

| You see | Why, and what to do |
|---|---|
| A red message in the panel | The scene or its rules file has a mistake; the message names the file. Undo your last change, or fix what it says |
| Text looks different in Inkscape than in the preview | The fonts are not installed, or Inkscape was open while you installed them (step 1) |
| A picture you added is missing in the preview | It lives outside `design/`. Put it in `design/msu/` and link it again |
| The video boxes are dark | Normal here: there are no players. The boxes show where the videos go |
| `./run.sh` says the address is in use | Something else has port 8095: `PORT=8096 ./run.sh` (Windows: `set PORT=8096` then `run.bat`) |
| A name stopped updating | Its layer name was lost (ungrouping and regrouping can do it). Put the name back from the table in `docs/DESIGNING.md` |

---

## Running a show

```bash
./run.sh                       # prints the panel login link and the OBS address
```

- **Panel:** <http://127.0.0.1:8095>. `HOST_CODE=yourcode ./run.sh` sets the login code.
- **OBS:** Sources → + → Browser, the URL from the panel's OBS card, 1920 × 1080, tick **Control audio via OBS**.
- **Match data** comes from a data source, set by `source:` in `overlay.yaml` or `KIT_SOURCE`: `sim` (the simulator,
  the default) or `bscompstats` (a tournament on a BSCompStats site: picks, bans, lineups, scores, the bracket, and
  live gameplay from TournamentAssistant). The designs are the same for both.
- **Auto-switch** follows the `automation:` rules in `overlay.yaml` (Picks & Bans → Getting Ready → Match → …).
- **Replay playlist:** breaks play a shuffled mix of the replays you add in the panel and those of the players still
  in the bracket; Getting Ready plays someone who is about to play. Needs a replay viewer (ChroViewer) for the
  video; see `DEPLOY.md`.
- **Generic starter scenes** (not MSU): `OVERLAY=overlay.starter.yaml ./run.sh`.

### Staging: look before it goes on air

Tick **Staging** at the top of the panel (it works like OBS's Studio Mode). From then on the scene buttons and the
text cards (top bar, casters, up next, be right back, ticker: the ones with an amber edge) edit **Next**, not what
viewers see. The panel shows two previews, **On air** (red) and **Next** (amber); **Go live** puts the whole staged
set on air in one step with the normal crossfade, **Discard** throws it away.

- Not staged, always immediate: match data, the replay playlist (it runs on a live clock), video links, stream
  delay and the replay settings.
- **Auto-switch only ever acts on air.** If a rule changes the on-air scene while you have something staged, Next
  stays exactly as you set it.
- **Emergency:** the Scene card has "Switch on air now", which skips staging.
- The Next preview never draws replays: its video boxes stay dark.

### HTTP API (Stream Deck, scripts, the caster bot)

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
| `{"action":"playlist","op":"add","refs":["<replay link>"]}` | add replays to the playlist (`next`, `prev`, `random`, `clear`, `resetPlayed` …) |
| `{"action":"source","control":"next"}` | simulator step (`reset`, `auto`, `speed`, `hold`) |

`GET /api/state` (same header) returns the current data, `show` (what is on air), `staging`, `staged` and
`stagedDiffers`. `tools/act.sh '<json>'` is a shortcut for the POST.

Environment: `PORT`, `HOST`, `HOST_CODE`, `OVERLAY` (another config file), `KIT_DATA`, `KIT_SOURCE`, and for the
BSCompStats source `BSCS_URL` / `BSCS_TOURNAMENT` / `BSCS_KEY`; `CHROVIEWER_URL` (the replay viewer as the browser
reaches it). The rest are in `.env.example` and `DEPLOY.md`.

---

## What's in the box

```
design/                    ← what a designer edits
  msu/                     the MSU scenes (.svg), their animations (.rules.yaml) and their art (background, shield)
                           where the art came from and its measurements: msu/SOURCES.md
  fonts/                   the fonts the scenes use (tools/install-fonts.sh installs them for Inkscape)
  *.svg, *.rules.yaml      generic starter scenes (overlay.starter.yaml)
docs/DESIGNING.md          the designer's reference: every layer name, every piece of data, animations
overlay.yaml               scene list, side colours, simulator settings, automatic scene switching
run.sh / run.bat           start the server (Linux, macOS / Windows)
server/                    the server (Deno): panel, data sources, playlist, automation
web/                       the overlay page, its engine (layer names → live bindings, animations, particles) and the panel
tools/                     install-fonts.sh; act.sh (send a panel action); browser checks used while developing
shots/                     reference screenshots of the scenes
DEPLOY.md, Dockerfile, docker-compose.yml, docker/      hosting it on a server
data/                      made when it runs: your panel settings and login code. Never committed
```

## How it works (one paragraph)

The server gets match data from the source, holds it back by the panel's stream delay, and pushes it to the overlay
page over a WebSocket, along with what is on stream: scene, casters, BRB, ticker. The page loads every scene's SVG
once, splits it into a `back` layer (under the video) and a front layer (over it), and reads every layer name into a
binding. Each update re-applies the bindings, then runs the rules: data changes and match events trigger animations.
Switching scenes is a crossfade plus the new scene's `enter` animations. Video holes (`feed:`) are real iframes kept
loaded across scene changes, and they glide between positions when the layout changes.

## Fonts and art

Oxanium, Inter and Squada One are under the SIL Open Font License (texts in `design/fonts/`). Shader and Geom Graphic
came from the MSU Esports designer for this overlay; they are here so the scenes render, not for use elsewhere. The
MSU Esports marks and background art belong to MSU Esports (`design/msu/SOURCES.md` says what was traced or
rebuilt from what).
