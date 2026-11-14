// The playlist's rules for whose replay plays, and which have had their turn.   deno test server/playlist.test.ts
import { PlaylistControl, emptyPlaylist } from "./playlist.ts";
import type { PlaylistItem } from "./model.ts";

// no lookups: every replay is 100 s long, known from the start
globalThis.fetch = () => Promise.resolve(new Response("{}", { status: 404 }));
const assert = (ok: unknown, what: string) => { if (!ok) throw new Error(what); };
const INFO = { source: "beatleader", song: "s", duration: 100 } as unknown as PlaylistItem["info"];

const TEAMS = [
  { name: "Alpha", replays: ["a1-x", "a1-y", "a2-x"], players: [{ name: "Ann", replays: ["a1-x", "a1-y"] }, { name: "Abe", replays: ["a2-x"] }] },
  { name: "Bravo", replays: ["b1-x", "b2-x"], players: [{ name: "Bea", replays: ["b1-x"] }, { name: "Bob", replays: ["b2-x"] }] },
  { name: "Charlie", replays: ["c1-x", "c1-y"], players: [{ name: "Cy", replays: ["c1-x", "c1-y"] }], out: true },
  { name: "Delta", replays: [], players: [] },
];
function make(own = ["caster-1", "caster-2"]) {
  const pc = new PlaylistControl(emptyPlaylist(), () => {});
  pc.add(own);
  pc.setTeams(TEAMS, null, false);
  for (const it of pc.p.items) it.info = INFO;
  return pc;
}
const cur = (pc: PlaylistControl) => pc.p.items.find((x) => x.id === pc.p.current?.id)!;
/** The current replay has been playing for `s` seconds. */
const playFor = (pc: PlaylistControl, s: number) => { pc.p.current!.duration = 100; pc.p.current!.startAt = Date.now() - s * 1000; pc.p.current!.pausedAt = null; };
const MIX = ["caster-1", "caster-2", "a1-x", "a1-y", "a2-x", "b1-x", "b2-x"];

Deno.test("the break mix is the panel's own replays and those of every team still in", () => {
  const pc = make();
  assert(pc.p.scope?.kind === "mix", `kind ${pc.p.scope?.kind}`);
  assert(JSON.stringify(pc.p.scope?.out) === '["Charlie"]', `out ${JSON.stringify(pc.p.scope?.out)}`);
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) { pc.next(); seen.add(cur(pc).ref); playFor(pc, 100); }
  assert([...seen].sort().join() === [...MIX].sort().join(), `played ${[...seen].sort()}`);
});

Deno.test("each replay has its turn before any has a second, then they all start over, never the same one twice running", () => {
  const pc = make();
  pc.next();
  for (let round = 0; round < 5; round++) {
    const order: string[] = [];
    for (let i = 0; i < MIX.length; i++) { order.push(cur(pc).ref); playFor(pc, 100); const was = cur(pc).ref; pc.next(); assert(cur(pc).ref !== was, "same replay twice running"); }
    assert(new Set(order).size === MIX.length, `round ${round}: a repeat before everything had a turn: ${order}`);
  }
});

Deno.test("a replay cut short keeps its turn; one played half way or more has had it", () => {
  const pc = make();
  pc.next(); const first = cur(pc); playFor(pc, 30); pc.next();
  assert(!pc.p.played!.includes(first.id), "30 of 100 s counted as played");
  const second = cur(pc); playFor(pc, 55); pc.next();
  assert(pc.p.played!.includes(second.id), "55 of 100 s did not count");
});

Deno.test("Getting Ready plays someone about to play, at once, and that never counts as a turn", () => {
  const pc = make();
  pc.next(); const inBreak = cur(pc); playFor(pc, 20);
  pc.setTeams(TEAMS, { teams: ["Alpha", "Bravo"], players: ["Abe", "Bea"] }, true);
  assert(pc.p.scope?.kind === "lineup", `kind ${pc.p.scope?.kind}`);
  assert(["a2-x", "b1-x"].includes(cur(pc).ref), `on Getting Ready: ${cur(pc).ref}`);
  assert(pc.p.current!.passing === true, "not marked as a glimpse");
  assert(!pc.p.played!.includes(inBreak.id), "the break's replay, cut at 20 s, counted");
  const glimpse = cur(pc); playFor(pc, 90);
  for (let i = 0; i < 6; i++) { pc.next(); assert(["a2-x", "b1-x"].includes(cur(pc).ref), "left the lineup"); playFor(pc, 90); }
  assert(!pc.p.played!.includes(glimpse.id) && pc.p.played!.length === 0, `glimpses counted: ${pc.p.played}`);
  // the match starts (no replay scene), then a break: a fresh replay from the mix, not the rest of the glimpse
  pc.setTeams(TEAMS, null, false);
  assert(pc.p.scope?.kind === "mix" && !pc.p.current!.passing, "back in the mix");
  assert(pc.p.played!.length === 0, "leaving Getting Ready counted the glimpse");
});

Deno.test("a lineup with no replays of its own: their teams'; teams with none: the mix goes on", () => {
  const pc = make();
  pc.setTeams(TEAMS, { teams: ["Alpha", "Bravo"], players: ["Nobody", "Else"] }, true);
  assert(pc.p.scope?.kind === "teams", `kind ${pc.p.scope?.kind}`);
  assert(["a1-x", "a1-y", "a2-x", "b1-x", "b2-x"].includes(cur(pc)?.ref ?? pc.p.items.find((x) => x.team === "Alpha")!.ref), "not theirs");
  pc.setTeams(TEAMS, { teams: ["Delta", "Echo"], players: ["Dee"] }, true);
  assert(pc.p.scope?.kind === "mix", `kind ${pc.p.scope?.kind}`);
});

Deno.test("a team that is knocked out leaves the mix; when it is back in (a result undone) it returns", () => {
  const pc = make();
  const without = TEAMS.map((t) => (t.name === "Bravo" ? { ...t, out: true } : t));
  pc.setTeams(without, null, false);
  for (let i = 0; i < 100; i++) { pc.next(); assert(cur(pc).team !== "Bravo" && cur(pc).team !== "Charlie", `knocked-out team played: ${cur(pc).ref}`); playFor(pc, 100); }
  pc.setTeams(TEAMS, null, false);
  const seen = new Set<string>(); for (let i = 0; i < 100; i++) { pc.next(); seen.add(cur(pc).ref); playFor(pc, 100); }
  assert(seen.has("b1-x") && seen.has("b2-x"), "did not return");
});

Deno.test("everyone out: your own list; that empty too: every team's; players' replays switched off: only your own, in its order", () => {
  const allOut = TEAMS.map((t) => ({ ...t, out: true }));
  let pc = make(); pc.setTeams(allOut, null, false);
  assert(pc.p.scope?.kind === "special", `kind ${pc.p.scope?.kind}`);
  pc = make([]); pc.setTeams(allOut, null, false);
  assert(pc.p.scope?.kind === "all", `kind ${pc.p.scope?.kind}`);
  pc = make(); pc.setFollowTeams(false); pc.setMode("order");
  assert(pc.p.scope?.kind === "special", `kind ${pc.p.scope?.kind}`);
  pc.next(); const a = cur(pc).ref; pc.next(); const b = cur(pc).ref; pc.next();
  assert(a !== b && cur(pc).ref === a && a.startsWith("caster"), `order ${a} ${b} ${cur(pc).ref}`);
});

Deno.test("forgetting what has played, and a removed replay, leave no stale marks", () => {
  const pc = make();
  pc.next(); playFor(pc, 100); pc.next(); playFor(pc, 100); pc.next();
  assert(pc.p.played!.length === 2, `marks ${pc.p.played!.length}`);
  pc.resetPlayed(); assert(pc.p.played!.length === 0, "not forgotten");
  pc.next(); playFor(pc, 100); const gone = cur(pc); pc.next();
  pc.setTeams(TEAMS.filter((t) => t.name !== gone.team), null, false); pc.remove(gone.id);
  assert(!pc.p.played!.some((id) => !pc.p.items.some((x) => x.id === id)), "a mark for a replay that is gone");
});
