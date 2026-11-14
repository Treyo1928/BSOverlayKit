# The caster bot

Whoever is in the casting voice channel on Discord is on the overlay's **Casters** scene, in the order they joined,
with their Discord name and picture. Their ring lights up while they talk. Nobody is set up by hand: a caster joins
the channel and is on stream; they leave and are gone.

The bot sits in the channel muted. It never records or decodes anyone's voice: Discord's voice library only notices
that sound packets are arriving from someone, and that is all "talking" means here.

## One-time setup (about 5 minutes)

1. **Create the bot.** <https://discord.com/developers/applications> → **New Application** → name it (e.g. "MSU
   Caster Bot") → **Create**.
2. **Get its token.** **Bot** tab → **Reset Token** → copy it. Treat it like a password: anyone with it can act as
   the bot. No "Privileged Gateway Intents" need switching on.
3. **Invite it to the server.** **OAuth2** → **URL Generator**: scope **bot**; bot permissions **View Channels**
   and **Connect** (nothing else). Open the link it makes, pick the server, **Authorize**. (You need "Manage Server"
   there, or ask an admin to open the link.)
4. **Give the overlay the token.**
   - On the server (docker compose): put `DISCORD_TOKEN=<the token>` in the overlay's `.env`, then
     `docker compose up -d`.
   - On your own PC with `start.sh`: `cp .env.example .env` in this folder and set `DISCORD_TOKEN` there.

That is all. In the overlay panel, the **Casters** card now says the bot is connected and lists the voice channels
it can see: **pick the casting channel there**. Until you do, the bot follows the first voice channel with "cast"
in its name, if there is one.

## Using it

- **Casters card → Take the casters from the Discord voice channel**: on is the bot; off lets you type casters in by
  hand (for when Discord or the bot is down).
- **Voice channel**: which channel the bot sits in. Change it any time; the bot moves within a few seconds.
- **On stream** beside each person in the channel: untick someone who is in the channel but is not a caster (a
  producer, someone listening in). It is remembered.

## Check it works

1. Open the panel, switch to the **Casters** scene, pick the channel.
2. Join that voice channel. Within a second or two your picture and name appear. Talk: your ring glows.
3. Have someone else join and leave: the layout follows.

Problems: the bot's log (`docker compose logs casters`, or `logs/discord-bot.log` under `start.sh`) says what is
wrong in plain words: no token, a token Discord refuses, a bot that is in no server yet, a channel it cannot see
(it needs View Channels and Connect there). If it cannot join voice but can see the channel, casters still appear;
only the talking rings stay dark.

## Running it on its own

```bash
npm install && npm start      # reads .env here; the overlay must already be running
```
