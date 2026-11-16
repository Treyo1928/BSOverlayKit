// The bot's ears: the only part of the Discord bot that is in a voice channel.
//   It sits (muted) in the casting channel the main bot (../bot.py) follows, while somebody else is in it, and
//   tells the overlay two things: who is talking (their ring lights up on the Casters scene), and what they say
//   (the casters' voices on stream, mixed in the panel: Sound). Nothing is recorded, kept or decoded here: each
//   packet goes straight on and is gone. VOICE_AUDIO=off: no sound is passed on at all, only who is talking.
//
//   It is JavaScript because hearing a Discord voice channel means taking part in its end-to-end encryption, and
//   this library is the one that does that dependably. Everything else the bot does is in ../bot.py.
//
//   Settings (environment, or ../.env): DISCORD_TOKEN, OVERLAY_URL, OVERLAY_CODE; optional IGNORE_USER_IDS,
//   VOICE_AUDIO. It logs in as the same bot as bot.py.
import { readFileSync } from 'node:fs';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { EndBehaviorType, entersState, generateDependencyReport, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';

const env = (k, d = '') => (process.env[k] ?? d).trim();
const TOKEN = env('DISCORD_TOKEN');
const IGNORE = new Set(env('IGNORE_USER_IDS').split(/[\s,]+/).filter(Boolean));
const OVERLAY = env('OVERLAY_URL', 'http://127.0.0.1:8095').replace(/\/+$/, '');
const AUDIO = !/^(off|0|no|false)$/i.test(env('VOICE_AUDIO', 'on'));
let OVERLAY_CODE = env('OVERLAY_CODE');
if (!OVERLAY_CODE) {
  try { OVERLAY_CODE = JSON.parse(readFileSync(new URL(`../../${env('KIT_DATA', 'data')}/secrets.json`, import.meta.url))).hostCode; } catch { /* not beside an overlay */ }
}

// asked to stop before there is anything to close (as a container's first process, Node ignores these otherwise)
const quit = () => process.exit(0);
process.on('SIGINT', quit);
process.on('SIGTERM', quit);

if (!TOKEN) {
  // Not set up: stay quiet and stay up (a container that exits is started again, over and over).
  console.log('voice: no DISCORD_TOKEN, so nothing to do. Set it (see discord-bot/README.md) and start this again.');
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}
if (!OVERLAY_CODE) {
  console.error('voice: no OVERLAY_CODE (the overlay panel\'s login code), so it cannot tell the overlay anything.');
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
    if (overlay.down) { console.log('overlay reachable again'); overlay.down = ''; }
    return await r.json().catch(() => ({}));
  } catch (e) {
    if (overlay.down !== e.message) console.warn(`overlay not reachable (${OVERLAY}): ${e.message}`);
    overlay.down = e.message;
    return null;
  }
}

// the line the sound goes down: a WebSocket to the overlay, opened again whenever it drops
let line = null, lineOk = false, lineSaid = '';
function openLine() {
  if (!AUDIO) return;
  const ws = line = new WebSocket(`${OVERLAY.replace(/^http/, 'ws')}/ws/voice`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(OVERLAY_CODE);
  ws.onmessage = () => { lineOk = true; if (lineSaid !== 'up') console.log('voices: connected to the overlay'); lineSaid = 'up'; };
  ws.onerror = () => {};
  ws.onclose = () => {
    if (lineSaid !== 'down') console.warn('voices: no line to the overlay (trying again every 3 s)');
    lineSaid = 'down'; lineOk = false;
    if (line === ws) setTimeout(openLine, 3000);
  };
}
const idBytes = new Map();
/** One Opus packet from one person: [length of their id][id][packet], unless the line is down or backed up. */
function sendVoice(uid, packet) {
  if (!lineOk || line.readyState !== 1 || line.bufferedAmount > 64_000 || IGNORE.has(uid)) return;
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

// ---------------------------------------------------------------- in the channel while someone else is
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const talking = new Set();
let channelId = '';                  // the channel to listen in (the main bot's choice, by way of the overlay)
let connection = null, problem = '';

function leave() {
  connection?.destroy();
  connection = null;
  for (const uid of talking) overlay({ action: 'speaking', id: uid, on: false });
  talking.clear();
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
    .then(() => { problem = ''; console.log(`listening in #${channel.name} (${channel.guild.name})`); })
    .catch(() => {
      if (connection !== mine) return;
      const can = channel.permissionsFor(client.user);
      const missing = ['ViewChannel', 'Connect'].filter((p) => !can?.has(p));
      problem = missing.length ? `the bot lacks ${missing.join(' and ')} in that channel (channel or role permissions in Discord)`
        : channel.full ? 'the channel is full'
        : `it got as far as: ${steps.join(' -> ') || 'nothing'} (stuck at "signalling": Discord never answered; at "connecting": the voice link itself, UDP out of this machine or the encryption library)`;
      console.error(`could not join voice in #${channel.name}: ${problem}. Casters still show; their rings will not light up and they are not heard. Trying again in 60 s.`);
      setTimeout(() => { if (connection === mine) { leave(); sit(); } }, 60_000);
    });
}

/** Ask the overlay which channel the main bot follows (every 3 s), and say how the listening stands. */
async function ask() {
  const said = await overlay({ action: 'discordVoice', listening: !!connection && !problem, problem });
  if (!said) return;
  const next = client.channels.cache.get(said.channelId)?.isVoiceBased?.() ? said.channelId : '';
  if (next === channelId) return;
  console.log(next ? `listening channel: ${client.channels.cache.get(next).name}` : 'no channel to listen in');
  leave();
  problem = '';
  channelId = next;
  sit();
}

client.once(Events.ClientReady, async () => {
  console.log(`voice: logged in as ${client.user.tag}`);
  openLine();
  await ask();
  setInterval(ask, 3_000);
});
client.on(Events.VoiceStateUpdate, (before, after) => {
  if (before.channelId === channelId || after.channelId === channelId) sit();
});
client.on(Events.Error, (e) => console.error(`discord: ${e.message}`));

const stop = async () => { leave(); await client.destroy().catch(() => {}); process.exit(0); };
for (const sig of ['SIGINT', 'SIGTERM']) { process.off(sig, quit); process.on(sig, stop); }
// one bad moment must not take the listening down mid-cast
process.on('unhandledRejection', (e) => console.error(`unexpected: ${e?.stack ?? e}`));

console.log(generateDependencyReport().split('\n').filter((l) => /davey|aes-256-gcm|voice:/.test(l)).join(' | '));
client.login(TOKEN).catch((e) => {
  // stay up and quiet: leaving would have the container started again and again, knocking on Discord each time
  console.error(`could not log in to Discord: ${e.message}. Is DISCORD_TOKEN right? Fix it and start this again.`);
  setInterval(() => {}, 1 << 30);
});
