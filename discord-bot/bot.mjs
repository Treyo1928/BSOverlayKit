// The caster bot.
//   Whoever is in the casting voice channel shows on the overlay's Casters scene (in the order they joined, with
//   their Discord name and picture), and their ring lights up while they talk. Nobody is set up by hand: joining the
//   channel is all a caster does.
//
//   Which channel: the one picked in the overlay panel's Casters card (the bot tells the overlay which voice channels
//   it can see). Until one is picked there: CASTER_CHANNEL_ID if set, else the first voice channel with "cast" in
//   its name.
//
//   The bot sits in the channel muted. It never records or decodes anyone's audio: Discord's voice library only
//   notices that packets are arriving from someone, and that is all "talking" means here.
//
//   Settings (environment, or .env beside this file): DISCORD_TOKEN, OVERLAY_URL, OVERLAY_CODE; optional
//   CASTER_CHANNEL_ID, IGNORE_USER_IDS. See README.md.
import { readFileSync } from 'node:fs';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { entersState, generateDependencyReport, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';

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
  joinedAt.clear();
}
function join(id) {
  leave();
  channelId = id;
  const channel = client.channels.cache.get(id);
  if (!channel?.isVoiceBased?.()) return;
  const mine = connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,      // must receive packets to know who is talking
    selfMute: true,
  });
  mine.receiver.speaking.on('start', (uid) => { if (!talking.has(uid)) { talking.add(uid); overlay({ action: 'speaking', id: uid, on: true }); } });
  mine.receiver.speaking.on('end', (uid) => { talking.delete(uid); overlay({ action: 'speaking', id: uid, on: false }); });
  mine.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // a move between voice servers reconnects by itself; anything else, join again
      await Promise.race([entersState(mine, VoiceConnectionStatus.Signalling, 5_000), entersState(mine, VoiceConnectionStatus.Connecting, 5_000)]);
    } catch {
      if (connection !== mine) return;          // the channel was changed meanwhile
      console.warn('voice disconnected, joining again in 5 s');
      setTimeout(() => connection === mine && join(channelId), 5_000);
    }
  });
  entersState(mine, VoiceConnectionStatus.Ready, 20_000)
    .then(() => console.log(`listening in #${channel.name} (${channel.guild.name})`))
    // without voice the list of who is there still works (that comes from the server, not the voice link): only the
    // talking rings do not
    .catch((e) => console.error(`could not join voice in #${channel.name}: ${e.message}. Casters still show; their rings will not light up.`));
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
    if (next) join(next); else { leave(); channelId = ''; }
    await sendCasters(true);
  } else if (lastSent === null) await sendCasters(true);
}

client.once(Events.ClientReady, async () => {
  console.log(`logged in as ${client.user.tag}; in ${client.guilds.cache.size} server(s), ${voiceChannels().length} voice channel(s) visible`);
  if (!client.guilds.cache.size) console.warn('the bot is in no server yet: invite it (see README.md)');
  await heartbeat();
  setInterval(heartbeat, 8_000);
});
client.on(Events.VoiceStateUpdate, (before, after) => {
  if (before.channelId === channelId || after.channelId === channelId) sendCasters();
});
client.on(Events.GuildMemberUpdate, () => sendCasters());      // a name or picture changed while in the channel
client.on(Events.Error, (e) => console.error(`discord: ${e.message}`));

const stop = async () => { leave(); await client.destroy().catch(() => {}); process.exit(0); };
for (const sig of ['SIGINT', 'SIGTERM']) { process.off(sig, quit); process.on(sig, stop); }

console.log(generateDependencyReport().split('\n').filter((l) => /davey|aes-256-gcm|voice:/.test(l)).join(' | '));
client.login(TOKEN).catch((e) => {
  // stay up and quiet: leaving would have the container started again and again, knocking on Discord each time
  console.error(`could not log in to Discord: ${e.message}. Is DISCORD_TOKEN right? Fix it and start this again.`);
  setInterval(() => {}, 1 << 30);
});
