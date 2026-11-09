// The replay playlist for Starting Soon / Intermission / BRB (any scene with a feed:main hole).
//
// The server owns the clock, so every overlay page (OBS, the panel preview, a second PC) shows the same moment of
// the same replay: `current.startAt` is when song time 0 happens (epoch ms), or `pausedAt` (song seconds) while no
// replay scene is on stream. Between songs there is a gap for the "up next" card: the next replay loads under it,
// and the song starts once an overlay says its viewer is ready (or after a timeout).
import type { Playlist, PlaylistItem, ReplayInfo } from "./model.ts";

const MIN_CARD_MS = 3200;      // the "up next" card stays at least this long
const START_AFTER_READY_MS = 900;
const READY_TIMEOUT_MS = 15_000;
const FADE_S = 1.2;            // overlays fade the music out over this long before pausing (overlay.js FADE_MS)

const rand = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");

export function emptyPlaylist(): Playlist {
  return { items: [], mode: "order", current: null };
}

/** Song seconds right now (negative while the "up next" card is still up). */
export function position(p: Playlist, now = Date.now()): number | null {
  const c = p.current;
  if (!c) return null;
  if (c.pausedAt !== null) return c.pausedAt;
  if (c.startAt === null) return null;
  return (now - c.startAt) / 1000;
}

export class PlaylistControl {
  private infoLoading = new Set<string>();
  constructor(
    public p: Playlist,
    private changed: (structural: boolean) => void,
  ) {
    // older show.json: a plain list of links
    this.p.items = (this.p.items ?? []).filter((x) => x?.id && x?.ref);
    this.p.mode ??= "order";
    this.p.current ??= null;
    if (this.p.current && !this.p.items.some((x) => x.id === this.p.current!.id)) this.p.current = null;
    for (const it of this.p.items) if (!it.info) this.resolve(it);
  }

  get current(): PlaylistItem | null {
    return this.p.items.find((x) => x.id === this.p.current?.id) ?? null;
  }

  /** What plays after the current one (null in shuffle: it is picked when the song ends). */
  upNext(): PlaylistItem | null {
    const items = this.p.items;
    if (!items.length) return null;
    if (this.p.mode === "repeat") return this.current;
    if (this.p.mode === "shuffle") return null;
    const i = items.findIndex((x) => x.id === this.p.current?.id);
    return items[(i + 1) % items.length];
  }

  // ---------------------------------------------------------------- editing
  add(refs: string[]) {
    for (const ref of refs.map((s) => String(s).trim()).filter(Boolean)) {
      const it: PlaylistItem = { id: rand(), ref, info: null };
      this.p.items.push(it);
      this.resolve(it);
    }
    this.changed(true);
  }
  /** Replace the whole list (the HTTP API's old `replays` action). Keeps items whose link stays. */
  set(refs: string[]) {
    const keep = new Map(this.p.items.map((x) => [x.ref, x]));
    this.p.items = refs.map((s) => String(s).trim()).filter(Boolean).map((ref) => keep.get(ref) ?? { id: rand(), ref, info: null });
    for (const it of this.p.items) if (!it.info) this.resolve(it);
    if (this.p.current && !this.current) this.p.current = null;
    this.changed(true);
  }
  remove(id: string) {
    const wasCurrent = this.p.current?.id === id;
    const i = this.p.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.p.items.splice(i, 1);
    if (wasCurrent) this.switchTo(this.p.items[i % Math.max(1, this.p.items.length)] ?? null);
    this.changed(true);
  }
  move(id: string, to: number) {
    const i = this.p.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [it] = this.p.items.splice(i, 1);
    this.p.items.splice(Math.max(0, Math.min(this.p.items.length, to)), 0, it);
    this.changed(true);
  }
  sort(by: string) {
    const items = this.p.items;
    const text = (f: (i: ReplayInfo) => string) => (a: PlaylistItem, b: PlaylistItem) =>
      (a.info ? f(a.info) : a.ref).localeCompare(b.info ? f(b.info) : b.ref, undefined, { sensitivity: "base" });
    const num = (f: (i: ReplayInfo) => number | null) => (a: PlaylistItem, b: PlaylistItem) =>
      (b.info ? f(b.info) ?? -1 : -1) - (a.info ? f(a.info) ?? -1 : -1);
    if (by === "song") items.sort(text((i) => i.song));
    else if (by === "player") items.sort(text((i) => i.player));
    else if (by === "mapper") items.sort(text((i) => i.mapper));
    else if (by === "stars") items.sort(num((i) => i.stars));
    else if (by === "acc") items.sort(num((i) => i.acc));
    else if (by === "length") items.sort((a, b) => (a.info?.duration ?? 0) - (b.info?.duration ?? 0));
    else if (by === "shuffle") {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
    }
    this.changed(true);
  }
  setMode(mode: string) {
    this.p.mode = mode === "shuffle" || mode === "repeat" ? mode : "order";
    this.changed(true);
  }

  // ---------------------------------------------------------------- playing
  play(id: string) { this.switchTo(this.p.items.find((x) => x.id === id) ?? null); }
  next() { this.switchTo(this.pick(this.p.mode === "repeat" ? "order" : this.p.mode)); }
  prev() {
    const items = this.p.items;
    const i = items.findIndex((x) => x.id === this.p.current?.id);
    this.switchTo(items[(i - 1 + items.length) % items.length] ?? null);
  }
  random() { this.switchTo(this.pick("shuffle")); }
  restart() { if (this.current) this.switchTo(this.current); }
  clear() { this.p.items = []; this.p.current = null; this.changed(true); }

  private pick(mode: string): PlaylistItem | null {
    const items = this.p.items;
    if (!items.length) return null;
    const i = items.findIndex((x) => x.id === this.p.current?.id);
    if (mode === "shuffle" && items.length > 1) {
      // not the current one, and not one of the last few if there are enough
      const recent = new Set(this.recent.slice(-Math.min(items.length - 1, 4)));
      const others = items.filter((x) => x.id !== this.p.current?.id);
      const fresh = others.filter((x) => !recent.has(x.id));
      const from = fresh.length ? fresh : others;
      return from[Math.floor(Math.random() * from.length)];
    }
    if (mode === "repeat") return items[Math.max(0, i)];
    return items[(i + 1) % items.length];
  }
  private recent: string[] = [];
  private waitingSince = 0;     // when the current one started waiting with a replay scene on stream

  private switchTo(it: PlaylistItem | null) {
    if (this.p.current) this.recent.push(this.p.current.id);
    this.recent = this.recent.slice(-10);
    this.p.current = it
      ? { id: it.id, startAt: null, pausedAt: null, duration: it.info?.duration ?? 0, switchedAt: Date.now(), ready: false }
      : null;
    this.changed(true);
  }

  /** An overlay page reports on its viewer for the current item. */
  viewer(id: string, r: { ready?: boolean; duration?: number; ended?: boolean }) {
    const c = this.p.current;
    if (!c || c.id !== id) return;
    if (r.ready && !c.ready) { c.ready = true; this.changed(false); }
    const d = Number(r.duration);
    if (d > 5 && d < 3600 && Math.abs(d - c.duration) > 0.05) { c.duration = d; this.changed(false); }
    const pos = position(this.p);
    if (r.ended && pos !== null && c.pausedAt === null && pos > Math.max(5, c.duration * 0.8)) this.finished();
  }

  private finished() {
    this.switchTo(this.pick(this.p.mode));
  }

  /** Every ~250 ms. `onAir`: a scene with the replay hole is on stream. */
  tick(onAir: boolean, now = Date.now()) {
    const p = this.p;
    if (!p.current && p.items.length && onAir) this.switchTo(p.items[0]);
    const c = p.current;
    if (!c) return;
    if (c.startAt === null && c.pausedAt === null) {
      // waiting for the next replay to load under the "up next" card (the timeout only counts while it is on stream)
      if (!onAir) { this.waitingSince = 0; return; }
      this.waitingSince ||= now;
      if (c.ready || now - this.waitingSince > READY_TIMEOUT_MS) {
        c.startAt = Math.max(now + START_AFTER_READY_MS, c.switchedAt + MIN_CARD_MS);
        this.changed(false);
      }
      return;
    }
    if (!onAir && c.pausedAt === null) {
      const pos = position(p, now)!;
      c.pausedAt = pos >= 0 ? pos + FADE_S : pos;     // the music keeps going while it fades out
      this.changed(false);
    } else if (onAir && c.pausedAt !== null) {
      c.startAt = now - c.pausedAt * 1000;
      c.pausedAt = null;
      this.changed(false);
    }
    const pos = position(p, now);
    if (c.pausedAt === null && pos !== null && c.duration > 0 && pos >= c.duration + 0.4) this.finished();
  }

  // ---------------------------------------------------------------- who played what
  private async resolve(it: PlaylistItem) {
    if (this.infoLoading.has(it.id)) return;
    this.infoLoading.add(it.id);
    try {
      it.info = await replayInfo(it.ref);
      it.error = it.info ? undefined : "unknown replay link";
      if (this.p.current?.id === it.id && it.info?.duration && !this.p.current.duration) this.p.current.duration = it.info.duration;
    } catch (e) {
      it.error = (e as Error).message;
    } finally {
      this.infoLoading.delete(it.id);
      this.changed(true);
    }
  }
}

// ------------------------------------------------------------------ replay info (song, player) for a link
export function blScoreId(ref: string): string | null {
  const e = ref.trim();
  const m = /^(?:bl:)?(\d+)$/i.exec(e) ?? /beatleader\.(?:com|xyz|net)\/(?:score|replay)?\/?(?:\?scoreId=)?(\d+)/i.exec(e) ??
    /[?&]scoreIdBL=(\d+)/i.exec(e) ?? /replay\.beatleader\.(?:com|xyz)\/\?.*scoreId=(\d+)/i.exec(e);
  return m ? m[1] : null;
}

async function replayInfo(ref: string): Promise<ReplayInfo | null> {
  const bl = blScoreId(ref);
  if (bl) {
    const r = await fetch(`https://api.beatleader.com/score/${bl}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`BeatLeader: score ${bl} not found (${r.status})`);
    const s = await r.json();
    return {
      source: "beatleader",
      song: s.song?.name ?? "", subName: s.song?.subName ?? "", artist: s.song?.author ?? "", mapper: s.song?.mapper ?? "",
      cover: s.song?.cover ?? "", difficulty: prettyDiff(s.difficulty?.difficultyName ?? ""), stars: num(s.difficulty?.stars),
      duration: num(s.difficulty?.duration) ?? 0, player: s.player?.name ?? "", playerAvatar: s.player?.avatar ?? "",
      country: s.player?.country ?? "", acc: num(s.accuracy), fc: !!s.fullCombo, misses: (s.missedNotes ?? 0) + (s.badCuts ?? 0),
    };
  }
  if (/^https?:\/\/.+\.bsor$/i.test(ref.trim())) return await bsorInfo(ref.trim());
  if (/^ss:\d+$/i.test(ref.trim()) || /scoresaber\.com/i.test(ref)) {
    // ScoreSaber has no public "score by id" lookup; the viewer still plays it
    return { source: "scoresaber", song: "", subName: "", artist: "", mapper: "", cover: "", difficulty: "", stars: null, duration: 0, player: "", playerAvatar: "", country: "", acc: null, fc: false, misses: null };
  }
  return null;
}
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const prettyDiff = (d: string) => ({ ExpertPlus: "Expert+", Expert: "Expert", Hard: "Hard", Normal: "Normal", Easy: "Easy" } as Record<string, string>)[d] ?? d;

/** The info block at the start of a BeatLeader .bsor file: player, song, mapper, difficulty. */
async function bsorInfo(url: string): Promise<ReplayInfo | null> {
  const r = await fetch(url, { headers: { range: "bytes=0-8191" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`replay file: ${r.status}`);
  const buf = new DataView(await r.arrayBuffer());
  let o = 0;
  const i32 = () => { const v = buf.getInt32(o, true); o += 4; return v; };
  const str = () => { const n = i32(); if (n < 0 || n > 2000) throw new Error("not a .bsor file"); const s = new TextDecoder().decode(new Uint8Array(buf.buffer, o, n)); o += n; return s; };
  if (i32() !== 0x442d3d69) throw new Error("not a .bsor file");
  o += 2;   // version, section type (0 = info)
  const f = ["version", "gameVersion", "timestamp", "playerID", "playerName", "platform", "trackingSystem", "hmd", "controller", "hash", "songName", "mapper", "difficulty"];
  const v: Record<string, string> = {};
  for (const k of f) v[k] = str();
  return {
    source: "file", song: v.songName, subName: "", artist: "", mapper: v.mapper, cover: v.hash ? `https://eu.cdn.beatsaver.com/${v.hash.toLowerCase()}.jpg` : "",
    difficulty: prettyDiff(v.difficulty), stars: null, duration: 0, player: v.playerName, playerAvatar: "", country: "", acc: null, fc: false, misses: null,
  };
}
