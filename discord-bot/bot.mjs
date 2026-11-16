// The caster bot.
//   Whoever is in the casting voice channel shows on the overlay's Casters scene (in the order they joined, with
//   their Discord name and picture), and their ring lights up while they talk. Nobody is set up by hand: joining the
//   channel is all a caster does.
//
//   Which channel: the one picked in the overlay panel's Casters card (the bot tells the overlay which voice channels
//   it can see). Until one is picked there: CASTER_CHANNEL_ID if set, else the first voice channel with "cast" in
//   its name.
//
//   The bot sits in the channel muted, and only while somebody else is in it. What it hears there it passes to the overlay as it arrives, so the casters'
//   voices are on stream (mixed in the panel: Sound). Nothing is recorded, kept or decoded here: each packet goes
//   straight on and is gone. VOICE_AUDIO=off: no sound is passed on at all, only who is talking.
//
//   The players' voice channel (picked in the panel too): while a TournamentAssistant song is being played, the
//   players in it are server-deafened, and undeafened when it ends, is cancelled or they finish (deafen.mjs). The
//   bot does not sit in that channel; it needs "Deafen Members" there.
//
//   Settings (environment, or .env beside this file): DISCORD_TOKEN, OVERLAY_URL, OVERLAY_CODE; optional
//   CASTER_CHANNEL_ID, IGNORE_USER_IDS, VOICE_AUDIO, STATE_DIR. See README.md.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client, Events, GatewayIntentBits, PermissionFlagsBits, Routes } from 'discord.js';
import { makeDeafener } from './deafen.mjs';
import { EndBehaviorType, entersState, generateDependencyReport, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';

const env = (k, d = '') => (process.env[k] ?? d).trim();
const TOKEN = env('DISCORD_TOKEN');
const IGNORE = new Set(env('IGNORE_USER_IDS').split(/[\s,]+/).filter(Boolean));   // people who are never casters
const OVERLAY = env('OVERLAY_URL', 'http://127.0.0.1:8095').replace(/\/+$/, '');
let OVERLAY_CODE = env('OVERLAY_CODE');
if (!OVERLAY_CODE) {
  try { OVERLAY_CODE = JSON.parse(readFileSync(new URL(`../${env('KIT_DATA', 'data')}/secrets.json`, import.meta.url))).hostCode; } catch { /* not beside an overlay */ }
}

// asked to stop before there is anything to close (as a container's first process, Node ignores these otherwise)
const quit = () => process.exit(0);
process.on('SIGINT', quit);
process.on('SIGTERM', quit);

if (!TOKEN) {
  // Not set up: stay quiet and stay up (a container that exits is started again, over and over).
  console.log('caster bot: no DISCORD_TOKEN, so nothing to do. Set it (see discord-bot/README.md) and start this again.');
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}
if (!OVERLAY_CODE) {
  console.error('caster bot: no OVERLAY_CODE (the overlay panel\'s login code), so it cannot tell the overlay anything.');
  process.exit(2);
}

// ---------------------------------------------------------------- the overlay
/** Send the overlay an action; answers what it said back (null when it could not be reached or refused). */
async function overlay(action) {
  try {
    const r = await fetch(`${OVERLAY}/api/action`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OVERLAY_CODE}`, 'content-type': 'application/json' },
      body: JSON.stringify(action),
    });
    if (!r.ok) { console.warn(`overlay ${action.action}: ${r.status} ${(await r.text()).slice(0, 200)}`); return null; }
    return await r.json().catch(() => ({}));
  } catch (e) {
    if (overlay.down !== e.message) console.warn(`overlay not reachable (${OVERLAY}): ${e.message}`);
    overlay.down = e.message;
    return null;
  }
}

// ---------------------------------------------------------------- the line to the overlay
// One WebSocket, opened again whenever it drops. Up it: the casters' voices and how the players' channel stands.
// Down it: who is playing a song right now (the orders deafen.mjs works from).
const AUDIO = !/^(off|0|no|false)$/i.test(env('VOICE_AUDIO', 'on'));
let line = null, lineOk = false, lineSaid = '';
function openLine() {
  const ws = line = new WebSocket(`${OVERLAY.replace(/^http/, 'ws')}/ws/bot`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(OVERLAY_CODE);
  ws.onmessage = (e) => {
    if (!lineOk) { lineOk = true; roomSent = ''; if (lineSaid !== 'up') console.log('line to the overlay: connected'); lineSaid = 'up'; }
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'deafen') { roomWanted = String(m.room ?? ''); deafener.order(m); sendRoom(); }
    if (m.type === 'deafenTest') deafener.test(String(m.id), Number(m.ms) || 4000);
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    if (lineSaid !== 'down') console.warn('line to the overlay: down (trying again every second)');
    lineSaid = 'down'; lineOk = false;
    if (line === ws) setTimeout(openLine, 1000);
  };
}
const idBytes = new Map();
/** One Opus packet from one person: [length of their id][id][packet], unless the line is down or backed up. */
function sendVoice(uid, packet) {
  if (!AUDIO || !lineOk || line.readyState !== 1 || line.bufferedAmount > 64_000 || IGNORE.has(uid)) return;
  let id = idBytes.get(uid);
  if (!id) idBytes.set(uid, id = Buffer.from(uid, 'latin1'));
  const out = new Uint8Array(1 + id.length + packet.length);
  out[0] = id.length; out.set(id, 1); out.set(packet, 1 + id.length);
  line.send(out);
}
/** Start passing on what this person says (once per person per stay in the channel). */
function hear(mine, uid) {
  if (!AUDIO || mine.receiver.subscriptions.has(uid) || uid === client.user?.id) return;
  const stream = mine.receiver.subscribe(uid, { end: { behavior: EndBehaviorType.Manual } });
  stream.on('data', (packet) => sendVoice(uid, packet));
  stream.on('error', (e) => console.warn(`voices: ${uid}: ${e.message}`));
}

// ---------------------------------------------------------------- the players' channel: deaf while they play
// (the rules are in deafen.mjs; here is only how they reach Discord, the file, and the panel)
const STATE_FILE = `${(env('STATE_DIR') || new URL('./state', import.meta.url).pathname).replace(/\/+$/, '')}/deafened.json`;
const inVoice = (c) => (c?.isVoiceBased?.() ? [...c.members.values()].filter((m) => !m.user.bot) : []);
const deafener = makeDeafener({
  log: (text) => console.log(text),
  store: {
    load() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; } },
    // a whole new file swapped into place: a crash mid-write leaves the old one, never half of one
    save(o) { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(o)); renameSync(`${STATE_FILE}.tmp`, STATE_FILE); },
  },
  discord: {
    state(uid) {
      for (const g of client.guilds.cache.values()) {
        const v = g.voiceStates.cache.get(uid);
        if (v?.channelId) return { guildId: g.id, channelId: v.channelId, deaf: !!v.serverDeaf };
      }
      return null;
    },
    // straight to Discord's API by id: works whatever this bot has or has not got cached about the person
    setDeaf: (guildId, uid, on, why) => client.rest.patch(Routes.guildMember(guildId, uid), { body: { deaf: on }, reason: `Overlay bot: ${why}` }),
    members: (id) => inVoice(client.channels.cache.get(id)).map((m) => ({ id: m.id, guildId: m.guild.id, deaf: !!m.voice.serverDeaf })),
  },
});
let roomWanted = '', roomSent = '';      // the players' channel picked in the panel; what the overlay was last told of it
/** Tell the overlay who is in the players' channel and how the deafening stands (for the panel). */
function sendRoom(force = false) {
  if (!lineOk || line.readyState !== 1) return;
  const c = client.channels.cache.get(roomWanted), room = c?.isVoiceBased?.() ? c : null;
  const msg = JSON.stringify({
    type: 'room', channelId: room?.id ?? '', ...deafener.status(),
    may: !!room?.permissionsFor(room.guild.members.me)?.has(PermissionFlagsBits.DeafenMembers),
    members: inVoice(room).map((m) => ({ id: m.id, name: m.displayName, handle: `@${m.user.username}`, avatar: m.displayAvatarURL({ extension: 'png', size: 64 }), deaf: !!m.voice.serverDeaf })),
  });
  if (msg !== roomSent || force) line.send(roomSent = msg);
}

// ---------------------------------------------------------------- which channel, and who is in it
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const joinedAt = new Map();          // user id -> when they joined, so casters keep their places
const talking = new Set();
let channelId = '';                  // the channel being followed
let connection = null;

const voiceChannels = () => [...client.channels.cache.values()].filter((c) => c.isVoiceBased?.() && c.guild);
/** The channel to follow: the panel's choice, else the one in the settings, else one that sounds like casting. */
function wanted(chosen) {
  const known = (id) => (id && voiceChannels().some((c) => c.id === id) ? id : '');
  return known(chosen) || known(env('CASTER_CHANNEL_ID')) || (voiceChannels().find((c) => /cast/i.test(c.name))?.id ?? '');
}

function castersNow() {
  const channel = client.channels.cache.get(channelId);
  if (!channel?.isVoiceBased?.()) return [];
  const people = [...channel.members.values()].filter((m) => !m.user.bot && !IGNORE.has(m.id));
  for (const m of people) if (!joinedAt.has(m.id)) joinedAt.set(m.id, Date.now());
  for (const id of joinedAt.keys()) if (!people.some((m) => m.id === id)) joinedAt.delete(id);
  return people
    .sort((a, b) => joinedAt.get(a.id) - joinedAt.get(b.id))
    .map((m) => ({ id: m.id, name: m.displayName, handle: `@${m.user.username}`, avatar: m.displayAvatarURL({ extension: 'png', size: 256 }) }));
}

let lastSent = null;
async function sendCasters(force = false) {
  const list = castersNow();
  const json = JSON.stringify(list);
  if (json === lastSent && !force) return;
  lastSent = json;
  console.log(`casters: ${list.map((c) => c.name).join(', ') || '(nobody)'}`);
  await overlay({ action: 'discordCasters', casters: list });
  for (const id of talking) await overlay({ action: 'speaking', id, on: true });
}

// ---------------------------------------------------------------- who is talking
function leave() {
  connection?.destroy();
  connection = null;
  talking.clear();
}
/** Follow this channel: sit in it while anyone is there (see sit). */
function join(id) {
  leave();
  joinedAt.clear();       // another channel: the order people joined starts again
  channelId = id;
  sit();
}
/** The bot is in the voice channel only while a person is: alone it would sit in an empty room, so it steps out,
 *  and comes back the moment someone joins (it knows who is there without being in the channel itself). */
function sit() {
  const channel = client.channels.cache.get(channelId);
  const anyone = !!channel?.isVoiceBased?.() && [...channel.members.values()].some((m) => !m.user.bot);
  if (anyone && !connection) { console.log(`someone is in #${channel.name}: joining`); connect(channel); }
  else if (!anyone && connection) { console.log(`#${channel?.name ?? 'the channel'} is empty: stepping out until someone joins`); leave(); }
}
function connect(channel) {
  leave();
  const mine = connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,      // must receive packets to know who is talking
    selfMute: true,
  });
  const steps = [];        // how far the voice link got, for the message when it does not get there
  mine.on('stateChange', (was, now) => { if (was.status !== now.status) steps.push(now.status); });
  mine.on('error', (e) => steps.push(`error: ${e.message}`));
  mine.receiver.speaking.on('start', (uid) => { hear(mine, uid); if (!talking.has(uid)) { talking.add(uid); overlay({ action: 'speaking', id: uid, on: true }); } });
  mine.receiver.speaking.on('end', (uid) => { talking.delete(uid); overlay({ action: 'speaking', id: uid, on: false }); });
  mine.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // a move between voice servers reconnects by itself; anything else, join again
      await Promise.race([entersState(mine, VoiceConnectionStatus.Signalling, 5_000), entersState(mine, VoiceConnectionStatus.Connecting, 5_000)]);
    } catch {
      if (connection !== mine) return;          // the channel was changed meanwhile
      console.warn('voice disconnected, joining again in 5 s');
      setTimeout(() => { if (connection === mine) { leave(); sit(); } }, 5_000);
    }
  });
  entersState(mine, VoiceConnectionStatus.Ready, 20_000)
    .then(() => console.log(`listening in #${channel.name} (${channel.guild.name})`))
    // without voice the list of who is there still works (that comes from the server, not the voice link): only the
    // talking rings do not
    .catch(() => {
      if (connection !== mine) return;
      const can = channel.permissionsFor(client.user);
      const missing = ['ViewChannel', 'Connect'].filter((p) => !can?.has(p));
      const why = missing.length ? `the bot lacks ${missing.join(' and ')} in that channel (channel or role permissions in Discord)`
        : channel.full ? 'the channel is full'
        : `it got as far as: ${steps.join(' -> ') || 'nothing'} (stuck at "signalling": Discord never answered; at "connecting": the voice link itself, UDP out of this machine or the encryption library)`;
      console.error(`could not join voice in #${channel.name}: ${why}. Casters still show; their rings will not light up. Trying again in 60 s.`);
      setTimeout(() => { if (connection === mine) { leave(); sit(); } }, 60_000);
    });
}

// ---------------------------------------------------------------- keeping the overlay and the bot in step
/** Tell the overlay the bot is here and what it can see; follow the channel the panel has picked. Every 8 s. */
async function heartbeat() {
  const said = await overlay({
    action: 'discordBot',
    bot: client.user?.tag ?? '',
    following: channelId,
    channels: voiceChannels().map((c) => ({ id: c.id, name: c.name, guild: c.guild.name, people: [...c.members.values()].filter((m) => !m.user.bot).length })),
  });
  if (!said) return;
  if (overlay.down) { console.log('overlay reachable again'); overlay.down = ''; lastSent = null; }
  const next = wanted(said.channelId);
  if (next !== channelId) {
    console.log(next ? `following ${client.channels.cache.get(next)?.name}` : 'no voice channel to follow: pick one in the overlay panel (Casters)');
    if (next) join(next); else { leave(); joinedAt.clear(); channelId = ''; }
    await sendCasters(true);
  } else if (lastSent === null) await sendCasters(true);
}

client.once(Events.ClientReady, async () => {
  console.log(`logged in as ${client.user.tag}; in ${client.guilds.cache.size} server(s), ${voiceChannels().length} voice channel(s) visible`);
  if (!client.guilds.cache.size) console.warn('the bot is in no server yet: invite it (see README.md)');
  openLine();
  setInterval(() => { deafener.tick(); sendRoom(); }, 1000);
  setInterval(() => sendRoom(true), 5000);
  await heartbeat();
  setInterval(heartbeat, 8_000);
});
client.on(Events.VoiceStateUpdate, (before, after) => {
  const snap = (v) => (v.channelId ? { guildId: v.guild.id, channelId: v.channelId, deaf: !!v.serverDeaf } : null);
  if (!after.member?.user.bot) { deafener.voiceChanged(after.id, snap(before), snap(after)); sendRoom(); }
  if (before.channelId === channelId || after.channelId === channelId) { sit(); sendCasters(); }
});
client.on(Events.GuildMemberUpdate, () => sendCasters());      // a name or picture changed while in the channel
client.on(Events.Error, (e) => console.error(`discord: ${e.message}`));

let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  // nobody is left deaf because the bot was restarted: undo them all first (a few seconds at most)
  const left = await deafener.shutdown().catch(() => []);
  if (left.length) console.warn(`stopping with ${left.length} player(s) still server-deafened and not in voice: on file, undeafened when the bot is back and they are`);
  leave(); await client.destroy().catch(() => {}); process.exit(0);
};
// one bad moment must not take the bot down mid-song
process.on('unhandledRejection', (e) => console.error(`unexpected: ${e?.stack ?? e}`));
process.on('uncaughtException', (e) => console.error(`unexpected: ${e?.stack ?? e}`));
for (const sig of ['SIGINT', 'SIGTERM']) { process.off(sig, quit); process.on(sig, stop); }

console.log(generateDependencyReport().split('\n').filter((l) => /davey|aes-256-gcm|voice:/.test(l)).join(' | '));
client.login(TOKEN).catch((e) => {
  // stay up and quiet: leaving would have the container started again and again, knocking on Discord each time
  console.error(`could not log in to Discord: ${e.message}. Is DISCORD_TOKEN right? Fix it and start this again.`);
  setInterval(() => {}, 1 << 30);
});
