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
  return { items: [], mode: "order", current: null, followTeams: true };
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
    this.p.followTeams ??= true;
    this.p.played ??= [];
    this.p.scope = this.scope();
    if (this.p.current && !this.p.items.some((x) => x.id === this.p.current!.id)) this.p.current = null;
    for (const it of this.p.items) if (!it.info) this.resolve(it);
  }

  get current(): PlaylistItem | null {
    return this.p.items.find((x) => x.id === this.p.current?.id) ?? null;
  }

  // ---------------------------------------------------------------- whose replays
  // The list holds the panel's own replays (items without a team: a caster's, a guest's, anything pasted in) and
  // the replays the tournament's players chose to show (items with `team` and `player`, kept in step with the data
  // source by setTeams). What plays:
  //   - Getting Ready is on and a match is up: a replay of someone about to play (else of their two teams)
  //   - any other time: the break mix, shuffled: the panel's own replays and those of every team still in the bracket
  private focus: { teams: string[]; players: string[] } | null = null;   // who is about to play (lower-case), on Getting Ready
  private out = new Set<string>();                                       // teams knocked out (lower-case)
  private pool(): { kind: NonNullable<Playlist["scope"]>["kind"]; items: PlaylistItem[] } {
    const items = this.p.items;
    const follow = this.p.followTeams !== false;
    const lc = (s?: string) => (s ?? "").toLowerCase();
    if (follow && this.focus) {
      const theirs = items.filter((x) => x.team && this.focus!.teams.includes(lc(x.team)));
      const lineup = theirs.filter((x) => x.player && this.focus!.players.includes(lc(x.player)));
      if (lineup.length) return { kind: "lineup", items: lineup };
      if (theirs.length) return { kind: "teams", items: theirs };
    }
    const special = items.filter((x) => !x.team);
    const stillIn = follow ? items.filter((x) => x.team && !this.out.has(lc(x.team))) : [];
    if (stillIn.length) return { kind: "mix", items: [...special, ...stillIn] };
    if (special.length) return { kind: "special", items: special };
    const all = follow ? items.filter((x) => x.team) : [];
    return all.length ? { kind: "all", items: all } : { kind: "none", items: [] };
  }
  private scope(): NonNullable<Playlist["scope"]> {
    const pool = this.pool();
    const names = pool.kind === "lineup" ? [...new Set(pool.items.map((x) => x.player!))] : pool.kind === "teams" ? [...new Set(pool.items.map((x) => x.team!))] : [];
    return { kind: pool.kind, names, out: [...new Set(this.p.items.filter((x) => x.team && this.out.has(x.team.toLowerCase())).map((x) => x.team!))] };
  }
  /** The mode songs follow one another in: only the panel's own list, played alone, has one; everything else is shuffled. */
  private modeNow(): Playlist["mode"] { return this.pool().kind === "special" ? this.p.mode : "shuffle"; }
  /** A replay for Getting Ready is a glimpse, not a turn. */
  private passing(kind = this.pool().kind) { return kind === "lineup" || kind === "teams"; }

  /**
   * The data source's word on the teams: every team's replays (whose each is, and whether the team is out of the
   * bracket), and `focus`: who is about to play while Getting Ready is on (null any other time).
   * Replays that are new join the list, ones that are gone leave it. The replay that is playing is left to finish,
   * except across the line between a break and Getting Ready: there what should play now starts at once.
   */
  setTeams(teams: { name: string; replays: string[]; out?: boolean; players?: { name: string; replays: string[] }[] }[],
    focus: { teams: string[]; players: string[] } | null, onAir: boolean) {
    const want = new Map<string, { team: string; player?: string; ref: string }>();
    for (const t of teams) {
      const owned = new Set<string>();
      for (const pl of t.players ?? []) for (const ref of pl.replays) { owned.add(ref); want.set(`${t.name}\n${pl.name}\n${ref}`, { team: t.name, player: pl.name, ref }); }
      for (const ref of t.replays) if (!owned.has(ref)) want.set(`${t.name}\n\n${ref}`, { team: t.name, ref });
    }
    const key = (x: PlaylistItem) => `${x.team}\n${x.player ?? ""}\n${x.ref}`;
    const before = this.p.items.length;
    let structural = false;
    this.p.items = this.p.items.filter((x) => !x.team || want.has(key(x)));
    if (this.p.items.length !== before) structural = true;
    const have = new Set(this.p.items.filter((x) => x.team).map(key));
    for (const [k, w] of want) {
      if (have.has(k)) continue;
      const it: PlaylistItem = { id: rand(), ref: w.ref, info: null, team: w.team, ...(w.player ? { player: w.player } : {}) };
      this.p.items.push(it);
      this.resolve(it);
      structural = true;
    }
    this.out = new Set(teams.filter((t) => t.out).map((t) => t.name.toLowerCase()));
    this.focus = focus && (focus.teams.length || focus.players.length)
      ? { teams: focus.teams.map((n) => n.toLowerCase()), players: focus.players.map((n) => n.toLowerCase()) } : null;
    const ids = new Set(this.p.items.map((x) => x.id));
    this.p.played = (this.p.played ?? []).filter((id) => ids.has(id));
    const scope = this.scope();
    const moved = JSON.stringify(scope) !== JSON.stringify(this.p.scope);
    this.p.scope = scope;
    const pool = this.pool();
    const cur = this.current;
    if (this.p.current && !cur) this.p.current = null;                 // the playing one was removed
    else if (cur && pool.items.length) {
      // Getting Ready has come on: someone about to play, now. Or it has gone: a fresh replay from the mix, not the
      // rest of the glimpse. Otherwise a replay that no longer belongs gives way only while nothing is on stream.
      const glimpse = this.passing(pool.kind);
      if (glimpse !== !!this.p.current!.passing) this.switchTo(this.pick("shuffle"));
      else if (!pool.items.includes(cur) && !onAir) this.switchTo(this.pick("shuffle"));
    }
    if (structural || moved) this.changed(structural);
  }
  setFollowTeams(on: boolean) {
    this.p.followTeams = on;
    this.p.scope = this.scope();
    this.changed(true);
  }
  /** Everything gets its turn again from now. */
  resetPlayed() { this.p.played = []; this.changed(true); }

  /** What plays after the current one (null in shuffle: it is picked when the song ends). */
  upNext(): PlaylistItem | null {
    const items = this.pool().items;
    if (!items.length) return null;
    const mode = this.modeNow();
    if (mode === "repeat") return this.current;
    if (mode === "shuffle") return null;
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
    this.p.scope = this.scope();
    this.changed(true);
  }
  /** Replace the whole list (the HTTP API's old `replays` action). Keeps items whose link stays. */
  set(refs: string[]) {
    const keep = new Map(this.p.items.filter((x) => !x.team).map((x) => [x.ref, x]));
    const teams = this.p.items.filter((x) => x.team);
    this.p.items = [...refs.map((s) => String(s).trim()).filter(Boolean).map((ref) => keep.get(ref) ?? { id: rand(), ref, info: null }), ...teams];
    for (const it of this.p.items) if (!it.info) this.resolve(it);
    if (this.p.current && !this.current) this.p.current = null;
    this.changed(true);
  }
  remove(id: string) {
    const wasCurrent = this.p.current?.id === id;
    const i = this.p.items.findIndex((x) => x.id === id);
    if (i < 0 || this.p.items[i].team) return;       // a team's replay is taken off where it was put on: the site
    this.p.items.splice(i, 1);
    this.p.played = (this.p.played ?? []).filter((x) => x !== id);      // its mark goes with it
    this.p.scope = this.scope();
    if (wasCurrent) this.switchTo(this.pick(this.modeNow() === "repeat" ? "order" : this.modeNow()));
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
  next() { const mode = this.modeNow(); this.switchTo(this.pick(mode === "repeat" ? "order" : mode)); }
  prev() {
    const items = this.pool().items;
    const i = items.findIndex((x) => x.id === this.p.current?.id);
    this.switchTo(items[(Math.max(0, i) - 1 + items.length) % items.length] ?? null);
  }
  random() { this.switchTo(this.pick("shuffle")); }
  restart() { if (this.current) this.switchTo(this.current); }
  /** Empty the panel's own list. The teams' replays stay: they come from the data source. */
  clear() {
    this.p.items = this.p.items.filter((x) => x.team);
    if (this.p.current && !this.current) this.p.current = null;
    this.p.scope = this.scope();
    this.changed(true);
  }

  private pick(mode: string): PlaylistItem | null {
    const items = this.pool().items;
    if (!items.length) return null;
    const i = items.findIndex((x) => x.id === this.p.current?.id);
    if (mode === "shuffle" && items.length > 1) {
      // One that has not had its turn yet (and is not the one playing). When every one here has had its turn, they
      // all get another: their marks are wiped and the draw starts over. Replays outside this pool keep theirs.
      this.credit();     // the one playing first: it is part of "every one has had its turn"
      const played = new Set(this.p.played ?? []);
      const others = items.filter((x) => x.id !== this.p.current?.id);
      let fresh = others.filter((x) => !played.has(x.id));
      if (!fresh.length) {
        const here = new Set(items.map((x) => x.id));
        this.p.played = (this.p.played ?? []).filter((id) => !here.has(id));
        this.startedOver = true;       // the one playing was the last of the round: its mark is not put back
        fresh = others;
      }
      return fresh[Math.floor(Math.random() * fresh.length)];
    }
    if (mode === "repeat") return items[Math.max(0, i)];
    return items[(i + 1) % items.length];
  }
  private waitingSince = 0;     // when the current one started waiting with a replay scene on stream
  private startedOver = false;  // pick() has just wiped the marks: every replay had had its turn

  /**
   * The replay that is playing has had its turn if it is being played in a break (not as a glimpse on Getting Ready)
   * and has got at least half way: one cut short by the match starting, or skipped early, keeps its chance to be
   * seen whole.
   */
  private credit() {
    const c = this.p.current, pos = position(this.p);
    if (c && !c.passing && c.duration > 0 && pos !== null && pos >= c.duration * 0.5 && !this.p.played?.includes(c.id)) {
      this.p.played = [...(this.p.played ?? []), c.id];
    }
  }

  private switchTo(it: PlaylistItem | null) {
    if (!this.startedOver) this.credit();
    this.startedOver = false;
    this.p.current = it
      ? { id: it.id, startAt: null, pausedAt: null, duration: it.info?.duration ?? 0, switchedAt: Date.now(), ready: false, ...(this.passing() ? { passing: true } : {}) }
      : null;
    this.changed(true);
  }

  /** An overlay page reports on its viewer for the current item. */
  /**
   * What an overlay page says about the replay it is playing. `trusted`: the page gave the overlay key (OBS).
   * Any page may say its replay has loaded. A length is taken from any page only while none is known (a ScoreSaber
   * or file replay has none until a viewer has opened it: without one the replay would never end); a known length
   * is corrected, and a replay's end believed, only from a trusted page.
   */
  viewer(id: string, r: { ready?: boolean; duration?: number; ended?: boolean }, trusted = true) {
    const c = this.p.current;
    if (!c || c.id !== id) return;
    if (r.ready && !c.ready) { c.ready = true; this.changed(false); }
    const d = Number(r.duration);
    if ((trusted || !(c.duration > 0)) && d > 5 && d < 3600 && Math.abs(d - c.duration) > 0.05) { c.duration = d; this.changed(false); }
    const pos = position(this.p);
    if (trusted && r.ended && pos !== null && c.pausedAt === null && pos > Math.max(5, c.duration * 0.8)) this.finished();
  }

  private finished() {
    this.switchTo(this.pick(this.modeNow()));
  }

  /** Every ~250 ms. `onAir`: a scene with the replay hole is on stream. */
  tick(onAir: boolean, now = Date.now()) {
    const p = this.p;
    if (!p.current && onAir) {
      const pool = this.pool();
      if (pool.items.length) this.switchTo(pool.kind === "special" && p.mode !== "shuffle" ? pool.items[0] : this.pick("shuffle"));
    }
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
