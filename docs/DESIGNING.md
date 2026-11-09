# Designing scenes for BSOverlayKit

You design every scene in **Inkscape** (or Figma) as a normal picture. The engine makes it live by
reading **layer names**. You never write CSS or JavaScript. Motion goes in a small **rules file** per scene.

```
design/
  match.svg            ← the picture (Inkscape)
  match.rules.yaml     ← optional: animations and reactions
  fonts/               ← fonts the overlay uses (install them on your PC too, so Inkscape shows them)
overlay.yaml           ← which scenes exist, side colours, automatic scene switching
```

Save in Inkscape and the panel preview updates within a second. No restart, no refresh.

---

## 1. Workflow in Inkscape

1. **Document:** File → Document Properties → **1920 × 1080 px** (the starter files already are).
2. **Open the Layers and Objects panel:** `Ctrl+Shift+L`. This is where names live. Double-click a name to
   rename it (that's the label the engine reads).
3. **Backgrounds** go in a top-level layer named **`back`**. That layer is drawn *behind* the video holes,
   everything else *in front*.
4. **Placeholder content:** type "Player Name", "98.76%"… then name the object (below), or type
   placeholders straight into the text: `MAP {match.mapNumber}`.
5. **Variants:** a card that can be "banned" or "picked" is a group named `state:item.state` with one child
   group per look, named `when:banned`, `when:picked`… Hide the ones you're not working on with the 👁
   eye icon; the engine still shows the right one on stream.
6. **Save as Inkscape SVG** (the normal Save). Keep text as text: don't use *Object to Path* on live text.
7. **Fonts:** use fonts that are in `design/fonts/` (Oxanium and Inter to start with, already installed for
   you). To add one: drop the `.ttf` in `design/fonts/` and install it on your PC. Use the font's real
   family name for the file name (`Rajdhani-Bold.ttf`, or `Rajdhani.ttf` for a variable font).
8. **Images that never change** (logos, sponsor art): put them in `design/` and *link* (not embed) them
   when importing, or embed if you prefer. Both work.
9. **A set of scenes in its own folder** (like `design/msu/`): list them as `svg: msu/match` in
   `overlay.yaml`. Images linked from those SVGs are found relative to the SVG, so keep them in the same folder.

**Hidden in Inkscape = hidden on stream**, except layers the engine controls (`show:`, `hide:`, `when:`).
So you can keep draft layers around, hidden.

---

## 2. Layer names

A layer name can hold several **tokens** separated by spaces. For example,
`{a.name | upper} fit:300 #player-name` means: show player A's name in capitals, shrink it to fit 300 px,
and call it `player-name` for animations.

| Token | Put it on | Does |
|---|---|---|
| `{path}` | a text | replaces the text with live data, e.g. `{a.name}` |
| `{path \| filter}` | a text | formats it, e.g. `{a.acc \| acc}` → `97.43%` (see §4) |
| `fit:300` | a text | shrinks to fit 300 px wide (down to 70 %), then cuts off with "…" |
| `img:path` | an image | swaps the picture, e.g. `img:map.cover` (clip it in Inkscape for rounded corners) |
| `bar:path` | a rectangle | stretches its width with a 0–1 value, e.g. `bar:a.health`, `bar:tug`, `bar:map.progress` |
| `vbar:path` | a rectangle | same, but height, growing upward |
| `show:condition` | anything | only visible while the condition is true (see §3) |
| `hide:condition` | anything | hidden while the condition is true (both on one layer = show AND NOT hide) |
| `color:a` / `color:b` | a shape or text | fill with that side's colour from overlay.yaml |
| `color:path` | a shape or text | fill with the colour of the side the value names, e.g. `color:item.by` |
| `stroke:a`, `stroke:path` | a shape | same, for the outline |
| `state:path` | a group | shows exactly one child: the one named `when:<value>` (`when:a\|b` for several, `when:else` for the rest) |
| `repeat:path` | a group | copies its contents once per item in a list (`repeat:pool`, `repeat:results`); inside, use `item.…` |
| `feed:a` / `feed:b` | a rectangle | a hole where that side's video goes (link set in the panel). Team layouts use `feed:a1`, `feed:a2`, `feed:b1`, `feed:b2` (side + lineup position). A hole inside a hidden layer gets no video |
| `fx:dust` / `fx:glitter` | a rectangle | live particles (WebGL) filling that rectangle, in that spot of the layer order (see §6, *Particles*) |
| `pulse:path` | anything | pulses whenever that number goes up (shortcut for a rule) |
| `enter:2` | anything | default entrance order, if the scene has no `enter:` rules |
| `#name` or a plain name | anything | the name you use in the rules file. A layer named just `scoreboard` is target `scoreboard` |

**Text with placeholders typed inside it** works too, and is often easier. Type
`Best of {match.bestOf} · {a.points}–{b.points}` as the text itself. It mixes fixed words with data.

---

## 3. Conditions (for `show:` / `hide:` / `becomes:`)

| Write | True when |
|---|---|
| `map` | there is a current map (any non-empty value) |
| `!match.winner` | there is no winner yet |
| `match.phase=playing` | phase is exactly `playing` |
| `match.phase=finished\|done` | either value |
| `item.state!=banned` | not banned |
| `a.points>=2`, `a.points>1`, `<`, `<=` | number comparisons |

No spaces inside a condition.

---

## 4. Filters

| Filter | Example | Result |
|---|---|---|
| `acc` | `{a.acc \| acc}` | `97.43%` (— before the map starts). Counts smoothly |
| `pct` | `{a.health \| pct}` | `85%` |
| `int` | `{a.score \| int}` | `1,234,567`. Counts smoothly |
| `num:1` | `{map.nps \| num:1}` | `6.7` |
| `time` | `{map.duration \| time}` | `3:35` |
| `countdown` | `{brb.endsAt \| countdown}` | `4:59`, ticking |
| `upper` / `lower` | `{a.name \| upper}` | `NOVA` |
| `flag` | `{a.country \| flag}` | 🇺🇸 (needs an emoji font in OBS) |
| `or:"TBD"` | `{a.name \| or:"TBD"}` | fallback when empty |
| `plus:1` | `{index \| plus:1}` | adds a number |
| `ordinal` | `{a.seed \| ordinal}` | `1st` |

---

## 5. The data you can use

Numbers in paths count from **1**: `pool.1` is the first map, `upNext.2` the second upcoming match.

| Path | Meaning |
|---|---|
| `tournament.name`, `tournament.short`, `tournament.round` | tournament info |
| `match.label`, `match.bestOf`, `match.need` | "Quarterfinal 1", 5, 3 (maps needed to win) |
| `match.phase` | `idle` → `picks` → `waiting` → `loading` → `playing` → `finished` (map done) → … → `done` |
| `match.mapNumber` | number of the current/next map |
| `match.maps` (list) | one per map of the best-of, for "MAP 1 / MAP 2 / MAP 3" tabs: `number`, `label` ("MAP 2", or "TB" for the tiebreaker), `tiebreaker`, `state` (`played` `current` `upcoming` `unneeded`), `name`, `winner`, `winnerName` |
| `match.winner`, `match.winnerName` | `a`/`b` and the name, once decided |
| `match.playersPerMap`, `match.solo` | players per map (1 = 1v1, 2 = duos); `solo` is true in a 1v1, so one scene can hold both layouts with `show:match.solo` / `hide:match.solo` |
| `a.players` / `b.players` (list) | who plays the current/next map for that side: `name`, `avatar`, and live `acc`, `score`, `combo`, `misses`, `finished`. Use `repeat:a.players` |
| `a.roster` | everyone on the team (names) |
| `a.…` / `b.…` | each side (the team; in a 1v1, the player). For teams the live numbers are the lineup together (average accuracy, total score and misses): `name`, `avatar` (image URL), `initials`, `country`, `seed`, `points` (maps won), and live while playing: `acc`, `score`, `combo`, `maxCombo`, `misses`, `health` (0–1), `finished`, `leading`, `winner` |
| `diff`, `tug` | accuracy difference a − b, and the same as 0–1 for `bar:tug` (0.5 = even, ±2 % fills it) |
| `map.…` | current or next map: `name`, `artist`, `mapper`, `difficulty`, `category`, `cover`, `bpm`, `nps`, `length` ("3:35"), `duration` (s), `progress` (0–1), `time` ("1:12") |
| `pool` (list) | every map in the pool. Per item: the map fields above plus `state` (`available` `banned` `picked` `tiebreaker` `current` `played`), `by` (`a`/`b`), `byName`, `order` (play order), `winner`, `winnerName` |
| `picks.next` | the step being decided now: `type` (`pick`/`ban`), `verb` (`picking`/`banning`), `by`, `byName` |
| `picks.done` | true when picks and bans are finished |
| `picks.steps` (list) | every step: `type`, `by`, `byName`, `done`, `current` |
| `results` (list) | maps played: `index`, `map.…`, `winner`, `winnerName`, `pickedBy`, `a.acc` `a.score` `a.misses`, `b.…` |
| `last` | the latest map result, same shape as a `results` item |
| `upNext` (list) | upcoming matches: `label`, `a`, `b` |
| `caster` (list) | `caster.1.name`, `caster.1.handle`, `caster.1.avatar` (Discord picture URL), set in the panel |
| `header` | the top bar's event text from the panel (falls back to the round name) |
| `bracket` | `bracket.name`, `bracket.rounds` (list; per round `name` and `matches`: `a`, `b`, `aScore`, `bScore`, `winner`, `state` = `upcoming`/`live`/`done`, `current`) |
| `bracket.double` | true for double elimination. Then `bracket.winners` and `bracket.losers` are the two brackets' rounds (same shape as `rounds`: `bracket.winners.1.matches`, `bracket.losers.2.name` …) and `bracket.final` the grand final's matches. The MSU bracket scene has a layout for each kind (`show:bracket.double` / `hide:bracket.double`) |
| `replay.…` | the replay playlist's song in the `feed:main` box (Starting Soon, Intermission, Be Right Back): `song`, `artist`, `mapper`, `cover`, `difficulty`, `stars`, `player`, `playerAvatar`, `acc`, `fc`, `misses`, ready-made lines `byline` ("Artist · mapped by Mapper") and `diffline` ("Expert+ · ★ 7.69"), the clock `time`, `length`, `progress` (0–1, for `bar:replay.progress`), `index`/`count` in the list, and `replay.next.song` / `replay.next.player` (what plays after it, empty in shuffle) |
| `replay.switching` | true while the "up next" card should cover the video: from a song's end until the next one starts (it loads underneath). `replay.revealing` is true for the card's last 0.7 s, for its exit animation. See `becomes:replay.switching` in `msu/intermission.rules.yaml` |
| `brb.title`, `brb.message`, `brb.endsAt` | BRB info (use `{brb.endsAt \| countdown}`) |
| `ticker` | the ticker lines joined into one string |

**Scene variables:** in `overlay.yaml`, `focus-a: { svg: focus, vars: { big: a, small: b } }` makes
`{big.name}`, `color:big`, `feed:big` mean side A in that scene. One design serves Focus A and Focus B.

---

## 6. The rules file (`<scene>.rules.yaml`)

```yaml
enter:            # plays each time the scene comes on stream
  - { target: scoreboard, from: { y: -90, opacity: 0 }, duration: 600 }
  - { target: stats-a, play: slideRight, delay: 200 }

on:               # reactions
  mapBan:                         # a match event
    - { target: card, play: shake }       # for mapPick/mapBan: only THAT map's card
  increase:a.misses:              # a data change
    - { target: misses-a, play: pulse }
  becomes:a.leading:              # a condition turning true
    - { target: acc-a, play: pulse }

loop:             # runs forever while the scene is on
  - { target: live-dot, play: breathe }

animations:       # your own, usable as play: <name>
  slam:
    keyframes: [ { scale: 1.6, opacity: 0 }, { scale: 1, opacity: 1 } ]
    duration: 300
    easing: back-out

repeat:           # spacing of repeat: copies (otherwise a row with 20 px gaps)
  pool: { dx: 242 }            # next copy 242 px to the right
  results: { dy: 104 }         # or downward
  # wrap: 4, rowHeight: 300    # grid: 4 per row

tween: 250        # how long counting numbers take (ms), 0 = jump

fx:               # particle layers (rectangles named fx:…), see "Particles" below
  dust: { amount: 0.5 }
```

### A step

| Key | Meaning |
|---|---|
| `target` | a layer name (`#name` or plain name) |
| `play` | a preset or one of your `animations` |
| `from` / `to` | animate from these values to normal (or to `to`) |
| `keyframes` | a list of states, optional `offset: 0.7` to time a middle frame |
| `duration`, `delay` | milliseconds (default 500 / 0) |
| `easing` | `snappy` (default), `ease-out`, `ease-in`, `ease-in-out`, `linear`, `back-out` (overshoot), `back-in`, `bounce` |
| `repeat` | a number, or `forever`; `alternate: true` goes back and forth |
| `keep: false` | snap back after playing (default: stay at the last frame) |

Animatable values: **`x`, `y`** (pixels), **`scale`**, **`rotate`** (degrees), **`opacity`** (0–1).
Scale and rotate happen around the layer's own centre.

### Presets

`fadeIn` `fadeOut` `slideUp` `slideDown` `slideLeft` `slideRight` `popIn` `pulse` `flash` `shake`
`stamp` `breathe` `spin`

### Particles (`fx:`)

Draw a rectangle where the particles should be and name it `fx:dust` (gold dust and bokeh drifting up, thick
at the bottom) or `fx:glitter` (a dense twinkling bed along the bottom edge). Put it in the `back` layer to
keep particles behind everything; its fill doesn't matter. The particles run on the graphics card and stop
while the scene is off stream.

Tweak them in the rules file. Sizes are pixels, ranges are `[min, max]`:

```yaml
fx:
  dust: { amount: 0.6, color: "#ffedbf" }      # half as busy, another colour
  floor: { preset: glitter, cloudHeight: 60 }  # a new effect for a layer named fx:floor
```

| Key | Meaning |
|---|---|
| `amount` | how busy (1 = normal, 0.5 = half) |
| `color`, `opacity` | particle colour, overall strength |
| `near`, `far`, `nearShare`, `top` | how high they reach: most within `near` px of the bottom, `nearShare` of them; the rest within `far`; none above `top` |
| `size`, `sharp`, `sharpSize`, `big`, `bigSize`, `rings` | soft discs; the share of hard specks and of big bokeh; how many hollow rings |
| `rise`, `sway`, `life` | drift up and sideways over each particle's life (seconds) |
| `twinkle` | 0 steady … 1 sparkly |
| `clouds`, `cloudHeight` | the glittery dust haze along the bottom edge (0 = none) |

A weak streaming PC can turn all particles off with `&nofx` at the end of the OBS URL; `&fps` shows the frame rate
in the corner while testing. A particle layer inside a hidden layer (`show:`/`hide:`) stops drawing.

### Events (`on:` keys)

| Event | When |
|---|---|
| `matchStart` | the match starts |
| `mapPick`, `mapBan` | a map was picked or banned (targets inside `repeat:pool` hit only that map's copy) |
| `picksDone` | picks and bans finished |
| `mapLoad` | the next map is loading |
| `mapStart` | players started the map (after the stream delay set in the panel) |
| `songEnd` | every player has finished the song (TA's scores are in; the referee hasn't closed the map yet) |
| `mapEnd` | the referee closed the map's scores (the result is final) |
| `matchEnd` | the match is decided |

Data changes: `increase:path`, `decrease:path`, `change:path`, `becomes:condition`.

---

## 7. Automatic scene switching (`overlay.yaml`)

```yaml
automation:
  - { on: mapStart, scene: match, when: "casters, brb, picks" }   # only from these scenes
  - { on: mapEnd, scene: picks, after: 10s }
  - { on: matchEnd, scene: results, after: 10s }
```

The panel's **Auto-switch** box turns all of them on or off.

---

## 8. Tips

- **Name things you'll animate** (`scoreboard`, `card`, `result`). Groups are easiest: animate a group,
  not 20 separate pieces.
- **Test every state:** run the simulator from the panel (Next step / Auto-play match) and watch each scene.
- **Long names:** always give names a `fit:`. Test with a 20-character name.
- **Rounded images:** draw a rounded rectangle over the image, select both, then *Object → Clip → Set Clip*.
- **Gradients, blur, shadows** all work, but heavy blur over large areas costs performance in OBS. Prefer
  soft gradients.
- **Errors** (a typo in a rules file, a broken SVG) show in red in the panel, never on stream.
