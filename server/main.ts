// BSOverlayKit server.
//   deno run -A server/main.ts        (or ./run.sh)
// Env: PORT (8095), HOST (127.0.0.1), HOST_CODE (panel login; default is generated and printed once),
//      OVERLAY (the settings file, default overlay.yaml; e.g. OVERLAY=overlay.starter.yaml for the starter scenes),
//      KIT_DATA (runtime state folder, default data; must be allowed for writing, see run.sh)
import { parse as parseYaml } from "jsr:@std/yaml@1";
import { TUG_FULL, accuracyForRaw, fmtTime, rawCurve, type DataSource, type EventMsg, type LiveState, type OverlayData, type ShowState, type StagedShow } from "./model.ts";
import { SimSource, type SimOptions } from "./sources/sim.ts";
import { BscsSource, type BscsOptions } from "./sources/bscompstats.ts";
import { emptyPlaylist, PlaylistControl, position } from "./playlist.ts";

const ROOT = new URL("../", import.meta.url);
const at = (p: string) => new URL(p, ROOT);
const PORT = Number(Deno.env.get("PORT") ?? 8095);
const HOST = Deno.env.get("HOST") ?? "127.0.0.1";
const CONFIG_FILE = Deno.env.get("OVERLAY") ?? "overlay.yaml";
// the replay viewer (our ChroViewer build). Its address as OBS sees it.
// With {n} in it (https://v{n}.viewer.example.org) every video box gets an address of its own (v1 … v5): on a hosted
// viewer that is what lets a browser give each replay its own process (with the Origin-Agent-Cluster header, see
// DEPLOY.md). Links the server itself builds use the first.
const VIEWER_PATTERN = (Deno.env.get("CHROVIEWER_URL") ?? "http://127.0.0.1:4000").replace(/\/+$/, "");
const VIEWER = VIEWER_PATTERN.replace("{n}", "1");
// TA live replays reach the viewers through the viewer's own relay (/ta-live/<host:port>/u/<player>). The TA server's
// address as the VIEWER reaches it, when that differs from the one the BSCompStats site uses (a container name in
// the local test stack): KIT_TA_RELAY_HOST=msu-ta-server:8676. Empty: the address in the match's `ta`.
const TA_RELAY = (Deno.env.get("KIT_TA_RELAY_HOST") ?? "").trim();
// KIT_DATA: a different runtime-state folder (login code, panel settings), e.g. for a second test instance
const DATA = (Deno.env.get("KIT_DATA") ?? "data").replace(/\/$/, "");
const dataAt = (p: string) => new URL(p, new URL(`${DATA}/`, ROOT));

// ------------------------------------------------------------------ config, secrets, show state
type Config = {
  title: string; colors: Record<string, string>; crossfade: number; source: string;
  /** `replays: players` (Getting Ready): the scene's replay box shows someone about to play, not the break mix. */
  scenes: Record<string, { svg: string; vars?: Record<string, string>; label?: string; replays?: string }>;
  /** how far behind the players the live (TA) replays are shown, in ms: the buffer that rides out late data */
  liveDelay: number;
  /** Where the whiteboard sits on the 1920 × 1080 stream (overlay.yaml, whiteboard:). */
  whiteboard: { x: number; y: number; width: number; height: number };
  automation: { on: string; scene: string; after?: number | string; when?: string; fade?: number | string; why?: string; stay?: number | string }[];
  sim: SimOptions;
  bscompstats: BscsOptions;
  header: string;
  /** A HitScoreVisualizer config in design/, used by every replay viewer. Empty: each replay's own. */
  hsv: string;
};
let config!: Config;
let configError = "";
async function loadConfig() {
  try {
    const raw: any = parseYaml(await Deno.readTextFile(at(CONFIG_FILE)));
    const scenes: Config["scenes"] = {};
    for (const s of raw.scenes ?? []) {
      if (typeof s === "string") scenes[s] = { svg: s };
      else for (const [k, v] of Object.entries(s)) scenes[k] = { svg: (v as any).svg ?? k, vars: (v as any).vars, label: (v as any).label, replays: (v as any).replays };
    }
    config = { title: raw.title ?? "Overlay", colors: raw.colors ?? {}, crossfade: raw.crossfade ?? 400, source: raw.source ?? "sim", scenes, automation: raw.automation ?? [], whiteboard: boardBox(raw.whiteboard), sim: raw.sim ?? {}, bscompstats: raw.bscompstats ?? {}, header: raw.header ?? "", hsv: String(raw.hsv ?? ""),
      liveDelay: Math.max(300, Math.min(15_000, raw.liveDelay === undefined ? 2500 : typeof raw.liveDelay === "number" ? raw.liveDelay : parseDuration(String(raw.liveDelay)))) };
    // the start script points a test stack somewhere else without editing this file
    const e = (k: string) => Deno.env.get(k) || undefined;
    config.source = e("KIT_SOURCE") ?? config.source;
    config.bscompstats = { ...config.bscompstats, url: e("BSCS_URL") ?? config.bscompstats.url, tournament: e("BSCS_TOURNAMENT") ?? config.bscompstats.tournament };
    configError = "";
  } catch (e) {
    configError = `${CONFIG_FILE}: ${(e as Error).message}`;
    console.error(configError);
    config ??= { title: "Overlay", colors: {}, crossfade: 400, source: "sim", scenes: {}, automation: [], whiteboard: boardBox(null), sim: {}, bscompstats: {}, header: "", hsv: "", liveDelay: 2500 };
  }
}
await loadConfig();

/** The whiteboard's place on stream: what overlay.yaml says, kept inside the picture; bottom left otherwise (under the casters). */
function boardBox(raw: any) {
  const n = (v: unknown, d: number, lo: number, hi: number) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const width = n(raw?.width, 890, 200, 1920), height = n(raw?.height, 470, 150, 1080);
  return { x: n(raw?.x, 50, 0, 1920 - width), y: n(raw?.y, 575, 0, 1080 - height), width, height };
}
async function readJson<T>(p: string, fallback: T): Promise<T> {
  try { return { ...fallback, ...JSON.parse(await Deno.readTextFile(dataAt(p))) }; } catch { return fallback; }
}
const rand = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
const secrets = await readJson("secrets.json", { hostCode: rand(10), overlayKey: rand(20), sessionKey: rand(40) });
secrets.sessionKey ??= rand(40);
if (Deno.env.get("HOST_CODE")) secrets.hostCode = Deno.env.get("HOST_CODE")!;
await Deno.writeTextFile(dataAt("secrets.json"), JSON.stringify(secrets, null, 1));

const show: ShowState = await readJson("show.json", {
  scene: Object.keys(config.scenes)[0] ?? "casters",
  auto: true,
  header: config.header,
  casters: [{ id: "", name: "Caster One", handle: "@casterone", avatar: "", speaking: false }, { id: "", name: "Caster Two", handle: "@castertwo", avatar: "", speaking: false }],
  castersFrom: "panel",
  brb: { title: "Be Right Back", message: "The next match starts soon", endsAt: Date.now() + 5 * 60_000 },
  ticker: ["Welcome to the stream!", "Be kind in chat ♥"],
  feeds: {},
  streamDelayMs: 0,
  upNext: { a: "", b: "", text: "" },
} as ShowState);
// older show.json files: casters had pronouns and cam links (both dropped)
const cleanCaster = (c: any) => ({ id: String(c?.id ?? ""), name: String(c?.name ?? ""), handle: String(c?.handle ?? ""), avatar: String(c?.avatar ?? ""), speaking: false });
show.casters = (show.casters ?? []).map(cleanCaster);
show.castersFrom ??= "panel";
show.header ??= config.header;
show.upNext = { a: String(show.upNext?.a ?? ""), b: String(show.upNext?.b ?? ""), text: String(show.upNext?.text ?? "") };
// players who stare at the ceiling make a first-person replay nauseating: the viewers hold the look near level
show.mix = { music: Math.min(1, Number(show.mix?.music ?? 1)), hits: Math.min(1, Number(show.mix?.hits ?? 1)), scenes: { ready: 0.5, casters: 0.35, ...(show.mix?.scenes ?? {}) } };   // casters talk over theirs
for (const k of Object.keys(show.mix.scenes)) show.mix.scenes[k] = Math.min(1, show.mix.scenes[k]);
show.viewer = Object.assign({ lockPitch: true, pitchUp: 12, pitchDown: 12, fov: 70, z: -0.55, renderScale: 1, maxFps: 60, output: 1080, quality: "medium", distortion: true }, show.viewer as Partial<ShowState["viewer"]> | undefined);
delete (show.viewer as Record<string, unknown>).preview;   // the picture relay it chose between is gone
// one limit for both directions (older show.json files) becomes the two; a hold never outlives a restart
if (show.viewer.pitchLimit !== undefined) { show.viewer.pitchUp = show.viewer.pitchDown = show.viewer.pitchLimit; delete show.viewer.pitchLimit; }
show.viewer.pitchHold = null;
show.staging = !!show.staging;
show.staged ??= null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const saveShow = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => Deno.writeTextFile(dataAt("show.json"), JSON.stringify(show, null, 1)), 300); };

// the replay playlist (Starting Soon / Intermission / BRB). Older show.json files had a plain list of links.
show.playlist ??= emptyPlaylist();
// after a restart the song starts over (under the "up next" card) instead of jumping somewhere
if (show.playlist.current) Object.assign(show.playlist.current, { startAt: null, pausedAt: null, ready: false, switchedAt: Date.now() });

// ------------------------------------------------------------------ design files (SVG + rules), live reload
async function designList() {
  const out: Record<string, { svg: string; vars: Record<string, string>; rules: unknown; error: string; label: string }> = {};
  for (const [id, s] of Object.entries(config.scenes)) {
    let rules: unknown = {}, error = "";
    try {
      const text = await Deno.readTextFile(at(`design/${s.svg}.rules.yaml`)).catch(() => "");
      rules = text ? parseYaml(text) ?? {} : {};
    } catch (e) { error = `${s.svg}.rules.yaml: ${(e as Error).message}`; }
    out[id] = { svg: `/design/${s.svg}.svg`, vars: s.vars ?? {}, rules, error, label: s.label ?? id };
  }
  return out;
}
let designVersion = Date.now();
/** Scenes with a feed:main hole: the playlist plays while one of them is on stream and pauses otherwise. */
let replayScenes = new Set<string>();
async function findReplayScenes() {
  const out = new Set<string>();
  for (const [id, s] of Object.entries(config.scenes)) {
    const svg = await Deno.readTextFile(at(`design/${s.svg}.svg`)).catch(() => "");
    if (/feed:main\b/.test(svg)) out.add(id);
  }
  replayScenes = out;
}
await findReplayScenes();
(async () => {
  let t: ReturnType<typeof setTimeout> | undefined;
  // a file: address as a path the system understands ("/C:/kit/design" is "C:\\kit\\design" on Windows)
  const fsPath = (u: URL) => { const p = decodeURIComponent(u.pathname); return Deno.build.os === "windows" ? p.replace(/^\//, "").replaceAll("/", "\\") : p; };
  for await (const ev of Deno.watchFs([fsPath(at("design")), fsPath(at(CONFIG_FILE))])) {
    if (ev.paths.every((p) => /\.(swp|tmp|~)$|[\/\\]\.#/.test(p))) continue;
    clearTimeout(t);
    t = setTimeout(async () => {        // editors write files in several steps; wait for the last one
      await loadConfig();
      await findReplayScenes();
      designVersion = Date.now();
      broadcastAll({ type: "design", version: designVersion });
      broadcastAll(boardMsg());      // the whiteboard's place is in overlay.yaml too
      console.log("design changed:", ev.paths.map((p) => p.split(/[\/\\]/).pop()).join(", "));
    }, 250);
  }
})();

// ------------------------------------------------------------------ data source
let data: OverlayData | null = null;   // what overlays see (already delayed)
let dirty = true;                      // something changed: push to sockets on the next tick
let liveData: OverlayData | null = null;
const playlist = new PlaylistControl(show.playlist, (structural) => { dirty = true; if (structural) saveShow(); });
if (show.replays?.length && !show.playlist.items.length) playlist.set(show.replays);
delete show.replays;
// The match being followed, and the tournament when the panel chose another, are remembered across restarts. The
// tournament in the configuration (BSCS_TOURNAMENT) is where it starts; if that setting is changed later, the new
// setting wins over what the panel had chosen under the old one.
const configured = config.bscompstats.tournament ?? "";
const follow = await readJson<{ match: string; tournament?: string; configured?: string }>("bscompstats.json", { match: config.bscompstats.match ?? "" });
const keptTournament = follow.tournament && follow.configured === configured ? follow.tournament : configured;
const source: DataSource & { panel?: () => unknown } = config.source === "bscompstats"
  ? new BscsSource({ ...config.bscompstats, tournament: keptTournament, match: keptTournament === (follow.tournament ?? configured) ? follow.match : "" },
      Deno.env.get("BSCS_KEY") ?? (secrets as any).bscsKey ?? "",
      (match, tournament) => Deno.writeTextFile(dataAt("bscompstats.json"), JSON.stringify({ match, tournament, configured })))
  : new SimSource(at("data/pool.json"), config.sim);
/** The site this overlay follows, when it follows one: also where people may sign in from. */
const site = source instanceof BscsSource ? source : null;
await source.start(
  (d) => {
    liveData = d;
    const push = () => { data = d; dirty = true; };
    show.streamDelayMs > 0 ? setTimeout(push, show.streamDelayMs) : push();
  },
  (e) => setTimeout(() => onEvent(e), show.streamDelayMs),
  // Live numbers (scores, accuracy, combo, misses) are held back as far as the live replays are: a viewer shows its
  // player `liveDelay` behind, so numbers put up as they arrive ran ahead of the picture (a miss counted on screen
  // seconds before the player was seen to miss). Less the fifth of a second the numbers take to get here.
  (l) => setTimeout(() => setLive(l), liveNumbersDelay()),
);

/** How long live numbers wait: the replays' own delay while the match's videos are live TA replays, else nothing; plus the stream delay. */
function liveNumbersDelay(): number {
  const viaTa = !!liveData?.taLive && Object.keys(liveData.taLive.players ?? {}).length > 0;
  return (viaTa ? Math.max(0, config.liveDelay - 200) : 0) + Math.max(0, show.streamDelayMs);
}

let pitchHoldTimer: ReturnType<typeof setTimeout> | undefined;   // ends a "show the up/down limit" hold
let songEndAt = 0;                      // when songEnd last went out
let pendingSwitches: ReturnType<typeof setTimeout>[] = [];   // automation rules waiting out their `after:`
function onEvent(e: EventMsg) {
  // songEnd can come from two places for the same song (the live feed, and the source seeing TA's "finished"): once
  if (e.name === "songEnd") {
    if (Date.now() - songEndAt < 20_000) return;
    songEndAt = Date.now();
  }
  broadcastOverlays({ type: "event", ...e });
  broadcastPanels({ type: "log", text: `${e.name}${e.item !== undefined ? ` #${e.item}` : ""}${e.side ? ` (${e.side})` : ""}` });
  // A song starting overtakes whatever was still waiting to happen: "back to Picks & Bans 10 s after the last map"
  // must not pull the stream off a map that began in the meantime.
  if (e.name === "mapStart") { for (const t of pendingSwitches) clearTimeout(t); pendingSwitches = []; }
  if (!show.auto) return;
  for (const rule of config.automation) {
    if (rule.on !== e.name) continue;
    if (rule.why && rule.why !== e.why) continue;            // why: pick / result (see mapNext)
    const dur = (v: number | string | undefined) => (typeof v === "number" ? v : parseDuration(v ?? "0"));
    const after = dur(rule.after), stay = dur(rule.stay), from = rule.when?.split(/\s*,\s*/) ?? null;
    const asked = Date.now();
    // after: how long after the event. when: only from these scenes. stay: the scene being left must have been up
    // this long (so what it shows, a map's result, is not cut off). An event can come a moment before the scene it
    // is meant to leave is on (a map ends: Picks & Bans follows 3 s later, and the next map is known at once): the
    // rule then waits for that scene, a short while, instead of finding the wrong scene and doing nothing.
    const wait = (ms: number) => {
      const timer = setTimeout(() => {
        pendingSwitches = pendingSwitches.filter((t) => t !== timer);
        if (!show.auto) return;
        if (from && !from.includes(show.scene)) {
          if (stay > 0 && Date.now() - asked < after + 8000) wait(250);
          return;
        }
        const left = stay - sceneAge();
        if (left > 0) return wait(left);
        setScene(rule.scene, rule.fade === undefined ? undefined : dur(rule.fade));
      }, ms);
      pendingSwitches.push(timer);
    };
    wait(after);
  }
}
// how long the scene on air has been on air
let sceneNow = "", sceneSince = Date.now();
function sceneAge() {
  if (show.scene !== sceneNow) { sceneNow = show.scene; sceneSince = Date.now(); }
  return Date.now() - sceneSince;
}
setInterval(sceneAge, 100);
function parseDuration(s: string) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(String(s).trim());
  return m ? Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000 }[m[2] ?? "ms"] ?? 1) : 0;
}
// a rule's own crossfade (fade: 200ms) applies to its switch only
let fade: { ms: number; until: number } | null = null;
function setScene(scene: string, fadeMs?: number) {
  if (!config.scenes[scene]) return;
  fade = fadeMs !== undefined && scene !== show.scene ? { ms: fadeMs, until: Date.now() + 1500 } : null;
  show.scene = scene;
  saveShow();
  dirty = true;
  queueMicrotask(() => { try { syncTeamReplays(); } catch { /* not started yet */ } });
}

// ------------------------------------------------------------------ staging (Preview / Program, like OBS's Studio Mode)
// On air is `show`, as always. `show.staged` is an optional copy of what the operator sets by hand (scene, up next,
// top bar text, BRB, casters, ticker). Actions sent with "staged": true edit that copy; "take" puts all of it on air
// in one step (normal crossfade), "discardStaged" drops it. Automation and everything without the flag act on air
// only: when a rule switches the on-air scene, the staged copy stays as it is (the panel says that air has moved).
const STAGE_KEYS = ["scene", "header", "upNext", "brb", "casters", "castersFrom", "ticker"] as const;
const STAGEABLE = new Set(["scene", "header", "upNext", "brb", "casters", "castersFrom", "ticker"]);
let target: ShowState | StagedShow = show;     // what the action being run edits: on air, or the staged copy
function ensureStaged(): StagedShow {
  show.staging = true;
  if (!show.staged) {
    const copy = structuredClone(Object.fromEntries(STAGE_KEYS.map((k) => [k, show[k]]))) as unknown as StagedShow;
    copy.casters = copy.casters.map((c) => ({ ...c, speaking: false }));
    show.staged = { ...copy, airScene: show.scene };
  }
  return show.staged;
}
/** Is anything staged that differs from what is on air? (A countdown that has only ticked on doesn't count.) */
function stagedDiffers(): boolean {
  const st = show.staged;
  if (!st) return false;
  if (st.brbMinutes !== undefined) return true;
  const plain = (c: { id: string; name: string; handle: string; avatar: string }[]) => JSON.stringify(c.map((x) => [x.id, x.name, x.handle, x.avatar]));
  return st.scene !== show.scene || st.header !== show.header || JSON.stringify(st.upNext) !== JSON.stringify(show.upNext)
    || JSON.stringify(st.brb) !== JSON.stringify(show.brb) || st.castersFrom !== show.castersFrom
    || (st.castersFrom === "panel" && plain(st.casters) !== plain(show.casters)) || JSON.stringify(st.ticker) !== JSON.stringify(show.ticker);
}
function take() {
  const st = show.staged;
  if (!st) return;
  show.header = st.header; show.upNext = st.upNext; show.ticker = st.ticker;
  show.brb = { ...st.brb, endsAt: st.brbMinutes !== undefined ? Date.now() + st.brbMinutes * 60_000 : st.brb.endsAt };
  // a list the Discord bot keeps is live already: don't put a stale copy of it back
  if (!(st.castersFrom === "discord" && show.castersFrom === "discord")) show.casters = st.casters;
  show.castersFrom = st.castersFrom;
  show.staged = null;
  setScene(st.scene);
}
/** The show as a staged preview sees it: on air, with the staged values over it. */
const stagedView = () => ({ ...show, ...(show.staged ?? {}) });

// ------------------------------------------------------------------ sockets
const overlays = new Set<WebSocket>();
const panels = new Set<WebSocket>();
const send = (ws: WebSocket, m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
const broadcastOverlays = (m: unknown) => overlays.forEach((ws) => send(ws, m));
const broadcastPanels = (m: unknown) => panels.forEach((ws) => send(ws, m));
const broadcastAll = (m: unknown) => { broadcastOverlays(m); broadcastPanels(m); };

const stagedViews = new Set<WebSocket>();     // previews of the staged state (&staged)
/** Overlay pages that gave the key (optional): the ones whose reports about a replay's length and end are believed. */
const trusted = new WeakSet<WebSocket>();
const MAX_OVERLAYS = 200;                     // watching needs no key, so there is a ceiling
// ------------------------------------------------------------------ live gameplay (TA bridge / mock TA)
let live: LiveState | null = null;
let songEnded = false;                 // songEnd was sent for the song being played
/** Live gameplay changed: from the `live` action (tools, the old TA bridge) or from the source (BSCompStats in TA mode). */
function setLive(a: any) {
  const before = live;
  const was = live?.phase ?? null;
  live = a?.phase ? { matchId: a.matchId, phase: a.phase, load: a.load, time: Number(a.time) || 0, duration: Number(a.duration) || 0, players: a.players, feeds: a.feeds, startedAt: Number(a.startedAt) || undefined } : null;
  const now = live?.phase ?? null;
  if (now !== was && now === "loading") { onEvent({ name: "mapLoad" }); songEnded = false; }
  if (now !== was && now === "playing") { onEvent({ name: "mapStart" }); if (was !== "loading") songEnded = false; }
  // The song is over (the referee still has to close the map): every player has reported a finish, or the live
  // feed stopped at the end of the song. The second case matters: a player who quits, fails out or drops never
  // reports "finished", and waiting for all of them meant the overlay sat on Match until the map was closed.
  const everyone = (Object.values(live?.players ?? {}).flat() as ({ finished?: boolean } | null)[]).filter(Boolean);
  const allDone = now === "playing" && everyone.length > 0 && everyone.every((p) => p?.finished);
  const ranOut = was === "playing" && now === null && (before?.duration ?? 0) > 0 && (before?.time ?? 0) >= before!.duration! - 3;
  if (!songEnded && (allDone || ranOut)) {
    songEnded = true;
    onEvent({ name: "songEnd" });
  }
  dirty = true;
}

const followedMatch = () => ((source as any).panel?.()?.following as string | undefined) ?? "";
/** A TA-mode match's video holes: a replay viewer following each lineup player's live replay. */
function withTaFeeds(d: OverlayData | null): OverlayData | null {
  if (!d?.taLive) return d;
  const relay = TA_RELAY || d.taLive.relay;
  const feeds = Object.fromEntries(Object.entries(d.taLive.players).map(([hole, id]) =>
    [hole, `${VIEWER}/?${new URLSearchParams({ taLive: `/ta-live/${relay}/u/${id}`, taDelay: String(config.liveDelay), hideUI: "true" })}`]));
  return { ...d, feeds: { ...feeds, ...(d.feeds ?? {}) } };
}
function withLive(d: OverlayData | null): OverlayData | null {
  d = withTaFeeds(d);
  if (!d || !live?.phase || (live.matchId && live.matchId !== followedMatch())) return d;
  const out: OverlayData = structuredClone(d);
  for (const s of ["a", "b"] as const) {
    const lp = live.players?.[s] ?? [];
    if (!lp.length) continue;
    out[s].players = lp.map((p, i) => ({ ...(out[s].players[i] ?? { name: "?", avatar: "", score: 0, acc: null, combo: 0, misses: 0, finished: false }), ...p }));
    const ps = out[s].players;
    const accs = ps.map((p) => p.acc).filter((x): x is number => typeof x === "number");
    // The side's figure, as the match is scored. On match points each player's accuracy goes through the curve
    // first and the points are averaged (a 98 and an 80 are worth more than two 89s); `acc` is then the accuracy
    // that earns those mean points, which is what BSCompStats shows and decides the map on.
    const curve = out.match.scoring === "points" ? out.match.curve : null;
    if (!accs.length) { out[s].acc = null; out[s].matchPoints = null; }
    else if (curve) {
      const raw = accs.reduce((t, x) => t + rawCurve(x, curve), 0) / accs.length;
      out[s].acc = accuracyForRaw(raw, curve);
      const perfect = out.match.perfectAcc;
      out[s].matchPoints = perfect ? (curve.perfectPoints / rawCurve(perfect, curve)) * raw : null;
    } else { out[s].acc = accs.reduce((t, x) => t + x, 0) / accs.length; out[s].matchPoints = null; }
    out[s].score = ps.reduce((t, p) => t + (p.score || 0), 0);
    out[s].misses = ps.reduce((t, p) => t + (p.misses || 0), 0);
    out[s].combo = Math.min(...ps.map((p) => p.combo || 0));
    out[s].finished = ps.every((p) => p.finished);
  }
  out.a.leading = (out.a.acc ?? 0) > (out.b.acc ?? 0);
  out.b.leading = (out.b.acc ?? 0) > (out.a.acc ?? 0);
  out.diff = (out.a.acc ?? 0) - (out.b.acc ?? 0);
  out.tug = 0.5 + Math.max(-1, Math.min(1, out.diff / TUG_FULL)) / 2;
  out.match.phase = live.phase;
  out.match.load = live.phase === "loading" ? live.load ?? "loading" : "";
  if (out.map && live.duration) {
    out.map.progress = Math.min(1, (live.time ?? 0) / live.duration);
    out.map.time = fmtTime(live.time ?? 0);
  }
  out.feeds = { ...(out.feeds ?? {}), ...(live.feeds ?? {}) };
  if (live.startedAt) out.feedsStartAt = live.startedAt;
  return out;
}

/** A replay link as typed in the panel -> our viewer's address. BeatLeader: a score link or id; ScoreSaber: "ss:<id>" or a watch link. */
function viewerUrl(entry: string, settings: Record<string, unknown> = {}, autoplay = true): string {
  const e = entry.trim();
  const q = new URLSearchParams({ hideUI: "true" });
  if (autoplay) q.set("autoplay", "true");
  let m: RegExpExecArray | null;
  if ((m = /^(?:bl:)?(\d+)$/i.exec(e)) || (m = /beatleader\.(?:com|xyz|net)\/(?:score|replay)?\/?(?:\?scoreId=)?(\d+)/i.exec(e)) || (m = /[?&]scoreIdBL=(\d+)/i.exec(e)) || (m = /replay\.beatleader\.(?:com|xyz)\/\?.*scoreId=(\d+)/i.exec(e))) q.set("scoreIdBL", m[1]);
  else if ((m = /^ss:(\d+)$/i.exec(e)) || (m = /scoresaber\.com\/.*?[?&]scoreId=(\d+)/i.exec(e)) || (m = /[?&]scoreId=(\d+)/i.exec(e))) q.set("scoreId", m[1]);
  else if (/^https?:\/\/.+\.bsor$/i.test(e)) q.set("replayUrl", e);
  else return "";
  if (Object.keys(settings).length) q.set("settings", JSON.stringify(settings));
  return `${VIEWER}/?${q}`;
}

/** The playlist as overlays need it: what plays in feed:main, on which clock, and the song info for the scenes. */
function replayMsg() {
  const it = playlist.current, c = show.playlist.current;
  if (!it || !c) return null;
  const next = playlist.upNext();
  const i = show.playlist.items.indexOf(it);
  return {
    id: it.id, url: viewerUrl(it.ref, { masterVolume: 0 }, false), startAt: c.startAt, pausedAt: c.pausedAt, duration: c.duration,
    switchedAt: c.switchedAt, info: it.info, next: next && next !== it ? next.info : null, index: i + 1, count: show.playlist.items.length,
    mode: show.playlist.mode, team: it.team ?? "",
  };
}
// the playlist's clock; the client shows/hides the "up next" card from the same numbers
// (no overlay open = nobody watching: the clock waits instead of playing songs to no one)
setInterval(() => playlist.tick(replayScenes.has(show.scene) && overlays.size > 0), 250);

/**
 * Whose replays the playlist plays. The data source lists every team's showcase replays, whose each one is, and which
 * teams are out of the bracket. In a break (Starting Soon, Intermission, Be Right Back) the playlist plays its mix:
 * the panel's own replays and those of every team still in. On a scene marked `replays: players` (Getting Ready),
 * while a match is under way, it plays someone about to play: the lineups of the map that is up, else their teams.
 * See server/playlist.ts.
 */
function syncTeamReplays() {
  const d = liveData;
  if (!d) return;
  const teams = new Map<string, { name: string; replays: string[]; out?: boolean; players?: { name: string; replays: string[] }[] }>();
  for (const t of d.teams ?? []) teams.set(t.name.toLowerCase(), { name: t.name, replays: t.replays ?? [], out: t.out, players: t.players });
  // a side put together for this match only is not in the tournament's list
  for (const s of [d.a, d.b]) if (s?.name && s.replays?.length && !teams.has(s.name.toLowerCase())) teams.set(s.name.toLowerCase(), { name: s.name, replays: s.replays });
  const inMatch = d.match.phase !== "idle" && d.match.phase !== "done";
  const focus = inMatch && config.scenes[show.scene]?.replays === "players"
    ? { teams: [d.a.name, d.b.name], players: [...d.a.players, ...d.b.players].map((p) => p.name) } : null;
  playlist.setTeams([...teams.values()], focus, replayScenes.has(show.scene) && overlays.size > 0);
}
setInterval(syncTeamReplays, 1000);

const stateMsg = (staged = false) => ({
  type: "state", data: withLive(data), show: { ...(staged ? stagedView() : show), playlist: undefined, staged: undefined }, colors: config.colors,
  crossfade: fade && Date.now() < fade.until ? fade.ms : config.crossfade, designVersion,
  replay: replayMsg(), now: Date.now(),
  // the HitScoreVisualizer config for the replay viewers' flying hit scores: a file in design/ (overlay.yaml `hsv:`)
  hsv: config.hsv,
  viewerPattern: VIEWER_PATTERN.includes("{n}") ? VIEWER_PATTERN : "",
});
const panelMsg = async () => ({
  ...stateMsg(), staging: !!show.staging, staged: show.staged ? { ...stagedView(), playlist: undefined, staged: undefined } : null,
  stagedDiffers: stagedDiffers(), airMoved: !!show.staged && show.staged.airScene !== show.scene,
  playlist: { ...show.playlist, position: position(show.playlist), onAir: replayScenes.has(show.scene) }, live: liveData, scenes: Object.fromEntries(Object.entries(config.scenes).map(([k, v]) => [k, v.label ?? k])),
  source: { name: source.name, status: source.status(), panel: source.panel?.() ?? null }, overlayUrl: "/overlay", overlayKeyUrl: `/overlay?key=${secrets.overlayKey}`,
  errors: [configError, ...Object.values(await designList()).map((d) => d.error)].filter(Boolean),
});
setInterval(async () => {
  if (!dirty) return;
  dirty = false;
  const air = stateMsg(), next = stagedViews.size ? stateMsg(true) : null;
  for (const ws of overlays) send(ws, stagedViews.has(ws) ? next : air);
  if (panels.size) { const m = await panelMsg(); broadcastPanels(m); }
}, 50);

// ------------------------------------------------------------------ actions (panel + HTTP API)
const actions: Record<string, (a: any) => unknown> = {
  scene: (a) => { if (target === show) setScene(a.scene); else if (config.scenes[a.scene]) target.scene = a.scene; },
  // staging: on/off (off drops what was staged), "take" = staged goes on air, "discardStaged" = Next is On air again
  staging: (a) => { show.staging = !!a.on; if (!show.staging) show.staged = null; },
  take: () => take(),
  discardStaged: () => { show.staged = null; },
  auto: (a) => { show.auto = !!a.on; },
  // from the panel: typing casters in takes over from the Discord bot until the bot is switched back on
  casters: (a) => { target.casters = (a.casters ?? []).map(cleanCaster); target.castersFrom = "panel"; },
  castersFrom: (a) => { target.castersFrom = a.from === "discord" ? "discord" : "panel"; },
  // from the Discord bot (tools/discord-bot): who is in the casting voice channel, and who is talking
  discordCasters: (a) => {
    if (show.castersFrom !== "discord") return;
    const talking = new Set(show.casters.filter((c) => c.speaking).map((c) => c.id));
    show.casters = (a.casters ?? []).map(cleanCaster).map((c: any) => ({ ...c, speaking: talking.has(c.id) }));
  },
  // live gameplay from a TA bridge or tools/mock-ta (see LiveState in model.ts)
  live: (a) => setLive(a),
  // the replay playlist: { action: "playlist", op: "add", refs: [...] } and play / next / prev / random / restart /
  // remove / move / sort / mode / clear (see server/playlist.ts)
  playlist: (a) => {
    const ops: Record<string, () => void> = {
      add: () => playlist.add(Array.isArray(a.refs) ? a.refs : String(a.refs ?? "").split("\n")),
      play: () => playlist.play(String(a.id)), next: () => playlist.next(), prev: () => playlist.prev(),
      random: () => playlist.random(), restart: () => playlist.restart(), remove: () => playlist.remove(String(a.id)),
      move: () => playlist.move(String(a.id), Number(a.to)), sort: () => playlist.sort(String(a.by)),
      mode: () => playlist.setMode(String(a.mode)), clear: () => playlist.clear(),
      followTeams: () => playlist.setFollowTeams(!!a.on),
      resetPlayed: () => playlist.resetPlayed(),
    };
    if (!ops[a.op]) throw new Error(`unknown playlist op "${a.op}"`);
    ops[a.op]();
  },
  replays: (a) => playlist.set(a.replays ?? []),        // the whole list at once (older API)
  speaking: (a) => {
    const c = show.casters.find((x) => x.id && x.id === String(a.id));
    if (c) c.speaking = !!a.on;
  },
  header: (a) => { target.header = String(a.header ?? ""); },
  signOff: (a) => { show.signOff = !!a.on; },
  // the Casters scene's "up next" block: two team names, or one line of text; all empty = hidden
  upNext: (a) => { target.upNext = { a: String(a.a ?? "").trim(), b: String(a.b ?? "").trim(), text: String(a.text ?? "").trim() }; },
  viewer: (a) => {
    if (a.lockPitch !== undefined) show.viewer.lockPitch = !!a.lockPitch;
    const deg = (x: unknown) => Math.max(0, Math.min(90, Number(x) || 0));
    if (a.z !== undefined) show.viewer.z = Math.max(-3, Math.min(3, Math.round((Number(a.z) || 0) * 100) / 100));
    if (a.fov !== undefined) show.viewer.fov = Math.max(30, Math.min(120, Math.round(Number(a.fov)) || 70));
    if (a.pitchUp !== undefined) show.viewer.pitchUp = deg(a.pitchUp);
    if (a.pitchDown !== undefined) show.viewer.pitchDown = deg(a.pitchDown);
    if (a.pitchLimit !== undefined) show.viewer.pitchUp = show.viewer.pitchDown = deg(a.pitchLimit);   // older tools
    // show a limit: every replay camera sits at it for a few seconds (at most 30), then follows the players again
    if (a.pitchHold !== undefined) {
      const dir = a.pitchHold === "up" || a.pitchHold === "down" ? a.pitchHold : null;
      const ms = Math.max(1000, Math.min(30_000, Number(a.holdMs) || 5000));
      clearTimeout(pitchHoldTimer);
      show.viewer.pitchHold = dir ? { dir, until: Date.now() + ms } : null;
      if (dir) pitchHoldTimer = setTimeout(() => { show.viewer.pitchHold = null; dirty = true; }, ms);
    }
    if (a.renderScale !== undefined) show.viewer.renderScale = Math.max(0.25, Math.min(1, Number(a.renderScale) || 1));
    if (a.maxFps !== undefined) show.viewer.maxFps = Math.max(10, Math.min(120, Number(a.maxFps) || 60));
    if (a.quality !== undefined) show.viewer.quality = ["high", "medium", "low", "none"].includes(String(a.quality)) ? a.quality : "medium";
    if (a.distortion !== undefined) show.viewer.distortion = !!a.distortion;
    if (a.output !== undefined) show.viewer.output = [0, 720, 1080, 1440, 2160].includes(Number(a.output)) ? Number(a.output) : 1080;
  },
  // the mixer: the music's level for everything and per scene, and the hitsounds' (0 to 1: a replay viewer cannot
  // play louder than its recording)
  mix: (a) => {
    const level = (x: unknown) => Math.max(0, Math.min(1, Math.round((Number(x) || 0) * 100) / 100));
    const mix = show.mix!;
    if (a.music !== undefined) mix.music = level(a.music);
    if (a.hits !== undefined) mix.hits = level(a.hits);
    if (a.scene !== undefined && a.level !== undefined && String(a.scene) in config.scenes) mix.scenes[String(a.scene)] = level(a.level);
  },
  brb: (a) => {
    Object.assign(target.brb, a.brb ?? {});
    if (a.minutes === undefined) return;
    target.brb.endsAt = Date.now() + Number(a.minutes) * 60_000;
    if (target !== show) (target as StagedShow).brbMinutes = Number(a.minutes);   // counts down from "Go live"
  },
  ticker: (a) => { target.ticker = (a.ticker as string[]).map((s) => s.trim()).filter(Boolean); },
  feeds: (a) => { show.feeds = a.feeds; },
  streamDelay: (a) => { show.streamDelayMs = Math.max(0, Number(a.ms) || 0); },
  source: (a) => source.control?.(a.control, a),
};
// ------------------------------------------------------------------ whiteboard
// Drawn in the panel, shown on stream on top of whatever scene is on, so it stays through scene changes. It is
// not part of the show state: a stroke in progress sends a few points many times a second, and the whole show must
// not be sent again each time. It has its own messages (the whole board to a page that connects or after undo /
// clear; one stroke, or a few more points of one, while someone draws) and its own file.
interface Stroke { id: string; color: string; width: number; erase?: boolean; points: number[] }
const board = await readJson<{ open: boolean; strokes: Stroke[] }>("board.json", { open: false, strokes: [] });
board.strokes = Array.isArray(board.strokes) ? board.strokes : [];
const MAX_STROKES = 600, MAX_STROKE_NUMBERS = 8000;
let boardTimer: ReturnType<typeof setTimeout> | undefined;
const saveBoard = () => { clearTimeout(boardTimer); boardTimer = setTimeout(() => Deno.writeTextFile(dataAt("board.json"), JSON.stringify(board)).catch(() => {}), 700); };
const boardMsg = () => ({ type: "board", open: board.open, strokes: board.strokes, box: config.whiteboard });
/** Points as the panel sent them, made safe: pairs of numbers from 0 to 1, a few decimals. */
const boardPoints = (raw: unknown, room: number) =>
  (Array.isArray(raw) ? raw : []).slice(0, Math.max(0, room - (room % 2))).map((v) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 10000) / 10000);
function boardAction(a: any) {
  if (a.op === "open") { board.open = !!a.on; broadcastAll(boardMsg()); }
  else if (a.op === "stroke") {
    const st = a.stroke ?? {};
    const id = String(st.id ?? "").slice(0, 40);
    if (!id || !/^#[0-9a-f]{6}$/i.test(String(st.color)) || board.strokes.some((x) => x.id === id)) return;
    const points = boardPoints(st.points, MAX_STROKE_NUMBERS);
    if (points.length < 2 || points.length % 2) return;
    const stroke: Stroke = { id, color: String(st.color).toLowerCase(), width: Math.min(80, Math.max(1, Number(st.width) || 6)), ...(st.erase ? { erase: true } : {}), points };
    board.strokes.push(stroke);
    if (board.strokes.length > MAX_STROKES) { board.strokes.splice(0, board.strokes.length - MAX_STROKES); broadcastAll(boardMsg()); }
    else broadcastAll({ type: "boardStroke", stroke });
  } else if (a.op === "append") {
    const stroke = board.strokes.findLast((x) => x.id === String(a.id));
    if (!stroke) return;
    const points = boardPoints(a.points, MAX_STROKE_NUMBERS - stroke.points.length);
    if (points.length < 2) return;
    stroke.points.push(...points);
    broadcastAll({ type: "boardAppend", id: stroke.id, points });
  } else if (a.op === "undo") { board.strokes.pop(); broadcastAll(boardMsg()); }
  else if (a.op === "clear") { board.strokes = []; broadcastAll(boardMsg()); }
  else throw new Error(`unknown board op "${a.op}"`);
  saveBoard();
}

async function runAction(a: any) {
  if (a?.action === "board") return boardAction(a);      // not show state: nothing else to save or send
  const fn = actions[a?.action];
  if (!fn) throw new Error(`unknown action "${a?.action}"`);
  // "staged": true on a scene / text action edits the staged copy (and turns staging on); anything else is on air
  target = a.staged && STAGEABLE.has(a.action) ? ensureStaged() : show;
  try { await fn(a); } finally { target = show; }
  if (a.action !== "speaking" && a.action !== "live") saveShow();   // talking flickers on and off; not worth a file write each time
  dirty = true;
}

// ------------------------------------------------------------------ http
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml",
  json: "application/json", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", ttf: "font/ttf",
  otf: "font/otf", woff2: "font/woff2", gif: "image/gif",
};
async function file(dir: string, rel: string) {
  if (rel.includes("..")) return new Response("bad path", { status: 400 });
  try {
    const body = await Deno.readFile(at(`${dir}/${rel}`));
    return new Response(body, { headers: { "content-type": TYPES[rel.split(".").pop()!.toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" } });
  } catch { return new Response("not found", { status: 404 }); }
}
// ------------------------------------------------------------------ signing in to the panel
// Two ways in. The overlay page itself needs neither.
//  - The shared code (HOST_CODE). Its cookie is a keyed hash of the code, so nothing is kept in memory: a restart
//    signs nobody out, and changing the code signs everybody out. Scripts and the caster bot send the code itself.
//  - A BSCompStats account, when the overlay follows the site with a key that names this overlay as its sign-in
//    address. The site sends an approved person back with a code (sources/bscompstats.ts); their cookie names them
//    and is signed here. Whether they may still be here is asked of the site's list on every request, so someone
//    taken off it is out within the minute.
async function sha256(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const SESSION = await sha256(`${secrets.sessionKey}|${secrets.hostCode}`);
const same = (a: string, b: string) => { let d = a.length ^ b.length; for (let i = 0; i < a.length && i < b.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(secrets.sessionKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const sign = async (text: string) => [...new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const cookieOf = (req: Request, name: string) => new RegExp(`(?:^|;\\s*)${name}=([\\w.-]+)`).exec(req.headers.get("cookie") ?? "")?.[1] ?? "";
const SESSION_S = 2592000;   // 30 days
const secure = (req: Request) => (req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "");
const cookie = (req: Request) => `kit_sid=${SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_S}${secure(req)}`;
const personCookie = async (req: Request, id: string) => {
  const body = `${id}.${Date.now() + SESSION_S * 1000}`;
  return `kit_user=${body}.${await sign(body)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_S}${secure(req)}`;
};
const dropCookie = (req: Request, name: string) => `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req)}`;

type Who = { via: "code" } | { via: "site"; id: string; name: string };
/** Who is asking, or null: the shared code (cookie or header), or a person the site still lets in. */
async function who(req: Request): Promise<Who | null> {
  const sid = cookieOf(req, "kit_sid");
  if ((sid && same(sid, SESSION)) || same(req.headers.get("authorization") ?? "", `Bearer ${secrets.hostCode}`)) return { via: "code" };
  const [id, until, mac] = cookieOf(req, "kit_user").split(".");
  if (!site || !id || !until || !mac || !same(mac, await sign(`${id}.${until}`)) || !(Number(until) > Date.now())) return null;
  const person = site.person(id);
  return person ? { via: "site", id, name: person.name ?? "Someone" } : null;
}
// Wrong codes are counted per address: 8 in ten minutes and that address waits out the rest of the ten minutes.
// TRUST_PROXY says how many proxies stand in front (1: the usual one). Each proxy adds the address it saw to the
// END of X-Forwarded-For, so the visitor is that many from the end; whatever a visitor wrote in the header
// themselves sits further left and is never read. Without TRUST_PROXY the header is ignored.
const PROXIES = Math.max(0, Math.floor(Number(Deno.env.get("TRUST_PROXY") ?? 0)) || 0);
const TRUST_PROXY = PROXIES > 0;
const failures = new Map<string, { n: number; since: number }>();
const WINDOW_MS = 600_000, MAX_FAILURES = 8;
const addressOf = (req: Request, info: Deno.ServeHandlerInfo) => {
  const hops = TRUST_PROXY ? (req.headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean) : [];
  return hops[hops.length - PROXIES] ?? hops[0] ?? (info.remoteAddr as Deno.NetAddr).hostname;
};
function blocked(addr: string) {
  const f = failures.get(addr);
  if (f && Date.now() - f.since > WINDOW_MS) failures.delete(addr);
  return (failures.get(addr)?.n ?? 0) >= MAX_FAILURES;
}
/** For what needs a sign-in: null when signed in, else the refusal. A wrong code in the header counts like a wrong code typed in. */
async function refuse(req: Request, info: Deno.ServeHandlerInfo): Promise<Response | null> {
  if (await who(req)) return null;
  const addr = addressOf(req, info);
  if (blocked(addr)) return Response.json({ ok: false, error: "Too many wrong codes. Try again in ten minutes." }, { status: 429 });
  if (req.headers.has("authorization")) failed(addr);
  return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}
function failed(addr: string) {
  const f = failures.get(addr) ?? { n: 0, since: Date.now() };
  f.n++;
  failures.set(addr, f);
  if (failures.size > 5000) {
    for (const [k, v] of failures) if (Date.now() - v.since > WINDOW_MS) failures.delete(k);
    // still full (a flood of addresses): the oldest go, so this list has a ceiling whatever is thrown at it
    for (const k of failures.keys()) { if (failures.size <= 4000) break; failures.delete(k); }
  }
}
// A page on another site must not drive the panel with a signed-in visitor's cookie (a sibling address under the
// same domain is "same site" to the browser, so SameSite does not stop it). Browsers name the page a request comes
// from in Origin; scripts and the caster bot send none.
const PUBLIC_HOST = (() => { try { return new URL(Deno.env.get("PUBLIC_URL") ?? "").host; } catch { return ""; } })();
function foreign(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let host = "";
  try { host = new URL(origin).host; } catch { return true; }
  const returnTo = site?.signIn()?.returnTo;
  const mine = [req.headers.get("host"), TRUST_PROXY ? req.headers.get("x-forwarded-host") : null, PUBLIC_HOST, returnTo ? new URL(returnTo).host : ""];
  return !mine.includes(host);
}
const elsewhere = () => Response.json({ ok: false, error: "This request came from another site." }, { status: 403 });
/** This overlay's own address as the visitor's browser has it ("https://overlay.example"). */
const originOf = (req: Request) => {
  const proto = (TRUST_PROXY && req.headers.get("x-forwarded-proto")) || new URL(req.url).protocol.replace(":", "");
  return `${proto}://${(TRUST_PROXY && req.headers.get("x-forwarded-host")) || req.headers.get("host") || new URL(req.url).host}`;
};
/** "Sign in with BSCompStats" is offered when the key names the address this visitor is on as its sign-in address. */
const siteSignIn = (req: Request) => { const s = site?.signIn(); return s && s.returnTo === originOf(req) ? s : null; };
const perAddress = new Map<string, number>();    // keyless overlay pages open, by address
const MAX_PER_ADDRESS = 40;

Deno.serve({ port: PORT, hostname: HOST }, async (req, info) => {
  const url = new URL(req.url), p = url.pathname;
  const upgrade = req.headers.get("upgrade") === "websocket";

  if (p === "/healthz") return new Response("ok");
  if (p === "/ws/overlay" && upgrade) {
    // Watching needs no key: OBS, or anyone with the address. It only ever receives. What a page SENDS is believed
    // by degree (see PlaylistControl.viewer): any page may say its replay has loaded, or give a length where none
    // is known; a known length is corrected and a replay's end believed only from a page that gave the key.
    // The ceilings are for pages nobody vouches for: OBS (the key) and a signed-in panel's previews always get in,
    // so a crowd of strangers cannot take the stream's own place.
    const keyed = same(url.searchParams.get("key") ?? "", secrets.overlayKey);
    const known = keyed || !!(await who(req));
    const addr = addressOf(req, info);
    if (!known && (overlays.size >= MAX_OVERLAYS || (perAddress.get(addr) ?? 0) >= MAX_PER_ADDRESS)) return new Response("too many viewers", { status: 503 });
    const { socket, response } = Deno.upgradeWebSocket(req);
    // what is staged is not on stream yet: only the panel's own preview (signed in) or a keyed page is shown it
    const isStaged = known && url.searchParams.has("staged");
    if (keyed) trusted.add(socket);
    let counted = false;
    socket.onopen = () => {
      overlays.add(socket);
      if (!known) { counted = true; perAddress.set(addr, (perAddress.get(addr) ?? 0) + 1); }
      if (isStaged) stagedViews.add(socket);
      send(socket, stateMsg(isStaged));
      send(socket, boardMsg());
    };
    socket.onclose = () => {
      overlays.delete(socket); stagedViews.delete(socket);
      if (counted) { counted = false; const n = (perAddress.get(addr) ?? 1) - 1; n > 0 ? perAddress.set(addr, n) : perAddress.delete(addr); }
    };
    socket.onmessage = (e) => {
      if (typeof e.data !== "string" || e.data.length > 2000) return;
      try {
        const m = JSON.parse(e.data);
        if (m?.type !== "viewer" || typeof m.id !== "string") return;
        playlist.viewer(m.id, { ready: m.ready === true, duration: m.duration, ended: m.ended === true }, trusted.has(socket));
      } catch { /* ignore */ }
    };
    return response;
  }
  if (p === "/ws/panel" && upgrade) {
    if (foreign(req)) return elsewhere();
    const no = await refuse(req, info);
    if (no) return no;
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = async () => { panels.add(socket); send(socket, await panelMsg()); send(socket, boardMsg()); };
    socket.onclose = () => panels.delete(socket);
    socket.onmessage = async (e) => {
      const a = JSON.parse(e.data);
      try { await runAction(a); send(socket, { type: "ack", reqId: a.reqId, ok: true }); }
      catch (err) { send(socket, { type: "ack", reqId: a.reqId, ok: false, error: (err as Error).message }); }
    };
    return response;
  }
  if (p === "/api/action" && req.method === "POST") {
    if (foreign(req)) return elsewhere();
    const no = await refuse(req, info);
    if (no) return no;
    try { await runAction(await req.json()); return Response.json({ ok: true }); }
    catch (e) { return Response.json({ ok: false, error: (e as Error).message }, { status: 400 }); }
  }
  if (p === "/api/state") {
    const no = await refuse(req, info);
    if (no) return no;
    return Response.json({ data: liveData, show: { ...show, staged: undefined }, staging: !!show.staging, staged: show.staged ?? null,
      stagedDiffers: stagedDiffers(), source: source.status() });
  }
  if (p === "/api/design") return Response.json({ version: designVersion, scenes: await designList(), fonts: await fontList() });
  // who is signed in here (the panel shows it), and what the login page can offer
  if (p === "/api/me") {
    const me = await who(req);
    return Response.json({ signedIn: !!me, name: me?.via === "site" ? me.name : "", via: me?.via ?? "", site: siteSignIn(req) ? new URL(site!.signIn()!.site).host : "" });
  }
  if (p === "/api/signout" && req.method === "POST") {
    if (foreign(req)) return elsewhere();
    const out = new Headers();
    out.append("set-cookie", dropCookie(req, "kit_sid")); out.append("set-cookie", dropCookie(req, "kit_user"));
    return new Response(JSON.stringify({ ok: true }), { headers: out });
  }
  // Sign in with a BSCompStats account: off to the site with something only this browser holds (`state`), and back
  // with a code. A code that comes back to a browser which did not start the sign-in is not used.
  if (p === "/auth/start") {
    const s = siteSignIn(req);
    if (!s) return new Response(null, { status: 303, headers: { location: "/?signin=unavailable" } });
    const state = rand(24);
    const to = `${s.site}/connect/authorize?${new URLSearchParams({ key: s.keyId, redirect_uri: `${s.returnTo}/auth/callback`, state })}`;
    return new Response(null, { status: 303, headers: { location: to, "set-cookie": `kit_state=${state}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure(req)}` } });
  }
  if (p === "/auth/callback") {
    const back = (why: string, extra: string[] = []) => {
      const h = new Headers({ location: why ? `/?signin=${why}` : "/" });
      h.append("set-cookie", `kit_state=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0${secure(req)}`);
      for (const c of extra) h.append("set-cookie", c);
      return new Response(null, { status: 303, headers: h });
    };
    const state = cookieOf(req, "kit_state"), code = url.searchParams.get("code") ?? "";
    if (!site || !state || !same(state, url.searchParams.get("state") ?? "") || !code) return back("again");
    try {
      const person = await site.exchange(code);
      broadcastPanels({ type: "log", text: `${person.name ?? "Someone"} signed in with BSCompStats` });
      return back("", [await personCookie(req, person.id)]);
    } catch (e) {
      console.log(`sign-in with BSCompStats refused: ${(e as Error).message}`);
      return back("refused");
    }
  }
  if (p === "/api/login" && req.method === "POST") {
    if (foreign(req)) return elsewhere();
    const addr = addressOf(req, info);
    if (blocked(addr)) return Response.json({ ok: false, error: "Too many wrong codes. Try again in ten minutes." }, { status: 429 });
    const { code } = await req.json().catch(() => ({}));
    if (typeof code !== "string" || !same(code, secrets.hostCode)) { failed(addr); return Response.json({ ok: false }, { status: 401 }); }
    return Response.json({ ok: true }, { headers: { "set-cookie": cookie(req) } });
  }
  if (p.startsWith("/login/")) {
    const addr = addressOf(req, info);
    if (blocked(addr)) return new Response("Too many wrong codes. Try again in ten minutes.", { status: 429 });
    if (!same(decodeURIComponent(p.slice(7)), secrets.hostCode)) { failed(addr); return new Response(null, { status: 303, headers: { location: "/" } }); }
    return new Response(null, { status: 303, headers: { location: "/", "set-cookie": cookie(req) } });
  }

  if (p === "/" || p === "/panel") return file("web", (await who(req)) ? "panel.html" : "login.html");
  if (p === "/overlay") return file("web", "overlay.html");
  if (p.startsWith("/design/")) return file("design", decodeURIComponent(p.slice(8)));
  if (p.startsWith("/covers/")) return file("data/covers", decodeURIComponent(p.slice(8)));
  return file("web", decodeURIComponent(p.slice(1)));
});

async function fontList() {
  const out: string[] = [];
  for await (const f of Deno.readDir(at("design/fonts"))) if (/\.(ttf|otf|woff2?)$/i.test(f.name)) out.push(`/design/fonts/${f.name}`);
  return out;
}

// a code that came from the environment is the operator's own: it is not written to the log
const fromEnv = !!Deno.env.get("HOST_CODE");
console.log(`
  BSOverlayKit on http://${HOST}:${PORT}
  panel login code:  ${fromEnv ? "(the one set in HOST_CODE)" : `${secrets.hostCode}   (or open http://${HOST}:${PORT}/login/${secrets.hostCode})`}
  OBS Browser Source: http://${HOST}:${PORT}/overlay
`);
