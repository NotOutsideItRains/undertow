"""Tests that need no Discord: the queue rules, link parsing, and the client against a fake Undertow."""
import asyncio
import shlex
import subprocess
import types
import unittest
from unittest import mock

from aiohttp import web

import discord.gateway as gw

import identity
import lrc
import prefs
import tidalmatch
import weburl
from playqueue import PlayQueue
from undertow_client import TRACK_ID, Undertow, UndertowError, fetch_bot_token, label, mmss, parse_tidal_url


class Queue(unittest.TestCase):
    def q(self, n=3):
        q = PlayQueue()
        q.add([f"s{i}" for i in range(1, n + 1)])
        return q

    def test_order_and_end(self):
        q = self.q()
        self.assertEqual([q.advance() for _ in range(4)], ["s1", "s2", "s3", None])

    def test_loop_track_repeats_but_skip_moves_on(self):
        q = self.q(); q.advance(); q.cycle_loop("track")
        self.assertEqual(q.advance(), "s1")
        self.assertEqual(q.advance(skip=True), "s2")

    def test_loop_queue_wraps(self):
        q = self.q(2); q.cycle_loop("queue")
        self.assertEqual([q.advance() for _ in range(5)], ["s1", "s2", "s1", "s2", "s1"])

    def test_back_plays_the_previous_song_then_carries_on(self):
        q = self.q(); q.advance(); q.advance()  # now on s2, s1 behind
        self.assertTrue(q.back())
        self.assertEqual([q.advance() for _ in range(3)], ["s1", "s2", "s3"])

    def test_back_with_nothing_before(self):
        q = self.q(); q.advance()
        self.assertFalse(q.back())
        self.assertEqual(q.current, "s1")

    def test_restart_replays_current(self):
        q = self.q(); q.advance()
        self.assertTrue(q.restart())
        self.assertEqual([q.advance() for _ in range(2)], ["s1", "s2"])

    def test_cycle(self):
        q = PlayQueue()
        self.assertEqual([q.cycle_loop() for _ in range(3)], ["track", "queue", "off"])

    def test_remove_and_limit(self):
        q = self.q()
        self.assertEqual(q.remove(2), "s2")
        self.assertEqual(list(q.upcoming), ["s1", "s3"])
        with self.assertRaises(IndexError): q.remove(0)
        with self.assertRaises(IndexError): q.remove(3)
        small = PlayQueue(limit=2)
        self.assertEqual(small.add(["a", "b", "c"]), 2)

    def test_shuffle_keeps_everything(self):
        q = self.q(20); q.shuffle()
        self.assertEqual(sorted(q.upcoming), sorted(f"s{i}" for i in range(1, 21)))


class Identity(unittest.TestCase):
    def test_identify_packet_gets_the_vr_values(self):
        pkt = {"op": gw.DiscordWebSocket.IDENTIFY, "d": {"token": "t", "properties": {"os": "linux", "browser": "discord.py", "device": "discord.py"}}}
        out = identity.rewrite(pkt, identity.PLATFORMS["vr"])
        self.assertEqual(out["d"]["properties"], {"os": "Horizon OS", "browser": "Discord VR", "device": "Discord VR"})
        self.assertEqual(out["d"]["token"], "t")

    def test_other_packets_are_untouched(self):
        pkt = {"op": gw.DiscordWebSocket.HEARTBEAT, "d": 5}
        self.assertEqual(identity.rewrite(dict(pkt), identity.PLATFORMS["vr"]), pkt)

    def test_unknown_platform_changes_nothing(self):
        self.assertFalse(identity.apply("off")); self.assertFalse(identity.apply("nonsense"))

    def test_patch_applies_once_and_rewrites_what_is_sent(self):
        sent = []

        async def fake(self, data): sent.append(data)
        gw.DiscordWebSocket.send_as_json = fake  # stand in for the real sender
        self.assertTrue(identity.apply("vr")); self.assertFalse(identity.apply("vr"))
        pkt = {"op": gw.DiscordWebSocket.IDENTIFY, "d": {"properties": {"browser": "discord.py"}}}
        asyncio.run(gw.DiscordWebSocket.send_as_json(object(), pkt))
        self.assertEqual(sent[0]["d"]["properties"]["browser"], "Discord VR")


class Search(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        import os
        os.environ.update({"DISCORD_TOKEN": "x", "UNDERTOW_URL": "http://x", "UNDERTOW_KEY": "k"})
        global bot
        import bot  # noqa: F401
        self.tracks = [
            {"id": "1", "title": "Ordinary World", "artists": [{"name": "Duran Duran"}], "duration": 340, "source": "TIDAL"},
            {"id": "sub:ab12:9", "title": "I want a lobotomy (feat. Kasane Teto)", "artists": [], "duration": None, "source": "Home"},
        ]

    async def test_menu_lists_every_result_and_marks_other_sources(self):
        v = bot.PickView(types.SimpleNamespace(id=1), self.tracks)
        o = v.menu.options
        self.assertEqual([x.value for x in o], ["0", "1"])
        self.assertTrue(o[0].label.startswith("1. Ordinary World")); self.assertIn("5:40", o[0].description)
        self.assertIn("Home", o[1].description); self.assertIn("Unknown artist", o[1].description)
        self.assertEqual(v.menu.max_values, 2)

    async def test_only_the_person_who_searched_can_pick(self):
        v = bot.PickView(types.SimpleNamespace(id=1), self.tracks)
        i = types.SimpleNamespace(user=types.SimpleNamespace(id=2), response=mock.AsyncMock())
        await v.picked(i)
        args, kw = i.response.send_message.call_args
        self.assertIn("belongs to whoever searched", args[0]); self.assertTrue(kw["ephemeral"])

    async def test_picking_queues_the_chosen_songs_and_starts(self):
        v = bot.PickView(types.SimpleNamespace(id=1), self.tracks)
        v.menu._values = ["1", "0"]  # what Discord sends when two are ticked
        started = mock.AsyncMock()
        player = types.SimpleNamespace(start=started)
        i = types.SimpleNamespace(user=types.SimpleNamespace(id=1, display_name="Dess"), guild=object(), channel=object(), response=mock.AsyncMock())
        got = {}

        async def fake_queue_up(guild, channel, member, items):
            got["items"] = items
            return player, len(items), False
        with mock.patch.object(bot, "queue_up", fake_queue_up):
            await v.picked(i)
        self.assertEqual([x["id"] for x in got["items"]], ["sub:ab12:9", "1"])  # in the order picked
        self.assertEqual(got["items"][0]["by"], "Dess")
        started.assert_awaited_once()
        self.assertIn("Starting now", i.response.edit_message.call_args.kwargs["content"])


class Lyrics(unittest.TestCase):
    KARAOKE = {"sync": "word", "lines": [
        {"startMs": 27395, "durationMs": 1565, "text": "I been tryna call", "words": [{"startMs": 27395, "durationMs": 154, "text": "I"}, {"startMs": 27549, "durationMs": 191, "text": "been"}]},
        {"startMs": 30000, "text": "I've been on my own for long enough"},
        {"startMs": 33000, "text": "Maybe you can show me how to love"},
        {"startMs": 36000, "text": "Maybe"},
    ]}

    def test_karaoke_becomes_lines(self):
        self.assertEqual(lrc.to_lines(self.KARAOKE)[0], (27395, "I been tryna call", ""))  # the whole line, no per-word timing
        self.assertEqual(len(lrc.to_lines(self.KARAOKE)), 4)
        self.assertTrue(lrc.is_timed(self.KARAOKE))

    def test_unsorted_and_junk_lines(self):
        j = {"lines": [{"startMs": 5000, "text": "b"}, {"startMs": 1000, "text": "a"}, {"startMs": 2000, "text": "  "}, {"text": "no time"}]}
        self.assertEqual(lrc.to_lines(j), [(1000, "a", ""), (5000, "b", "")])
        self.assertFalse(lrc.is_timed(j))
        self.assertEqual(lrc.to_lines({"lines": None, "text": "plain"}), [])
        self.assertFalse(lrc.is_timed({"lines": [{"startMs": 0, "text": x} for x in "abcd"]}))  # all at 0:00 is not timing

    def test_line_at(self):
        L = lrc.to_lines(self.KARAOKE)
        self.assertEqual([lrc.line_at(L, p) for p in (0, 27394, 27395, 29999, 30000, 99999)], [-1, -1, 0, 0, 1, 3])

    def test_window(self):
        L = lrc.to_lines(self.KARAOKE)
        mid = lrc.window(L, 1)
        self.assertIn("**▸ I've been on my own for long enough**", mid)
        self.assertIn("*I been tryna call*", mid); self.assertIn("Maybe you can show me how to love", mid)
        self.assertTrue(lrc.window(L, -1).startswith("**♪**"))
        self.assertTrue(lrc.window(L, 3).endswith("**♪**"))
        self.assertIn("\\*", lrc.window([(0, "a*b", ""), (1, "c", ""), (2, "d", "")], 0))  # markdown characters in a line are escaped

    def test_background_vocals_stay_apart_from_the_verse(self):
        j = {"lines": [{"startMs": 1000, "text": "I'm just calling back to let you know", "background": "Back to let you know"},
                       {"startMs": 4000, "text": "I could never say it on the phone", "background": "Say it on the phone"},
                       {"startMs": 8000, "text": "(Ooh)", "backgroundOnly": True}, {"startMs": 11000, "text": "Plain"}]}
        L = lrc.to_lines(j)
        self.assertEqual(L[0], (1000, "I'm just calling back to let you know", "Back to let you know"))  # the verse text has no bg stuck on it
        w = lrc.window(L, 0).split("\n")
        self.assertEqual(w[0], "**▸ I'm just calling back to let you know**")
        self.assertEqual(w[1], "-# Back to let you know")  # its own line, in Discord's small gray text
        self.assertEqual(w[2], "I could never say it on the phone")
        self.assertEqual(w[3], "-# Say it on the phone")
        self.assertNotIn("(Back", lrc.window(L, 0))

    def test_pages_split_at_line_breaks(self):
        text = "\n".join(f"line number {i}" for i in range(600))
        ps = lrc.pages(text, 500)
        self.assertTrue(all(len(p) <= 500 for p in ps)); self.assertGreater(len(ps), 3)
        self.assertEqual("\n".join(ps).split("\n"), text.split("\n"))
        self.assertEqual(lrc.pages(""), [""])


class Live(unittest.IsolatedAsyncioTestCase):
    """The live-lyrics loop on a fake clock: no Discord, no waiting."""

    def setUp(self):
        import os
        os.environ.update({"DISCORD_TOKEN": "x", "UNDERTOW_URL": "http://x", "UNDERTOW_KEY": "k"})
        global bot
        import bot  # noqa: F401

    async def asyncSetUp(self):
        asyncio.get_running_loop().slow_callback_duration = 1e9  # the fake clock makes every step look slow; that's not a problem here

    async def run_for(self, seconds, lyrics_by_id, tracks):
        """tracks: [(start_second, track)]; returns the list of embed descriptions sent or edited, in order."""
        clock = {"t": 0.0}
        real_sleep = asyncio.sleep
        shown = []

        async def fake_sleep(d):
            clock["t"] += d
            await real_sleep(0)

        class Msg:
            async def edit(_, embeds=None, **kw): shown.append(embeds[0].description)

        class Chan:
            async def send(_, embeds=None, **kw): shown.append(embeds[0].description); return Msg()

        def current():
            cur = None
            for start, tr in tracks:
                if clock["t"] >= start: cur = (start, tr)
            return cur

        class Q:
            @property
            def current(_): c = current(); return c[1] if c else None

        async def fake_lyrics(tid):
            r = lyrics_by_id[tid]
            if isinstance(r, bot.UndertowError): raise r
            return r

        p = types.SimpleNamespace(q=Q(), vc=types.SimpleNamespace(is_connected=lambda: True), live=None)
        p.position_ms = lambda: int((clock["t"] - current()[0]) * 1000)
        live = bot.LiveLyrics(p, Chan())
        with mock.patch.object(bot.asyncio, "sleep", fake_sleep), mock.patch.object(bot.time, "monotonic", lambda: clock["t"]), mock.patch.object(bot.bot.ut, "lyrics", fake_lyrics), mock.patch.object(bot, "LRC_LEAD_MS", 0):
            live.start()
            while clock["t"] < seconds:
                await real_sleep(0)
            live.stop()
        return shown

    SONG = {"sync": "line", "name": "Test", "lines": [{"startMs": 1000, "text": "first"}, {"startMs": 4000, "text": "second"}, {"startMs": 8000, "text": "third"}, {"startMs": 12000, "text": "fourth"}]}

    async def test_lines_change_at_their_time_and_edits_are_spaced(self):
        shown = await self.run_for(14, {"1": self.SONG}, [(0, {"id": "1", "label": "A - B", "cover": None})])
        cur = [next((l for l in d.split("\n") if l.startswith("**▸")), None) for d in shown]
        self.assertEqual([c for c in cur if c], ["**▸ first**", "**▸ second**", "**▸ third**", "**▸ fourth**"])  # each line once, in order
        self.assertLessEqual(len(shown), 7)  # one send, then only edits when the line changed

    async def test_follows_the_queue_and_explains_missing_lyrics(self):
        err = bot.UndertowError("none", 404)
        shown = await self.run_for(10, {"1": self.SONG, "2": err}, [(0, {"id": "1", "label": "A - B", "cover": None}), (6, {"id": "2", "label": "C - D", "cover": None})])
        self.assertIn("No lyrics found", shown[-1])  # the second song has none: said so on the same message

    async def test_untimed_lyrics_point_to_the_lyrics_command(self):
        plain = {"sync": "plain", "name": "x", "lines": None, "text": "just words\nmore words"}
        shown = await self.run_for(3, {"1": plain}, [(0, {"id": "1", "label": "A - B", "cover": None})])
        self.assertIn("can't scroll along", shown[0]); self.assertIn("lyrics", shown[0])


class Links(unittest.IsolatedAsyncioTestCase):
    def test_finding_links_and_sites(self):
        self.assertEqual(weburl.find_url("play https://example.com/a.mp3 please"), "https://example.com/a.mp3")
        self.assertEqual(weburl.find_url("(https://youtu.be/abc)"), "https://youtu.be/abc")
        self.assertIsNone(weburl.find_url("ordinary world"))
        self.assertTrue(weburl.site_ok("https://www.youtube.com/watch?v=x")); self.assertTrue(weburl.site_ok("https://artist.bandcamp.com/track/y"))
        self.assertFalse(weburl.site_ok("https://evil-youtube.com/x")); self.assertFalse(weburl.site_ok("https://youtube.com.evil.net/x"))
        self.assertTrue(weburl.web_id("https://a/b").startswith("web:"))
        self.assertTrue(weburl._is_playlist_link("https://www.youtube.com/playlist?list=PL1")); self.assertFalse(weburl._is_playlist_link("https://www.youtube.com/watch?v=x&list=PL1"))

    def test_headers_cannot_break_out(self):
        h = weburl.ffmpeg_headers({"User-Agent": 'x"; evil', "Referer": "a\r\nX-Injected: 1"})
        self.assertEqual(h, 'User-Agent: x; evil\r\nReferer: aX-Injected: 1\r\n')
        self.assertNotIn('"', h)

    async def test_private_and_odd_addresses_are_refused(self):
        for u in ("http://127.0.0.1/a.mp3", "http://localhost:8000/x", "http://192.168.0.73:7000/", "http://10.0.0.5/a", "http://169.254.169.254/latest/meta-data", "http://[::1]/a",
                  "ftp://example.com/a.mp3", "file:///etc/passwd", "http://user:pw@example.com/a.mp3", "http://nonexistent.invalid/a"):
            self.assertFalse(await weburl.safe_host(u), u)
        self.assertIsNone(await weburl.probe_direct("http://127.0.0.1:1/a.mp3"))

    async def test_a_public_name_that_points_at_a_private_address_is_refused(self):
        async def fake_getaddrinfo(host, port, **kw): return [(2, 1, 6, "", ("192.168.1.9", 0)), (2, 1, 6, "", ("93.184.216.34", 0))]
        loop = asyncio.get_running_loop()
        with mock.patch.object(loop, "getaddrinfo", fake_getaddrinfo):
            self.assertFalse(await weburl.safe_host("http://sneaky.example.com/a.mp3"))  # one private address among the answers is enough to refuse
        async def public_only(host, port, **kw): return [(2, 1, 6, "", ("93.184.216.34", 0))]
        with mock.patch.object(loop, "getaddrinfo", public_only):
            self.assertTrue(await weburl.safe_host("https://example.com/a.mp3"))

    async def asyncSetUp(self):
        import tempfile, os
        self.hits = []
        self.flac_path = os.path.join(tempfile.mkdtemp(), "t.flac")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "flac", self.flac_path], check=True)
        app = web.Application()

        async def flac(r):
            self.hits.append((r.path, r.headers.get("User-Agent"), r.headers.get("Referer")))
            return web.Response(body=open(self.flac_path, "rb").read(), headers={"Content-Type": "audio/flac"}) if getattr(self, "flac_path", None) else web.Response(status=404)

        async def page(r): return web.Response(text="<html>not audio</html>", content_type="text/html")
        async def octet(r): return web.Response(body=b"abc", headers={"Content-Type": "application/octet-stream"})
        async def go(r): raise web.HTTPFound(r.query["to"])
        async def radio(r):
            resp = web.StreamResponse(headers={"Content-Type": "audio/mpeg", "icy-name": "Test FM"}); await resp.prepare(r); await resp.write(b"x" * 100); return resp

        app.add_routes([web.get("/song.flac", flac), web.get("/page", page), web.get("/blob.mp3", octet), web.get("/blob", octet), web.get("/go", go), web.get("/radio", radio)])
        self.runner = web.AppRunner(app); await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0); await site.start()
        self.base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"

    async def asyncTearDown(self):
        await self.runner.cleanup()

    async def test_probe_direct(self):
        a = await weburl.probe_direct(f"{self.base}/song.flac", allow_private=True)
        self.assertEqual((a["title"], a["live"]), ("song", False))
        self.assertIsNone(await weburl.probe_direct(f"{self.base}/page", allow_private=True))      # a web page isn't audio
        self.assertIsNone(await weburl.probe_direct(f"{self.base}/blob", allow_private=True))      # unknown bytes with no audio extension
        self.assertEqual((await weburl.probe_direct(f"{self.base}/blob.mp3", allow_private=True))["title"], "blob")
        r = await weburl.probe_direct(f"{self.base}/radio", allow_private=True)
        self.assertEqual((r["title"], r["live"]), ("Test FM", True))                              # a radio stream: named, and live
        self.assertEqual((await weburl.probe_direct(f"{self.base}/go?to=/song.flac", allow_private=True))["url"], f"{self.base}/song.flac")  # redirects are followed
        self.assertIsNone(await weburl.probe_direct(f"{self.base}/go?to=http://127.0.0.1:1/x.mp3"))  # ...and every hop is checked (loopback refused without the test override)

    async def test_yt_dlp_output_piped_through_the_bots_source(self):
        """PipedAudio with a stand-in for yt-dlp (a process printing a file): the audio comes out decoded, and the process is stopped on cleanup."""
        import os
        os.environ.update({"DISCORD_TOKEN": "x", "UNDERTOW_URL": "http://x", "UNDERTOW_KEY": "k"})
        import bot
        proc = subprocess.Popen(["cat", self.flac_path], stdout=subprocess.PIPE)
        a = bot.PipedAudio(proc)
        data = b""
        while True:
            chunk = await asyncio.to_thread(a.read)
            if not chunk: break
            data += chunk
        self.assertEqual(len(data), 2 * 48000 * 2 * 2)  # two seconds of 48 kHz stereo, 16-bit
        long = subprocess.Popen(["sleep", "30"], stdout=subprocess.PIPE)
        b = bot.PipedAudio(long)
        b.cleanup()
        self.assertIsNotNone(long.poll())  # the downloader doesn't keep running after a skip

    async def test_ffmpeg_plays_a_direct_link_with_the_bots_options(self):
        before = f'-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -headers "{weburl.ffmpeg_headers({"User-Agent": weburl.UA, "Referer": "https://site.example/"})}"'
        cmd = ["ffmpeg", "-nostdin", "-v", "error", *shlex.split(before), "-i", f"{self.base}/song.flac", "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "-"]
        out = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, timeout=30)
        self.assertEqual(len(out.stdout), 2 * 48000 * 2 * 2)  # two seconds of 48 kHz stereo, 16-bit
        self.assertIn(("/song.flac", weburl.UA, "https://site.example/"), self.hits)


class Helpers(unittest.TestCase):
    def test_links(self):
        self.assertEqual(parse_tidal_url("https://tidal.com/browse/track/147542"), ("track", "147542"))
        self.assertEqual(parse_tidal_url("https://tidal.com/album/147540?u"), ("album", "147540"))
        self.assertEqual(parse_tidal_url("http://www.tidal.com/track/9"), ("track", "9"))
        self.assertEqual(parse_tidal_url("https://listen.tidal.com/album/147540/track/147542"), ("track", "147542"))  # a song inside an album link is the song
        self.assertEqual(parse_tidal_url("https://tidal.com/browse/playlist/0DFC3B10-fbdb-4419-bf54-11b90051fa6c?u"), ("playlist", "0dfc3b10-fbdb-4419-bf54-11b90051fa6c"))
        self.assertEqual(parse_tidal_url("https://tidal.com/artist/461"), ("artist", "461"))
        self.assertEqual(parse_tidal_url("https://listen.tidal.com/mix/001c6f834b879878b2cab51816ce21"), ("mix", "001c6f834b879878b2cab51816ce21"))
        self.assertIsNone(parse_tidal_url("https://tidal.com/track/notanumber")); self.assertIsNone(parse_tidal_url("https://tidal.com/artist/abc"))
        self.assertIsNone(parse_tidal_url("ordinary world"))

    def test_track_ids_and_stream_urls(self):
        self.assertTrue(TRACK_ID.match("147542")); self.assertTrue(TRACK_ID.match("sub:ab12cd34ef56:9a8b7c"))
        self.assertFalse(TRACK_ID.match("hello")); self.assertFalse(TRACK_ID.match("sub:zz:1"))
        ut = Undertow("http://h", "k", "CD")
        self.assertEqual(ut.stream_url("147542"), "http://h/v1/tracks/147542/stream?quality=CD")
        self.assertEqual(ut.stream_url("sub:ab12:my song/1"), "http://h/v1/tracks/sub:ab12:my%20song%2F1/stream?quality=CD")  # colons stay, anything else is escaped

    def test_format(self):
        self.assertEqual(mmss(340), "5:40"); self.assertEqual(mmss(3725), "1:02:05"); self.assertEqual(mmss(None), "0:00")
        self.assertEqual(label({"title": "Ordinary World", "version": "Remastered", "artists": [{"name": "Duran Duran"}]}), "Duran Duran - Ordinary World (Remastered)")


class Client(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.seen = []
        app = web.Application()

        async def search(r):
            self.seen.append(r.headers.get("Authorization"))
            if r.headers.get("Authorization") != "Bearer good":
                return web.json_response({"error": {"status": 401, "message": "That API key isn't valid"}}, status=401)
            return web.json_response({"tracks": [{"id": "1", "title": "A", "artists": [{"name": "B"}]}]})

        async def stream(r):
            self.seen.append(("stream", r.headers.get("Authorization"), r.headers.get("Range"), r.query.get("quality")))
            if r.headers.get("Authorization") != "Bearer good":
                return web.Response(status=401)
            return web.Response(body=b"x", headers={"Content-Type": "audio/flac"})

        async def album(r):
            return web.json_response({"id": "9", "tracks": {"tracks": [{"id": "1"}, {"id": "2"}]}})

        async def token(r):
            k = r.headers.get("Authorization")
            if k == "Bearer botkey":
                return web.json_response({"token": "TOKEN-123"})
            if k == "Bearer nobot":
                return web.json_response({"error": {"message": "no"}}, status=403)
            return web.json_response({"error": {"message": "none saved"}}, status=404)

        async def playlist(r): return web.json_response({"title": "Chill Pop", "tracks": {"tracks": [{"id": "1"}, {"id": "2"}]}})
        async def mix(r): return web.json_response({"title": "Ordinary World", "tracks": {"tracks": [{"id": "5"}]}})
        async def toptracks(r): return web.json_response({"tracks": [{"id": "7", "artists": [{"name": "Duran Duran"}]}]})

        app.add_routes([web.get("/v1/playlists/{id}", playlist), web.get("/v1/mixes/{id}", mix), web.get("/v1/artists/{id}/top-tracks", toptracks), web.get("/v1/bot/token", token), web.get("/v1/search", search), web.get("/v1/tracks/{id}/stream", stream), web.get("/v1/albums/{id}", album)])
        self.runner = web.AppRunner(app); await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0); await site.start()
        self.base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"

    async def asyncTearDown(self):
        await self.runner.cleanup()

    async def test_search_album_and_errors(self):
        ut = Undertow(self.base, "good"); await ut.start()
        self.assertEqual((await ut.search("a"))[0]["id"], "1")
        self.assertEqual(len(await ut.album_tracks("9")), 2)
        await ut.close()
        bad = Undertow(self.base, "nope"); await bad.start()
        with self.assertRaises(UndertowError) as c: await bad.search("a")
        self.assertEqual(c.exception.status, 401); self.assertIn("isn't valid", str(c.exception))
        await bad.close()

    async def test_bot_token_from_undertow(self):
        self.assertEqual(await fetch_bot_token(self.base, "botkey"), "TOKEN-123")
        with self.assertRaises(UndertowError) as c: await fetch_bot_token(self.base, "nobot")
        self.assertIn("Discord bot switch", str(c.exception))
        with self.assertRaises(UndertowError) as c: await fetch_bot_token(self.base, "other")
        self.assertIn("Users > Discord bot", str(c.exception))

    async def test_playlist_mix_and_artist_links(self):
        ut = Undertow(self.base, "good"); await ut.start()
        self.assertEqual(await ut.playlist("0dfc3b10-fbdb-4419-bf54-11b90051fa6c"), ("Chill Pop", [{"id": "1"}, {"id": "2"}]))
        self.assertEqual((await ut.mix("001c"))[0], "Ordinary World mix")
        name, tracks = await ut.artist_top("461")
        self.assertEqual((name, len(tracks)), ("Duran Duran's top songs", 1))
        await ut.close()

    async def test_unreachable(self):
        ut = Undertow("http://127.0.0.1:1", "good"); await ut.start()
        with self.assertRaises(UndertowError): await ut.search("a")
        await ut.close()

    async def test_warm_asks_for_one_byte(self):
        ut = Undertow(self.base, "good", "CD"); await ut.start()
        await ut.warm("7"); await ut.close()
        self.assertIn(("stream", "Bearer good", "bytes=0-0", "CD"), self.seen)

    async def test_ffmpeg_sends_the_key_header_like_the_bot_builds_it(self):
        """The exact before_options string from bot.py, through ffmpeg, against a fake server: it must send the Authorization header."""
        ut = Undertow(self.base, "good", "CD")
        before = f'-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -headers "Authorization: Bearer good\r\n"'
        cmd = ["ffmpeg", "-nostdin", "-v", "error", *shlex.split(before), "-i", ut.stream_url("7"), "-vn", "-f", "null", "-"]
        await asyncio.to_thread(subprocess.run, cmd, capture_output=True, timeout=30)  # the body isn't audio: ffmpeg fails, but it asked first
        heads = [s for s in self.seen if isinstance(s, tuple) and s[1] == "Bearer good" and s[2] != "bytes=0-0"]
        self.assertTrue(heads, f"ffmpeg never sent the header; the server saw {self.seen}")


def T(id, title, artist, dur, version=None):
    return {"id": id, "title": title, "version": version, "artists": [{"name": a} for a in artist.split(",")], "duration": dur}


class TidalMatch(unittest.TestCase):
    def pick(self, entry, cands):
        hit = tidalmatch.best(cands, entry)
        return hit["id"] if hit else None

    def test_artist_dash_title_with_noise(self):
        e = {"title": "David Bowie - Ordinary World (Official Video) [HD]", "artist": "Bowie", "duration": 312}
        self.assertEqual(self.pick(e, [T("1", "Ordinary World", "Duran Duran", 340), T("2", "Ordinary World", "David Bowie", 310)]), "2")

    def test_topic_channel_with_exact_fields(self):
        e = {"title": "Ordinary World", "artist": "Duran Duran - Topic", "duration": 340, "exact": True}
        self.assertEqual(self.pick(e, [T("9", "Ordinary World", "Duran Duran", 341)]), "9")

    def test_remix_is_not_the_original(self):
        e = {"title": "Artist - Song", "artist": "Artist", "duration": 200}
        self.assertIsNone(self.pick(e, [T("1", "Song", "Artist", 200, "Remix")]))

    def test_wanted_remix_matches_remix(self):
        e = {"title": "Artist - Song (Remix)", "artist": "Artist", "duration": 200}
        self.assertEqual(self.pick(e, [T("1", "Song", "Artist", 200), T("2", "Song", "Artist", 201, "Remix")]), "2")

    def test_wrong_length_or_artist_or_title_refused(self):
        e = {"title": "Artist - Song", "artist": "Artist", "duration": 200}
        self.assertIsNone(self.pick(e, [T("1", "Song", "Artist", 260)]))
        self.assertIsNone(self.pick(e, [T("1", "Song", "Someone Else", 200)]))
        self.assertIsNone(self.pick(e, [T("1", "Song Two", "Artist", 200)]))

    def test_non_tidal_ids_ignored_and_feat_ignored(self):
        e = {"title": "Artist - Song (feat. Guest)", "artist": "Artist", "duration": 0}
        self.assertEqual(self.pick(e, [T("sub:ab:1", "Song", "Artist", 0), T("5", "Song", "Artist", 0)]), "5")

    def test_query(self):
        self.assertEqual(tidalmatch.query({"title": "A - B (Official Audio)", "artist": "x"}), "A B")


class Licenses(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = {"status": 0}
        self.held = set()

        async def status(r):
            self.calls["status"] += 1
            return web.json_response({"licensed": r.match_info["g"] in self.held})

        async def redeem(r):
            b = await r.json()
            if b["code"] != "UT-GOOD":
                return web.json_response({"error": {"status": 404, "message": "That license code isn't right"}}, status=404)
            self.held.add(b["guild"])
            return web.json_response({"ok": True, "holder": "Sam"})
        app = web.Application()
        app.router.add_get("/v1/bot/licenses/{g}", status)
        app.router.add_post("/v1/bot/licenses", redeem)
        self.runner = web.AppRunner(app); await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0); await site.start()
        self.ut = Undertow(f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}", "k")
        await self.ut.start()

    async def asyncTearDown(self):
        await self.ut.close()
        await self.runner.cleanup()

    async def test_status_is_remembered_and_redeem_refreshes_it(self):
        self.assertFalse((await self.ut.license_status(7)).get("licensed"))
        await self.ut.license_status(7)
        self.assertEqual(self.calls["status"], 1)  # the second ask came from memory
        await self.ut.redeem_license("UT-GOOD", 7, "Sam HQ")
        self.assertTrue((await self.ut.license_status(7)).get("licensed"))

    async def test_wrong_code_says_why(self):
        with self.assertRaises(UndertowError) as cm:
            await self.ut.redeem_license("nope", 7, "x")
        self.assertIn("isn't right", str(cm.exception))

    async def test_last_answer_stands_when_undertow_is_down(self):
        self.held.add("7")
        self.assertTrue((await self.ut.license_status(7)).get("licensed"))
        import undertow_client
        self.ut._licenses[7] = (self.ut._licenses[7][0] - undertow_client.LICENSE_TTL - 1, {"licensed": True})  # expired
        await self.runner.cleanup()
        self.assertTrue((await self.ut.license_status(7)).get("licensed"))
        with self.assertRaises(UndertowError):
            await self.ut.license_status(8)  # never seen, can't say


class Resume(unittest.TestCase):
    def setUp(self):
        import os
        os.environ.update({"DISCORD_TOKEN": "x", "UNDERTOW_URL": "http://x", "UNDERTOW_KEY": "k"})
        global bot
        import bot  # noqa: F401

    def player(self, connected=True):
        q = PlayQueue()
        q.add([{"id": "2", "label": "B"}, {"id": "3", "label": "C", "web": {"kind": "ytdlp", "url": "https://y/x"}}])
        q.current = {"id": "1", "label": "A"}
        vc = types.SimpleNamespace(is_connected=lambda: connected, channel=types.SimpleNamespace(id=77))
        return types.SimpleNamespace(vc=vc, q=q, channel=types.SimpleNamespace(id=55), volume=0.4)

    def test_snapshot_keeps_current_first_then_queue_and_survives_json(self):
        import json
        snap = bot.GuildPlayer.snapshot(self.player())
        self.assertEqual([i["id"] for i in snap["items"]], ["1", "2", "3"])
        self.assertEqual((snap["vc"], snap["text"], snap["volume"], snap["loop"]), (77, 55, 0.4, "off"))
        self.assertEqual(json.loads(json.dumps(snap)), snap)

    def test_nothing_to_resume(self):
        self.assertIsNone(bot.GuildPlayer.snapshot(self.player(connected=False)))
        p = self.player(); p.q.current = None; p.q.upcoming.clear()
        self.assertIsNone(bot.GuildPlayer.snapshot(p))


class PlainPages(unittest.TestCase):
    def test_bracketed_lines_become_small_gray_text(self):
        p = lrc.pages("Verse line\n(backing vocal)\nNext line")
        self.assertEqual(p[0].split("\n"), ["Verse line", "-# (backing vocal)", "Next line"])


class Credits(unittest.TestCase):
    def test_unison_submitter_and_writers(self):
        j = {"submitter": {"name": "Sam", "level": 12.0, "badge": "Top Syncer"}, "songwriters": ["A", "B"]}
        self.assertEqual(lrc.credits(j), "Submitted by Sam (level 12, Top Syncer) · Written by A, B")

    def test_nothing_known(self):
        self.assertEqual(lrc.credits({"submitter": None, "songwriters": []}), "")
        self.assertEqual(lrc.credits({}), "")

    def test_only_a_name(self):
        self.assertEqual(lrc.credits({"submitter": {"name": "Sam"}}), "Submitted by Sam")


class Prefs(unittest.TestCase):
    def test_roundtrip_and_clear(self):
        import pathlib, tempfile
        with tempfile.TemporaryDirectory() as d, mock.patch.object(prefs, "FILE", pathlib.Path(d) / "p.json"):
            self.assertIsNone(prefs.get(5, "live_channel"))
            prefs.put(5, "live_channel", 99)
            self.assertEqual(prefs.get(5, "live_channel"), 99)
            self.assertIsNone(prefs.get(6, "live_channel"))
            prefs.put(5, "live_channel", None)
            self.assertIsNone(prefs.get(5, "live_channel"))


if __name__ == "__main__":
    unittest.main()
