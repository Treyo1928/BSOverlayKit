// BSCompStats source: follows one match on a BSCompStats site over its live events stream
// (GET /api/v1/matches/:id/events, see BSCompStats docs/api.md) and turns it into the overlay's data contract,
// so every scene works the same as with the simulator.
//
// overlay.yaml:
//   source: bscompstats
//   bscompstats: { url: "http://127.0.0.1:3100", tournament: msu-test, match: "" }
// The API key is never in overlay.yaml (that file gets shared): set BSCS_KEY in the environment, or "bscsKey" in
// data/secrets.json. A read-only key is enough; the overlay only reads.
//
// TA-mode matches (the site's worker runs them through TournamentAssistant, BSCompStats docs/api.md "TA mode"): each
// planned map's `start.status.phase` says how far TA is (waiting / loading / ready / playing / finished), and while a
// song plays the same events stream sends `event: live` with every player's score about 4 times a second. This source
// turns both into the overlay's live state (phase loading/playing, numbers per side and lineup slot), and names each
// lineup player's TA live-replay stream for the video holes (`taLive`). Matches that are not in TA mode have no live
// play: a map is "waiting" until its scores are in, then the scores show as the map's result.
import { blankSide, type BracketData, type DataSource, type EventMsg, fmtTime, type LiveState, type MapSlot, type OverlayData, type PlayerData, type PoolItem, type ResultItem, type Side, type TeamInfo } from "../model.ts";

export interface BscsOptions { url?: string; tournament?: string; match?: string }

// The parts of the BSCompStats match JSON this source reads.
interface PoolMap {
  poolMapId: string; name: string; mapper: string | null; artist?: string | null; coverImage: string | null;
  difficultyLabel: string; isTiebreaker: boolean; duration: number; perfectAcc?: number | null; category?: string | null; bpm?: number; hash?: string;
}
interface Run { playerId: string; playerName: string; score: number; accuracy: number | null; failed: boolean }
interface Go { accEquivalent: number | null; points?: number | null; counted: boolean; complete: boolean; runs: Run[] }
interface PlannedMap {
  order: number; poolMapId: string; matchMapId: string; isTiebreaker: boolean; pickedByTeamId: string | null; map: PoolMap;
  lineups: Record<string, string[]>; scores: Record<string, Run[]>; goes: Record<string, Go[]>;
  scoresClosed: boolean; result: { winnerId: string | null; decided: boolean };
  // a map run through TA: who asked for the start, and how far TA is ("loading" / "playing" / "finished" / "error")
  start?: { requestedAt?: string | null; playRequestedAt?: string | null;
    status?: { phase?: string | null; startedAt?: string | number | null; players?: { playerId: string; state: string; score?: number; accuracy?: number }[] } | null } | null;
}
interface Team { id: string; name: string; color: string; logo?: string | null;
  players: { id: string; name: string; avatar: string | null; beatLeaderId?: string | null; taPlatformId?: string | null; replays?: string[] }[] }
/** `event: live` of the match events stream: every lineup player's numbers while a song plays. */
interface LiveEvent {
  matchId: string; matchMapId: string; phase: "playing" | "over"; startedAt: number; at: number;
  players: { playerId: string; teamId: string; slot: number; platformId: string; score: number; accuracy: number | null; combo: number; misses: number; songPosition: number; finished: boolean }[];
}
interface Match {
  id: string; name: string; state: "PICKBAN" | "PLAYING" | "COMPLETE";
  scoring?: { mode?: string; curve?: { padding: number; slope: number; perfectPoints: number } } | null;
  taMode?: boolean; ta?: { host: string; port: number; liveUrl?: string } | null;
  tournament: { name: string; slug: string };
  format: { playersPerMap: number; tiebreaker: string; winCondition?: string; pickBanSequence: { actor: "COIN_WINNER" | "COIN_LOSER"; action: "PICK" | "BAN" }[] };
  teamA: Team; teamB: Team; coinFlipWinnerId: string | null; winnerId: string | null;
  pool: { maps: PoolMap[] };
  actions: { seq: number; type: "PICK" | "BAN"; teamId: string; poolMapId: string }[];
  pending: { seq: number; type: "PICK" | "BAN"; teamId: string; waitingForPoolMapId: string | null } | null;
  plannedMaps: PlannedMap[];
  scoreboard: { a: number; b: number };
}
interface Slot {
  key: string; section: string; round: number; position: number; state: string;
  teamA: { id: string; name: string } | null; teamB: { id: string; name: string } | null; winnerId: string | null;
  match: { id: string; state: string; a: number; b: number } | null;
  passThrough?: boolean;
}

const RESULT_HOLD_MS = 15_000;   // how long "finished" (the map result banner) stays up after scores close

export class BscsSource implements DataSource {
  readonly name = "bscompstats";
  #emit: (d: OverlayData) => void = () => {};
  #event: (e: EventMsg) => void = () => {};
  #url: string;
  #tournament: string;
  #matchId: string;
  #key: string;
  #match: Match | null = null;
  #prev: Match | null = null;
  #bracket: BracketData | null = null;
  #matches: { id: string; label: string; state: string }[] = [];
  #status = "not connected";
  #abort: AbortController | null = null;
  #timer?: ReturnType<typeof setInterval>;
  #finishedUntil = 0;
  #auto = true;          // no match picked in the panel: follow the newest unfinished one
  #holdTimer?: ReturnType<typeof setTimeout>;
  #live: (l: LiveState | null) => void = () => {};
  #lastLive: LiveEvent | null = null;     // the newest numbers of the song being played
  #liveOn = false;                        // this source has a live state out (so it must also take it back)
  #platformIds = new Map<string, string>();
  #teams: TeamInfo[] = [];                // every team entered in the tournament   // playerId -> TA platform id, as seen in live events

  constructor(opts: BscsOptions, key: string, private onFollow: (matchId: string) => void = () => {}) {
    this.#url = (opts.url ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
    this.#tournament = opts.tournament ?? "";
    this.#matchId = opts.match ?? "";
    this.#auto = !this.#matchId;
    this.#key = key;
  }

  async start(emit: (d: OverlayData) => void, event: (e: EventMsg) => void, live?: (l: LiveState | null) => void) {
    this.#emit = emit;
    this.#event = event;
    if (live) this.#live = live;
    if (!this.#key) this.#status = "no API key: set BSCS_KEY or bscsKey in data/secrets.json";
    await this.#refreshLists();
    this.#timer = setInterval(() => this.#refreshLists(), 5_000);
    if (this.#matchId) this.#follow(this.#matchId);
    this.#push();
  }
  async stop() { clearInterval(this.#timer); this.#abort?.abort(); }
  status() { return `BSCompStats · ${this.#status}`; }

  /** The panel: which matches exist, and which one is followed. */
  panel() { return { following: this.#matchId, auto: this.#auto, matches: this.#matches }; }

  control(action: string, args: Record<string, unknown>) {
    if (action === "follow") {
      const id = String(args.matchId ?? "").trim().split("/").pop() ?? "";   // a match id, or a link to its page
      this.#auto = !id;
      if (id) this.#follow(id);
      else this.#refreshLists();
      this.onFollow(id);
    }
  }

  // ---------------------------------------------------------------- connection
  async #api(path: string) {
    const r = await fetch(`${this.#url}/api/v1${path}`, { headers: { authorization: `Bearer ${this.#key}` } });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 120)}`);
    return r.json();
  }

  async #refreshLists() {
    if (!this.#key || !this.#tournament) return;
    try {
      const t = await this.#api(`/tournaments/${encodeURIComponent(this.#tournament)}`);
      this.#teams = (t.teams ?? []).map((team: Team) => this.#teamInfo(team));
      this.#matches = (t.matches ?? []).map((m: any) => ({ id: m.id, label: `${m.name || `${m.teamA?.name} vs ${m.teamB?.name}`}`, state: m.state }));
      // nothing picked in the panel: follow the newest match that isn't finished
      if (this.#auto) {
        const newest = [...this.#matches].reverse().find((m) => m.state !== "COMPLETE");
        if (newest && newest.id !== this.#matchId) this.#follow(newest.id);
      }
      const followed = (t.matches ?? []).find((m: any) => m.id === this.#matchId);
      const bracketId = followed?.bracketNode?.bracketId ?? t.brackets?.[0]?.id;
      if (bracketId) {
        const b = await this.#api(`/brackets/${bracketId}`);
        this.#bracket = this.#bracketData(b.bracket);
      }
      // the tournament answered: say so even before there is a match to follow (the match stream sets its own)
      if (!this.#matchId || /^tournament:|not connected/.test(this.#status)) {
        this.#status = this.#matchId ? "connecting…" : `connected to "${t.tournament?.name ?? this.#tournament}", no unfinished match to follow yet`;
      }
      this.#push();
    } catch (e) {
      this.#status = `tournament: ${(e as Error).message}`;
    }
  }

  /** A picture's address on the site: uploads are stored as a path ("/api/img/…"). */
  #abs(path: string | null | undefined): string {
    return !path ? "" : /^https?:\/\//i.test(path) ? path : path.startsWith("/") ? this.#url + path : "";
  }
  #teamInfo(team: Team): TeamInfo {
    const logoKind = !team.logo ? "star" : team.logo === "msu" ? "msu" : "image";
    return {
      name: team.name, logoKind, logo: logoKind === "image" ? this.#abs(team.logo) : "",
      replays: [...new Set(team.players.flatMap((p) => p.replays ?? []))],
    };
  }

  #follow(id: string) {
    this.#abort?.abort();
    this.#matchId = id;
    this.#match = this.#prev = null;
    this.#lastLive = null;
    this.#sendLive();
    this.#push();
    if (!id || !this.#key) return;
    const abort = this.#abort = new AbortController();
    (async () => {
      let wait = 1000;
      while (!abort.signal.aborted) {
        try {
          this.#status = "connecting…";
          const r = await fetch(`${this.#url}/api/v1/matches/${encodeURIComponent(id)}/events`, {
            headers: { authorization: `Bearer ${this.#key}`, accept: "text/event-stream" }, signal: abort.signal,
          });
          if (r.status === 404 && !this.#auto) {
            // the match is gone (deleted, or a fresh test database): go back to following the newest one
            this.#status = "followed match no longer exists, following the newest";
            this.#auto = true;
            this.#matchId = "";
            this.onFollow("");
            this.#refreshLists();
            return;
          }
          if (!r.ok || !r.body) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
          this.#status = "live";
          wait = 1000;
          const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += value;
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const ev = /^event: *(.*)$/m.exec(block)?.[1]?.trim();
              const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
              if (ev === "match" && data) this.#onMatch(JSON.parse(data).match ?? JSON.parse(data));
              if (ev === "live" && data) this.#onLive(JSON.parse(data));
            }
          }
          throw new Error("stream ended");
        } catch (e) {
          if (abort.signal.aborted) return;
          this.#status = `reconnecting (${(e as Error).message})`;
          await new Promise((res) => setTimeout(res, wait));
          wait = Math.min(15_000, wait * 2);
        }
      }
    })();
  }

  /**
   * Whether the match is over, and who won. The site says so once an organiser completes it; before that, a match
   * won on maps is over as soon as one side has the maps it needs (3-1 in a best of five: the tiebreaker is still
   * on the plan, but nobody will play it). A map that has been started in TA anyway is played: not over.
   */
  #over(m: Match): { over: boolean; winner: Side | null } {
    const sideOf = (teamId: string | null): Side | null => (teamId === m.teamA.id ? "a" : teamId === m.teamB.id ? "b" : null);
    if (m.state === "COMPLETE") return { over: true, winner: sideOf(m.winnerId) };
    if (m.format.winCondition === "AGGREGATE_MARGIN") return { over: false, winner: null };
    if (m.plannedMaps.find((p) => !p.scoresClosed)?.start?.requestedAt) return { over: false, winner: null };
    const picks = m.format.pickBanSequence.filter((s) => s.action === "PICK").length;
    const slots = picks + (m.format.tiebreaker && m.format.tiebreaker !== "NONE" ? 1 : 0);
    const need = Math.floor(slots / 2) + 1;
    const won = (teamId: string) => m.plannedMaps.filter((p) => p.scoresClosed && p.result.winnerId === teamId).length;
    const winner: Side | null = won(m.teamA.id) >= need ? "a" : won(m.teamB.id) >= need ? "b" : null;
    return { over: !!winner, winner };
  }

  // ---------------------------------------------------------------- events from match changes
  #onMatch(m: Match) {
    const prev = this.#prev;
    this.#match = m;
    const idx = (poolMapId: string) => m.pool.maps.findIndex((p) => p.poolMapId === poolMapId);
    const sideOf = (teamId: string | null): Side | undefined => (teamId === m.teamA.id ? "a" : teamId === m.teamB.id ? "b" : undefined);
    if (!prev) {
      if (!m.actions.length && m.state === "PICKBAN") this.#event({ name: "matchStart" });
    } else {
      for (const a of m.actions.slice(prev.actions.length)) {
        this.#event({ name: a.type === "PICK" ? "mapPick" : "mapBan", item: idx(a.poolMapId), side: sideOf(a.teamId) });
      }
      const picksLeft = (x: Match) => x.format.pickBanSequence.length - x.actions.length;
      if (picksLeft(prev) > 0 && picksLeft(m) <= 0) this.#event({ name: "picksDone" });
      for (const pm of m.plannedMaps) {
        const was = prev.plannedMaps.find((p) => p.matchMapId === pm.matchMapId);
        // TA says every player is done with the song (finished, failed or gone), before the referee closes the map
        const over = (p?: PlannedMap) => (p?.start?.status?.phase === "finished" ? p.start.requestedAt ?? "" : null);
        if (!pm.scoresClosed && over(pm) !== null && over(pm) !== over(was)) this.#event({ name: "songEnd" });
        if (pm.scoresClosed && !was?.scoresClosed) {
          this.#finishedUntil = Date.now() + RESULT_HOLD_MS;
          clearTimeout(this.#holdTimer);
          this.#holdTimer = setTimeout(() => this.#push(), RESULT_HOLD_MS + 50);
          this.#event({ name: "mapEnd", side: sideOf(pm.result.winnerId) });
        }
      }
      if (this.#over(m).over && !this.#over(prev).over) this.#event({ name: "matchEnd", side: this.#over(m).winner ?? undefined });
      // a map is up: the next one to play is known and nobody has a pick or ban to make first (the last pick of the
      // pick/ban phase, a pick made between maps, or the map before it closing with this one already picked)
      const upNext = (x: Match) => (!this.#over(x).over && !(x.pending && !x.pending.waitingForPoolMapId)
        ? x.plannedMaps.find((p) => !p.scoresClosed)?.matchMapId ?? null : null);
      if (upNext(m) && upNext(m) !== upNext(prev)) this.#event({ name: "mapNext" });
    }
    this.#prev = m;
    this.#sendLive();
    this.#push();
  }

  // ---------------------------------------------------------------- live play (TA mode)
  #onLive(l: LiveEvent) {
    if (!this.#match || l.matchId !== this.#match.id) return;
    for (const p of l.players ?? []) if (p.platformId) this.#platformIds.set(p.playerId, p.platformId);
    this.#lastLive = l;
    this.#sendLive();
  }

  /** The overlay's live state, from the next map's TA status and the newest live numbers; null = nothing live. */
  #liveState(): LiveState | null {
    const m = this.#match;
    if (!m?.taMode || this.#over(m).over) return null;
    const pm = m.plannedMaps.find((p) => !p.scoresClosed);
    const phase = pm?.start?.requestedAt ? pm.start.status?.phase : null;
    if (!pm || !phase) return null;
    const l = this.#lastLive?.matchMapId === pm.matchMapId ? this.#lastLive : null;
    const sides = (f: (playerId: string) => Partial<PlayerData>) => ({
      a: (pm.lineups[m.teamA.id] ?? []).map(f), b: (pm.lineups[m.teamB.id] ?? []).map(f),
    });
    const duration = Number(pm.map.duration) || 0;
    if (phase === "waiting" || phase === "loading" || phase === "ready") {
      return { matchId: m.id, phase: "loading", load: phase, time: 0, duration, players: sides(() => ({ acc: null, score: 0, combo: 0, misses: 0, finished: false })) };
    }
    if (phase !== "playing" || l?.phase === "over") return null;      // finished, error; or the song just ended
    const status = pm.start!.status!;
    const startedAt = l?.startedAt ?? (status.startedAt ? new Date(status.startedAt).getTime() : 0);
    return {
      matchId: m.id, phase: "playing", duration, startedAt: startedAt || undefined,
      time: l ? Math.max(0, ...l.players.map((p) => p.songPosition || 0)) : startedAt ? Math.max(0, (Date.now() - startedAt) / 1000) : 0,
      players: sides((id) => {
        const p = l?.players.find((x) => x.playerId === id);
        if (p) return { acc: p.accuracy, score: p.score, combo: p.combo, misses: p.misses, finished: !!p.finished };
        // before the first numbers (or a player the feed doesn't have): what the status knows
        const s = status.players?.find((x) => x.playerId === id);
        const done = s?.state === "finished" || s?.state === "failed" || s?.state === "quit";
        return { acc: done ? s?.accuracy ?? null : null, score: s?.score ?? 0, combo: 0, misses: 0, finished: !!done };
      }),
    };
  }
  #sendLive() {
    const l = this.#liveState();
    if (!l && !this.#liveOn) return;       // nothing of ours is out: leave a live state set by a tool alone
    this.#liveOn = !!l;
    this.#live(l);
  }

  // ---------------------------------------------------------------- the data contract
  #push() {
    const m = this.#match;
    if (!m) return this.#emit(this.#empty());
    const A = m.teamA, B = m.teamB;
    const sideOf = (teamId: string | null): Side | null => (teamId === A.id ? "a" : teamId === B.id ? "b" : null);
    const teamOf = (s: Side) => (s === "a" ? A : B);
    const nameOf = (s: Side | null) => (s ? teamOf(s).name : "");
    const perMap = Math.max(1, m.format.playersPerMap || 1);
    const picks = m.format.pickBanSequence.filter((s) => s.action === "PICK").length;
    const slots = picks + (m.format.tiebreaker && m.format.tiebreaker !== "NONE" ? 1 : 0);
    const need = Math.floor(slots / 2) + 1;
    const { over, winner } = this.#over(m);

    const current = over ? null : m.plannedMaps.find((p) => !p.scoresClosed) ?? null;
    const lastClosed = [...m.plannedMaps].reverse().find((p) => p.scoresClosed) ?? null;
    const waiting = m.pending?.waitingForPoolMapId ?? null;
    const phase: OverlayData["match"]["phase"] =
      over ? "done"
      : Date.now() < this.#finishedUntil && lastClosed ? "finished"
      : m.pending && !waiting ? "picks"
      : current ? "waiting"
      : "finished";

    const mapData = (p: PoolMap) => ({
      hash: p.hash ?? "", name: p.name, artist: p.artist ?? "", mapper: p.mapper ?? "", difficulty: p.difficultyLabel,
      category: p.category ?? (p.isTiebreaker ? "Tiebreaker" : ""), cover: p.coverImage ?? "", bpm: Math.round(p.bpm ?? 0),
      nps: 0, duration: p.duration, length: fmtTime(p.duration),
    });
    // a team's go on a map: the counted attempt (the best when a replay was called)
    const goOf = (pm: PlannedMap, s: Side) => {
      const goes = pm.goes[teamOf(s).id] ?? [];
      return goes.find((g) => g.counted) ?? goes.at(-1) ?? null;
    };
    const lineupMap = current ?? lastClosed;
    const playersOf = (s: Side): PlayerData[] => {
      const team = teamOf(s);
      const ids = lineupMap?.lineups[team.id] ?? [];
      const runs = lineupMap ? goOf(lineupMap, s)?.runs ?? [] : [];
      return ids.map((id) => {
        const p = team.players.find((x) => x.id === id);
        const run = runs.find((r) => r.playerId === id);
        return { name: p?.name ?? "?", avatar: this.#abs(p?.avatar), score: run?.score ?? 0, acc: run?.accuracy ?? null, combo: 0, misses: 0, finished: !!run };
      });
    };
    const side = (s: Side) => {
      const team = teamOf(s);
      const go = lineupMap ? goOf(lineupMap, s) : null;
      const other = lineupMap ? goOf(lineupMap, s === "a" ? "b" : "a") : null;
      return {
        ...blankSide(), ...this.#teamInfo(team), initials: team.name.slice(0, 1), points: m.scoreboard[s],
        avatar: perMap === 1 ? playersOf(s)[0]?.avatar ?? "" : "",
        players: playersOf(s), roster: team.players.map((p) => p.name),
        acc: go?.accEquivalent ?? null, matchPoints: go?.points ?? null, score: (go?.runs ?? []).reduce((t, r) => t + (r.score || 0), 0),
        finished: !!go?.complete, leading: (go?.accEquivalent ?? 0) > (other?.accEquivalent ?? 0), winner: winner === s,
      };
    };

    const planned = new Map(m.plannedMaps.map((p) => [p.poolMapId, p]));
    const acts = new Map(m.actions.map((a) => [a.poolMapId, a]));
    const pool: PoolItem[] = m.pool.maps.map((p) => {
      const act = acts.get(p.poolMapId), pm = planned.get(p.poolMapId);
      const state: PoolItem["state"] = pm && pm === current ? "current" : pm?.scoresClosed ? "played"
        : act?.type === "BAN" ? "banned" : act?.type === "PICK" ? "picked" : p.isTiebreaker ? "tiebreaker" : "available";
      const by = sideOf(act?.teamId ?? pm?.pickedByTeamId ?? null);
      const w = pm?.scoresClosed ? sideOf(pm.result.winnerId) : null;
      return { ...mapData(p), state, by, byName: nameOf(by), order: pm?.order ?? null, winner: w, winnerName: nameOf(w) };
    });

    const results: ResultItem[] = m.plannedMaps.filter((p) => p.scoresClosed).map((p, n) => {
      const res = (s: Side) => {
        const g = goOf(p, s);
        return { acc: g?.accEquivalent ?? 0, score: (g?.runs ?? []).reduce((t, r) => t + (r.score || 0), 0), misses: 0 };
      };
      const w = sideOf(p.result.winnerId);
      return { index: n + 1, map: mapData(p.map), winner: w, winnerName: nameOf(w), pickedBy: sideOf(p.pickedByTeamId), a: res("a"), b: res("b") };
    });

    const coin = m.coinFlipWinnerId;
    const actorSide = (actor: "COIN_WINNER" | "COIN_LOSER"): Side => {
      const winnerSide = sideOf(coin) ?? "a";
      return actor === "COIN_WINNER" ? winnerSide : winnerSide === "a" ? "b" : "a";
    };
    const steps = m.format.pickBanSequence.map((s, i) => {
      const by = actorSide(s.actor);
      return { type: s.action === "PICK" ? "pick" as const : "ban" as const, by, byName: nameOf(by), done: i < m.actions.length, current: !!m.pending && !waiting && i === m.pending.seq };
    });
    const nextSide = m.pending && !waiting ? sideOf(m.pending.teamId) : null;

    const mapSlots: MapSlot[] = Array.from({ length: slots }, (_, i) => {
      const p = m.plannedMaps.find((x) => x.order === i + 1);
      const tb = i === slots - 1 && slots > picks;
      return {
        number: i + 1, label: tb ? "TB" : `MAP ${i + 1}`, tiebreaker: tb,
        state: p?.scoresClosed ? "played" : p && p === current ? "current" : over ? "unneeded" : "upcoming",
        name: p?.map.name ?? "", winner: p?.scoresClosed ? sideOf(p.result.winnerId) : null, winnerName: nameOf(p?.scoresClosed ? sideOf(p.result.winnerId) : null),
      };
    });

    const shown = current ?? (phase === "finished" ? lastClosed : null);
    const a = side("a"), b = side("b");
    const diff = (a.acc ?? 0) - (b.acc ?? 0);
    this.#emit({
      tournament: { name: m.tournament.name, short: "", round: m.name },
      match: {
        label: m.name, bestOf: slots, need, phase,
        mapNumber: Math.min(slots, m.plannedMaps.filter((p) => p.scoresClosed).length + (current ? 1 : 0)) || 1, load: "",
        winner, winnerName: nameOf(winner), maps: mapSlots, playersPerMap: perMap, solo: perMap === 1,
        scoring: m.scoring?.mode === "MATCH_POINTS" ? "points" : "accuracy",
        curve: m.scoring?.mode === "MATCH_POINTS" ? m.scoring.curve ?? null : null,
        perfectAcc: (current ?? lastClosed)?.map.perfectAcc ?? null,
      },
      a, b, diff,
      tug: 0.5 + Math.max(-1, Math.min(1, diff / 0.02)) / 2,
      map: shown ? {
        ...mapData(shown.map), progress: shown.scoresClosed ? 1 : 0, time: fmtTime(0),
        pickedBy: sideOf(shown.pickedByTeamId), pickedByName: nameOf(sideOf(shown.pickedByTeamId)), tiebreaker: !!shown.isTiebreaker,
      } : null,
      pool,
      picks: {
        next: nextSide && m.pending ? { type: m.pending.type === "PICK" ? "pick" : "ban", verb: m.pending.type === "PICK" ? "picking" : "banning", by: nextSide, byName: nameOf(nextSide) } : null,
        done: m.actions.length >= m.format.pickBanSequence.length,
        steps,
      },
      results,
      last: results.at(-1) ?? null,
      upNext: this.#matches.filter((x) => x.state === "PICKBAN" && x.id !== m.id).slice(0, 3).map((x) => ({ label: x.label, a: "", b: "" })),
      bracket: this.#bracket,
      teams: this.#teams,
      taLive: m.taMode && m.ta && current ? { relay: `${m.ta.host}:${m.ta.port}`, players: this.#taPlayers(m, current, perMap) } : null,
    });
  }

  /** Video hole -> TA platform id, for the players in the next map's lineups ("a"/"b" in a 1v1, else "a1", "a2", …). */
  #taPlayers(m: Match, pm: PlannedMap, perMap: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [side, team] of [["a", m.teamA], ["b", m.teamB]] as const) {
      (pm.lineups[team.id] ?? []).forEach((id, i) => {
        const p = team.players.find((x) => x.id === id);
        const platformId = this.#platformIds.get(id) ?? p?.taPlatformId ?? p?.beatLeaderId ?? "";
        if (platformId) out[perMap === 1 ? side : `${side}${i + 1}`] = String(platformId);
      });
    }
    return out;
  }

  #empty(): OverlayData {
    return {
      tournament: { name: "", short: "", round: "" },
      match: { label: "", bestOf: 0, need: 0, phase: "idle", mapNumber: 1, load: "", winner: null, winnerName: "", maps: [], playersPerMap: 1, solo: true },
      a: blankSide(), b: blankSide(), diff: 0, tug: 0.5, map: null, pool: [],
      picks: { next: null, done: false, steps: [] }, results: [], last: null, upNext: [], bracket: this.#bracket, teams: this.#teams,
    };
  }

  /** BSCompStats bracket slots -> rounds of match boxes (winners, losers and grand final for double elimination). */
  #bracketData(b: { name: string; format?: string; slots: Slot[] } | null): BracketData | null {
    if (!b) return null;
    const box = (s: Slot) => ({
      a: s.teamA?.name ?? "TBD", b: s.teamB?.name ?? "TBD",
      aScore: s.match ? s.match.a : null, bScore: s.match ? s.match.b : null,
      winner: !s.winnerId ? null : s.winnerId === s.teamA?.id ? "a" as const : s.winnerId === s.teamB?.id ? "b" as const : null,
      state: s.winnerId || s.match?.state === "COMPLETE" ? "done" as const : s.match ? "live" as const : "upcoming" as const,
      current: !!s.match && s.match.id === this.#matchId,
    });
    const slots = b.slots.filter((s) => !s.passThrough);
    /** One section's rounds, named by how far from its end they are ("Winners Final", "Losers Round 1", …). */
    const rounds = (section: string, names: (fromEnd: number, i: number) => string) => {
      const inSection = slots.filter((s) => s.section === section);
      const nums = [...new Set(inSection.map((s) => s.round))].sort((x, y) => x - y);
      return nums.map((r, i) => ({
        name: names(nums.length - 1 - i, i),
        matches: inSection.filter((s) => s.round === r).sort((x, y) => x.position - y.position).map(box),
      }));
    };
    const final = slots.filter((s) => s.section === "GF").sort((x, y) => x.round - y.round || x.position - y.position).map(box);
    const double = b.format === "DOUBLE_ELIM" || slots.some((s) => s.section === "L");
    if (!double) {
      const main = rounds("W", (e, i) => (e === 0 ? "Final" : e === 1 ? "Semifinals" : e === 2 ? "Quarterfinals" : `Round ${i + 1}`));
      if (final.length) main.push({ name: "Final", matches: final });
      return { name: b.name, double, rounds: main, winners: main, losers: [], final };
    }
    const winners = rounds("W", (e, i) => (e === 0 ? "Winners Final" : e === 1 ? "Winners Semifinals" : `Winners Round ${i + 1}`));
    const losers = rounds("L", (e, i) => (e === 0 ? "Losers Final" : `Losers Round ${i + 1}`));
    return { name: b.name, double, rounds: [...winners, { name: "Grand Final", matches: final }], winners, losers, final };
  }
}
