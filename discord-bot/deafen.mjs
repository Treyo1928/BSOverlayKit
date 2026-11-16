// Deafening players while they play, and above all undeafening them afterwards.
//
// The overlay says who is in a song right now (an "order", about once a second). Whoever of them sits in the
// players' voice channel is server-deafened, and undeafened the moment the overlay stops naming them.
// Undeafening must never be missed, so it does not hang on any one message arriving:
//  - everyone deafened is written to a file BEFORE Discord is asked ("owed"); a restarted bot reads it back
//  - no order for a few seconds (overlay down or unreachable): nobody is wanted deaf
//  - an order carries the latest time its song can still be going; and nobody stays deaf longer than MAX_MS
//  - someone who left voice while deaf cannot be changed (Discord refuses): they stay owed and are undeafened the
//    moment they are in any voice channel again; Discord is asked now and then anyway, in case the bot's picture
//    of who is connected is out of date
//  - a failed undeafen is tried again every couple of seconds
//  - anyone found server-deafened in the players' channel with no song is undeafened too, whoever did it
//  - stopping the bot undeafens everyone first
// Someone a person undeafened by hand during a song is left alone for the rest of that song.
//
// Discord is handed in (bot.mjs for the real thing, the tests for a pretend one):
//   discord.state(uid) -> { guildId, channelId, deaf } | null     discord.members(channelId) -> [{ id, guildId, deaf }]
//   discord.setDeaf(guildId, uid, on, why) -> Promise; rejects with .code 40032 (not in voice), 10007 (left the server)
//   store.load() -> saved object | null     store.save(object)
export const STALE_MS = 7_000;          // no order for this long: nobody is wanted deaf
export const START_GRACE_MS = 6_000;    // after starting, wait this long for a first order before undeafening
export const MAX_MS = 20 * 60_000;      // nobody stays deaf longer than this
export const ABSENT_RETRY_MS = 15_000;  // someone not in voice: ask Discord again this often anyway
const RETRY_MS = 2_000, JUST_UNDONE_MS = 3_000;
const NOT_IN_VOICE = 40032, GONE = [10007, 10013], FORBIDDEN = [50013, 50001];

export function makeDeafener({ discord, store, now = Date.now, log = () => {} }) {
  const saved = store.load() ?? {};
  const owed = new Map(Object.entries(saved.owed ?? {}));          // uid -> { since, run, guildId }: deafened, not yet undone
  const released = new Map(Object.entries(saved.released ?? {}));  // "run|uid" -> when: not deafened again in that song
  let room = saved.room ?? '';     // the players' channel as last ordered (for when orders stop)
  let order = null;                // { at, run, ids, until, room, on }
  const tests = new Map(), busy = new Map(), nextTry = new Map(), undone = new Map();
  const born = now();
  let stopping = false, lastRelease = null, error = '';

  const save = () => {
    for (const [k, at] of released) if (now() - at > MAX_MS * 2) released.delete(k);
    try { store.save({ owed: Object.fromEntries(owed), released: Object.fromEntries(released), room }); }
    catch (e) { error = `cannot write the list of deafened people (${e.message})`; log(`deafen: ${error}`); }   // still undeafen
  };
  const fresh = () => !!order && !stopping && now() - order.at <= STALE_MS;
  const theRoom = () => (fresh() ? (order.on ? order.room : '') : room);

  /** Who should be deaf this instant (uid -> song). */
  function wanted() {
    const out = new Map(), t = now();
    if (stopping) return out;
    if (fresh() && order.on && order.room && t < order.until) {
      for (const uid of order.ids) if (!released.has(`${order.run}|${uid}`)) out.set(uid, order.run);
    }
    for (const [uid, until] of tests) { if (t < until) out.set(uid, 'test'); else tests.delete(uid); }
    return out;
  }

  async function ask(uid, guildId, on, why) {
    const word = on ? 'deafen' : 'undeafen';
    busy.set(uid, word);
    try {
      await discord.setDeaf(guildId, uid, on, why);
    } catch (e) {
      busy.delete(uid);
      const drop = () => { owed.delete(uid); save(); };
      if (!on && GONE.includes(e?.code)) return drop();                 // they left the server: nothing is owed
      if (e?.code === NOT_IN_VOICE) {                                    // not connected: tried again when they are back
        nextTry.set(uid, now() + ABSENT_RETRY_MS);
        if (on) drop();                                                  // the deafen never happened
        return;
      }
      nextTry.set(uid, now() + RETRY_MS);
      if (FORBIDDEN.includes(e?.code)) {
        error = 'the bot is not allowed to deafen people: give its role "Deafen Members" in the server (or in the players\' channel)';
        if (on) { drop(); nextTry.set(uid, now() + 10_000); }
      } else error = `Discord refused to ${word} someone (${e?.message ?? e}); trying again`;
      return log(`deafen: could not ${word} ${uid}: ${e?.message ?? e}`);
    }
    busy.delete(uid); nextTry.delete(uid);
    if (!on) { owed.delete(uid); undone.set(uid, now()); save(); }
    if (!error.startsWith('cannot write')) error = '';
    log(`deafen: ${word}ed ${uid} (${why})`);
  }

  /** Make Discord match what is wanted. Safe to call as often as anyone likes. */
  function tick() {
    const t = now();
    // just started, the overlay has not spoken yet: a song may be on, so do not undeafen and deafen again a moment later
    if (!order && !stopping && t - born < START_GRACE_MS) return;
    const want = wanted(), at = theRoom();
    const waiting = (uid) => busy.has(uid) || t < (nextTry.get(uid) ?? 0);

    for (const [uid, run] of want) {
      const st = discord.state(uid);
      if (!at || st?.channelId !== at) continue;                         // only in the players' channel
      if (st.deaf && owed.has(uid)) continue;
      if (!st.deaf && waiting(uid)) continue;
      owed.set(uid, { since: owed.get(uid)?.since ?? t, run, guildId: st.guildId });
      save();                                                            // on file before Discord is asked
      if (!st.deaf) ask(uid, st.guildId, true, run === 'test' ? 'a test from the overlay panel' : 'playing a song');
    }
    for (const [uid, o] of owed) {
      const st = discord.state(uid), tooLong = t - o.since > MAX_MS;
      if (want.has(uid) && at && st?.channelId === at && !tooLong) continue;      // rightly deaf
      if (tooLong && want.has(uid)) { released.set(`${want.get(uid)}|${uid}`, t); save(); }
      if (waiting(uid)) continue;
      if (!st) nextTry.set(uid, t + ABSENT_RETRY_MS);                    // not in voice as far as is known: ask, but seldom
      ask(uid, st?.guildId ?? o.guildId, false, 'no longer playing');
    }
    // anyone else deaf in the players' channel who should not be
    for (const m of at ? discord.members(at) : []) {
      if (!m.deaf || owed.has(m.id) || want.has(m.id) || busy.has(m.id) || t - (undone.get(m.id) ?? -1e15) <= JUST_UNDONE_MS) continue;
      owed.set(m.id, { since: t, run: 'found', guildId: m.guildId });
      save();
      ask(m.id, m.guildId, false, 'deafened in the players\' channel with no song playing');
    }
  }

  return {
    tick,
    /** From the overlay, about once a second: { run, ids, until, room, on, release }. */
    order(o) {
      const next = { at: now(), run: String(o.run ?? ''), ids: (o.ids ?? []).map(String), until: Number(o.until) || 0, room: String(o.room ?? ''), on: !!o.on };
      const kept = next.on ? next.room : '';       // nothing to watch while switched off
      if (kept !== room) { room = kept; save(); }
      // "Undeafen everyone now" in the panel: everyone in this song is let go for the rest of it
      if (lastRelease !== null && (o.release ?? 0) !== lastRelease) {
        for (const uid of new Set([...next.ids, ...owed.keys()])) released.set(`${next.run}|${uid}`, now());
        tests.clear();
        save();
        log('deafen: everyone released from the panel');
      }
      lastRelease = o.release ?? 0;
      order = next;
      tick();
    },
    /** Deafen one person for a moment (the panel's "Test"), to see that the bot may. */
    test(uid, ms = 4000) { tests.set(String(uid), now() + Math.min(10_000, Math.max(1000, ms))); tick(); },
    /** Discord says someone's voice state changed. */
    voiceChanged(uid, before, after) {
      nextTry.delete(uid);            // they may be back: do not wait out a retry
      // undeafened by a person (not by us) while we had them deaf: left alone for the rest of this song
      if (before?.deaf && after && !after.deaf && owed.has(uid) && busy.get(uid) !== 'undeafen') {
        released.set(`${owed.get(uid).run}|${uid}`, now());
        if (fresh()) released.set(`${order.run}|${uid}`, now());
        owed.delete(uid);
        save();
        log(`deafen: ${uid} was undeafened by someone; left alone for the rest of this song`);
      }
      tick();
    },
    /** The bot is stopping: undeafen everyone who can be (a few seconds at most). Answers who is still owed. */
    async shutdown(waitMs = 6000, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
      stopping = true;
      for (const end = now() + waitMs; ;) {
        nextTry.clear();
        tick();
        do await sleep(50); while (busy.size && now() < end);
        if (now() >= end || ![...owed.keys()].some((uid) => discord.state(uid))) return [...owed.keys()];
        await sleep(300);
      }
    },
    status: () => ({ owed: [...owed.keys()], error }),
  };
}
