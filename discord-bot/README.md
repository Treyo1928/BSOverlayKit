# The Discord bot

One Discord bot that does three things for the stream:

1. **Casters on the Casters scene.** Whoever is in the casting voice channel is on the overlay's **Casters** scene, in
   the order they joined, with their Discord name and picture. Their ring lights up while they talk. Nobody is set
   up by hand: a caster joins the channel and is on stream; they leave and are gone.
2. **Casters' voices on stream.** What is said in the casting channel is passed to the overlay, so the voices are on
   stream without OBS capturing Discord. They are mixed in the panel's **Sound** card.
3. **Players deafened while they play.** In the players' voice channel (players and a TO talk there about picks and
   bans), each player is server-deafened from the moment their TournamentAssistant song starts until it ends, is
   cancelled, or they finish or fail. The TO is never touched.

It is one small Node program: `bot.mjs`, with the deafening's rules on their own in `deafen.mjs`.

Nothing is recorded or kept: each bit of sound goes straight to the stream's page and is gone. Tell your casters the
channel is live while the bot is in it. `VOICE_AUDIO=off` in `.env` stops any sound being passed on (the bot then
only knows who is talking). The bot sits in the casting channel muted, and only while someone else is in it. It
never sits in the players' channel.

## One-time setup (about 5 minutes)

1. **Create the bot.** <https://discord.com/developers/applications> → **New Application** → name it → **Create**.
2. **Get its token.** **Bot** tab → **Reset Token** → copy it. Treat it like a password: anyone with it can act as
   the bot. No "Privileged Gateway Intents" need switching on.
3. **Invite it to the server.** **OAuth2** → **URL Generator**: scope **bot**; bot permissions **View Channels**,
   **Connect** and **Deafen Members** (nothing else). Open the link it makes, pick the server, **Authorize**. (You
   need "Manage Server" there, or ask an admin to open the link.) A bot that is already in the server: give its role
   **Deafen Members** in Server Settings → Roles, or in the players' channel's own permissions.
4. **Give the bot the token.** In this folder: `cp .env.example .env`, and set `DISCORD_TOKEN` in `.env`. Then
   start it: on the server `docker compose up -d` in the overlay folder; on your own PC, `start.sh`. (On the server
   `OVERLAY_URL` and `OVERLAY_CODE` in the file are not used: compose fills them in.)

Then, in the overlay panel:

- **Casters** card: pick the casting voice channel. Until you do, the bot follows the first voice channel with
  "cast" in its name, if there is one.
- **Players' voice channel** card: pick the channel the players and the TO sit in.

## Casters

- **Casters card → Take the casters from the Discord voice channel**: on is the bot; off lets you type casters in by
  hand (for when Discord or the bot is down).
- **Voice channel**: which channel the bot follows. Change it any time; the bot moves within a few seconds.
- **On stream** beside each person in the channel: untick someone who is in the channel but is not a caster (a
  producer, someone listening in): they are not shown and not heard on stream. It is remembered.
- **Sound card → Casters' voices on stream**: the switch for all voice-channel sound, a level for all casters
  together and one for each person (100 % is the voice as Discord sends it; up to 200 % lifts a quiet one).
- **Casters** above the panel's preview: hear the voices in your own browser. Off by default, and leave it off if
  you are in the voice channel yourself (you would hear everyone a moment late). It changes nothing on stream.
- OBS: the overlay's Browser Source needs **Control audio via OBS** ticked, as for the replays' sound. If OBS also
  captures Discord itself, the casters are heard twice: use one or the other.

## Players deafened while they play

**Players' voice channel** card in the panel:

- **Voice channel the players and the TO sit in.** "None" switches the whole thing off.
- **Deafen the players while they play a song in TournamentAssistant.** Off: nobody is deafened, and anyone the bot
  had deafened is undeafened at once.
- **One row per player of the match** with the Discord account that is theirs. It is filled in by itself for players
  who sign in to the tournament site with Discord (the overlay's API key must belong to someone who runs the
  tournament). Otherwise pick them from the list: it holds whoever is in the channel right now, so they must have
  joined. The choice is remembered for that player. A player with no account beside their name is not deafened, and
  the card says so in red.
- **Test** deafens that one person for 4 seconds and undeafens them: do it once per player before the match, with
  them in the channel. It shows the bot is allowed to, and that you picked the right person.
- **Undeafen everyone now** undeafens everyone the bot has deafened and leaves them alone for the rest of the song
  being played. The next song deafens as usual.

Who is deafened, and when: only players **in the song**, only while they are **in this channel**, from the moment
the site reports the song as playing (not while the map loads). It needs a match run through TournamentAssistant on
the site, and the overlay following that match.

### Nobody is left deaf

Undeafening does not depend on any one thing going right. A player is undeafened when:

| What happens | Then |
|---|---|
| The song ends, or is cancelled, or the map is restarted | undeafened at once (within about a second) |
| They finish, fail or quit before the others | they are undeafened; the others stay deaf until they are done |
| They move to another voice channel mid-song | undeafened there; deafened again if they come back while it plays |
| They leave voice altogether mid-song | Discord will not change someone who is not connected. They are undeafened the moment they are in **any** voice channel again, however much later |
| Someone undeafens them by hand mid-song | the bot leaves them alone for the rest of that song |
| The overlay stops, restarts or cannot be reached | everyone is undeafened after 7 seconds of silence from it |
| The site stops reporting (it hung, its connection dropped) | everyone is undeafened: at the latest 35 s after the song's own length |
| The bot is restarted or stopped (a deploy) | it undeafens everyone first; anyone it could not reach is in a file and undeafened when it is back |
| The bot crashes | on starting again it reads the file and undeafens everyone not in a song |
| Discord refuses or is down | tried again every 2 seconds until it works |
| The file is lost | anyone server-deafened in the players' channel with no song playing is undeafened anyway |
| Anything else | nobody stays deaf longer than 20 minutes |

The last-but-one line has a consequence: **nobody stays server-deafened in the players' channel outside a song**,
whoever deafened them. Do not use that channel to server-deafen someone on purpose.

If a player is ever stuck anyway: right-click them in Discord → untick **Server Deafen**. The bot will not fight
you.

## Check it works

1. Open the panel, switch to the **Casters** scene, pick the casting channel. Join it: within a second or two your
   picture and name appear. Talk: your ring glows. Have someone else join and leave: the layout follows.
2. Pick the players' channel, have the players join it, set each one's account, press **Test** for each.

Problems: the log says what is wrong in plain words (`docker compose logs casters`, or `logs/discord-bot.log` under
`start.sh`): no token, a token Discord refuses, a bot
that is in no server yet, a channel it cannot see, a permission it lacks. The panel's Players card shows the
deafening's own problems in red. If the bot cannot join voice but can see the channel, casters still appear; only
the talking rings stay dark and no voices reach the stream.

## Running it by hand

```bash
npm install && npm start      # reads .env here; the overlay must already be running
npm test                      # the deafening: every row of the table above, against a pretend Discord
```
