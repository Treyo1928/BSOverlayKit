# MSU Esports overlay – source assets & measurements

Recreating the Mississippi State University (MSU) Esports stream overlay as SVG + WebGL.
Reference images (not copied here) came from the user's `OverlayWork/` folder:
`Images/new_bg.png`, `StartingSoonNew.png`, `IntermissionNew.png`, `CasterOverlay.png`,
`FinalNew.png`, `Val.png`, `Val2.png`, plus the fonts `Shader Regular.ttf`, `Shader Hairline.ttf`,
`Geom Graphic Light.ttf`.

All coordinates are in 1920x1080 overlay pixels. Ranges are inclusive (`x 595..1828` = 1234 px).

---

## 1. Files in this folder

| File | What it is | Origin |
|---|---|---|
| `shield.svg` | Vector MSU Esports "M/S" shield, gold gradient fill, 465x539.5 viewBox, 2 polygons (even-odd) | **Reconstruction** traced from the official 1024px YouTube avatar. Vertices idealized; all diagonals share one slope (~0.556, about 29°). 99.1 % IoU vs the official raster |
| `shield-hires-gold.png` | 478x551 transparent PNG of the shield, overlay gold gradient | Colour-keyed from the **official** YouTube avatar (JPEG source, so the edges are slightly soft) |
| `shield-hires-white.png` | Same alpha, white fill (for tinting) | Same as above |
| `logo-extracted.png` | 445x145 transparent PNG of the full lockup (shield + "MISSISSIPPI STATE / ESPORTS"), gold gradient | **Extracted, lower quality**: difference-matted from `StartingSoonNew.png` using `new_bg.png` as the known background. Logo sits at x 75..511, y 246..382 there |
| `logo-lockup-traced.svg` | Vector lockup: vector shield + auto-traced wordmark (viewBox 445x145) | **Approximate**: wordmark traced from the ~60px-tall raster (97.7 % IoU). Letter corners are slightly irregular. Replace it if an official file turns up |
| `bg-clean.png` | `new_bg.png` with every baked particle, bokeh disc/ring and gold dust cloud removed | Derived. About 5 % of pixels were rebuilt (bottom-heavy). The rest are the original pixels |
| `bg-gradient.png` | The smooth vertical gradient alone, 1920x1080, ±0.5 LSB dither | Derived (row mode of `new_bg.png`) |
| `bg-gradient-strip.png` | Same gradient as a 1x1080 strip (use as a 1-D texture/LUT) | Derived |
| `bg-flowers.png` | Magnolia line art as **white + alpha** RGBA, 1920x1080, particle holes filled | Derived (see the compositing formula in §3) |
| `particles-ref.png` | The removed particle layer (`new_bg − bg-clean`), RGBA additive reference | Derived. For tuning the shader only, not meant for shipping |
| `reference/official-youtube-avatar-1024.jpg` | Official channel avatar: cream shield on maroon with magnolia line art | Official (see §2) |
| `reference/official-campuslabs-profile-699.png` | Official Campus Labs / Cowbell Connect org picture (same design, 699x700) | Official |
| `reference/official-discord-splash-960.png` | Official Discord server invite splash: shield + "MISSISSIPPI STATE ESPORTS / JUST BETTER · /ESPORTSMSU" in the heading font, on this same flower background | Official |

## 2. Logo research – official sources

**No official transparent or vector MSU Esports logo was found publicly.** No press kit or brand page
for the club exists. msstate.edu brand assets cover only university/athletics marks, and Wikimedia Commons has
only athletics SVGs (e.g. `File:Mississippi State Bulldogs logo.svg`), nothing for esports.
The best official rasters are the club's own avatars:

- YouTube channel `UCr982QMNKdScvfkiynSGLHA` – https://www.youtube.com/channel/UCr982QMNKdScvfkiynSGLHA
  - avatar at 1024px: `https://yt3.googleusercontent.com/p7jc9dmnSYgHyvgUCfY0L0hvcgovbUgJgN2OFD6R3TTigslqTz76WhLLIEcjrcMkl2xlHY7U=s1024-c-k-c0x00ffffff-no-rj` (JPEG, no alpha). This is the source for `shield*.png/svg`
- Campus Labs ("Cowbell Connect") org page – https://msstate.campuslabs.com/engage/organization/msu-esports
  - JSON: https://msstate.campuslabs.com/engage/api/discovery/organization/bykey/msu-esports
  - picture: https://se-images.campuslabs.com/clink/images/ed689c88-cb2f-448d-b231-c6c9bb8f88d2d03f0800-74d9-4bbb-9154-edd1ff7b9f36.png (699x700 RGB, no alpha)
  - lists the club's links: X/Twitter `@esports_msu`, Instagram `esports_msu`, https://solo.to/msuesports,
    LinkedIn `msu-esports`, Facebook `msesAnnouncements`, Discord https://discord.gg/esportsmsu, e-mail `esports@cse.msstate.edu`
- Discord guild 91616024931106816 (via the public invite API):
  - splash https://cdn.discordapp.com/splashes/91616024931106816/90ba1ae245cbd5d1f7136d9e1dafe961.png?size=2048 (served at 960x540)
  - the guild icon is currently a seasonal Halloween bat variant of the shield, so it was not used
- Admissions page for the club: https://www.admissions.msstate.edu/student-experience/getting-involved/prospective-students/msu-esports
- MSU news (Twitch `esports_msu`, older `msstate_esports`): https://www5.msstate.edu/newsroom/article/2024/01/sixth-annual-esports-egg-bowl-set-saturday-jan-27

University brand / licensing context (these cover the university marks, not the club mark):
- Visual identity standards: https://brand.msstate.edu/identity · assets: https://brand.msstate.edu/assets/index.php
  (official maroon = Pantone 505). Unit logos are requested through the Office of Public Affairs.
- Trademark licensing: MSU marks are controlled by a licensing program run by Affinity Licensing, and
  commercial use needs written approval – https://legal.msstate.edu/trademark/brandguides/internaldeptmerchguide_letter.pdf
- Athletics internal branding portal: https://hailstate.com/sports/2024/1/25/InternalBrandingPortal

**Usage note:** the shield/lockup is the MSU Esports club's mark. Using it on MSU Esports' own broadcast
is the intended use. For anything else, or to get the real vector master, ask the club's graphics/production
team (Discord / `esports@cse.msstate.edu`). They also likely hold the source file for the magnolia artwork (§5).

## 3. Background decomposition (`new_bg.png`)

Findings:
- The gradient is **purely vertical**: every column has the same colour per row.
- The flower lines are **multiplicative on the gradient**: `pixel = G(y) · (1 + a)`, with `a ∈ [0, 1]`.
  The brightest line core is exactly 2×G at every height. That is why lines read pink at the top and
  neutral grey at the bottom. The flowers are not tinted separately; they are the gradient
  "dodged" ×2 by a white line layer.
- Shader recipe: `col = grad(y) * (1.0 + flowers.a)` (optionally `* tint`). Recomposing the delivered layers
  this way matches `bg-clean.png` to a mean abs error of 0.3/255 (99th pct 1.5/255).
- The flower art contains one internal duplicate: the cluster at the left-center (x 0..800, y 240..1000) is
  repeated at offset **(dx +1008, dy −205)**. It is otherwise not a tiling seamless pattern at this crop.

Particle removal method: particles don't fit the `G·(1+a)` hue model (cream on maroon). They were
detected from the colour residual plus a warm-hue score (plus a grey-ring detector restricted to areas with
little line art). Holes were filled tile-by-tile on the tint-free `a` map by exemplar (FFT masked-SSD) search,
taking the duplicate offset when it matched. The result was checked at 20× residual gain: no particles remain.
Limits: under the four big dust clouds at the bottom edge the line art is plausibly synthesized, not truly
recovered. A few short line fragments there don't connect perfectly.

### Gradient colours (row mode, exact)

| y | hex | RGB |
|---|---|---|
| 0 (top) | `#370715` | 55,7,21 |
| 270 | `#30111a` | 48,17,26 |
| 540 (middle) | `#231418` | 35,20,24 |
| 810 | `#151213` | 21,18,19 |
| 1079 (bottom) | `#0d0d0c` | 13,13,12 |

Note the green channel rises 7→20 by mid-height and then falls. It is not a straight maroon→black blend.
CSS stops (max error per channel):
- 3 stops (±4): `#370715 0%, #231418 50%, #0d0d0c 100%`
- 5 stops (±2.5): `#370715 0%, #30111a 25%, #231418 50%, #151213 75%, #0d0d0c 100%`
- 9 stops (±1.2): `#370715 0%, #350e18 13%, #30111a 25%, #29141a 38%, #231418 50%, #1b1315 62%, #151213 75%, #100f0f 87%, #0d0d0c 100%`
- Or sample `bg-gradient-strip.png` (exact).

Flower line colour = 2 × gradient at the same y. At the top that is ≈ `#6e0e2a`, mid ≈ `#462830`, bottom ≈ `#1a1a18`.

## 4. Colours & geometry of the scene images

**Cream/gold text and logo fill** (a vertical gradient on every element):
- Logo/shield and the "THE STREAM IS STARTING SOON" / "INTERMISSION" headings: top `#d9cdb3` → bottom `#d9c499`
  (heading block median `#dac9a4`; solid range p10–p90 `#d9c79f`–`#daccb0`)
- Lockup "MISSISSIPPI STATE" `#d9caaa`, "ESPORTS" `#d9c69e`
- `FinalNew.png`: "FINAL" `#d3c198`, "THANKS FOR WATCHING" `#c6b58f` (slightly darker/dimmed variants)
- Official avatar shield (flat, no gradient): `#f1eecb`. Avatar background maroon ≈ `#5d0c23`→`#420a1e` with soft shadow

**Maroon border of the cutout frames:** an 8 px stroke with a vertical gradient. Top edge `#5e0c23` (= MSU maroon
as used here; RGB 94,12,35), going darker down the sides.

`StartingSoonNew.png` / `IntermissionNew.png` (identical geometry):
- Transparent cutout (alpha=0): **x 595..1828, y 171..907** (1234x737), all 4 corners radius **≈16 px**
  (108 partially transparent anti-aliased pixels at the corners; outside pixels are fully opaque)
- Frame stroke outer box: x 587..1836, y 163..915 (1250x753), 8 px wide, outer radius ≈24
- Stroke colour along the sides: y163 `#5e0c23` → y265 `#4f081c` → y365 `#3d0514` → y465 `#2b030c` →
  y565 `#1b0106` → y665 `#0c0002` → black from ≈y800 to the bottom edge (y915).
  Roughly a linear `#5e0c23` → `#000000` over the top 85 % of the frame height.
- Logo lockup box x 75..511, y 246..382

`CasterOverlay.png` (two cams):
- Cutout A: **x 105..933, y 207..673** (829x467). Cutout B: **x 979..1807, y 207..674** (829x468; 1 px taller)
- Only the **top** corners are rounded (r ≈16). The bottom edge meets the name bar
- Frame outer boxes: A x 97..941, B x 971..1815, both y 199..791 (8 px stroke, outer r ≈24)
- Name bar (opaque, inside each frame): 8 px black separator at y ≈675..683, then a bar from y 684..783 with a vertical
  gradient `#353535` (y684) → `#202020` (y700) → `#0c0d0d` (y720) → `#000000` (≈y765..783).
  Its bottom corners are rounded r ≈16
- Caster stroke gradient is maroon at **both** ends: y199 `#5e0c23` → y320 `#3f0615` → y440 `#200107` →
  black ≈y620..700 → y720 `#140104` → y760 `#3f0615` → bottom edge y784..791 `#5d0c23`

## 5. Particle look (for the shader)

Three kinds of particles are baked in. The additive colour (normalized) is **`#ffedbf`** (255,237,191) and the
brightest cores are `#f7ecd2` / `#f2e6ce`.

1. **Sharp specks** (~6 % of particles): half-max diameter 2.7–8 px (median 3.7), additive peak 70–210/255,
   crisp edge with a slight soft halo.
2. **Soft bokeh discs** (~94 %): mostly 3–10 px across (90th pct about 8 px half-max), very dim (additive +9…+30).
   A few large out-of-focus ones are 20–45 px (e.g. at (1545,708), (1495,850), (1790,630)), and a couple
   of hollow **bokeh rings** ~30 px across at mid-height ((1125,572), (1152,645)).
3. **Gold dust clouds** hugging the bottom edge: grainy, low-contrast clouds 150–270 px wide and 60–100 px tall
   at x 150..310, 780..850, 900..1070 and 1650..1920 (y ≥ 975).

Density versus height in `new_bg.png` (components per megapixel / % area covered):

| band y | per Mpx | coverage |
|---|---|---|
| 0–270 | ~27 (only faint specks) | 0.04 % |
| 270–540 | 39 | 0.13 % |
| 540–700 | 111 | 0.45 % |
| 700–860 | 208 | 0.95 % |
| 860–970 | 464 | 1.95 % |
| 970–1080 | 1316 | 8.95 % |

Rule of thumb: almost nothing in the top 40 %, then density roughly doubles every ~110 px going down, and
the bright specks are spread through y 450–1080. Particles are distributed fairly evenly across x, with slight
clustering bottom-left and right.

`StartingSoonNew.png` and `IntermissionNew.png` add an **extra dense glitter ground band** on top of that
(colour `#ffeeca`): 530/Mpx at y 900–960, 2127/Mpx at y 960–1020 and 4931/Mpx at y 1020–1080, covering 36 % of the
bottom 60 px. It reads as a sparkling dust floor; `FinalNew.png` and `CasterOverlay.png` don't have it.

## 6. Fonts

- **Val.png / Val2.png bar text** (`MSU MAROON`, `BEST OF 3`, `MAP 1/2/3`, `SPLIT`, `PLACEHOLDER`,
  `NECC DIV I/III GROUP STAGE`): **Shader** (the supplied `Shader Regular.ttf`). It's an extended geometric
  family. Rendered samples match the letterforms (S, R, B, M, A, P, 3). The small `NECC …` labels match
  **Shader Regular** directly. `MSU MAROON` / `BEST OF 3` / `MAP n` use a **heavier Shader weight**
  (or Regular with a stroke) plus a dark maroon outline/shadow. Only Regular and Hairline were supplied.
  `Geom Graphic Light` does **not** match any visible text (it may be meant for small body or score text).
- **Big italic headings** ("THE STREAM IS STARTING SOON", "INTERMISSION", "FINAL", "THANKS FOR WATCHING", and the
  Discord splash "MISSISSIPPI STATE ESPORTS / JUST BETTER"): **not identified.** It's a heavy, slanted, square-cornered
  **unicase** display face: N drawn like a squared lowercase "n", A like a squared lowercase "a", S looks like "5",
  K and G squared with spurs. I rendered and compared these and **none match**: Hemi Head Bold Italic (closest in weight
  and slant, but its A and N are normal), Kenyan Coffee Bd It, Gunplay, Nulshock, Zekton, Neuropol / Neuropol X /
  Neuropolitical, Spy Agency, Good Times, Zero Velocity. Ask the overlay's designer for the font name. Until then the
  headings could be traced to SVG paths from the PNGs (fixed text), or Hemi Head Bold Italic could stand in
  (Typodermic, https://www.dafont.com/hemi-head.font). Its bundled "Desktop EULA" allows free commercial use for
  **static** work only (images, rendered video). Embedding the font file in a web/OBS browser overlay via `@font-face`
  is probably not covered and would need Typodermic's web/app licence. Converting fixed headings to SVG paths avoids that.
  None of the candidates were installed. They were only rendered from a scratch folder.
- **Logo lockup wordmark** ("MISSISSIPPI STATE / ESPORTS"): a condensed, squared athletic sans (an Industry/United-Sans-like
  style). It's not identified and not needed, because it's part of the logo artwork (use `logo-lockup-traced.svg`).

## 7. Magnolia line-art pattern – candidates (not downloaded)

The same magnolia drawing (flowers with stamen hatching, buds, veined leaves) appears in the club's official
avatar and Discord splash. So the club's designer has the original, and that is the most reliable way to get a
vector. Stock candidates in the same engraving/outline style; **none visually confirmed** (Adobe Stock blocks
scripted preview access), and all are **paid**:
- Adobe Stock 159214961 "Black seamless pattern with flowers, buds, leaves and branches of magnolia" (vector) –
  https://stock.adobe.com/images/black-seamless-pattern-with-flowers-buds-leaves-and-branches-of-magnolia-vector-illustration-isolated-on-background-for-design-fabric-or-wallpaper/159214961
- Adobe Stock 248058071 "Seamless pattern, floral elements, bundle of linear sketch of magnolia flowers" (vector) –
  https://stock.adobe.com/images/seamless-pattern-floral-elements-bundle-of-linear-sketch-of-magnolia-flowers-collection-of-hand-drawn-style-black-and-white-line-illustrations-on-a-white-background-vector-illustration/248058071
- Alamy "Magnolia flowers on a branch pattern" (linear vector) – https://www.alamy.com/magnolia-flowers-on-a-branch-pattern-vector-illustration-image410214674.html
- Alamy "Magnolia in blossom … seamless pattern" – https://www.alamy.com/magnolia-in-blossom-flourishing-flower-and-leaves-seamless-pattern-image363110579.html
- Patternbank "Magnolia Botanical Flowers Hand Drawn" (raster tile, $120 commercial) – https://patternbank.com/kasiarobak/designs/226245283-magnolia-botanical-flowers-hand-drawn-vector

Until a source vector is found, `bg-flowers.png` (alpha) is the usable layer. To animate it, multiply by the gradient
as in §3, then drift or parallax it or modulate its alpha.

---

## Added for the scenes (2026-10-28)

| File | What it is | How it was made |
|---|---|---|
| `starting.svg`, `intermission.svg`, `casters.svg`, `final.svg` | The four reference screens, live | Laid out on the measured coordinates above (cutouts, 8px frames, logo position). Cutouts are real holes, so OBS sources under the overlay show through |
| `match.svg` | In-game scene in the style of `Val.png` / `Val2.png` | Hanging top bar (round, BEST OF, MAP tabs), team row with score dots, two feed holes, stats, song card |
| headings in those SVGs ("THE STREAM IS STARTING SOON", "INTERMISSION", "FINAL", "THANKS FOR WATCHING") | Vector paths | Traced with potrace from the reference PNGs at 6× (the heading font is unidentified, see §2/§4). To write new words in that style, the closest open font is **Squada One** (OFL, in `design/fonts`) |
| `panel-swirl.png` | 1024×512 maroon swirl texture for the Val-style panels (stretched over each panel; the halftone dots are a vector pattern on top) | Generated (log-spiral streaks + vignette) to resemble the panels in `Val.png`. Replace it with the designer's real texture if it turns up |
| particles | Not an image: the `fx:dust` and `fx:glitter` layers (`web/engine/fx.js`), tuned against `particles-ref.png` | WebGL shader |

Fonts: the bar text uses **Shader** (Regular, made heavier with a same-colour stroke) and small text **Geom Graphic
Light**, both from the designer's `OverlayWork` folder. Their licences are unknown; ask the designer before
publishing the overlay files anywhere public.
