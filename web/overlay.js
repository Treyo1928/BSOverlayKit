// The OBS page. Loads the scene SVGs, keeps them bound to live data, switches scenes, plays rules.
import { Scene } from "/engine/scene.js";

const params = new URLSearchParams(location.search);
const key = params.get("key");
const debug = params.has("debug");
// &staged: a preview of the STAGED state (the panel's "Next" side): the staged scene and texts instead of what is on
// air. It never runs replay viewers: its video holes stay dark.
const staged = params.has("staged");
// &mute: the panel's preview. It shows the scene with the video boxes dark and plays nothing: the replays are drawn by
// whoever shows the stream (OBS), and a panel that is open on someone's desk, mostly minimised, should cost nothing.
const mute = params.has("mute") || staged;
// &listen (the panel's "Replays and sound here"): the preview draws the replays itself (small) and plays their sound
const listen = params.has("listen") && !staged;
// &viewer=http://127.0.0.1:4000: this page takes its replay viewers from there instead of the address the overlay
// server gives (a stream PC that runs its own viewer, each box then in a browser process of its own)
const viewerOverride = (() => { try { return params.get("viewer") ? new URL(params.get("viewer")).origin : ""; } catch { return ""; } })();
const silent = (mute && !listen) || params.has("silent");   // no sound at full quality (testing)
// how big the panel shows this page (it tells us, also on resize): the preview's replays draw at that size, not 1080p
let previewScale = 1;
if (params.has("bg")) document.body.classList.add("preview-bg");

let scenes = {}, active = null, state = null, designVersion = null, loading = null;
const $ = (s) => document.querySelector(s);

function showError(msg) {
  console.error(msg);
  if (!debug) return;                 // never put errors on the real stream
  const d = $("#debug");
  d.textContent = msg;
  d.style.display = msg ? "block" : "none";
}

// ---------------------------------------------------------------- fonts from design/fonts
async function loadFonts(urls) {
  for (const url of urls) {
    const file = decodeURIComponent(url.split("/").pop()).replace(/\.\w+$/, "");
    // "Oxanium.ttf" -> family Oxanium (all weights, variable font); "Oxanium-Bold.ttf" -> Oxanium 700
    const [family, style = ""] = file.split("-");
    const weights = { hairline: 100, thin: 100, extralight: 200, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
    const w = weights[style.toLowerCase().replace("italic", "")] ?? (/^\d{3}$/.test(style) ? style : "100 900");
    try {
      const face = new FontFace(family, `url("${encodeURI(url)}")`,   // quoted + encoded: file names have spaces
        { weight: String(w), style: /italic/i.test(style) ? "italic" : "normal" });
      document.fonts.add(await face.load());
    } catch (e) { showError(`font ${file}: ${e.message}`); }
  }
}

// ---------------------------------------------------------------- scenes
async function loadDesign() {
  const d = await fetch("/api/design").then((r) => r.json());
  await loadFonts(d.fonts);
  const next = {};
  const errors = [];
  for (const [id, def] of Object.entries(d.scenes)) {
    if (def.error) errors.push(def.error);
    const s = new Scene(id, def, { colors: state?.colors ?? {} });
    try { await s.load($("#back"), $("#front")); next[id] = s; }
    catch (e) { errors.push(e.message); s.destroy(); }
  }
  for (const s of Object.values(scenes)) s.destroy();
  scenes = next;
  active = null;
  showError(errors.join("\n"));
  if (state) apply(state, true);
}

// the server's clock (all overlays follow the same replay clock, even on another PC)
let clockOffset = 0;
const serverNow = () => Date.now() + clockOffset;
const REVEAL_MS = 700;               // the "up next" card's exit, after the song starts

/** The replay playlist for the scenes: `replay.song`, `replay.player`, `replay.switching` (the "up next" card) … */
function replayCtx(r) {
  if (!r) return {};
  const now = serverNow();
  const i = r.info ?? {};
  const pos = r.pausedAt ?? (r.startAt == null ? 0 : Math.max(0, (now - r.startAt) / 1000));
  const dur = r.duration || i.duration || 0;
  return {
    ...i,
    song: i.song || (i.source === "scoresaber" ? "ScoreSaber replay" : "Replay"),
    loaded: !!r.info,
    switching: r.startAt == null || now < r.startAt + REVEAL_MS,
    revealing: r.startAt != null && now >= r.startAt && now < r.startAt + REVEAL_MS,
    time: fmt(Math.min(pos, dur || pos)), length: dur ? fmt(dur) : "", progress: dur ? Math.min(1, pos / dur) : 0,
    next: r.next ?? {}, index: r.index, count: r.count, mode: r.mode,
    team: r.team ?? "",                                  // whose showcase replay it is ("" = from the panel's own list)
    // ready-made lines, so a design needn't juggle empty values
    byline: [i.artist, i.mapper && `mapped by ${i.mapper}`].filter(Boolean).join(" · "),
    diffline: [i.difficulty, i.stars ? `★ ${i.stars.toFixed(2)}` : ""].filter(Boolean).join(" · "),
  };
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function ctxFrom(st) {
  const d = st.data ?? {};
  const show = st.show ?? {};
  return {
    ...d,
    replay: replayCtx(st.replay),
    caster: show.casters ?? [],
    header: show.header || d.tournament?.round || "",
    // the Casters scene's "up next" block, typed in the panel: hidden until something is set
    nextUp: (() => {
      const n = show.upNext ?? {}, teams = !!(n.a && n.b);
      // two names = a match-up (`teams`, with the text as its `label`); otherwise one `line` of text
      // their marks, where the names are teams of the tournament (else the default star)
      const mark = (name) => (d.teams ?? []).find((t) => t.name.toLowerCase() === String(name ?? "").trim().toLowerCase()) ?? { logoKind: "star", logo: "" };
      const ma = mark(n.a), mb = mark(n.b);
      return { aLogoKind: ma.logoKind, aLogo: ma.logo, bLogoKind: mb.logoKind, bLogo: mb.logo, a: n.a ?? "", b: n.b ?? "", teams, label: teams ? n.text ?? "" : "", line: teams ? "" : n.text || n.a || n.b || "", set: !!(n.a || n.b || n.text) };
    })(),
    brb: show.brb ?? {},
    ticker: (show.ticker ?? []).join("     ◆     "),
    show,
    colors: st.colors ?? {},
  };
}

function apply(st, fresh = false) {
  document.documentElement.style.setProperty("--fade", `${st.crossfade ?? 400}ms`);
  const ctx = ctxFrom(st);
  for (const s of Object.values(scenes)) {
    s.env.colors = st.colors ?? {};
    s.env.fadeMs = st.crossfade ?? 400;
    s.update(ctx);
  }
  switchTo(st.show?.scene, fresh);
  updateFeeds(st);
}

function switchTo(id, fresh) {
  if (!scenes[id] || (active === id && !fresh)) return;
  const was = active;
  active = id;
  for (const [sid, s] of Object.entries(scenes)) s.setVisible(sid === id);
  scenes[id].enter();
  scenes[id].startLoops();
  if (was !== id && state) assignViewers();
}

// &fps on the URL: the frame rate in the corner: this page's, then each replay on screen (frames each viewer draws)
let pageFps = 0;
if (params.has("fps") || params.has("report")) {
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;right:12px;bottom:12px;z-index:10;font:700 28px monospace;color:#0f0;background:#000c;padding:4px 10px";
  if (params.has("fps")) document.body.append(el);
  let n = 0, t0 = performance.now();
  const tick = (now) => {
    n++;
    if (now - t0 >= 1000) {
      pageFps = Math.round(n * 1000 / (now - t0));
      const shown = pool.filter((f) => f.shown && f.fps != null).map((f) => f.fps);
            el.textContent = `${pageFps} fps` + (shown.length ? ` · replays ${shown.join(" ")}` : "")
        + (liveFreezes ? ` · live freezes ${liveFreezes}` : "");
      n = 0; t0 = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
// &report=<url>: every 5 s, POST the frame rates there (comparing browsers on one PC)
if (params.get("report")) {
  setInterval(() => {
    const body = { ua: navigator.userAgent, scene: active, pageFps, heap: performance.memory?.usedJSHeapSize ?? null,
      viewers: pool.map((f) => ({ i: f.i + 1, hole: f.hole, shown: f.shown, ready: f.el.classList.contains("ready"), fps: f.fps ?? null,
        size: f.size ?? null, box: f.shown ? [Math.round(f.el.offsetWidth), Math.round(f.el.offsetHeight)] : null,
        v: f.v ? { t: Math.round(f.v.time * 10) / 10, playing: f.v.playing } : null })) };
    fetch(params.get("report"), { method: "POST", body: JSON.stringify(body) }).catch(() => {});
  }, 5000);
}

// countdowns tick even without new data
setInterval(() => { if (state && active) scenes[active]?.update(ctxFrom(state)); }, 250);

// ---------------------------------------------------------------- video feeds (persistent iframes)
// A hole shows: a link set in the panel, else what the data provides (TA live / mock replays in the viewer), else
// for feed:main the replay playlist. Iframes stay loaded across scenes; their sound fades in when the hole is on
// stream and out when it leaves (replay viewers only: they listen for msu:… messages, see chroviewer's
// broadcast-bridge.ts). A hole with a clock (the playlist, live replays) is kept on the server's clock: every overlay
// page seeks its viewer to the same moment, so OBS and the panel preview match.
// A fixed pool of replay viewers, made once and never unloaded. Making a new viewer page per replay (and throwing the
// old one away) leaked: every page brings its own WebGL context, decoders and caches, and a removed page is only
// freed when the browser gets round to it. Instead each viewer keeps its page for the whole show, moves to whichever
// hole needs it, and loads the next replay inside the same page (msu:load, chroviewer's broadcast-bridge.ts). A viewer
// that already shows the replay a hole wants just moves there; spare viewers preload what other scenes will show (a
// match's players while the map loads), so scene changes don't show loading. A hole shows a dark panel until its
// replay is in. Links that aren't replay-viewer links (typed into the panel) get a plain iframe of their own.
// Multiview (&multiview, opt-in): the viewers are tiles of ONE ChroViewer page (?multiview=N) covering the screen,
// drawn by one renderer into their holes: one browser process and WebGL context instead of N (chroviewer's
// multiview-shell.tsx). Every message carries the tile it is for; the page draws only the tiles listed in msu:tiles.
// Cheaper on light maps (Chromium, 4 replays: 60 fps each, ~25 % less CPU and memory), but every tile's per-frame
// work then shares ONE thread: on a heavy map (Spin Eternally: one replay alone ~35-60 fps) 4 tiles got 12-15 fps
// each, where 4 separate pages (in parallel, on 4 cores) got 60/35/60/58. Firefox is slower at it too (out-of-
// process WebGL: 37-41 vs 56-59). So separate pages are the default; &separate is accepted for older links.
const MULTI = params.has("multiview");
// Multiview keeps a 5th tile so the playlist replay has its own: otherwise the last match player loads into the one
// that was playing Intermission as Match comes on (a dark box for a few seconds). A waiting tile isn't drawn, so it
// costs little there; a 5th page of its own costs about 1 GB, so separate pages stay at 4. &viewers=N overrides.
const POOL = Math.max(1, Number(params.get("viewers")) || (MULTI ? 5 : 4));
let multi = null;                                      // { el, ifr, origin }
const pool = [];
if (params.has("debug")) window.__msuPool = pool;       // for checks: what each viewer is told
// viewers: { i, el, ifr, origin, alive, hole, link, token, v, … }
const plain = {};                                      // hole -> { el, ifr, src } for non-replay links
let loadToken = 0;
const VOLUME = { main: 1, a: 1, a1: 1 };               // which holes are heard while on stream (the others are silent); how loud is the panel mixer's business
const FADE_MS = 1200;
// Re-seek a viewer that is this far off the clock. The copy you hear (OBS) is only corrected when it is clearly off,
// and rarely: every seek is an audible skip. A muted copy (the panel preview) can be kept tighter.
const DRIFT = { heard: { s: 1.5, wait: 10_000 }, muted: { s: 0.4, wait: 2000 } };
if (debug) window.msuFeeds = {};                       // hole id -> its viewer, for checking sync from the console
// A preview without &listen runs no viewers: its video boxes are dark panels (`blanks`), so the layout still reads.
const noViewers = mute && !listen;
const blanks = {};                                     // hole id -> its dark panel

/**
 * Each viewer on its own local address (127.0.0.2, .3, …: all this PC). Browsers run every frame of one site in one
 * process, so viewers on 127.0.0.1 shared a single CPU core; on separate addresses they run in parallel, and each gets
 * its own WebGL context allowance. Only for a viewer on 127.0.0.1 (start.sh serves it on 127.0.0.1-6).
 */
function viewerOrigin(src, i) {
  // &viewer= on this page's address wins; else a hosted viewer with an address per box (CHROVIEWER_URL with {n} in
  // it: v1.…, v2.…); else the one address the server gave
  const pattern = viewerOverride ? "" : state?.viewerPattern ?? "";
  const u = new URL(viewerOverride || (pattern ? pattern.replace("{n}", String(1 + (i % 5))) : src));
  if (u.hostname === "127.0.0.1" && !params.has("nospread")) u.hostname = `127.0.0.${2 + (i % 5)}`;
  return u.origin;
}
/** A replay-viewer link → what to load ({ scoreIdBL } / { scoreId } / { replayUrl }), or null for other links. */
function replayLink(src) {
  try {
    const q = new URL(src).searchParams;
    if (q.get("taLive")) return { taLive: q.get("taLive"), ...(Number(q.get("taDelay")) > 0 ? { taDelay: Number(q.get("taDelay")) } : {}) };      // a player's TA live replay (see "live replays" below)
    if (q.get("scoreIdBL")) return { scoreIdBL: q.get("scoreIdBL") };
    if (q.get("scoreId")) return { scoreId: q.get("scoreId") };
    if (q.get("replayUrl")) return { replayUrl: q.get("replayUrl") };
  } catch {}
  return null;
}
const linkKey = (l) => (l ? l.taLive ?? l.scoreIdBL ?? l.scoreId ?? l.replayUrl ?? "" : "");

function feedSrc(id, st) {
  const name = id.slice(5);
  const http = (v) => (/^https?:\/\//.test(v ?? "") ? v : "");
  if (http(st.show?.feeds?.[name])) return { src: st.show.feeds[name], clock: null, replayId: null };
  if (http(st.data?.feeds?.[name])) {
    const at = st.data.feedsStartAt;
    return { src: st.data.feeds[name], clock: at ? { startAt: at, pausedAt: null } : null, replayId: null };
  }
  if (name === "main" && st.replay?.url) {
    return { src: st.replay.url, clock: { startAt: st.replay.startAt, pausedAt: st.replay.pausedAt }, replayId: st.replay.id };
  }
  return { src: "", clock: null, replayId: null };
}

// The HitScoreVisualizer config every replay viewer uses for its flying hit scores: the file overlay.yaml names
// with `hsv:` (inside design/), read again whenever the designs change. Empty: each replay keeps its own.
const hsvProfile = { key: "", text: "" };
async function loadHsv(path, version) {
  const key = path ? `${path}@${version}` : "";
  if (key === hsvProfile.key) return;
  hsvProfile.key = key;
  hsvProfile.text = path ? await fetch(`/design/${path}?v=${version}`).then((r) => (r.ok ? r.text() : "")).catch(() => "") : "";
}

// a viewer page's link: muted, and already at the panel's quality (changing it after load rebuilds the 3D scene)
function viewerUrl(origin, extra = {}) {
  const cam = state?.show?.viewer ?? {};
  const settings = { masterVolume: 0, graphicsQuality: cam.quality ?? "medium", screenDisplacementEffects: cam.distortion ?? true };
  return `${origin}/?${new URLSearchParams({ ...extra, hideUI: "true", settings: JSON.stringify(settings) })}`;
}
function multiview(src) {
  if (multi) return multi;
  const el = document.createElement("div");
  el.className = "feed multiview shown";
  Object.assign(el.style, { left: "0", top: "0", width: "100%", height: "100%", background: "transparent", zIndex: "1" });
  const ifr = document.createElement("iframe");
  ifr.allow = "autoplay; encrypted-media";
  ifr.style.background = "transparent";
  const origin = viewerOrigin(src, 0);
  ifr.src = viewerUrl(origin, { multiview: String(POOL) });
  el.append(ifr);
  $("#feeds").append(el);
  return (multi = { el, ifr, origin });
}
function newViewer(src) {
  const i = pool.length;
  const el = document.createElement("div");
  el.className = "feed viewer";
  let ifr, origin;
  if (MULTI) ({ ifr, origin } = multiview(src));       // a tile: the hole's dark panel is all of it here
  else {
    ifr = document.createElement("iframe");
    ifr.allow = "autoplay; encrypted-media";
    origin = viewerOrigin(src, i);
    ifr.src = viewerUrl(origin);
    el.append(ifr);
  }
  $("#feeds").append(el);
  if (multi) $("#feeds").append(multi.el);             // the tiles' page stays above the holes' dark panels
  const f = { i, tile: String(i), el, ifr, origin, alive: false, hole: null, name: "", link: "", want: null, token: 0, v: null, clock: null, replayId: null,
    vol: 0, target: 0, sent: -1, shown: false, busyUntil: 0, camSent: "", reported: false, loadSentAt: 0 };
  pool.push(f);
  return f;
}
/** Point a viewer at a replay (loads it inside its page once the page is up; nothing to do if it already has it). */
function load(f, link) {
  const key = linkKey(link);
  if (f.link === key) return;
  f.link = key;
  f.want = link;
  f.token = ++loadToken;
  f.v = null; f.reported = false; f.camSent = ""; f.vol = 0; f.sent = -1;
  f.isLive = !!link.taLive; f.live = null; f.preloaded = "";
  f.el.classList.remove("ready");
  sendLoad(f);
}
function sendLoad(f) {
  if (!f.alive || !f.want) return;
  f.loadSentAt = performance.now();
  tell(f, { type: "msu:load", token: f.token, ...f.want });
}

/** Holes → viewers: keep what's right, move viewers that already have a wanted replay, load the rest, preload spares. */
let wanted = {};                                       // hole id -> { src, link, clock, replayId }
const lastLive = {};                                   // hole id -> { w: its last live entry, lostAt: when the data dropped it }
// long enough for the scene to change: the switch waits out the live delay first (overlay.yaml), then crossfades
const lingerMs = (l) => (Number(l.w.link?.taDelay) || 1000) + 2500;
const LIVE_LINGER_MS = 6000;
let lingerTimer;
function updateFeeds(st) {
  const ids = new Set(Object.values(scenes).flatMap((s) => s.feeds.map((f) => f.id)));
  wanted = {};
  for (const id of ids) {
    const w = feedSrc(id, st);
    if (w.src) wanted[id] = { ...w, link: replayLink(w.src) };
    if (wanted[id]?.link?.taLive) wanted[id].clock = null;        // live: the viewer follows the player, not our clock
    // A live hole keeps its player's last frame for a moment after the data stops naming it (the song is over and
    // the map closed: the next map has no lineup yet). The scene is about to change; without this the boxes went
    // see-through on Match before it did.
    if (wanted[id]?.link?.taLive) lastLive[id] = { w: wanted[id], lostAt: 0 };
    else if (!wanted[id] && lastLive[id]) {
      const l = lastLive[id];
      l.lostAt ||= performance.now();
      if (performance.now() - l.lostAt < lingerMs(l)) wanted[id] = l.w;
      else delete lastLive[id];
    }
  }
  if (Object.values(lastLive).some((l) => l.lostAt)) { clearTimeout(lingerTimer); lingerTimer = setTimeout(() => state && updateFeeds(state), 500); }
  // links that aren't replays: a plain iframe per hole, as before
  for (const id of ids) {
    const src = wanted[id] && !wanted[id].link ? wanted[id].src : "";
    let p = plain[id];
    if (!src) { if (p) { p.el.remove(); delete plain[id]; } continue; }
    if (!p) {
      const el = document.createElement("div");
      el.className = "feed";
      $("#feeds").append(el);
      p = plain[id] = { el, ifr: null, src: "" };
    }
    if (p.src !== src) {
      p.src = src;
      p.ifr?.remove();
      p.ifr = document.createElement("iframe");
      p.ifr.allow = "autoplay; encrypted-media";
      p.ifr.src = src;
      p.el.append(p.ifr);
    }
  }
  assignViewers();
}
function visibleHoles() {
  const s = scenes[active];
  return new Map((s?.feeds ?? []).filter((f) => shownInScene(f.el) && wanted[f.id]?.link).map((f) => [f.id, f.el.getBoundingClientRect()]));
}
function assignViewers() {
  const visible = visibleHoles();
  if (noViewers) {                                     // a preview: dark boxes, every viewer idle
    for (const f of pool) { f.hole = null; f.name = ""; f.clock = null; f.replayId = null; }
    layoutFeeds(visible);
    return;
  }
  const taken = new Set();
  const bind = (f, id) => {
    const w = wanted[id];
    taken.add(f);
    f.hole = id; f.name = id.slice(5); f.clock = w.clock; f.replayId = w.replayId;
    load(f, w.link);
  };
  const need = [...visible.keys()];
  // A live match keeps one viewer more: its players' viewers must already be connected and waiting when the song
  // starts, while the playlist's replay still plays on Getting Ready.
  const poolMax = POOL + (Object.values(wanted).some((w) => w.link?.taLive) ? 1 : 0);
  // what other scenes will show: a match's players first, the playlist's paused replay last
  const later = Object.keys(wanted).filter((id) => wanted[id].link && !visible.has(id) && mine(id))
    .sort((x, y) => (x === "feed:main") - (y === "feed:main"));
  // 1. viewers already on a visible hole with the right replay stay; 2. a viewer that has the replay moves to it
  for (const id of need) {
    const f = pool.find((x) => !taken.has(x) && x.hole === id && x.link === linkKey(wanted[id].link))
      ?? pool.find((x) => !taken.has(x) && x.link === linkKey(wanted[id].link));
    if (f) bind(f, id);
  }
  // 3. the rest load into a spare viewer: one nobody wants, else any free one; make more only if every one is in use
  const free = () => pool.find((x) => !taken.has(x) && !Object.values(wanted).some((w) => linkKey(w.link) === x.link))
    ?? pool.find((x) => !taken.has(x));
  for (const id of need) {
    if ([...taken].some((x) => x.hole === id)) continue;
    const f = free() ?? (pool.length < poolMax || pool.length < need.length ? newViewer(wanted[id].src) : null);
    if (f) bind(f, id);
  }
  // 4. spare viewers preload the holes of other scenes (already loaded ones keep theirs)
  for (const id of later) {
    if (pool.some((x) => x.link === linkKey(wanted[id].link) && !taken.has(x))) {
      const f = pool.find((x) => x.link === linkKey(wanted[id].link) && !taken.has(x));
      bind(f, id);
      continue;
    }
    const f = free() ?? (pool.length < poolMax ? newViewer(wanted[id].src) : null);
    if (f) bind(f, id);
  }
  for (const f of pool) if (!taken.has(f)) { f.hole = null; f.name = ""; f.clock = null; f.replayId = null; }
  layoutFeeds(visible);
}

const tell = (f, msg) => { try { f.ifr?.contentWindow?.postMessage(MULTI ? { ...msg, tile: f.tile } : msg, f.origin); } catch {} };
/** Multiview: where each tile goes (shown holes whose replay is in), in the tiles page's own pixels. */
let tilesSent = "";
function sendTiles() {
  if (!multi) return;
  const at = multi.el.getBoundingClientRect();
  const tiles = pool.filter((f) => f.shown && f.el.classList.contains("ready")).map((f) => {
    const b = f.el.getBoundingClientRect();
    return { tile: f.tile, x: b.left - at.left, y: b.top - at.top, width: b.width, height: b.height };
  });
  const key = JSON.stringify(tiles);
  if (key === tilesSent) return;
  tilesSent = key;
  try { multi.ifr.contentWindow?.postMessage({ type: "msu:tiles", tiles }, multi.origin); } catch {}
}
/** The browser took a viewer's WebGL context (too many open): reload its page; it gets its replay again. */
function revive(f) {
  const now = performance.now();
  if (MULTI) {                                         // one page holds every tile: reload it once
    if (now - (multi?.revivedAt ?? -1e9) < 5000) return;
    multi.revivedAt = now;
    showError("the replay viewers' page lost its WebGL context; reloading it");
    for (const x of pool) { x.alive = false; x.v = null; x.camSent = ""; x.sent = -1; x.el.classList.remove("ready"); }
    tilesSent = "";
    multi.ifr.src = viewerUrl(multi.origin, { multiview: String(POOL) });
    return;
  }
  if (now - (f.revivedAt ?? -1e9) < 5000) return;
  f.revivedAt = now;
  showError(`viewer ${f.i + 1}: the browser dropped its WebGL context; reloading it`);
  f.alive = false; f.v = null; f.camSent = ""; f.sent = -1;
  f.el.classList.remove("ready");
  f.ifr.src = viewerUrl(f.origin);
}
const report = (m) => ws?.readyState === 1 && ws.send(JSON.stringify({ type: "viewer", ...m }));

/** Keep a viewer on its clock: waiting before the start, paused while off stream, re-seeked if it drifts. */
function syncToClock(f) {
  const v = f.v, c = f.clock, now = performance.now();
  if (!v?.loaded || !(v.duration > 0) || now < f.busyUntil) return;
  const want = c.pausedAt ?? (c.startAt == null ? null : (serverNow() - c.startAt) / 1000);
  const at = v.time + (v.playing ? (now - v.at) / 1000 : 0);
  const cmd = (msg, wait = 400) => { tell(f, msg); f.busyUntil = now + wait; };
  const drift = silent || !(VOLUME[f.name] > 0) ? DRIFT.muted : DRIFT.heard;
  if (want === null || want < 0) {                    // not started yet (the "up next" card is up)
    if (v.playing) cmd({ type: "msu:pause" });
    else if (v.time > 0.2) cmd({ type: "msu:seek", time: 0 });
  } else if (want >= v.duration) {
    // over: let it finish
  } else if (c.pausedAt != null || !f.shown) {         // off stream: pause once the music has faded out
    if (v.playing && f.vol === 0) cmd({ type: "msu:pause" });
    else if (!v.playing && Math.abs(v.time - want) > 0.3) cmd({ type: "msu:seek", time: want });
  } else if (!v.playing) {                             // starting (or resuming): from exactly the right moment
    if (Math.abs(v.time - want) > 0.3) tell(f, { type: "msu:seek", time: want });
    cmd({ type: "msu:play" }, 1500);
  } else if (Math.abs(at - want) > drift.s) {
    cmd({ type: "msu:seek", time: want + 0.1 }, drift.wait);
  }
}

// fade each viewer's sound toward its target (on stream: its hole's volume, else 0), and keep clocks
setInterval(() => {
  for (const f of pool) {
    if (!f.alive) continue;
    if (f.want && !f.v && performance.now() - f.loadSentAt > 20_000) sendLoad(f);   // a load that never answered
    // Three levels go to each viewer. Its whole output fades in and out as its hole comes on stream and leaves it
    // (masterVolume). The MUSIC has the panel mixer's level on top: the music slider times the level of the scene
    // that is on (songVolume). The HITSOUNDS have their own slider (hitsoundVolume). So turning the music down does
    // not turn the hits down, and the same slider figures sound the same on every scene: no hole is quieter by itself.
    const mix = state?.show?.mix;
    const scene = state?.show?.scene;
    const music = mix ? Math.min(1, (Number(mix.music) || 0) * (mix.scenes?.[scene] ?? 1)) : 1;
    const hits = mix ? Math.max(0, Math.min(1, Number(mix.hits ?? 1))) : 1;
    f.target = f.shown && !silent ? VOLUME[f.name] ?? 0 : 0;
    const step = (50 / FADE_MS) * Math.max(VOLUME[f.name] ?? 0, 0.01);
    f.vol = f.vol < f.target ? Math.min(f.target, f.vol + step) : Math.max(f.target, f.vol - step);
    // The music's level fades when the scene changes; a slider moved in the mixer is heard at once (finding a level
    // by ear needs the level you set, not a fade toward it).
    const mixed = mix ? `${mix.music}|${mix.scenes?.[scene] ?? 1}` : "";
    if (f.song === undefined || (f.mixed !== mixed && f.mixScene === scene)) f.song = music;
    f.mixed = mixed; f.mixScene = scene;
    f.song = f.song < music ? Math.min(music, f.song + 50 / FADE_MS) : Math.max(music, f.song - 50 / FADE_MS);
    const levels = {};
    if (Math.abs(f.vol - f.sent) > 0.004 || (f.sent !== 0 && f.vol === 0)) levels.masterVolume = f.sent = f.vol;
    if (f.songSent === undefined || Math.abs(f.song - f.songSent) > 0.004 || (f.songSent !== 0 && f.song === 0)) levels.songVolume = f.songSent = f.song;
    if (f.hitsSent !== hits) levels.hitsoundVolume = f.hitsSent = hits;
    // all three again every few seconds: a viewer that reloaded (or was busy loading) has lost them
    if (performance.now() - (f.levelsAt ?? 0) > 3000) Object.assign(levels, { masterVolume: f.sent = f.vol, songVolume: f.songSent = f.song, hitsoundVolume: f.hitsSent = hits });
    if (Object.keys(levels).length) { f.levelsAt = performance.now(); f.told = { ...(f.told ?? {}), ...levels }; tell(f, { type: "msu:settings", settings: levels }); }
    // the replay viewer settings from the panel (up/down look lock, resolution, frame cap), sent again after a reload.
    // The panel's small preview (&mute) draws at the size it is shown and 30 fps, leaving the PC's power to OBS.
    const cam = state?.show?.viewer;
    if (cam) {
      // drawn for the chosen output (1080p by default), not the screen's pixels: this page is always 1920×1080, so
      // on a 4K screen at 150 % (or zoomed) the viewers would otherwise draw 1.5× as many pixels per side
      const output = cam.output ?? 1080;
      const forOutput = output > 0 ? output / 1080 / Math.min(devicePixelRatio || 1, 2) : 1;
      const full = Math.max(0.25, Math.min(2, Math.round(forOutput * (cam.renderScale ?? 1) * 100) / 100));
      const scale = mute ? Math.min(full, Math.max(0.25, Math.round(previewScale * 1.15 * 20) / 20)) : full;
      const fps = mute ? Math.min(cam.maxFps ?? 60, 30) : cam.maxFps ?? 60;
      const quality = cam.quality ?? "medium", distortion = cam.distortion ?? true;
      // "show a limit" from the panel: the camera sits at the up or down limit while it lasts
      const hold = cam.pitchHold && cam.pitchHold.until > serverNow() ? (cam.pitchHold.dir === "up" ? 1 : -1) : 0;
      const fov = Math.max(30, Math.min(120, Number(cam.fov) || 70));
      // a lineup player's own saber colours on their hole ("a1" = side a's first player, "a" = a 1v1's); anyone else's replay (the
      // playlist, a typed link) keeps the colours it was recorded with. Sent either way: a viewer is reused.
      const who = /^([ab])(\d*)$/.exec(f.name ?? "");   // "a" alone: a 1v1's only player
      const sabers = who ? state?.data?.[who[1]]?.players?.[(Number(who[2]) || 1) - 1]?.sabers : null;
      const colours = sabers
        ? { customColors: true, preferReplayColors: false, leftColor: sabers.left, rightColor: sabers.right, environmentLeftColor: sabers.left,
            environmentRightColor: sabers.right, environmentLeftBoostColor: sabers.left, environmentRightBoostColor: sabers.right }
        : { customColors: false, preferReplayColors: true };
      const camZ = Math.max(-3, Math.min(3, Number(cam.z ?? -0.55) || 0));
      const camKey = `${cam.lockPitch}|${cam.pitchUp}|${cam.pitchDown}|${fov}|${camZ}|${sabers ? sabers.left + sabers.right : ''}|${hold}|${scale}|${fps}|${quality}|${distortion}|${hsvProfile.key}`;
      // sent again every few seconds too: a viewer that missed them (busy loading, or reused for another hole) ran
      // at its own 120 fps cap instead of 60, and pulled the shared multiview loop up with it
      if (f.camSent !== camKey || performance.now() - (f.camAt ?? 0) > 3000) {
        f.camSent = camKey;
        f.camAt = performance.now();
        tell(f, { type: "msu:settings", settings: { ...colours, replayCameraFov: fov, replayCameraDepthOffset: camZ, replayCameraLockPitch: !!cam.lockPitch, replayCameraPitchUp: Number(cam.pitchUp) || 0, replayCameraPitchDown: Number(cam.pitchDown) || 0,
          replayCameraPitchHold: cam.lockPitch ? hold : 0, renderScale: scale,
          graphicsQuality: quality, screenDisplacementEffects: !!distortion,
          // our own hit-score look (overlay.yaml `hsv:`) instead of whatever each replay was recorded with
          ...(hsvProfile.text ? { overrideHsvProfile: true, preferReplayHsvProfile: false, hsvProfile: hsvProfile.text } : {}) } });
        tell(f, { type: "msu:frameRate", fps });
      }
    }
    if (f.isLive) {                                    // never paused, played or seeked by us
      const hash = state?.data?.map?.hash ?? "";       // the map the players are about to load: fetch it ahead
      if (hash && f.preloaded !== hash) { f.preloaded = hash; tell(f, { type: "msu:preload", mapHash: hash }); }
    } else if (f.clock) syncToClock(f);
    else if (f.v?.loaded) {                            // no clock (a typed-in link): play on stream, pause off it
      if (!f.shown && f.vol === 0 && f.v.playing && performance.now() > f.busyUntil) { tell(f, { type: "msu:pause" }); f.busyUntil = performance.now() + 600; }
      if (f.shown && !f.v.playing && performance.now() > f.busyUntil) { tell(f, { type: "msu:play" }); f.busyUntil = performance.now() + 600; }
    }
  }
}, 50);
window.addEventListener("message", (e) => {
  if (e.source === window.parent && e.origin === location.origin && e.data?.type === "msu:previewScale") {
    previewScale = Math.max(0.1, Math.min(1, Number(e.data.scale) || 1));
    return;
  }
  if (!e.data || typeof e.data !== "object") return;
  const f = MULTI
    ? (multi && e.source === multi.ifr.contentWindow ? pool.find((x) => x.tile === String(e.data.tile)) : null)
    : pool.find((x) => x.ifr.contentWindow === e.source);
  if (!f) return;
  if (e.data.type === "msu:state") {
    const d = e.data;
    if (!f.alive) {                                    // the page is up: give it its replay
      f.alive = true;
      f.sent = -1; f.camSent = ""; f.picSent = -1;
      if (f.want) { f.loadSentAt = 0; sendLoad(f); }
    }
    if (Number(d.token) !== f.token) return;           // still showing an earlier replay
    f.v = { time: Number(d.time) || 0, playing: !!d.playing, duration: Number(d.duration) || 0, loaded: !!d.loaded, at: performance.now() };
    const ready = f.isLive ? liveReady(f) : f.v.loaded && f.v.duration > 0;
    f.el.classList.toggle("ready", ready);
    if (MULTI) sendTiles();
    if (f.replayId && ready && !f.reported) {
      f.reported = true;
      report({ id: f.replayId, ready: true, duration: f.v.duration });
    }
  }
  if (e.data.type === "msu:live" && f.isLive) {
    // a live viewer that was playing and ran out of replay data freezes its picture (and cuts its music) until more
    // arrives: counted, for the &debug corner. Many of these = raise liveDelay in overlay.yaml
    if (f.live?.status === "watching" && e.data.status === "buffering") liveFreezes++;
    f.live = e.data;
    f.el.classList.toggle("ready", liveReady(f));
    if (MULTI) sendTiles();
    liveSync();
  }
  if (e.data.type === "msu:ended" && f.replayId && f.v) report({ id: f.replayId, ended: true });
  if (e.data.type === "msu:contextLost") revive(f);
  if (e.data.type === "msu:fps") { f.fps = Number(e.data.fps) || 0; f.size = e.data.size ?? null; }
  if (e.data.type === "msu:audio") { f.audioBlocked = !!e.data.blocked; soundBanner(); }
});
// ---------------------------------------------------------------- live replays (TA)
// A hole whose link has ?taLive=… is a viewer following that player's live replay from the TA server (chroviewer's
// broadcast-bridge.ts). It needs no play/seek from us: it waits until the player starts a song, plays a little behind
// them, holds the last frame afterwards and plays the next song on the same connection. The hole stays a dark panel
// until there is a picture. What we add: the map fetched ahead (msu:preload), and all viewers of a match on the same
// beat (msu:liveSync): players start a song a few tens of ms apart, so once every viewer is watching, the latest
// song start among them is sent to all, once per song.
let liveFreezes = 0;                                   // times a live viewer ran dry since this page opened
const liveReady = (f) => ["buffering", "watching", "paused", "ended"].includes(f.live?.status);
let liveSynced = "";
function liveSync() {
  const fs = pool.filter((f) => f.isLive && f.hole);
  if (!fs.length || !fs.every((f) => f.live?.status === "watching" && f.live.streamId != null && Number(f.live.songStartServerMs) > 0)) return;
  const song = fs.map((f) => `${f.i}:${f.live.streamId}`).join("|");
  if (song === liveSynced) return;
  liveSynced = song;
  const songStartServerMs = Math.max(...fs.map((f) => Number(f.live.songStartServerMs)));
  for (const f of fs) tell(f, { type: "msu:liveSync", songStartServerMs });
}

/**
 * A browser window (not OBS, which always allows it) may hold the replays' music back until someone clicks the page:
 * autoplay rules. Then a banner says so, and a click anywhere tells every viewer to start it. Hitsounds start later
 * than the music, after a click, which is why they could be heard while the music wasn't.
 */
const banner = document.createElement("div");
banner.textContent = "🔇 Click anywhere to turn on the replay music";
banner.style.cssText = "position:absolute;left:50%;top:14px;transform:translateX(-50%);z-index:20;display:none;" +
  "font:700 26px sans-serif;color:#fff;background:#000d;padding:8px 18px;border-radius:10px;cursor:pointer";
document.body.append(banner);
function soundBanner() {
  const held = !silent && pool.some((f) => f.audioBlocked && f.shown && (VOLUME[f.name] ?? 0) > 0);
  banner.style.display = held ? "block" : "none";
}
const unlockAll = () => { for (const f of pool) if (f.alive) tell(f, { type: "msu:unlock" }); };
for (const type of ["pointerdown", "keydown"]) addEventListener(type, unlockAll, true);
/** A hole inside a layer that show:/hide:/when: has hidden gets no video (one scene can hold a 1v1 and a duos layout). */
function shownInScene(el) {
  for (let n = el; n && !n.classList?.contains("scene-svg"); n = n.parentNode) {
    if (n.style?.visibility === "hidden" || n.style?.display === "none") return false;
  }
  return true;
}
function layoutFeeds(visible = visibleHoles()) {
  const box = (el, b) => Object.assign(el.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
  for (const f of pool) {
    const b = f.hole ? visible.get(f.hole) : null;
    f.shown = !!b;
    f.el.classList.toggle("shown", f.shown);
    if (b) box(f.el, b);
  }
  soundBanner();
  if (MULTI) sendTiles();
  const s = scenes[active];
  const plainBoxes = new Map((s?.feeds ?? []).filter((f) => shownInScene(f.el)).map((f) => [f.id, f.el.getBoundingClientRect()]));
  for (const [id, p] of Object.entries(plain)) {
    const b = plainBoxes.get(id);
    p.el.classList.toggle("shown", !!b);
    if (b) box(p.el, b);
  }
  for (const [id, b] of noViewers ? visible : []) {
    let p = blanks[id];
    if (!p) {
      const el = document.createElement("div");
      el.className = "feed viewer blank";
      $("#feeds").append(el);
      p = blanks[id] = { el };
    }
    box(p.el, b);
  }
  for (const [id, p] of Object.entries(blanks)) p.el.classList.toggle("shown", noViewers && visible.has(id));
  if (debug) window.msuFeeds = Object.fromEntries(pool.filter((f) => f.hole).map((f) => [f.hole, f]));
}

// ---------------------------------------------------------------- connection
let ws = null;
function connect() {
  // no key is needed to watch; a page that has the key (optional, for OBS) is the one whose replay reports count
  const q = new URLSearchParams();
  if (key) q.set("key", key);
  if (mute) q.set("role", "preview");
  if (staged) q.set("staged", "1");
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/overlay?${q}`);
  ws.onopen = () => document.body.classList.remove("offline");
  ws.onclose = () => {
    document.body.classList.add("offline");
    setTimeout(connect, 1000);
  };
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "state") {
      loadHsv(m.hsv || "", m.designVersion);
      if (m.now) clockOffset = m.now - Date.now();
      state = m;
      if (designVersion !== m.designVersion) {
        designVersion = m.designVersion;
        loading = loadDesign();
      }
      await loading;
      try { apply(m); } catch (err) { showError(`render: ${err.message}`); }
    }
    if (m.type === "design") { designVersion = m.version; loading = loadDesign(); }
    if (m.type === "event") {
      try { scenes[active]?.event(m); } catch (err) { showError(`event ${m.name}: ${err.message}`); }
    }
  };
}
connect();

// OBS: replay the entrance when this source is shown again
window.addEventListener("obsSourceVisibleChanged", (e) => { if (e.detail.visible && active) scenes[active].enter(); });
