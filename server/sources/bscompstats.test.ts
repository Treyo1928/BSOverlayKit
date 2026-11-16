// deno test --allow-read --allow-env server/        Who is "in a song" as far as the bot that deafens players is told.
import { assertEquals } from "jsr:@std/assert@1";
import { type LiveEvent, type Match, playingIn } from "./bscompstats.ts";

const T0 = 1_800_000_000_000;
/** A TA match with one map being played by A1, A2 (team a) and B1, B2 (team b): a 100 s song that started at T0. */
function match(status: unknown, extra: Record<string, unknown> = {}): Match {
  return {
    id: "m1", taMode: true, teamA: { id: "ta", players: [] }, teamB: { id: "tb", players: [] },
    plannedMaps: [
      { matchMapId: "done", scoresClosed: true, map: { duration: 90 }, lineups: {}, start: { requestedAt: "r0", status: { phase: "finished" } } },
      { matchMapId: "mm1", scoresClosed: false, map: { duration: 100 }, lineups: { ta: ["A1", "A2"], tb: ["B1", "B2"] }, start: status === null ? null : { requestedAt: "r1", status }, ...extra },
    ],
  } as unknown as Match;
}
const playing = (states: Record<string, string> = {}) => ({
  phase: "playing", startedAt: new Date(T0).toISOString(),
  players: ["A1", "A2", "B1", "B2"].map((playerId) => ({ playerId, state: states[playerId] ?? "playing" })),
});
const now = T0 + 30_000;
const who = (m: Match, live: LiveEvent | null = null, at = now, seen = new Map<string, number>()) => playingIn(m, live, at, seen)?.players ?? null;

Deno.test("nobody before the song: no start asked, waiting, loading, ready", () => {
  assertEquals(who(match(null)), null);
  for (const phase of ["waiting", "loading", "ready"]) assertEquals(who(match({ phase })), null, phase);
});

Deno.test("everyone in the lineups while it plays", () => {
  const p = playingIn(match(playing()), null, now, new Map())!;
  assertEquals(p.players, ["A1", "A2", "B1", "B2"]);
  assertEquals(p.until, T0 + 100_000 + 35_000);
  assertEquals(p.run, `mm1:r1:${T0}`);
});

Deno.test("a player who finished, failed or quit is no longer playing; the rest are", () => {
  assertEquals(who(match(playing({ A1: "finished" }))), ["A2", "B1", "B2"]);
  assertEquals(who(match(playing({ A1: "failed", B2: "quit" }))), ["A2", "B1"]);
  assertEquals(who(match(playing({ A1: "finished", A2: "finished", B1: "failed", B2: "quit" }))), null);
});

Deno.test("the live numbers say a player finished before the status does", () => {
  const live = { matchId: "m1", matchMapId: "mm1", phase: "playing", startedAt: T0, at: now, players: [{ playerId: "B1", finished: true }, { playerId: "A1", finished: false }] } as unknown as LiveEvent;
  assertEquals(who(match(playing()), live), ["A1", "A2", "B2"]);
});

Deno.test("nobody once it is over: finished, failed to start, the live feed's last word", () => {
  assertEquals(who(match({ ...playing(), phase: "finished" })), null);
  assertEquals(who(match({ phase: "error", message: "The site restarted while this map was being played." })), null);
  const over = { matchId: "m1", matchMapId: "mm1", phase: "over", startedAt: T0, at: now, players: [] } as unknown as LiveEvent;
  assertEquals(who(match(playing()), over), null, "the feed says over a moment before the status does");
});

Deno.test("nobody once it is cancelled: the request is gone, or the map was closed", () => {
  const cancelled = match(playing());
  cancelled.plannedMaps[1].start = { requestedAt: null, status: playing() } as never;
  assertEquals(who(cancelled), null);
  assertEquals(who(match(playing(), { scoresClosed: true })), null);
});

Deno.test("live numbers left over from the map before do not count for this one", () => {
  const stale = { matchId: "m1", matchMapId: "done", phase: "over", startedAt: T0 - 500_000, at: now, players: [] } as unknown as LiveEvent;
  assertEquals(who(match(playing()), stale), ["A1", "A2", "B1", "B2"]);
});

Deno.test("a status stuck on playing (the site hung): nobody once the song cannot still be going", () => {
  assertEquals(who(match(playing()), null, T0 + 134_000), ["A1", "A2", "B1", "B2"]);
  assertEquals(who(match(playing()), null, T0 + 136_000), null);
});

Deno.test("no start time from the site: counted from when it was first seen playing", () => {
  const seen = new Map<string, number>(), m = match({ phase: "playing", players: [] });
  assertEquals(playingIn(m, null, now, seen)!.until, now + 135_000);
  assertEquals(playingIn(m, null, now + 50_000, seen)!.until, now + 135_000, "the end does not move as time passes");
  assertEquals(playingIn(m, null, now + 136_000, seen), null);
});

Deno.test("a restarted map is a new song (its own run)", () => {
  const again = match(playing());
  again.plannedMaps[1].start!.requestedAt = "r2";
  assertEquals(playingIn(again, null, now, new Map())!.run, `mm1:r2:${T0}`);
});

Deno.test("not a TA match: nobody", () => {
  assertEquals(who({ ...match(playing()), taMode: false } as Match), null);
});
