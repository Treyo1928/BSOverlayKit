// node --test        Every way a player could be left deaf, against a pretend Discord.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDeafener, STALE_MS, START_GRACE_MS, MAX_MS, ABSENT_RETRY_MS } from './deafen.mjs';

const ROOM = 'room', OTHER = 'other', G = 'guild';
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const refused = (text, code) => Object.assign(new Error(text), { code });

/** A pretend Discord server: who is in which channel, who is server-deafened; calls can be made to fail. */
function world({ file = null, people = new Map(), t = 1_000_000, inRoom = [] } = {}) {
  const w = {
    t, people, calls: [], disk: file, fail: null, gate: null, blind: false, d: null,
    // `deaf` is their server-deafen in G; another server (p.guild) has its own, which nothing here sets
    snap(uid) { const p = people.get(uid); return p?.channel ? { guildId: p.guild ?? G, channelId: p.channel, deaf: (p.guild ?? G) === G && p.deaf } : null; },
    join(uid, channel = ROOM, guild = G) { const before = w.snap(uid); const p = people.get(uid) ?? { deaf: false, here: true }; p.channel = channel; p.guild = guild; people.set(uid, p); w.d?.voiceChanged(uid, before, w.snap(uid)); },
    leave(uid) { const before = w.snap(uid); people.get(uid).channel = null; w.d?.voiceChanged(uid, before, null); },
    quitServer(uid) { Object.assign(people.get(uid), { channel: null, here: false }); },
    byHand(uid, deaf) { const before = w.snap(uid); people.get(uid).deaf = deaf; w.d.voiceChanged(uid, before, w.snap(uid)); },
    deaf: (...uids) => uids.map((u) => people.get(u).deaf),
    onFile: () => (w.disk ? JSON.parse(w.disk).owed : {}),
    // what the bot may ask
    state: (uid) => (w.blind ? null : w.snap(uid)),
    members: (ch) => [...people].filter(([, p]) => p.channel === ch).map(([id, p]) => ({ id, guildId: G, deaf: p.deaf })),
    async setDeaf(guildId, uid, on) {
      w.calls.push(`${on ? 'deafen' : 'undeafen'} ${uid}`);
      if (w.gate) await w.gate;
      const e = w.fail?.(uid, on); if (e) throw e;
      const p = people.get(uid);
      if (!p?.here) throw refused('Unknown Member', 10007);
      if (!p.channel || (p.guild ?? G) !== guildId) throw refused('Target user is not connected to voice.', 40032);
      const before = w.snap(uid); p.deaf = on; const after = w.snap(uid);
      setImmediate(() => w.d.voiceChanged(uid, before, after));     // Discord's own news of the change
    },
    load: () => (w.disk ? JSON.parse(w.disk) : null),
    save(o) { w.disk = JSON.stringify(o); },
    start() { w.d = makeDeafener({ discord: w, store: w, now: () => w.t }); return w; },
    /** A new bot process, the same Discord and the same file. */
    restarted: (later) => world({ file: w.disk, people, t: w.t + later }).start(),
    /** Let time pass, the overlay sending `order()` every second (none: the overlay is silent). */
    async run(ms, order) {
      for (let left = ms; left > 0; left -= 1000) {
        w.t += Math.min(1000, left);
        if (order) w.d.order(order()); else w.d.tick();
        await settle();
      }
    },
    song: (ids, extra = {}) => () => ({ run: 'map1', ids, until: w.t + 200_000, room: ROOM, on: true, release: 0, ...extra }),
  };
  for (const uid of inRoom) w.join(uid);
  return w;
}
const quiet = () => ({ run: '', ids: [], until: 0, room: ROOM, on: true, release: 0 });
const inRoom = (...uids) => world({ inRoom: uids }).start();

test('deafened when the song starts, undeafened when it ends', async () => {
  const w = inRoom('a', 'b', 'to');
  await w.run(2000, quiet);
  assert.deepEqual(w.deaf('a', 'b', 'to'), [false, false, false]);
  await w.run(1000, w.song(['a', 'b']));
  assert.deepEqual(w.deaf('a', 'b', 'to'), [true, true, false], 'both players, not the TO');
  await w.run(30_000, w.song(['a', 'b']));
  assert.deepEqual(w.calls, ['deafen a', 'deafen b'], 'asked once each, not over and over');
  await w.run(1000, quiet);
  assert.deepEqual(w.deaf('a', 'b'), [false, false]);
  assert.deepEqual(w.onFile(), {}, 'nothing left on file');
});

test('a cancelled song undeafens at once', async () => {
  const w = inRoom('a', 'b');
  await w.run(3000, w.song(['a', 'b']));
  w.t += 200; w.d.order(quiet()); await settle();
  assert.deepEqual(w.deaf('a', 'b'), [false, false]);
});

test('one player finishes or fails first: only they are undeafened', async () => {
  const w = inRoom('a', 'b');
  await w.run(3000, w.song(['a', 'b']));
  await w.run(2000, w.song(['b']));
  assert.deepEqual(w.deaf('a', 'b'), [false, true]);
  await w.run(1000, quiet);
  assert.deepEqual(w.deaf('b'), [false]);
});

test('left voice mid-song, song ends while away: undeafened the moment they are in any voice channel', async () => {
  const w = inRoom('a', 'b');
  await w.run(3000, w.song(['a', 'b']));
  w.leave('a');
  await w.run(5000, w.song(['a', 'b']));
  await w.run(60_000, quiet);
  assert.deepEqual(w.deaf('a', 'b'), [true, false], 'Discord will not change someone who is not connected');
  assert.ok(w.onFile().a, 'still on file');
  w.join('a', OTHER); await settle();
  assert.deepEqual(w.deaf('a'), [false], 'undeafened on joining a different channel');
  assert.deepEqual(w.onFile(), {});
});

test('left voice mid-song and came back while it is still going: stays deaf, undeafened at the end', async () => {
  const w = inRoom('a');
  await w.run(3000, w.song(['a']));
  w.leave('a'); await w.run(4000, w.song(['a']));
  w.join('a'); await w.run(2000, w.song(['a']));
  assert.deepEqual(w.deaf('a'), [true]);
  await w.run(1000, quiet);
  assert.deepEqual(w.deaf('a'), [false]);
});

test('the bot is in two servers: left voice mid-song, then joined voice in the OTHER server: still owed in the first', async () => {
  const w = inRoom('a');
  await w.run(3000, w.song(['a']));
  w.leave('a'); await w.run(2000, quiet);
  w.join('a', 'far', 'other-server'); await w.run(30_000, quiet);
  assert.deepEqual([w.people.get('a').deaf, Object.keys(w.onFile())], [true, ['a']], 'not written off: the deafen is in the first server');
  assert.ok(w.calls.filter((c) => c === 'undeafen a').length <= 4, 'and not hammering Discord meanwhile');
  w.leave('a'); w.join('a', OTHER); await w.run(2000, quiet);      // back while Discord was still being asked
  assert.deepEqual([w.deaf('a'), w.onFile()], [[false], {}], 'undeafened once in voice in the first server again');
});

test('moved to another channel mid-song: undeafened there', async () => {
  const w = inRoom('a');
  await w.run(3000, w.song(['a']));
  w.join('a', OTHER); await settle();
  assert.deepEqual(w.deaf('a'), [false]);
  await w.run(3000, w.song(['a']));
  assert.deepEqual(w.deaf('a'), [false], 'not deafened outside the players\' channel');
  w.join('a', ROOM); await w.run(1000, w.song(['a']));
  assert.deepEqual(w.deaf('a'), [true], 'back in the channel during the song: deaf again');
  await w.run(1000, quiet);
  assert.deepEqual(w.deaf('a'), [false]);
});

test('joined the channel after the song started: deafened then', async () => {
  const w = inRoom('b');
  w.people.set('a', { deaf: false, here: true, channel: null });
  await w.run(3000, w.song(['a', 'b']));
  assert.deepEqual(w.deaf('a'), [false]);
  w.join('a'); await settle();
  assert.deepEqual(w.deaf('a'), [true]);
  await w.run(1000, quiet);
  assert.deepEqual(w.deaf('a'), [false]);
});

test('the overlay goes silent mid-song (crash, restart, network): everyone is undeafened', async () => {
  const w = inRoom('a', 'b');
  await w.run(3000, w.song(['a', 'b']));
  await w.run(STALE_MS - 1000);
  assert.deepEqual(w.deaf('a'), [true], 'a short gap is ridden out');
  await w.run(3000);
  assert.deepEqual(w.deaf('a', 'b'), [false, false]);
  await w.run(2000, w.song(['a', 'b']));
  assert.deepEqual(w.deaf('a', 'b'), [true, true], 'the overlay is back and the song still on: deaf again');
  await w.run(1000, quiet);
  assert.deepEqual(w.deaf('a', 'b'), [false, false]);
});

test('the overlay keeps saying "playing" for ever (the site hung): the song\'s own end time undeafens', async () => {
  const w = inRoom('a'), until = w.t + 120_000;
  const stuck = () => ({ run: 'map1', ids: ['a'], until, room: ROOM, on: true, release: 0 });
  await w.run(119_000, stuck);
  assert.deepEqual(w.deaf('a'), [true]);
  await w.run(3000, stuck);
  assert.deepEqual(w.deaf('a'), [false]);
  await w.run(30_000, stuck);
  assert.deepEqual(w.deaf('a'), [false]);
});

test('nobody stays deaf longer than the limit, whatever the orders say', async () => {
  const w = inRoom('a');
  const forever = () => ({ run: 'map1', ids: ['a'], until: w.t + 1e10, room: ROOM, on: true, release: 0 });
  await w.run(MAX_MS - 5000, forever);
  assert.deepEqual(w.deaf('a'), [true]);
  await w.run(10_000, forever);
  assert.deepEqual(w.deaf('a'), [false]);
  await w.run(20_000, forever);
  assert.deepEqual(w.deaf('a'), [false], 'and not deafened again for that song');
});

test('the bot is restarted mid-song: stays deaf through the restart, undeafened at the end', async () => {
  const w = inRoom('a');
  await w.run(3000, w.song(['a']));
  const w2 = w.restarted(4000);
  await w2.run(1000);
  assert.deepEqual(w2.deaf('a'), [true], 'not undeafened before the overlay has had a chance to speak');
  await w2.run(5000, w2.song(['a']));
  assert.deepEqual([w2.deaf('a'), w2.calls], [[true], []], 'nothing needed doing');
  await w2.run(1000, quiet);
  assert.deepEqual(w2.deaf('a'), [false]);
});

test('the bot crashed mid-song and comes back after it ended: undeafened from the file', async () => {
  const w = inRoom('a', 'b');
  await w.run(3000, w.song(['a', 'b']));
  w.leave('b');
  const w2 = w.restarted(600_000);
  await w2.run(2000, quiet);
  assert.deepEqual(w2.deaf('a', 'b'), [false, true], 'b is not in voice yet');
  w2.join('b', OTHER); await settle();
  assert.deepEqual(w2.deaf('b'), [false]);
});

test('the bot comes back and the overlay never answers: undeafened after the grace', async () => {
  const w = inRoom('a');
  await w.run(3000, w.song(['a']));
  const w2 = w.restarted(1000);
  await w2.run(START_GRACE_MS + 2000);
  assert.deepEqual(w2.deaf('a'), [false]);
});

test('the file was lost: someone deaf in the players\' channel with no song is undeafened anyway', async () => {
  const w = world({ inRoom: ['a'] }); w.people.get('a').deaf = true; w.start();
  await w.run(2000, quiet);
  assert.deepEqual(w.deaf('a'), [false]);
});

test('Discord fails the undeafen (outage, rate limit): tried again until it works', async () => {
  const w = inRoom('a');
  await w.run(3000, w.song(['a']));
  w.fail = (uid, on) => (on ? null : refused('503 Service Unavailable'));
  await w.run(20_000, quiet);
  assert.deepEqual(w.deaf('a'), [true]);
  assert.ok(w.calls.filter((c) => c === 'undeafen a').length >= 5, 'kept trying');
  assert.match(w.d.status().error, /undeafen/);
  w.fail = null;
  await w.run(3000, quiet);
  assert.deepEqual([w.deaf('a'), w.d.status().error], [[false], '']);
});

test('what the bot believes about who is connected is out of date: Discord is asked anyway', async () => {
  const w = inRoom('a');
  await w.run(3000, w.song(['a']));
  w.blind = true;
  await w.run(ABSENT_RETRY_MS + 3000, quiet);
  assert.deepEqual(w.deaf('a'), [false]);
});

test('the song ends while the deafen is still on its way to Discord', async () => {
  const w = inRoom('a');
  let open; w.gate = new Promise((r) => { open = r; });
  w.t += 1000; w.d.order(w.song(['a'])()); await settle();
  w.t += 500; w.d.order(quiet()); await settle();
  assert.deepEqual(w.calls, ['deafen a'], 'the undeafen waits for the deafen to land: they cannot cross');
  open(); w.gate = null;
  await w.run(2000, quiet);
  assert.deepEqual([w.calls, w.deaf('a')], [['deafen a', 'undeafen a'], [false]], 'the late deafen landed and was undone');
});

test('a person undeafens a player by hand mid-song: the bot leaves them alone for that song', async () => {
  const w = inRoom('a', 'b');
  await w.run(3000, w.song(['a', 'b']));
  w.byHand('a', false); await settle();
  await w.run(10_000, w.song(['a', 'b']));
  assert.deepEqual(w.deaf('a', 'b'), [false, true]);
  await w.run(1000, quiet);
  await w.run(2000, w.song(['a', 'b'], { run: 'map2' }));
  assert.deepEqual(w.deaf('a'), [true], 'the next song deafens them as usual');
  await w.run(1000, quiet);
  assert.deepEqual(w.deaf('a', 'b'), [false, false]);
});

test('"Undeafen everyone now" in the panel', async () => {
  const w = inRoom('a', 'b');
  await w.run(3000, w.song(['a', 'b']));
  await w.run(1000, w.song(['a', 'b'], { release: 1 }));
  assert.deepEqual(w.deaf('a', 'b'), [false, false]);
  await w.run(10_000, w.song(['a', 'b'], { release: 1 }));
  assert.deepEqual(w.deaf('a', 'b'), [false, false], 'not deafened again in this song');
});

test('switched off in the panel mid-song, the channel unset, or the channel changed: undeafened', async () => {
  const w = inRoom('a');
  await w.run(3000, w.song(['a']));
  await w.run(1000, w.song(['a'], { on: false }));
  assert.deepEqual(w.deaf('a'), [false]);
  await w.run(2000, w.song(['a']));
  assert.deepEqual(w.deaf('a'), [true]);
  await w.run(1000, w.song(['a'], { room: '' }));
  assert.deepEqual(w.deaf('a'), [false]);
  await w.run(2000, w.song(['a']));
  await w.run(1000, w.song(['a'], { room: OTHER }));
  assert.deepEqual(w.deaf('a'), [false]);
});

test('the bot is stopped mid-song (a deploy): everyone is undeafened before it goes', async () => {
  const w = inRoom('a', 'b', 'c');
  await w.run(3000, w.song(['a', 'b', 'c']));
  w.leave('c');
  const left = await w.d.shutdown(2000, async () => { w.t += 50; await settle(); });
  assert.deepEqual([w.deaf('a', 'b'), left], [[false, false], ['c']], 'c is not in voice: still on file for the next start');
  const w2 = w.restarted(60_000);
  w2.join('c'); await w2.run(1000, quiet);
  assert.deepEqual(w2.deaf('c'), [false]);
});

test('a player left the server while deaf: forgotten, nothing loops', async () => {
  const w = inRoom('a');
  await w.run(3000, w.song(['a']));
  w.quitServer('a');
  await w.run(5000, quiet);
  assert.deepEqual(w.onFile(), {});
  const n = w.calls.length; await w.run(60_000, quiet);
  assert.equal(w.calls.length, n);
});

test('the bot may not deafen: says so, deafens nobody, owes nobody', async () => {
  const w = inRoom('a');
  w.fail = () => refused('Missing Permissions', 50013);
  await w.run(5000, w.song(['a']));
  assert.deepEqual(w.deaf('a'), [false]);
  assert.match(w.d.status().error, /Deafen Members/);
  assert.deepEqual(w.onFile(), {});
});

test('the panel\'s test deafens for a moment and undoes it, with no song', async () => {
  const w = inRoom('a');
  await w.run(2000, quiet);
  w.d.test('a', 4000); await settle();
  assert.deepEqual(w.deaf('a'), [true]);
  await w.run(5000, quiet);
  assert.deepEqual(w.deaf('a'), [false]);
});

test('someone not in the song is never touched, also when already deaf elsewhere', async () => {
  const w = world({ inRoom: ['a', 'to'] }); w.join('x', OTHER); w.people.get('x').deaf = true; w.start();
  await w.run(5000, w.song(['a']));
  await w.run(5000, quiet);
  assert.deepEqual(w.deaf('to', 'x'), [false, true], 'a server-deafen in another channel is someone else\'s business');
  assert.deepEqual(w.calls, ['deafen a', 'undeafen a']);
});

test('the disk is full: people are still undeafened', async () => {
  const w = inRoom('a');
  await w.run(3000, w.song(['a']));
  w.save = () => { throw new Error('No space left on device'); };
  await w.run(2000, quiet);
  assert.deepEqual(w.deaf('a'), [false]);
});
