// Simulated match source: plays a Bo5 the way a BeatKhana match runs (picks & bans, then per map:
// players chosen -> map loads -> live scores -> results), so scenes can be designed without a tournament.
// Controls (panel "Simulator" box): reset, next (one step), auto (run it all), speed.
import { TUG_FULL, blankSide, type BracketData, type DataSource, type EventMsg, fmtTime, type MapData, type MapSlot, type OverlayData, type PoolItem, type ResultItem, type Side } from "../model.ts";

/** `sim:` in overlay.yaml renames the simulated match, so previews look like your event. */
export interface SimOptions {
  tournament?: string; short?: string; round?: string; a?: string; b?: string;
  players?: number;                  // players per map: 1 = 1v1 (the default), 2 = duos, …
  rosterA?: string[]; rosterB?: string[];
  maps?: number;                     // pool size (7 by default). 11 = a finals pool: 6 picks, 4 bans, best of 7
}

interface Live { score: number; acc: number; combo: number; maxCombo: number; misses: number; health: number; pos: number; skill: number; finished: boolean }

/** A placeholder player picture (the simulator has no real ones): the initial on a coloured disc. */
const avatar = (name: string) => {
  const hue = [...name].reduce((t, c) => (t * 31 + c.charCodeAt(0)) % 360, 7);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="hsl(${hue} 45% 32%)"/>` +
    `<circle cx="48" cy="38" r="17" fill="hsl(${hue} 50% 78%)"/><path d="M12 96c2-24 18-34 36-34s34 10 36 34z" fill="hsl(${hue} 50% 78%)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

const ORDER_7: { type: "pick" | "ban"; by: Side }[] = [
  { type: "ban", by: "a" }, { type: "ban", by: "b" }, { type: "pick", by: "a" }, { type: "pick", by: "b" },
  { type: "pick", by: "a" }, { type: "pick", by: "b" },
];
// a bigger (finals) pool: 6 picks and 4 bans, the map left over is the tiebreaker
const ORDER_11: typeof ORDER_7 = [
  { type: "pick", by: "a" }, { type: "pick", by: "b" }, { type: "ban", by: "b" }, { type: "ban", by: "a" }, { type: "pick", by: "b" },
  { type: "pick", by: "a" }, { type: "ban", by: "a" }, { type: "ban", by: "b" }, { type: "pick", by: "a" }, { type: "pick", by: "b" },
];
const TYPES = ["True Acc", "Tech Acc", "Standard Acc", "Midspeed", "Tech", "Low Tech", "Speed", "Speed Tech", "Extreme", "Burst", "Stamina"];


export class SimSource implements DataSource {
  readonly name = "sim";
  #emit: (d: OverlayData) => void = () => {};
  #event: (e: EventMsg) => void = () => {};
  #pool: (MapData & { tiebreaker: boolean })[] = [];
  #players = { a: { name: "Nova", country: "US", seed: 1 }, b: { name: "Kestrel", country: "DE", seed: 4 } };
  #names = { tournament: "Saber Showdown Invitational", short: "SSI", round: "Quarterfinal 1" };
  #perMap = 1;
  #maps = 0;
  #order = ORDER_7;
  get #slots() { return this.#order.filter((s) => s.type === "pick").length + 1; }   // picked maps + the tiebreaker
  get #need() { return Math.floor(this.#slots / 2) + 1; }
  #roster: Record<Side, string[]> = { a: ["Nova"], b: ["Kestrel"] };
  #lineup: Record<Side, string[]> = { a: ["Nova"], b: ["Kestrel"] };
  #phase: OverlayData["match"]["phase"] = "idle";
  #picks: { type: "pick" | "ban"; by: Side; index: number }[] = [];
  #played: { index: number; winner: Side | null; a: Live; b: Live }[] = [];
  #current: number | null = null;
  #live: Record<Side, Live[]> = { a: [this.#fresh("a")], b: [this.#fresh("b")] };
  #timer?: ReturnType<typeof setInterval>;
  #autoTimer?: ReturnType<typeof setTimeout>;
  #auto = false;
  /** Numbers pinned from outside while a map plays (the "hold" control): to look at a design at any lead. */
  #hold: { a?: number | number[]; b?: number | number[]; misses?: { a?: number; b?: number } } | null = null;
  speed = 4;

  constructor(private poolFile: URL, opts: SimOptions = {}) {
    if (opts.a) this.#players.a.name = opts.a;
    if (opts.b) this.#players.b.name = opts.b;
    this.#maps = Math.round(opts.maps ?? 0);
    this.#perMap = Math.max(1, Math.min(4, Math.round(opts.players ?? 1)));
    const roster = (side: Side, given?: string[]) => {
      if (given?.length) return given;
      if (this.#perMap === 1) return [this.#players[side].name];
      return side === "a" ? ["Erin", "Trey", "Mia", "Will"] : ["Kaiden", "Kadence", "Alex", "Wyatt"];
    };
    this.#roster = { a: roster("a", opts.rosterA), b: roster("b", opts.rosterB) };
    this.#pickLineups(0);
    this.#names = { tournament: opts.tournament ?? this.#names.tournament, short: opts.short ?? this.#names.short, round: opts.round ?? this.#names.round };
  }

  async start(emit: (d: OverlayData) => void, event: (e: EventMsg) => void) {
    this.#emit = emit;
    this.#event = event;
    let raw = JSON.parse(await Deno.readTextFile(this.poolFile));
    // maps: N with a shorter pool file: the file's maps again (with other types), so a big pool can be previewed
    if (this.#maps > 0) raw = Array.from({ length: this.#maps }, (_, i) => i < raw.length ? raw[i] : { ...raw[i % raw.length], category: TYPES[i % TYPES.length] });
    if (raw.length >= 11) this.#order = ORDER_11;
    this.#pool = raw.map((m: any, i: number) => ({
      hash: m.hash, name: m.name, artist: m.artist, mapper: m.mapper, difficulty: m.difficulty, category: m.category,
      cover: m.cover, bpm: Math.round(m.bpm), nps: Math.round(m.nps * 10) / 10, duration: Math.round(m.duration),
      length: fmtTime(m.duration), tiebreaker: i === raw.length - 1,
    }));
    this.#push();
  }
  async stop() { clearInterval(this.#timer); clearTimeout(this.#autoTimer); }
  status() { return `Simulator · ${this.#phase}${this.#auto ? " · auto" : ""} · ${this.speed}× speed`; }

  #fresh(side: Side): Live {
    const skill = (side === "a" ? 0.968 : 0.965) + (Math.random() - 0.5) * 0.008;
    return { score: 0, acc: 0.96, combo: 0, maxCombo: 0, misses: 0, health: 0.5, pos: 0, skill, finished: false };
  }
  /** Who plays map n (0-based): rotate through each roster. */
  #pickLineups(n: number) {
    for (const s of ["a", "b"] as Side[]) {
      const r = this.#roster[s];
      this.#lineup[s] = Array.from({ length: Math.min(this.#perMap, r.length) }, (_, i) => r[(n * this.#perMap + i) % r.length]);
    }
    this.#live = { a: this.#lineup.a.map(() => this.#fresh("a")), b: this.#lineup.b.map(() => this.#fresh("b")) };
  }
  /** A side's numbers: the lineup together (average accuracy, total score and misses). */
  #agg(side: Side): Live {
    const ls = this.#live[side];
    const sum = (f: (l: Live) => number) => ls.reduce((t, l) => t + f(l), 0);
    return {
      score: sum((l) => l.score), acc: sum((l) => l.acc) / ls.length, combo: Math.min(...ls.map((l) => l.combo)),
      maxCombo: Math.max(...ls.map((l) => l.maxCombo)), misses: sum((l) => l.misses), health: sum((l) => l.health) / ls.length,
      pos: ls[0].pos, skill: 0, finished: ls.every((l) => l.finished),
    };
  }
  #playOrder() {
    return [...this.#picks.filter((p) => p.type === "pick").map((p) => p.index), this.#pool.findIndex((m) => m.tiebreaker)];
  }
  #points() {
    const p = { a: 0, b: 0 };
    for (const x of this.#played) if (x.winner) p[x.winner]++;
    return p;
  }

  // ---------------------------------------------------------------- controls
  control(action: string, args: Record<string, unknown>) {
    if (action === "reset") return this.#reset();
    if (action === "next") return this.#next();
    // hold: { a: 0.97, b: [0.99, 0.4], misses: { a: 120 } } pins those numbers while a map plays; hold with nothing lets go
    if (action === "hold") {
      const acc = (x: unknown) => (typeof x === "number" || (Array.isArray(x) && x.every((v) => typeof v === "number")) ? x as number | number[] : undefined);
      const m = args.misses as { a?: unknown; b?: unknown } | undefined;
      const hold = { a: acc(args.a), b: acc(args.b), misses: m ? { a: typeof m.a === "number" ? m.a : undefined, b: typeof m.b === "number" ? m.b : undefined } : undefined };
      this.#hold = hold.a === undefined && hold.b === undefined && !hold.misses ? null : hold;
      this.#applyHold();
      return this.#push();
    }
    if (action === "speed") { this.speed = Math.max(1, Math.min(30, Number(args.value) || 4)); return this.#push(); }
    if (action === "auto") {
      this.#auto = args.on === undefined ? !this.#auto : !!args.on;
      if (this.#auto) this.#autoStep();
      else clearTimeout(this.#autoTimer);
      return this.#push();
    }
  }

  #reset() {
    clearInterval(this.#timer);
    clearTimeout(this.#autoTimer);
    this.#auto = false;
    this.#phase = "idle";
    this.#picks = [];
    this.#played = [];
    this.#current = null;
    this.#pickLineups(0);
    this.#push();
  }

  /** One step of the match, in the order it happens on match day. */
  #next() {
    const pts = this.#points();
    if (this.#phase === "done") return;
    if (this.#phase === "idle") { this.#phase = "picks"; this.#event({ name: "matchStart" }); return this.#push(); }
    if (this.#phase === "picks") {
      const step = this.#order[this.#picks.length];
      if (!step) { this.#phase = "waiting"; this.#event({ name: "picksDone" }); this.#event({ name: "mapNext", why: "pick" }); return this.#push(); }
      const used = new Set(this.#picks.map((p) => p.index));
      const free = this.#pool.map((m, i) => ({ m, i })).filter((x) => !x.m.tiebreaker && !used.has(x.i));
      const pick = free[Math.floor(Math.random() * free.length)];
      this.#picks.push({ ...step, index: pick.i });
      this.#event({ name: step.type === "pick" ? "mapPick" : "mapBan", item: pick.i, side: step.by });
      if (this.#picks.length === this.#order.length) { this.#phase = "waiting"; this.#event({ name: "picksDone" }); this.#event({ name: "mapNext", why: "pick" }); }
      return this.#push();
    }
    if (this.#phase === "waiting" || this.#phase === "finished") {
      if (pts.a >= this.#need || pts.b >= this.#need) return;
      const done = new Set(this.#played.map((p) => p.index));
      this.#current = this.#playOrder().find((i) => !done.has(i)) ?? null;
      if (this.#current === null) return;
      this.#pickLineups(this.#played.length);
      this.#phase = "loading";
      this.#event({ name: "mapLoad" });
      return this.#push();
    }
    if (this.#phase === "loading") { this.#phase = "playing"; this.#songStart = Date.now(); this.#event({ name: "mapStart" }); this.#play(); return this.#push(); }
    if (this.#phase === "playing") { this.#finish(); }
  }

  #autoStep() {
    if (!this.#auto) return;
    const wait = { idle: 1500, picks: 1600, waiting: 2500, loading: 2000, playing: 0, finished: 9000, done: 0 }[this.#phase];
    if (this.#phase === "done") { this.#auto = false; return this.#push(); }
    if (this.#phase === "playing") { this.#autoTimer = setTimeout(() => this.#autoStep(), 500); return; }
    this.#autoTimer = setTimeout(() => { this.#next(); this.#autoStep(); }, wait);
  }

  #songStart = 0;                          // when the song being played started: no two songs share it
  // who is in the song right now, and who could be (for the bot that deafens players: see DataSource)
  playing() {
    if (this.#phase !== "playing" || this.#current === null) return null;
    const left = (this.#pool[this.#current].duration - this.#live.a[0].pos) / this.speed;
    return { run: `sim:${this.#songStart}`, until: Date.now() + left * 1000 + 15_000, players: [...this.#lineup.a, ...this.#lineup.b] };
  }
  roster() {
    return (["a", "b"] as const).flatMap((s) => this.#roster[s].map((name) => ({ id: name, name, team: this.#players[s].name, discordId: null })));
  }

  #play() {
    const map = this.#pool[this.#current!], tick = 0.1;
    clearInterval(this.#timer);
    this.#timer = setInterval(() => {
      for (const l of [...this.#live.a, ...this.#live.b]) {
        l.pos = Math.min(map.duration, l.pos + tick * this.speed);
        l.acc += (l.skill - l.acc) * 0.05 + (Math.random() - 0.5) * 0.004;
        if (Math.random() < 0.0012 * this.speed) { l.misses++; l.combo = 0; l.health = Math.max(0.1, l.health - 0.15); }
        else { l.combo += Math.max(1, Math.round(map.nps * tick * this.speed)); l.health = Math.min(1, l.health + 0.01); }
        l.maxCombo = Math.max(l.maxCombo, l.combo);
        l.score = Math.round(map.nps * map.duration * 115 * 7.6 * (l.pos / map.duration) * l.acc);
      }
      this.#applyHold();
      if (this.#live.a[0].pos >= map.duration) this.#finish();
      else this.#push();
    }, tick * 1000);
  }

  /** Pinned accuracies (one for the side, or one per player) and misses (the side's total, on its first player). */
  #applyHold() {
    const h = this.#hold;
    if (!h) return;
    for (const s of ["a", "b"] as Side[]) {
      const acc = h[s];
      this.#live[s].forEach((l, i) => {
        if (acc !== undefined) l.acc = Math.max(0, Math.min(1, Array.isArray(acc) ? acc[i % acc.length] : acc));
        if (h.misses?.[s] !== undefined) l.misses = i === 0 ? Math.max(0, Math.round(h.misses[s]!)) : 0;
      });
    }
  }

  #finish() {
    clearInterval(this.#timer);
    for (const l of [...this.#live.a, ...this.#live.b]) l.finished = true;
    const a = this.#agg("a"), b = this.#agg("b");
    const winner: Side | null = a.score === b.score ? null : a.score > b.score ? "a" : "b";
    this.#played.push({ index: this.#current!, winner, a: { ...a }, b: { ...b } });
    const pts = this.#points();
    this.#phase = pts.a >= this.#need || pts.b >= this.#need ? "done" : "finished";
    this.#event({ name: "mapEnd", side: winner ?? undefined });
    if (this.#phase === "done") this.#event({ name: "matchEnd", side: pts.a >= this.#need ? "a" : "b" });
    // every map was picked before the first was played: the next one is already known, as on the site
    else this.#event({ name: "mapNext", why: "result" });
    this.#push();
  }

  // ---------------------------------------------------------------- data contract
  #push() {
    const pts = this.#points();
    const P = this.#players;
    const name = (s: Side | null) => (s ? P[s].name : "");
    const matchWinner: Side | null = pts.a >= this.#need ? "a" : pts.b >= this.#need ? "b" : null;
    const playing = this.#phase === "playing" || this.#phase === "finished";
    const side = (s: Side) => {
      const l = this.#agg(s), o = this.#agg(s === "a" ? "b" : "a");
      const players = this.#lineup[s].map((name, i) => {
        const p = this.#live[s][i];
        return { name, avatar: avatar(name), score: playing ? p.score : 0, acc: playing ? p.acc : null, combo: playing ? p.combo : 0, misses: playing ? p.misses : 0, finished: playing && p.finished };
      });
      return {
        ...blankSide(), logoKind: s === "a" ? "msu" as const : "star" as const, avatar: this.#perMap === 1 ? avatar(P[s].name) : "", name: P[s].name, players, roster: this.#roster[s], initials: P[s].name.slice(0, 1), country: P[s].country, seed: P[s].seed, points: pts[s],
        ...(playing ? { score: l.score, acc: l.acc, combo: l.combo, maxCombo: l.maxCombo, misses: l.misses, health: l.health } : {}),
        finished: playing && l.finished, leading: playing && l.score > o.score, winner: matchWinner === s,
      };
    };
    const order = this.#playOrder();
    const pool: PoolItem[] = this.#pool.map((m, i) => {
      const act = this.#picks.find((p) => p.index === i);
      const played = this.#played.find((p) => p.index === i);
      const current = this.#current === i && (this.#phase === "loading" || this.#phase === "playing");
      return {
        ...m,
        state: current ? "current" : played ? "played" : act?.type === "ban" ? "banned" : act ? "picked" : m.tiebreaker ? "tiebreaker" : "available",
        by: act?.by ?? null, byName: name(act?.by ?? null),
        order: act?.type === "pick" || m.tiebreaker ? order.indexOf(i) + 1 || null : null,
        winner: played?.winner ?? null, winnerName: name(played?.winner ?? null),
      };
    });
    const results: ResultItem[] = this.#played.map((p, n) => ({
      index: n + 1, map: this.#pool[p.index], winner: p.winner, winnerName: name(p.winner),
      pickedBy: this.#picks.find((x) => x.index === p.index)?.by ?? null,
      a: { acc: p.a.acc, score: p.a.score, misses: p.a.misses }, b: { acc: p.b.acc, score: p.b.score, misses: p.b.misses },
    }));
    const nextIdx = this.#current ?? order.find((i) => !this.#played.some((p) => p.index === i));
    const curMap = nextIdx !== undefined && nextIdx >= 0 && (this.#phase !== "picks" && this.#phase !== "idle") ? this.#pool[nextIdx] : null;
    const diff = playing ? this.#agg("a").acc - this.#agg("b").acc : 0;
    const step = this.#phase === "picks" ? this.#order[this.#picks.length] : null;
    this.#emit({
      tournament: { name: this.#names.tournament, short: this.#names.short, round: this.#names.round },
      match: {
        label: this.#names.round, bestOf: this.#slots, need: this.#need, phase: this.#phase,
        playersPerMap: this.#perMap, solo: this.#perMap === 1, load: this.#phase === "loading" ? "loading" : "",
        mapNumber: this.#played.length + (this.#phase === "finished" || this.#phase === "done" ? 0 : 1),
        winner: matchWinner, winnerName: name(matchWinner),
        maps: Array.from({ length: this.#slots }, (_, i): MapSlot => {
          const p = this.#played[i];
          const idx = p?.index ?? order.filter((x) => !this.#played.some((q) => q.index === x))[i - this.#played.length];
          const live = i === this.#played.length && (this.#phase === "loading" || this.#phase === "playing");
          return {
            number: i + 1, label: i === this.#slots - 1 ? "TB" : `MAP ${i + 1}`, tiebreaker: i === this.#slots - 1,
            state: p ? "played" : live ? "current" : matchWinner ? "unneeded" : "upcoming",
            name: idx !== undefined && idx >= 0 && this.#picks.length ? this.#pool[idx]?.name ?? "" : "",
            winner: p?.winner ?? null, winnerName: name(p?.winner ?? null),
          };
        }),
      },
      a: side("a"), b: side("b"), diff,
      tug: 0.5 + Math.max(-1, Math.min(1, diff / TUG_FULL)) / 2,
      map: curMap ? {
        ...curMap,
        progress: playing ? Math.min(1, this.#live.a[0].pos / curMap.duration) : 0,
        time: fmtTime(playing ? this.#live.a[0].pos : 0),
        pickedBy: this.#picks.find((p) => p.type === "pick" && this.#pool[p.index] === curMap)?.by ?? null,
        pickedByName: name(this.#picks.find((p) => p.type === "pick" && this.#pool[p.index] === curMap)?.by ?? null),
        tiebreaker: curMap.tiebreaker,
      } : null,
      pool,
      picks: {
        next: step ? { ...step, verb: step.type === "ban" ? "banning" : "picking", byName: name(step.by) } : null,
        done: this.#picks.length >= this.#order.length,
        steps: this.#order.map((s, i) => ({ ...s, byName: name(s.by), done: i < this.#picks.length, current: this.#phase === "picks" && i === this.#picks.length })),
      },
      results,
      last: results.at(-1) ?? null,
      upNext: [{ label: "Quarterfinal 2", a: "Aster", b: "Lumen" }, { label: "Quarterfinal 3", a: "Orbit", b: "Vesper" }],
      bracket: this.#bracket(pts, matchWinner),
    });
  }

  /** A made-up 4-team double-elimination bracket (MSU's format) with this match as winners semifinal 1. */
  #bracket(pts: { a: number; b: number }, winner: Side | null): BracketData {
    const A = this.#players.a.name, B = this.#players.b.name;
    const m = (a: string, b: string, aScore: number | null = null, bScore: number | null = null) => ({
      a, b, aScore, bScore, winner: aScore === null || bScore === null || aScore === bScore ? null : aScore > bScore ? "a" as const : "b" as const,
      state: aScore === null ? "upcoming" as const : "done" as const, current: false,
    });
    const live = this.#phase !== "idle";
    const ws1 = { ...m(A, B), aScore: live ? pts.a : null, bScore: live ? pts.b : null, winner, state: winner ? "done" as const : live ? "live" as const : "upcoming" as const, current: true };
    const won = winner ? (winner === "a" ? A : B) : "TBD", lost = winner ? (winner === "a" ? B : A) : "TBD";
    const winners = [
      { name: "Winners Semifinals", matches: [ws1, m("Cowbell", "Bulldogs", 3, 1)] },
      { name: "Winners Final", matches: [m(won, "Cowbell")] },
    ];
    const losers = [
      { name: "Losers Round 1", matches: [m(lost, "Bulldogs")] },
      { name: "Losers Final", matches: [m("TBD", "TBD")] },
    ];
    const final = [m("TBD", "TBD")];
    return { name: "Playoffs", double: true, rounds: [...winners, { name: "Grand Final", matches: final }], winners, losers, final };
  }
}
