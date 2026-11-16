"""The overlay's Discord bot.

Casters: whoever is in the casting voice channel shows on the overlay's Casters scene (in the order they joined,
with their Discord name and picture). Nobody is set up by hand: joining the channel is all a caster does.

Players: while a TournamentAssistant song is being played, the players in it who sit in the players' voice
channel are server-deafened, and undeafened when it ends, is cancelled or they finish. How it makes sure nobody is
left deaf is in deafen.py. The bot does not sit in that channel; it needs "Deafen Members" there.

Which channels: picked in the overlay panel (the bot tells the overlay which voice channels it can see). Until a
casting channel is picked there: CASTER_CHANNEL_ID if set, else the first voice channel with "cast" in its name.

This program never joins a voice channel and never touches sound. Hearing the casters (the talking rings, their
voices on stream) is the small program in voice/, which logs in as the same bot.

Settings (environment, or .env beside this file): DISCORD_TOKEN, OVERLAY_URL, OVERLAY_CODE; optional
CASTER_CHANNEL_ID, IGNORE_USER_IDS, STATE_DIR. See README.md.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import signal
import sys
import time
from pathlib import Path

import aiohttp
import discord

from deafen import Deafener, Voice

HERE = Path(__file__).resolve().parent


def load_env_file() -> None:
    """Settings from .env beside this file, for running it by hand. What the environment already has wins."""
    try:
        lines = (HERE / ".env").read_text().splitlines()
    except OSError:
        return
    for line in lines:
        m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if m and not line.lstrip().startswith("#"):
            os.environ.setdefault(m[1], m[2].strip("'\""))


load_env_file()


def env(key: str, default: str = "") -> str:
    return (os.environ.get(key) or default).strip()


def say(line: str) -> None:
    print(line, flush=True)


TOKEN = env("DISCORD_TOKEN")
IGNORE = set(filter(None, re.split(r"[\s,]+", env("IGNORE_USER_IDS"))))      # people who are never casters
OVERLAY = env("OVERLAY_URL", "http://127.0.0.1:8095").rstrip("/")
OVERLAY_CODE = env("OVERLAY_CODE")
STATE_FILE = Path(env("STATE_DIR") or HERE / "state") / "deafened.json"
if not OVERLAY_CODE:
    try:      # run beside an overlay: its own login code
        OVERLAY_CODE = json.loads((HERE.parent / env("KIT_DATA", "data") / "secrets.json").read_text())["hostCode"]
    except (OSError, ValueError, KeyError):
        pass

intents = discord.Intents.none()
intents.guilds = True
intents.voice_states = True
client = discord.Client(intents=intents)
http: aiohttp.ClientSession | None = None


# ---------------------------------------------------------------------- the overlay
overlay_down = ""


async def overlay(action: dict) -> dict | None:
    """Send the overlay an action; answers what it said back (None when it could not be reached or refused)."""
    global overlay_down
    try:
        async with http.post(f"{OVERLAY}/api/action", json=action, headers={"authorization": f"Bearer {OVERLAY_CODE}"},
                             timeout=aiohttp.ClientTimeout(total=5)) as r:
            if r.status != 200:
                say(f"overlay {action['action']}: {r.status} {(await r.text())[:200]}")
                return None
            if overlay_down:
                say("overlay reachable again")
                overlay_down = ""
            try:
                return await r.json()
            except ValueError:
                return {}
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        if overlay_down != str(e):
            say(f"overlay not reachable ({OVERLAY}): {e}")
        overlay_down = str(e) or "unreachable"
        return None


# ---------------------------------------------------------------------- voice channels and who is in them
def voice_channels() -> list:
    return [c for g in client.guilds for c in (*g.voice_channels, *g.stage_channels)]


def channel(channel_id: str):
    c = client.get_channel(int(channel_id)) if channel_id.isdigit() else None
    return c if isinstance(c, (discord.VoiceChannel, discord.StageChannel)) else None


def people_in(c) -> list[tuple[discord.Member, discord.VoiceState]]:
    """The people (not bots) in a voice channel. Someone Discord has told us is there but nothing more about is
    left out: there is no name or picture to show for them."""
    out = []
    for uid, state in c.voice_states.items():
        member = c.guild.get_member(uid)
        if member is not None and not member.bot:
            out.append((member, state))
    return out


def voice_of(uid: str) -> Voice | None:
    """Where someone is in voice, in any server the bot is in (needs nothing known about them but that)."""
    if not uid.isdigit():
        return None
    for c in voice_channels():
        state = c.voice_states.get(int(uid))
        if state is not None:
            return Voice(str(c.guild.id), str(c.id), bool(state.deaf))
    return None


# ---------------------------------------------------------------------- casters
following = ""                       # the casting channel being followed
joined_at: dict[int, float] = {}     # user id -> when they joined, so casters keep their places
last_sent: str | None = None


def wanted_channel(chosen: str) -> str:
    """The channel to follow: the panel's choice, else the one in the settings, else one that sounds like casting."""
    known = {str(c.id) for c in voice_channels()}
    for candidate in (chosen, env("CASTER_CHANNEL_ID")):
        if candidate and candidate in known:
            return candidate
    return next((str(c.id) for c in voice_channels() if re.search("cast", c.name, re.I)), "")


def casters_now() -> list[dict]:
    c = channel(following)
    if c is None:
        return []
    people = [m for m, _ in people_in(c) if str(m.id) not in IGNORE]
    for m in people:
        joined_at.setdefault(m.id, time.time())
    for uid in [uid for uid in joined_at if all(m.id != uid for m in people)]:
        del joined_at[uid]
    people.sort(key=lambda m: joined_at[m.id])
    return [{"id": str(m.id), "name": m.display_name, "handle": f"@{m.name}",
             "avatar": m.display_avatar.replace(format="png", size=256).url} for m in people]


async def send_casters(force: bool = False) -> None:
    global last_sent
    casters = casters_now()
    as_json = json.dumps(casters)
    if as_json == last_sent and not force:
        return
    last_sent = as_json
    say(f"casters: {', '.join(c['name'] for c in casters) or '(nobody)'}")
    await overlay({"action": "discordCasters", "casters": casters})


async def heartbeat() -> None:
    """Tell the overlay the bot is here and what it can see; follow the channel the panel has picked. Every 8 s."""
    global following, last_sent
    was_down = bool(overlay_down)
    said = await overlay({
        "action": "discordBot", "bot": str(client.user or ""), "following": following,
        "channels": [{"id": str(c.id), "name": c.name, "guild": c.guild.name, "people": len(people_in(c))} for c in voice_channels()],
    })
    if said is None:
        return
    if was_down:
        last_sent = None      # the overlay may have restarted and forgotten who is in the channel
    nxt = wanted_channel(str(said.get("channelId") or ""))
    if nxt != following:
        following = nxt
        joined_at.clear()      # another channel: the order people joined starts again
        say(f"following {channel(nxt).name}" if nxt else "no voice channel to follow: pick one in the overlay panel (Casters)")
        await send_casters(force=True)
    elif last_sent is None:
        await send_casters(force=True)


# ---------------------------------------------------------------------- players: deaf while they play
class DeafenStore:
    def load(self):
        try:
            return json.loads(STATE_FILE.read_text())
        except (OSError, ValueError):
            return None

    def save(self, state: dict) -> None:
        # a whole new file swapped into place: a crash mid-write leaves the old one, never half of one
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(state))
        os.replace(tmp, STATE_FILE)


class DeafenDiscord:
    state = staticmethod(voice_of)

    async def set_deaf(self, guild_id: str, uid: str, on: bool, why: str) -> None:
        # straight to Discord's API by id: works whatever this bot has or has not got cached about the person
        await client.http.edit_member(int(guild_id), int(uid), reason=f"Overlay bot: {why}", deaf=on)

    def members(self, channel_id: str) -> list[tuple[str, str, bool]]:
        c = channel(channel_id)
        if c is None:
            return []
        bots = {m.id for m in c.guild.members if m.bot}
        return [(str(uid), str(c.guild.id), bool(state.deaf)) for uid, state in c.voice_states.items() if uid not in bots]


deafener = Deafener(DeafenDiscord(), DeafenStore(), log=say)
room_wanted = ""                     # the players' channel picked in the panel
line: aiohttp.ClientWebSocketResponse | None = None
room_sent = ""


async def send_room(force: bool = False) -> None:
    """Tell the overlay who is in the players' channel and how the deafening stands (for the panel)."""
    global room_sent
    if line is None or line.closed:
        return
    c = channel(room_wanted)
    status = deafener.status()
    msg = json.dumps({
        "type": "room", "channelId": str(c.id) if c else "",
        "members": [{"id": str(m.id), "name": m.display_name, "handle": f"@{m.name}",
                     "avatar": m.display_avatar.replace(format="png", size=64).url, "deaf": bool(state.deaf)}
                    for m, state in (people_in(c) if c else [])],
        "may": bool(c and c.permissions_for(c.guild.me).deafen_members),
        "owed": status["owed"], "error": status["error"],
    })
    if msg == room_sent and not force:
        return
    room_sent = msg
    try:
        await line.send_str(msg)
    except (aiohttp.ClientError, ConnectionError):
        pass      # the line is going down; it is opened again below


async def keep_line() -> None:
    """The line the overlay's orders come down (who is playing a song right now, about once a second): a WebSocket,
    opened again whenever it drops. While it is down no orders arrive, and deafen.py undeafens everyone."""
    global line, room_wanted, room_sent
    said = ""
    while True:
        try:
            async with http.ws_connect(re.sub(r"^http", "ws", OVERLAY) + "/ws/bot", heartbeat=10) as ws:
                await ws.send_str(OVERLAY_CODE)
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    try:
                        m = json.loads(msg.data)
                    except ValueError:
                        continue
                    if line is not ws:      # the overlay's first words: the code was right
                        line, room_sent = ws, ""
                        if said != "up":
                            say("line to the overlay: connected")
                        said = "up"
                    if m.get("type") == "deafen":
                        room_wanted = str(m.get("room") or "")
                        deafener.order(m)
                        await send_room()
                    elif m.get("type") == "deafenTest":
                        deafener.test(str(m.get("id")), float(m.get("ms") or 4000) / 1000)
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
            pass
        line = None
        if said != "down":
            say("line to the overlay: down (trying again every second)")
        said = "down"
        await asyncio.sleep(1)


# ---------------------------------------------------------------------- Discord's news
def snap(member: discord.Member, state: discord.VoiceState) -> Voice | None:
    return Voice(str(member.guild.id), str(state.channel.id), bool(state.deaf)) if state.channel else None


@client.event
async def on_voice_state_update(member: discord.Member, before: discord.VoiceState, after: discord.VoiceState) -> None:
    if member.bot:
        return
    deafener.voice_changed(str(member.id), snap(member, before), snap(member, after))
    await send_room()
    if following and following in (str(getattr(before.channel, "id", "")), str(getattr(after.channel, "id", ""))):
        await send_casters()


started = False


@client.event
async def on_ready() -> None:
    global started
    say(f"logged in as {client.user}; in {len(client.guilds)} server(s), {len(voice_channels())} voice channel(s) visible")
    if not client.guilds:
        say("the bot is in no server yet: invite it (see README.md)")
    if started:      # Discord reconnected: nothing to start twice
        return
    started = True
    for job in (every(8, heartbeat), every(1, tick), every(5, lambda: send_room(force=True)), keep_line()):
        asyncio.create_task(job)


async def tick() -> None:
    deafener.tick()
    await send_room()


async def every(seconds: float, job) -> None:
    while True:
        try:
            await job()
        except Exception as e:      # noqa: BLE001  one bad moment must not stop the bot mid-song
            say(f"unexpected: {type(e).__name__}: {e}")
        await asyncio.sleep(seconds)


# ---------------------------------------------------------------------- start and stop
async def main() -> None:
    global http
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)
    if not TOKEN:
        # not set up: stay quiet and stay up (a container that exits is started again, over and over)
        say("discord bot: no DISCORD_TOKEN, so nothing to do. Set it (see discord-bot/README.md) and start this again.")
        await stop.wait()
        return
    if not OVERLAY_CODE:
        say("discord bot: no OVERLAY_CODE (the overlay panel's login code), so it cannot tell the overlay anything.")
        sys.exit(2)
    discord.utils.setup_logging(level=logging.WARNING)
    http = aiohttp.ClientSession()

    async def run() -> None:
        try:
            await client.start(TOKEN)
        except discord.LoginFailure as e:
            # stay up and quiet: leaving would have the container started again and again, knocking on Discord each time
            say(f"could not log in to Discord: {e} Is DISCORD_TOKEN right? Fix it and start this again.")

    running = asyncio.create_task(run())
    await stop.wait()
    # nobody is left deaf because the bot was restarted: undo them all first (a few seconds at most)
    left = await deafener.shutdown()
    if left:
        say(f"stopping with {len(left)} player(s) still server-deafened and not in voice; they are on file and are "
            "undeafened when the bot is back and they are")
    await client.close()
    running.cancel()
    await http.close()


if __name__ == "__main__":
    asyncio.run(main())
