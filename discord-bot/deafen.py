"""Deafening players while they play, and above all undeafening them afterwards.

The overlay says who is in a song right now (an "order", about once a second). Whoever of them sits in the
players' voice channel is server-deafened, and undeafened the moment the overlay stops naming them: the song
ended, was cancelled, they finished or failed, the match changed, the feature was switched off.

Undeafening is the part that must never be missed, so it does not depend on any one message arriving:

- Everyone this bot deafens is written to a file BEFORE Discord is asked ("owed"). A bot that is restarted, or
  crashes, reads the file and undeafens them.
- No fresh order for a few seconds (the overlay is down, restarting, unreachable): nobody is wanted deaf.
- An order carries the latest time its song can still be going; past it nobody is wanted deaf. And nobody stays
  deaf longer than MAX_S whatever the orders say.
- Someone who left voice while deaf cannot be changed (Discord refuses), so they stay owed and are undeafened the
  moment they are in a voice channel again, whichever channel; meanwhile Discord is asked now and then anyway, in
  case what this bot believes about who is connected is out of date.
- A failed undeafen is tried again every couple of seconds until it works.
- Anyone found server-deafened in the players' channel who should not be is undeafened too, whoever did it (a
  lost file, another bot, a slip of the hand).
- Stopping the bot (a restart, a deploy) undeafens everyone first.

Someone a person undeafened by hand during a song is left alone for the rest of that song.

Nothing here talks to Discord: `discord` is given (bot.py for the real thing, test_deafen.py for a pretend one).

    discord.state(uid)                 -> Voice(guild_id, channel_id, deaf) or None (not in voice, as far as is known)
    await discord.set_deaf(guild_id, uid, on, why)   raises with .code 40032 (not in voice), 10007 (left the server)
    discord.members(channel_id)        -> [(uid, guild_id, deaf)] the people in that channel
    store.load() -> the saved dict or None;  store.save(dict)

Ids are strings throughout. Times are seconds.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

STALE_S = 7.0           # no order for this long: the overlay is gone, nobody is wanted deaf
START_GRACE_S = 6.0     # after starting, wait this long for a first order before undeafening owed people
MAX_S = 20 * 60.0       # nobody stays deaf longer than this, whatever the orders say
RETRY_S = 2.0           # a failed change is tried again after this
ABSENT_RETRY_S = 15.0   # someone not in voice: ask Discord again this often anyway
JUST_UNDONE_S = 3.0     # Discord's own news of an undeafen lags a moment: do not "find" them deaf again meanwhile

NOT_IN_VOICE, UNKNOWN_MEMBER, UNKNOWN_USER, MISSING_PERMISSIONS, MISSING_ACCESS = 40032, 10007, 10013, 50013, 50001


@dataclass(frozen=True)
class Voice:
    """Where someone is in voice, and whether they are server-deafened."""
    guild_id: str
    channel_id: str
    deaf: bool


@dataclass
class Order:
    at: float
    run: str            # which song (changes with every start)
    ids: frozenset      # who is playing it right now
    until: float        # the latest moment it can still be going (unix seconds)
    room: str           # the players' voice channel
    on: bool            # the feature is switched on


class Deafener:
    def __init__(self, discord, store, now=time.time, log=lambda line: None):
        self.discord, self.store, self.now, self.log = discord, store, now, log
        saved = store.load() or {}
        # uid -> {"since", "run", "guild_id"}: everyone this bot has deafened and not yet undeafened
        self.owed: dict[str, dict] = dict(saved.get("owed") or {})
        # "run|uid" -> when: undeafened by a person, or timed out, during that song: not deafened again in it
        self.released: dict[str, float] = dict(saved.get("released") or {})
        self.room: str = saved.get("room") or ""      # the players' channel as last ordered (for when orders stop)
        self.last: Order | None = None
        self.tests: dict[str, float] = {}             # uid -> until: "deafen me for a moment" from the panel
        self.busy: dict[str, str] = {}                # uid -> "deafen" | "undeafen" while Discord is being asked
        self.next_try: dict[str, float] = {}          # uid -> not before
        self.undone: dict[str, float] = {}            # uid -> when this bot last undeafened them
        self.born = now()
        self.stopping = False
        self.last_release = None
        self.error = ""
        self._tasks: set[asyncio.Task] = set()

    # ------------------------------------------------------------------ what is wanted
    def _save(self) -> None:
        t = self.now()
        self.released = {k: at for k, at in self.released.items() if t - at <= MAX_S * 2}
        try:
            self.store.save({"owed": self.owed, "released": self.released, "room": self.room})
        except Exception as e:      # noqa: BLE001  a full disk must not stop anyone being undeafened
            self.error = f"cannot write the list of deafened people ({e})"
            self.log(f"deafen: {self.error}")

    def _fresh(self) -> bool:
        return self.last is not None and not self.stopping and self.now() - self.last.at <= STALE_S

    def _the_room(self) -> str:
        if self._fresh():
            return self.last.room if self.last.on else ""
        return self.room

    def wanted(self) -> dict[str, str]:
        """Who should be deaf this instant (uid -> song): in a song the overlay vouches for right now, and not
        let go by hand."""
        out: dict[str, str] = {}
        t = self.now()
        if self.stopping:
            return out
        o = self.last
        if self._fresh() and o.on and o.room and t < o.until:
            for uid in o.ids:
                if f"{o.run}|{uid}" not in self.released:
                    out[uid] = o.run
        for uid, until in list(self.tests.items()):
            if t < until:
                out[uid] = "test"
            else:
                del self.tests[uid]
        return out

    # ------------------------------------------------------------------ asking Discord
    def _ask(self, uid: str, guild_id: str, on: bool, why: str) -> None:
        self.busy[uid] = "deafen" if on else "undeafen"
        task = asyncio.ensure_future(self._do(uid, guild_id, on, why))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _do(self, uid: str, guild_id: str, on: bool, why: str) -> None:
        word = "deafen" if on else "undeafen"
        try:
            await self.discord.set_deaf(guild_id, uid, on, why)
        except Exception as e:      # noqa: BLE001  whatever went wrong, it is handled here and tried again
            self.busy.pop(uid, None)
            code = getattr(e, "code", None)
            if not on and code in (UNKNOWN_MEMBER, UNKNOWN_USER):      # they left the server: nothing is owed
                self.owed.pop(uid, None)
                self._save()
                self.log(f"deafen: {uid} is no longer in the server; nothing to undo")
                return
            if code == NOT_IN_VOICE:
                # not connected: Discord will not change them. Still owed (if deafened); tried again when back
                self.next_try[uid] = self.now() + ABSENT_RETRY_S
                if on:      # the deafen never happened
                    self.owed.pop(uid, None)
                    self._save()
                return
            self.next_try[uid] = self.now() + RETRY_S
            if code in (MISSING_PERMISSIONS, MISSING_ACCESS):
                self.error = ('the bot is not allowed to deafen people: give its role "Deafen Members" in the server '
                              "(or in the players' channel)")
                if on:      # never deafened, so nothing is owed; no hurry to ask again
                    self.owed.pop(uid, None)
                    self._save()
                    self.next_try[uid] = self.now() + 10.0
            else:
                self.error = f"Discord refused to {word} someone ({e}); trying again"
            self.log(f"deafen: could not {word} {uid}: {e}")
            return
        self.busy.pop(uid, None)
        self.next_try.pop(uid, None)
        if not on:
            self.owed.pop(uid, None)
            self.undone[uid] = self.now()
            self._save()
        if self.error and "cannot write" not in self.error:
            self.error = ""
        self.log(f"deafen: {word}ed {uid} ({why})")

    # ------------------------------------------------------------------ making Discord match what is wanted
    def tick(self) -> None:
        """Make Discord match what is wanted. Safe to call as often as anyone likes."""
        t = self.now()
        # just started and the overlay has not spoken yet: a song may be going on, so do not undeafen and deafen
        # again a second later. After the grace, silence means nobody is wanted deaf.
        if self.last is None and not self.stopping and t - self.born < START_GRACE_S:
            return
        want, room = self.wanted(), self._the_room()

        for uid, run in want.items():
            st = self.discord.state(uid)
            if not room or st is None or st.channel_id != room:      # only in the players' channel
                continue
            if st.deaf:
                # deaf already (by this bot before its file was lost, or by someone else): ours to undo afterwards
                if uid not in self.owed:
                    self.owed[uid] = {"since": t, "run": run, "guild_id": st.guild_id}
                    self._save()
                continue
            if uid in self.busy or t < self.next_try.get(uid, 0):
                continue
            self.owed[uid] = {"since": self.owed.get(uid, {}).get("since", t), "run": run, "guild_id": st.guild_id}
            self._save()                                             # on file before Discord is asked
            self._ask(uid, st.guild_id, True, "a test from the overlay panel" if run == "test" else "playing a song")

        for uid, o in list(self.owed.items()):
            st = self.discord.state(uid)
            too_long = t - o["since"] > MAX_S
            if uid in want and room and st is not None and st.channel_id == room and not too_long:
                continue                                             # rightly deaf
            if too_long and uid in want:
                self.released[f"{want[uid]}|{uid}"] = t
                self._save()
                self.log(f"deafen: {uid} has been deaf for too long; undeafening")
            if uid in self.busy or t < self.next_try.get(uid, 0):
                continue
            if st is None:      # not in voice as far as is known: ask anyway, but seldom
                self.next_try[uid] = t + ABSENT_RETRY_S
            self._ask(uid, st.guild_id if st else o["guild_id"], False, "no longer playing")

        # anyone else deaf in the players' channel who should not be
        if room:
            for uid, guild_id, deaf in self.discord.members(room):
                if (deaf and uid not in self.owed and uid not in want and uid not in self.busy
                        and t - self.undone.get(uid, -1e12) > JUST_UNDONE_S):
                    self.owed[uid] = {"since": t, "run": "found", "guild_id": guild_id}
                    self._save()
                    self.log(f"deafen: {uid} is server-deafened in the players' channel without a song; undeafening")
                    self._ask(uid, guild_id, False, "deafened in the players' channel with no song playing")

    # ------------------------------------------------------------------ what happens
    def order(self, o: dict) -> None:
        """From the overlay, about once a second: {run, ids, until, room, on, release}. `until` is unix ms."""
        nxt = Order(at=self.now(), run=str(o.get("run") or ""), ids=frozenset(str(i) for i in o.get("ids") or []),
                    until=float(o.get("until") or 0) / 1000.0, room=str(o.get("room") or ""), on=bool(o.get("on")))
        kept = nxt.room if nxt.on else ""      # remembered for when orders stop; nothing to watch while switched off
        if kept != self.room:
            self.room = kept
            self._save()
        # "Undeafen everyone now" in the panel: everyone in this song is let go for the rest of it
        release = o.get("release") or 0
        if self.last_release is not None and release != self.last_release:
            for uid in set(nxt.ids) | set(self.owed):
                self.released[f"{nxt.run}|{uid}"] = self.now()
            self.tests.clear()
            self._save()
            self.log("deafen: everyone released from the panel")
        self.last_release = release
        self.last = nxt
        self.tick()

    def test(self, uid: str, seconds: float = 4.0) -> None:
        """Deafen one person for a moment (the panel's "Test"), to see that the bot may."""
        self.tests[str(uid)] = self.now() + min(10.0, max(1.0, seconds))
        self.tick()

    def voice_changed(self, uid: str, before: Voice | None, after: Voice | None) -> None:
        """Discord says someone's voice state changed."""
        self.next_try.pop(uid, None)      # they may be back: do not wait out a retry
        # undeafened by a person (not by us) while we had them deaf: leave them be for the rest of this song
        if before and before.deaf and after and not after.deaf and uid in self.owed and self.busy.get(uid) != "undeafen":
            run = self.owed[uid]["run"]
            self.released[f"{run}|{uid}"] = self.now()
            if self._fresh():
                self.released[f"{self.last.run}|{uid}"] = self.now()
            del self.owed[uid]
            self._save()
            self.log(f"deafen: {uid} was undeafened by someone; left alone for the rest of this song")
        self.tick()

    async def shutdown(self, wait: float = 6.0, sleep=asyncio.sleep) -> list[str]:
        """The bot is stopping: undeafen everyone who can be, waiting a few seconds for Discord. Answers who is
        still owed (people not in voice: they stay on file for the next start)."""
        self.stopping = True
        end = self.now() + wait
        while True:
            self.next_try.clear()
            self.tick()
            await sleep(0.05)
            while self.busy and self.now() < end:
                await sleep(0.05)
            reachable = [uid for uid in self.owed if self.discord.state(uid) is not None]
            if not reachable or self.now() >= end:
                return list(self.owed)
            await sleep(0.3)

    def status(self) -> dict:
        return {"owed": list(self.owed), "error": self.error}
