# The caster bot

Whoever is in the casting voice channel on Discord is on the overlay's **Casters** scene, in the order they joined,
with their Discord name and picture. Their ring lights up while they talk. Nobody is set up by hand: a caster joins
the channel and is on stream; they leave and are gone.

The bot sits in the channel muted, only while someone else is in it (it steps out of an empty channel and comes
back when someone joins), and passes what it hears to the overlay, so **the casters' voices are on
stream** without OBS capturing Discord. They are mixed in the panel's **Sound** card: one level for all casters and
one for each. Nothing is recorded or kept: each bit of sound goes straight to the stream's page and is gone. Tell
your casters the channel is live while the bot is in it. `VOICE_AUDIO=off` in `.env` stops the bot passing any sound
on (it then only knows who is talking).

## One-time setup (about 5 minutes)

1. **Create the bot.** <https://discord.com/developers/applications> → **New Application** → name it (e.g. "MSU
   Caster Bot") → **Create**.
2. **Get its token.** **Bot** tab → **Reset Token** → copy it. Treat it like a password: anyone with it can act as
   the bot. No "Privileged Gateway Intents" need switching on.
3. **Invite it to the server.** **OAuth2** → **URL Generator**: scope **bot**; bot permissions **View Channels**
   and **Connect** (nothing else). Open the link it makes, pick the server, **Authorize**. (You need "Manage Server"
   there, or ask an admin to open the link.)
4. **Give the bot the token.** In this folder: `cp .env.example .env`, and set `DISCORD_TOKEN` in `.env`. Then
   start it: on the server `docker compose up -d` in the overlay folder; on your own PC, `start.sh`. (On the server
   `OVERLAY_URL` and `OVERLAY_CODE` in the file are not used: compose fills them in.)

That is all. In the overlay panel, the **Casters** card now says the bot is connected and lists the voice channels
it can see: **pick the casting channel there**. Until you do, the bot follows the first voice channel with "cast"
in its name, if there is one.

## Using it

- **Casters card → Take the casters from the Discord voice channel**: on is the bot; off lets you type casters in by
  hand (for when Discord or the bot is down).
- **Voice channel**: which channel the bot sits in. Change it any time; the bot moves within a few seconds.
- **Sound card → Casters' voices on stream**: the switch for all voice-channel sound, a level for all casters
  together and one for each person (100 % is the voice as Discord sends it; up to 200 % lifts a quiet one).
- **Casters** above the panel's preview: hear the voices in your own browser. Off by default, and leave it off if
  you are in the voice channel yourself (you would hear everyone a moment late). It changes nothing on stream.
- OBS: the overlay's Browser Source needs **Control audio via OBS** ticked, as for the replays' sound. If OBS also
  captures Discord itself, the casters are heard twice: use one or the other.
- **On stream** beside each person in the channel: untick someone who is in the channel but is not a caster (a
  producer, someone listening in): they are not shown and not heard on stream. It is remembered.

## Check it works

1. Open the panel, switch to the **Casters** scene, pick the channel.
2. Join that voice channel. Within a second or two your picture and name appear. Talk: your ring glows.
3. Have someone else join and leave: the layout follows.

Problems: the bot's log (`docker compose logs casters`, or `logs/discord-bot.log` under `start.sh`) says what is
wrong in plain words: no token, a token Discord refuses, a bot that is in no server yet, a channel it cannot see
(it needs View Channels and Connect there). If it cannot join voice but can see the channel, casters still appear;
only the talking rings stay dark and no voices reach the stream.

## Running it on its own

```bash
npm install && npm start      # reads .env here; the overlay must already be running
```
