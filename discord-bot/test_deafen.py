"""Every way a player could be left deaf, against a pretend Discord.      python -m unittest -v   (in this folder)"""
import asyncio
import json
import unittest

from deafen import ABSENT_RETRY_S, MAX_S, STALE_S, START_GRACE_S, Deafener, Voice

ROOM, OTHER, G = "room", "other", "guild"


class Refused(Exception):
    def __init__(self, text, code=None):
        super().__init__(text)
        self.code = code


async def settle():
    for _ in range(30):
        await asyncio.sleep(0)


class World:
    """A pretend Discord server: who is in which channel, who is server-deafened; calls can be made to fail."""

    def __init__(self, file=None, people=None, t=1_000_000.0):
        self.t, self.people, self.calls, self.disk = t, people if people is not None else {}, [], file
        self.fail = None            # (uid, on) -> an exception to raise, or None
        self.gate = None            # an asyncio.Event: Discord answers only once it is set
        self.blind = False          # the bot believes nobody is in voice (a missed event)
        self.d = None

    # --- what people do
    def snap(self, uid):
        p = self.people.get(uid)
        return Voice(G, p["channel"], p["deaf"]) if p and p["channel"] else None

    def join(self, uid, channel=ROOM):
        before = self.snap(uid)
        self.people.setdefault(uid, {"deaf": False, "here": True, "channel": None})["channel"] = channel
        if self.d:
            self.d.voice_changed(uid, before, self.snap(uid))

    def leave(self, uid):
        before = self.snap(uid)
        self.people[uid]["channel"] = None
        if self.d:
            self.d.voice_changed(uid, before, None)

    def quit_server(self, uid):
        self.people[uid].update(channel=None, here=False)

    def by_hand(self, uid, deaf):
        before = self.snap(uid)
        self.people[uid]["deaf"] = deaf
        self.d.voice_changed(uid, before, self.snap(uid))

    def deaf(self, *uids):
        got = [self.people[u]["deaf"] for u in uids]
        return got[0] if len(got) == 1 else got

    # --- what the bot may ask (the `discord` and `store` given to Deafener)
    def state(self, uid):
        return None if self.blind else self.snap(uid)

    def members(self, channel):
        return [(uid, G, p["deaf"]) for uid, p in self.people.items() if p["channel"] == channel]

    async def set_deaf(self, guild_id, uid, on, why):
        self.calls.append(f"{'deafen' if on else 'undeafen'} {uid}")
        if self.gate:
            await self.gate.wait()
        if self.fail and (e := self.fail(uid, on)):
            raise e
        p = self.people.get(uid)
        if not p or not p["here"]:
            raise Refused("Unknown Member", 10007)
        if not p["channel"]:
            raise Refused("Target user is not connected to voice.", 40032)
        before = self.snap(uid)
        p["deaf"] = on
        after = self.snap(uid)
        asyncio.get_running_loop().call_soon(lambda: self.d.voice_changed(uid, before, after))   # Discord's own news of it

    def load(self):
        return json.loads(self.disk) if self.disk else None

    def save(self, o):
        self.disk = json.dumps(o)

    # --- running it
    def start(self):
        self.d = Deafener(self, self, now=lambda: self.t)
        return self.d

    def restarted(self, later):
        """A new bot process, the same Discord and the same file."""
        w = World(file=self.disk, people=self.people, t=self.t + later)
        w.start()
        return w

    async def run(self, seconds, order=None):
        """Let time pass, the overlay sending `order()` every second (None: the overlay is silent)."""
        left = seconds
        while left > 0:
            self.t += min(1.0, left)
            left -= 1.0
            if order:
                self.d.order(order())
            else:
                self.d.tick()
            await settle()

    def song(self, ids, **extra):
        return lambda: {"run": "map1", "ids": ids, "until": (self.t + 200) * 1000, "room": ROOM, "on": True, "release": 0, **extra}

    def on_file(self):
        return json.loads(self.disk)["owed"] if self.disk else {}


def quiet():
    return {"run": "", "ids": [], "until": 0, "room": ROOM, "on": True, "release": 0}


class DeafenTests(unittest.IsolatedAsyncioTestCase):
    def world(self, *in_room):
        w = World()
        for uid in in_room:
            w.join(uid)
        w.start()
        return w

    async def test_deafened_when_the_song_starts_undeafened_when_it_ends(self):
        w = self.world("a", "b", "to")
        await w.run(2, quiet)
        self.assertEqual(w.deaf("a", "b", "to"), [False, False, False])
        await w.run(1, w.song(["a", "b"]))
        self.assertEqual(w.deaf("a", "b", "to"), [True, True, False], "both players, not the TO")
        await w.run(30, w.song(["a", "b"]))
        self.assertEqual(sorted(w.calls), ["deafen a", "deafen b"], "asked once each, not over and over")
        await w.run(1, quiet)
        self.assertEqual(w.deaf("a", "b"), [False, False])
        self.assertEqual(w.on_file(), {}, "nothing left on file")

    async def test_a_cancelled_song_undeafens_at_once(self):
        w = self.world("a", "b")
        await w.run(3, w.song(["a", "b"]))
        w.t += 0.2
        w.d.order(quiet())
        await settle()
        self.assertEqual(w.deaf("a", "b"), [False, False])

    async def test_one_player_finishes_or_fails_first_only_they_are_undeafened(self):
        w = self.world("a", "b")
        await w.run(3, w.song(["a", "b"]))
        await w.run(2, w.song(["b"]))
        self.assertEqual(w.deaf("a", "b"), [False, True])
        await w.run(1, quiet)
        self.assertFalse(w.deaf("b"))

    async def test_left_voice_mid_song_and_it_ends_while_away_undeafened_on_joining_any_channel(self):
        w = self.world("a", "b")
        await w.run(3, w.song(["a", "b"]))
        w.leave("a")
        await w.run(5, w.song(["a", "b"]))
        await w.run(60, quiet)
        self.assertFalse(w.deaf("b"))
        self.assertTrue(w.deaf("a"), "Discord will not change someone who is not connected")
        self.assertIn("a", w.on_file(), "still on file")
        w.join("a", OTHER)
        await settle()
        self.assertFalse(w.deaf("a"), "undeafened on joining a different channel")
        self.assertEqual(w.on_file(), {})

    async def test_left_voice_mid_song_and_came_back_during_it_stays_deaf_until_the_end(self):
        w = self.world("a")
        await w.run(3, w.song(["a"]))
        w.leave("a")
        await w.run(4, w.song(["a"]))
        w.join("a")
        await w.run(2, w.song(["a"]))
        self.assertTrue(w.deaf("a"))
        await w.run(1, quiet)
        self.assertFalse(w.deaf("a"))

    async def test_moved_to_another_channel_mid_song_undeafened_there(self):
        w = self.world("a")
        await w.run(3, w.song(["a"]))
        w.join("a", OTHER)
        await settle()
        self.assertFalse(w.deaf("a"))
        await w.run(3, w.song(["a"]))
        self.assertFalse(w.deaf("a"), "not deafened outside the players' channel")
        w.join("a", ROOM)
        await w.run(1, w.song(["a"]))
        self.assertTrue(w.deaf("a"), "back in the channel during the song: deaf again")
        await w.run(1, quiet)
        self.assertFalse(w.deaf("a"))

    async def test_joined_the_channel_after_the_song_started_deafened_then(self):
        w = self.world("b")
        w.people["a"] = {"deaf": False, "here": True, "channel": None}
        await w.run(3, w.song(["a", "b"]))
        self.assertFalse(w.deaf("a"))
        w.join("a")
        await settle()
        self.assertTrue(w.deaf("a"))
        await w.run(1, quiet)
        self.assertFalse(w.deaf("a"))

    async def test_the_overlay_goes_silent_mid_song_everyone_is_undeafened(self):
        w = self.world("a", "b")
        await w.run(3, w.song(["a", "b"]))
        await w.run(STALE_S - 1)
        self.assertTrue(w.deaf("a"), "a short gap is ridden out")
        await w.run(3)
        self.assertEqual(w.deaf("a", "b"), [False, False])
        await w.run(2, w.song(["a", "b"]))
        self.assertEqual(w.deaf("a", "b"), [True, True], "the overlay is back and the song still on: deaf again")
        await w.run(1, quiet)
        self.assertEqual(w.deaf("a", "b"), [False, False])

    async def test_the_overlay_says_playing_for_ever_the_songs_own_end_time_undeafens(self):
        w = self.world("a")
        until = (w.t + 120) * 1000
        stuck = lambda: {"run": "map1", "ids": ["a"], "until": until, "room": ROOM, "on": True, "release": 0}  # noqa: E731
        await w.run(119, stuck)
        self.assertTrue(w.deaf("a"))
        await w.run(3, stuck)
        self.assertFalse(w.deaf("a"))
        await w.run(30, stuck)
        self.assertFalse(w.deaf("a"))

    async def test_nobody_stays_deaf_longer_than_the_limit_whatever_the_orders_say(self):
        w = self.world("a")
        forever = lambda: {"run": "map1", "ids": ["a"], "until": (w.t + 1e7) * 1000, "room": ROOM, "on": True, "release": 0}  # noqa: E731
        await w.run(MAX_S - 5, forever)
        self.assertTrue(w.deaf("a"))
        await w.run(10, forever)
        self.assertFalse(w.deaf("a"))
        await w.run(20, forever)
        self.assertFalse(w.deaf("a"), "and not deafened again for that song")

    async def test_the_bot_is_restarted_mid_song_stays_deaf_and_is_undeafened_at_the_end(self):
        w = self.world("a")
        await w.run(3, w.song(["a"]))
        w2 = w.restarted(4)
        await w2.run(1)
        self.assertTrue(w2.deaf("a"), "not undeafened before the overlay has had a chance to speak")
        await w2.run(5, w2.song(["a"]))
        self.assertTrue(w2.deaf("a"))
        self.assertEqual(w2.calls, [], "nothing needed doing")
        await w2.run(1, quiet)
        self.assertFalse(w2.deaf("a"))

    async def test_the_bot_crashed_mid_song_and_comes_back_after_it_ended(self):
        w = self.world("a", "b")
        await w.run(3, w.song(["a", "b"]))
        w.leave("b")
        w2 = w.restarted(600)
        await w2.run(2, quiet)
        self.assertFalse(w2.deaf("a"))
        self.assertTrue(w2.deaf("b"), "b is not in voice yet")
        w2.join("b", OTHER)
        await settle()
        self.assertFalse(w2.deaf("b"))

    async def test_the_bot_comes_back_and_the_overlay_never_answers(self):
        w = self.world("a")
        await w.run(3, w.song(["a"]))
        w2 = w.restarted(1)
        await w2.run(START_GRACE_S + 2)
        self.assertFalse(w2.deaf("a"))

    async def test_the_file_was_lost_someone_deaf_in_the_room_with_no_song_is_undeafened_anyway(self):
        w = World()
        w.join("a")
        w.people["a"]["deaf"] = True
        w.start()
        await w.run(2, quiet)
        self.assertFalse(w.deaf("a"))

    async def test_discord_fails_the_undeafen_tried_again_until_it_works(self):
        w = self.world("a")
        await w.run(3, w.song(["a"]))
        w.fail = lambda uid, on: None if on else Refused("503 Service Unavailable")
        await w.run(20, quiet)
        self.assertTrue(w.deaf("a"))
        self.assertGreaterEqual(w.calls.count("undeafen a"), 5, "kept trying")
        self.assertIn("undeafen", w.d.status()["error"])
        w.fail = None
        await w.run(3, quiet)
        self.assertFalse(w.deaf("a"))
        self.assertEqual(w.d.status()["error"], "")

    async def test_what_the_bot_believes_is_out_of_date_discord_is_asked_anyway(self):
        w = self.world("a")
        await w.run(3, w.song(["a"]))
        w.blind = True
        await w.run(ABSENT_RETRY_S + 3, quiet)
        self.assertFalse(w.deaf("a"))

    async def test_the_song_ends_while_the_deafen_is_still_on_its_way_to_discord(self):
        w = self.world("a")
        w.gate = asyncio.Event()
        w.t += 1
        w.d.order(w.song(["a"])())
        await settle()
        self.assertFalse(w.deaf("a"), "Discord has not answered yet")
        w.t += 0.5
        w.d.order(quiet())
        await settle()
        self.assertEqual(w.calls, ["deafen a"], "the undeafen waits for the deafen to land: they cannot cross")
        w.gate.set()
        await w.run(2, quiet)
        self.assertEqual(w.calls, ["deafen a", "undeafen a"], "the late deafen landed and was undone")
        self.assertFalse(w.deaf("a"))

    async def test_a_person_undeafens_a_player_by_hand_mid_song_left_alone_for_that_song(self):
        w = self.world("a", "b")
        await w.run(3, w.song(["a", "b"]))
        w.by_hand("a", False)
        await settle()
        await w.run(10, w.song(["a", "b"]))
        self.assertEqual(w.deaf("a", "b"), [False, True])
        await w.run(1, quiet)
        await w.run(2, w.song(["a", "b"], run="map2"))
        self.assertTrue(w.deaf("a"), "the next song deafens them as usual")
        await w.run(1, quiet)
        self.assertEqual(w.deaf("a", "b"), [False, False])

    async def test_undeafen_everyone_now_in_the_panel(self):
        w = self.world("a", "b")
        await w.run(3, w.song(["a", "b"]))
        await w.run(1, w.song(["a", "b"], release=1))
        self.assertEqual(w.deaf("a", "b"), [False, False])
        await w.run(10, w.song(["a", "b"], release=1))
        self.assertEqual(w.deaf("a", "b"), [False, False], "not deafened again in this song")

    async def test_switched_off_in_the_panel_mid_song_or_the_channel_unset(self):
        w = self.world("a")
        await w.run(3, w.song(["a"]))
        await w.run(1, w.song(["a"], on=False))
        self.assertFalse(w.deaf("a"))
        await w.run(2, w.song(["a"]))
        self.assertTrue(w.deaf("a"))
        await w.run(1, w.song(["a"], room=""))
        self.assertFalse(w.deaf("a"))

    async def test_the_players_channel_is_changed_mid_song(self):
        w = self.world("a")
        await w.run(3, w.song(["a"]))
        await w.run(1, w.song(["a"], room=OTHER))
        self.assertFalse(w.deaf("a"))

    async def test_the_bot_is_stopped_mid_song_everyone_is_undeafened_before_it_goes(self):
        w = self.world("a", "b", "c")
        await w.run(3, w.song(["a", "b", "c"]))
        w.leave("c")

        async def sleep(_):
            w.t += 0.05
            await settle()
        left = await w.d.shutdown(2, sleep)
        self.assertEqual(w.deaf("a", "b"), [False, False])
        self.assertEqual(left, ["c"], "c is not in voice: still on file for the next start")
        w2 = w.restarted(60)
        w2.join("c")
        await w2.run(1, quiet)
        self.assertFalse(w2.deaf("c"))

    async def test_a_player_left_the_server_while_deaf_forgotten_and_nothing_loops(self):
        w = self.world("a")
        await w.run(3, w.song(["a"]))
        w.quit_server("a")
        await w.run(5, quiet)
        self.assertEqual(w.on_file(), {})
        n = len(w.calls)
        await w.run(60, quiet)
        self.assertEqual(len(w.calls), n)

    async def test_the_bot_may_not_deafen_says_so_deafens_nobody_owes_nobody(self):
        w = self.world("a")
        w.fail = lambda uid, on: Refused("Missing Permissions", 50013)
        await w.run(5, w.song(["a"]))
        self.assertFalse(w.deaf("a"))
        self.assertIn("Deafen Members", w.d.status()["error"])
        self.assertEqual(w.on_file(), {})

    async def test_the_panels_test_deafens_for_a_moment_and_undoes_it(self):
        w = self.world("a")
        await w.run(2, quiet)
        w.d.test("a", 4)
        await settle()
        self.assertTrue(w.deaf("a"))
        await w.run(5, quiet)
        self.assertFalse(w.deaf("a"))

    async def test_someone_not_in_the_song_is_never_touched(self):
        w = World()
        w.join("a")
        w.join("to")
        w.join("x", OTHER)
        w.people["x"]["deaf"] = True
        w.start()
        await w.run(5, w.song(["a"]))
        await w.run(5, quiet)
        self.assertFalse(w.deaf("to"))
        self.assertTrue(w.deaf("x"), "a server-deafen in another channel is someone else's business")
        self.assertEqual(w.calls, ["deafen a", "undeafen a"])

    async def test_the_disk_is_full_people_are_still_undeafened(self):
        w = self.world("a")
        await w.run(3, w.song(["a"]))

        def full(_):
            raise OSError("No space left on device")
        w.save = full
        await w.run(2, quiet)
        self.assertFalse(w.deaf("a"))


if __name__ == "__main__":
    unittest.main()
