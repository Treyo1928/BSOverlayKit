// BSOverlayKit server.
//   deno run -A server/main.ts        (or ./run.sh)
// Env: PORT (8095), HOST (127.0.0.1), HOST_CODE (panel login; default is generated and printed once),
//      OVERLAY (the settings file, default overlay.yaml; e.g. OVERLAY=overlay.starter.yaml for the starter scenes),
//      KIT_DATA (runtime state folder, default data; must be allowed for writing, see run.sh)
import { parse as parseYaml } from "jsr:@std/yaml@1";
import { fmtTime, type DataSource, type EventMsg, type LiveState, type OverlayData, type ShowState } from "./model.ts";
import { SimSource, type SimOptions } from "./sources/sim.ts";
import { BscsSource, type BscsOptions } from "./sources/bscompstats.ts";
import { emptyPlaylist, PlaylistControl, position } from "./playlist.ts";

const ROOT = new URL("../", import.meta.url);
const at = (p: string) => new URL(p, ROOT);
const PORT = Number(Deno.env.get("PORT") ?? 8095);
const HOST = Deno.env.get("HOST") ?? "127.0.0.1";
const CONFIG_FILE = Deno.env.get("OVERLAY") ?? "overlay.yaml";
// the replay viewer (our ChroViewer build). Its address as OBS sees it.
const VIEWER = (Deno.env.get("CHROVIEWER_URL") ?? "http://127.0.0.1:4000").replace(/\/+$/, "");
// KIT_DATA: a different runtime-state folder (login code, panel settings), e.g. for a second test instance
const DATA = (Deno.env.get("KIT_DATA") ?? "data").replace(/\/$/, "");
const dataAt = (p: string) => new URL(p, new URL(`${DATA}/`, ROOT));

// ------------------------------------------------------------------ config, secrets, show state
type Config = {
  title: string; colors: Record<string, string>; crossfade: number; source: string;
  scenes: Record<string, { svg: string; vars?: Record<string, string>; label?: string }>;
  automation: { on: string; scene: string; after?: number | string; when?: string }[];
  sim: SimOptions;
  bscompstats: BscsOptions;
  header: string;
};
let config!: Config;
let configError = "";
async function loadConfig() {
  try {
    const raw: any = parseYaml(await Deno.readTextFile(at(CONFIG_FILE)));
    const scenes: Config["scenes"] = {};
    for (const s of raw.scenes ?? []) {
      if (typeof s === "string") scenes[s] = { svg: s };
      else for (const [k, v] of Object.entries(s)) scenes[k] = { svg: (v as any).svg ?? k, vars: (v as any).vars, label: (v as any).label };
    }
    config = { title: raw.title ?? "Overlay", colors: raw.colors ?? {}, crossfade: raw.crossfade ?? 400, source: raw.source ?? "sim", scenes, automation: raw.automation ?? [], sim: raw.sim ?? {}, bscompstats: raw.bscompstats ?? {}, header: raw.header ?? "" };
    // the start script points a test stack somewhere else without editing this file
    const e = (k: string) => Deno.env.get(k) || undefined;
    config.source = e("KIT_SOURCE") ?? config.source;
    config.bscompstats = { ...config.bscompstats, url: e("BSCS_URL") ?? config.bscompstats.url, tournament: e("BSCS_TOURNAMENT") ?? config.bscompstats.tournament };
    configError = "";
  } catch (e) {
    configError = `${CONFIG_FILE}: ${(e as Error).message}`;
    console.error(configError);
    config ??= { title: "Overlay", colors: {}, crossfade: 400, source: "sim", scenes: {}, automation: [], sim: {}, bscompstats: {}, header: "" };
  }
}
await loadConfig();

async function readJson<T>(p: string, fallback: T): Promise<T> {
  try { return { ...fallback, ...JSON.parse(await Deno.readTextFile(dataAt(p))) }; } catch { return fallback; }
}
const rand = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
const secrets = await readJson("secrets.json", { hostCode: rand(10), overlayKey: rand(20) });
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
} as ShowState);
// older show.json files: casters had pronouns and cam links (both dropped)
const cleanCaster = (c: any) => ({ id: String(c?.id ?? ""), name: String(c?.name ?? ""), handle: String(c?.handle ?? ""), avatar: String(c?.avatar ?? ""), speaking: false });
show.casters = (show.casters ?? []).map(cleanCaster);
show.castersFrom ??= "panel";
show.header ??= config.header;
// players who stare at the ceiling make a first-person replay nauseating: the viewers hold the look near level
show.viewer = Object.assign({ lockPitch: true, pitchLimit: 12, renderScale: 1, maxFps: 60, preview: "program", output: 1080, quality: "medium", distortion: true }, show.viewer as Partial<ShowState["viewer"]> | undefined);
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
  for await (const ev of Deno.watchFs([at("design").pathname, at(CONFIG_FILE).pathname])) {
    if (ev.paths.every((p) => /\.(swp|tmp|~)$|\/\.#/.test(p))) continue;
    clearTimeout(t);
    t = setTimeout(async () => {        // editors write files in several steps; wait for the last one
      await loadConfig();
      await findReplayScenes();
      designVersion = Date.now();
      broadcastAll({ type: "design", version: designVersion });
      console.log("design changed:", ev.paths.map((p) => p.split("/").pop()).join(", "));
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
// the match being followed is remembered across restarts (the panel picks it)
const follow = await readJson("bscompstats.json", { match: config.bscompstats.match ?? "" });
const source: DataSource & { panel?: () => unknown } = config.source === "bscompstats"
  ? new BscsSource({ ...config.bscompstats, match: follow.match }, Deno.env.get("BSCS_KEY") ?? (secrets as any).bscsKey ?? "",
      (id) => Deno.writeTextFile(dataAt("bscompstats.json"), JSON.stringify({ match: id })))
  : new SimSource(at("data/pool.json"), config.sim);
await source.start(
  (d) => {
    liveData = d;
    const push = () => { data = d; dirty = true; };
    show.streamDelayMs > 0 ? setTimeout(push, show.streamDelayMs) : push();
  },
  (e) => setTimeout(() => onEvent(e), show.streamDelayMs),
);

function onEvent(e: EventMsg) {
  broadcastOverlays({ type: "event", ...e });
  broadcastPanels({ type: "log", text: `${e.name}${e.item !== undefined ? ` #${e.item}` : ""}${e.side ? ` (${e.side})` : ""}` });
  if (!show.auto) return;
  for (const rule of config.automation) {
    if (rule.on !== e.name) continue;
    const ms = typeof rule.after === "number" ? rule.after : parseDuration(rule.after ?? "0");
    setTimeout(() => {
      if (!show.auto) return;
      if (rule.when && !rule.when.split(/\s*,\s*/).includes(show.scene)) return;   // only from these scenes
      setScene(rule.scene);
    }, ms);
  }
}
const parseDuration = (s: string) => {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(String(s).trim());
  return m ? Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000 }[m[2] ?? "ms"] ?? 1) : 0;
};
function setScene(scene: string) {
  if (!config.scenes[scene]) return;
  show.scene = scene;
  saveShow();
  dirty = true;
}

// ------------------------------------------------------------------ sockets
const overlays = new Set<WebSocket>();
const panels = new Set<WebSocket>();
const send = (ws: WebSocket, m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
const broadcastOverlays = (m: unknown) => overlays.forEach((ws) => send(ws, m));
const broadcastPanels = (m: unknown) => panels.forEach((ws) => send(ws, m));
const broadcastAll = (m: unknown) => { broadcastOverlays(m); broadcastPanels(m); };

// The panel preview's replays, drawn once: one on-air overlay (OBS, or the OBS link in a browser) sends small pictures
// of its replay viewers, and the previews show those instead of running viewers of their own. Rendering every replay
// twice on one PC halved the frame rate of both.
const previews = new Set<WebSocket>();
let picturesFrom: WebSocket | null = null;   // the on-air overlay sending them
function choosePictureSource() {
  const want = previews.size > 0 && show.viewer.preview === "program";
  if (picturesFrom && (!overlays.has(picturesFrom) || previews.has(picturesFrom))) picturesFrom = null;
  if (want && !picturesFrom) picturesFrom = [...overlays].find((ws) => !previews.has(ws)) ?? null;
  for (const ws of overlays) {
    if (previews.has(ws)) send(ws, { type: "pictures", from: want && !!picturesFrom });
    else send(ws, { type: "pictures", send: want && ws === picturesFrom });
  }
}
setInterval(choosePictureSource, 2000);
// ------------------------------------------------------------------ live gameplay (TA bridge / mock TA)
let live: LiveState | null = null;
let songEnded = false;                 // songEnd was sent for the song being played
const followedMatch = () => ((source as any).panel?.()?.following as string | undefined) ?? "";
function withLive(d: OverlayData | null): OverlayData | null {
  if (!d || !live?.phase || (live.matchId && live.matchId !== followedMatch())) return d;
  const out: OverlayData = structuredClone(d);
  for (const s of ["a", "b"] as const) {
    const lp = live.players?.[s] ?? [];
    if (!lp.length) continue;
    out[s].players = lp.map((p, i) => ({ ...(out[s].players[i] ?? { name: "?", avatar: "", score: 0, acc: null, combo: 0, misses: 0, finished: false }), ...p }));
    const ps = out[s].players;
    const accs = ps.map((p) => p.acc).filter((x): x is number => typeof x === "number");
    out[s].acc = accs.length ? accs.reduce((t, x) => t + x, 0) / accs.length : null;
    out[s].score = ps.reduce((t, p) => t + (p.score || 0), 0);
    out[s].misses = ps.reduce((t, p) => t + (p.misses || 0), 0);
    out[s].combo = Math.min(...ps.map((p) => p.combo || 0));
    out[s].finished = ps.every((p) => p.finished);
  }
  out.a.leading = (out.a.acc ?? 0) > (out.b.acc ?? 0);
  out.b.leading = (out.b.acc ?? 0) > (out.a.acc ?? 0);
  out.diff = (out.a.acc ?? 0) - (out.b.acc ?? 0);
  out.tug = 0.5 + Math.max(-1, Math.min(1, out.diff / 0.02)) / 2;
  out.match.phase = live.phase;
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
    mode: show.playlist.mode,
  };
}
// the playlist's clock; the client shows/hides the "up next" card from the same numbers
// (no overlay open = nobody watching: the clock waits instead of playing songs to no one)
setInterval(() => playlist.tick(replayScenes.has(show.scene) && overlays.size > 0), 250);

const stateMsg = () => ({
  type: "state", data: withLive(data), show: { ...show, playlist: undefined }, colors: config.colors, crossfade: config.crossfade, designVersion,
  replay: replayMsg(), now: Date.now(),
});
const panelMsg = async () => ({
  ...stateMsg(), playlist: { ...show.playlist, position: position(show.playlist), onAir: replayScenes.has(show.scene) }, live: liveData, scenes: Object.fromEntries(Object.entries(config.scenes).map(([k, v]) => [k, v.label ?? k])),
  source: { name: source.name, status: source.status(), panel: source.panel?.() ?? null }, overlayUrl: `/overlay?key=${secrets.overlayKey}`,
  errors: [configError, ...Object.values(await designList()).map((d) => d.error)].filter(Boolean),
});
setInterval(async () => {
  if (!dirty) return;
  dirty = false;
  broadcastOverlays(stateMsg());
  if (panels.size) { const m = await panelMsg(); broadcastPanels(m); }
}, 50);

// ------------------------------------------------------------------ actions (panel + HTTP API)
const actions: Record<string, (a: any) => unknown> = {
  scene: (a) => setScene(a.scene),
  auto: (a) => { show.auto = !!a.on; },
  // from the panel: typing casters in takes over from the Discord bot until the bot is switched back on
  casters: (a) => { show.casters = (a.casters ?? []).map(cleanCaster); show.castersFrom = "panel"; },
  castersFrom: (a) => { show.castersFrom = a.from === "discord" ? "discord" : "panel"; },
  // from the Discord bot (tools/discord-bot): who is in the casting voice channel, and who is talking
  discordCasters: (a) => {
    if (show.castersFrom !== "discord") return;
    const talking = new Set(show.casters.filter((c) => c.speaking).map((c) => c.id));
    show.casters = (a.casters ?? []).map(cleanCaster).map((c: any) => ({ ...c, speaking: talking.has(c.id) }));
  },
  // live gameplay from a TA bridge or tools/mock-ta (see LiveState in model.ts)
  live: (a) => {
    const was = live?.phase ?? null;
    live = a.phase ? { matchId: a.matchId, phase: a.phase, time: Number(a.time) || 0, duration: Number(a.duration) || 0, players: a.players, feeds: a.feeds, startedAt: Number(a.startedAt) || undefined } : null;
    const now = live?.phase ?? null;
    if (now !== was && now === "loading") { onEvent({ name: "mapLoad" }); songEnded = false; }
    if (now !== was && now === "playing") onEvent({ name: "mapStart" });
    // every player has finished the song (TA's scores are in; the referee still has to close the map)
    const everyone = Object.values(live?.players ?? {}).flat() as { finished?: boolean }[];
    if (now === "playing" && !songEnded && everyone.length && everyone.every((p) => p?.finished)) {
      songEnded = true;
      onEvent({ name: "songEnd" });
    }
  },
  // the replay playlist: { action: "playlist", op: "add", refs: [...] } and play / next / prev / random / restart /
  // remove / move / sort / mode / clear (see server/playlist.ts)
  playlist: (a) => {
    const ops: Record<string, () => void> = {
      add: () => playlist.add(Array.isArray(a.refs) ? a.refs : String(a.refs ?? "").split("\n")),
      play: () => playlist.play(String(a.id)), next: () => playlist.next(), prev: () => playlist.prev(),
      random: () => playlist.random(), restart: () => playlist.restart(), remove: () => playlist.remove(String(a.id)),
      move: () => playlist.move(String(a.id), Number(a.to)), sort: () => playlist.sort(String(a.by)),
      mode: () => playlist.setMode(String(a.mode)), clear: () => playlist.clear(),
    };
    if (!ops[a.op]) throw new Error(`unknown playlist op "${a.op}"`);
    ops[a.op]();
  },
  replays: (a) => playlist.set(a.replays ?? []),        // the whole list at once (older API)
  speaking: (a) => {
    const c = show.casters.find((x) => x.id && x.id === String(a.id));
    if (c) c.speaking = !!a.on;
  },
  header: (a) => { show.header = String(a.header ?? ""); },
  viewer: (a) => {
    if (a.lockPitch !== undefined) show.viewer.lockPitch = !!a.lockPitch;
    if (a.pitchLimit !== undefined) show.viewer.pitchLimit = Math.max(0, Math.min(90, Number(a.pitchLimit) || 0));
    if (a.renderScale !== undefined) show.viewer.renderScale = Math.max(0.25, Math.min(1, Number(a.renderScale) || 1));
    if (a.maxFps !== undefined) show.viewer.maxFps = Math.max(10, Math.min(120, Number(a.maxFps) || 60));
    if (a.preview !== undefined) show.viewer.preview = a.preview === "live" ? "live" : "program";
    if (a.quality !== undefined) show.viewer.quality = ["high", "medium", "low", "none"].includes(String(a.quality)) ? a.quality : "medium";
    if (a.distortion !== undefined) show.viewer.distortion = !!a.distortion;
    if (a.output !== undefined) show.viewer.output = [0, 720, 1080, 1440, 2160].includes(Number(a.output)) ? Number(a.output) : 1080;
  },
  brb: (a) => { Object.assign(show.brb, a.brb ?? {}); if (a.minutes !== undefined) show.brb.endsAt = Date.now() + Number(a.minutes) * 60_000; },
  ticker: (a) => { show.ticker = (a.ticker as string[]).map((s) => s.trim()).filter(Boolean); },
  feeds: (a) => { show.feeds = a.feeds; },
  streamDelay: (a) => { show.streamDelayMs = Math.max(0, Number(a.ms) || 0); },
  source: (a) => source.control?.(a.control, a),
};
async function runAction(a: any) {
  const fn = actions[a?.action];
  if (!fn) throw new Error(`unknown action "${a?.action}"`);
  await fn(a);
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
const sessions = new Set<string>();
const authed = (req: Request) => {
  const sid = /(?:^|;\s*)kit_sid=(\w+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  return !!sid && sessions.has(sid) || req.headers.get("authorization") === `Bearer ${secrets.hostCode}`;
};

Deno.serve({ port: PORT, hostname: HOST }, async (req) => {
  const url = new URL(req.url), p = url.pathname;
  const upgrade = req.headers.get("upgrade") === "websocket";

  if (p === "/ws/overlay" && upgrade) {
    if (url.searchParams.get("key") !== secrets.overlayKey) return new Response("bad key", { status: 403 });
    const { socket, response } = Deno.upgradeWebSocket(req);
    const preview = url.searchParams.get("role") === "preview";
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      overlays.add(socket);
      if (preview) previews.add(socket);
      send(socket, stateMsg());
      choosePictureSource();
    };
    socket.onclose = () => { overlays.delete(socket); previews.delete(socket); choosePictureSource(); };
    // an overlay reports on its replay viewer: loaded, the song's real length, finished
    socket.onmessage = (e) => {
      // a picture of one of its replays (hole name + JPEG): on to the previews
      if (e.data instanceof ArrayBuffer) {
        if (socket === picturesFrom) for (const ws of previews) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 2_000_000) ws.send(e.data);
        return;
      }
      try {
        const m = JSON.parse(e.data);
        if (m?.type === "viewer" && typeof m.id === "string") playlist.viewer(m.id, m);
      } catch { /* ignore */ }
    };
    return response;
  }
  if (p === "/ws/panel" && upgrade) {
    if (!authed(req)) return new Response("login required", { status: 401 });
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = async () => { panels.add(socket); send(socket, await panelMsg()); };
    socket.onclose = () => panels.delete(socket);
    socket.onmessage = async (e) => {
      const a = JSON.parse(e.data);
      try { await runAction(a); send(socket, { type: "ack", reqId: a.reqId, ok: true }); }
      catch (err) { send(socket, { type: "ack", reqId: a.reqId, ok: false, error: (err as Error).message }); }
    };
    return response;
  }
  if (p === "/api/action" && req.method === "POST") {
    if (!authed(req)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    try { await runAction(await req.json()); return Response.json({ ok: true }); }
    catch (e) { return Response.json({ ok: false, error: (e as Error).message }, { status: 400 }); }
  }
  if (p === "/api/state") {
    if (!authed(req)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    return Response.json({ data: liveData, show, source: source.status() });
  }
  if (p === "/api/design") return Response.json({ version: designVersion, scenes: await designList(), fonts: await fontList() });
  if (p === "/api/login" && req.method === "POST") {
    const { code } = await req.json().catch(() => ({}));
    if (code !== secrets.hostCode) return Response.json({ ok: false }, { status: 401 });
    const sid = rand(32);
    sessions.add(sid);
    return Response.json({ ok: true }, { headers: { "set-cookie": `kit_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` } });
  }
  if (p.startsWith("/login/")) {
    if (decodeURIComponent(p.slice(7)) !== secrets.hostCode) return new Response(null, { status: 303, headers: { location: "/" } });
    const sid = rand(32);
    sessions.add(sid);
    return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `kit_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` } });
  }

  if (p === "/" || p === "/panel") return file("web", authed(req) ? "panel.html" : "login.html");
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

console.log(`
  BSOverlayKit on http://${HOST}:${PORT}
  panel login code:  ${secrets.hostCode}   (or open http://${HOST}:${PORT}/login/${secrets.hostCode})
  OBS Browser Source: http://${HOST}:${PORT}/overlay?key=${secrets.overlayKey}
`);
