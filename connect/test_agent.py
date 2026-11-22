"""Tests for the Monochrome Connect receiver (agent.py): the player's bookkeeping, and that what the server says never runs as a command.
Run from the repository root:  python3 -m unittest discover -s connect -v
No network, no sound: the "player" is a few shell commands."""
import importlib.util
import os
import shutil
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = "http://srv.test"
URL = SERVER + "/__off/connect/audio/123?d=abc&q=HI_RES&e=1&s=x"


def load_agent(config_dir):
    os.environ["MC_CONFIG_DIR"] = config_dir  # read when the module loads
    spec = importlib.util.spec_from_file_location("agent", os.path.join(HERE, "agent.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class PlayerTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="mctest-")
        self.agent = load_agent(self.dir)
        self.out = os.path.join(self.dir, "out.txt")
        self.p = self.agent.Player(SERVER)

    def tearDown(self):
        self.p.kill()
        shutil.rmtree(self.dir, ignore_errors=True)

    def commands(self, play, volume=""):
        with open(os.path.join(self.dir, "commands.ini"), "w") as f:
            f.write(f"[commands]\nplay = {play}\nvolume = {volume}\n")

    def wait_for(self, path, seconds=3.0):
        end = time.time() + seconds
        while time.time() < end:
            if os.path.exists(path) and os.path.getsize(path):
                return open(path).read()
            time.sleep(0.05)
        self.fail(f"{path} was not written")

    def test_clean_num(self):
        c = self.agent.clean_num
        self.assertEqual(c("12.5", 100), 12.5)
        self.assertEqual(c("-4", 100), 0.0)
        self.assertEqual(c("9999", 100), 100.0)
        self.assertEqual(c("abc", 100, 7.0), 7.0)
        self.assertEqual(c(float("nan"), 100, 3.0), 3.0)
        self.assertEqual(c(None, 100), 0.0)

    def test_refuses_a_song_address_that_is_not_on_the_paired_server(self):
        self.commands(f"printf x > '{self.out}'; sleep 5")
        for url in ("http://evil.test/audio/1", "file:///etc/passwd", SERVER + ".evil.test/__off/connect/audio/1", "", SERVER + "/other"):
            self.p.command({"action": "play", "id": "1", "url": url, "pos": 0, "dur": 10})
            self.assertIsNone(self.p.track, url)
            self.assertFalse(self.p.playing)
        time.sleep(0.3)
        self.assertFalse(os.path.exists(self.out))

    def test_values_reach_the_command_only_as_environment_variables(self):
        marker = os.path.join(self.dir, "PWNED")
        self.commands(f"printf '%s|%s|%s|%s' \"$MC_URL\" \"$MC_POS\" \"$MC_VOL\" \"$MC_TITLE\" > '{self.out}'; sleep 5")
        title = f"$(touch {marker}) `touch {marker}`; \"; touch {marker}; \""
        self.p.command({"action": "play", "id": "123", "url": URL, "pos": 12.5, "dur": 200, "title": title, "vol": 40})
        got = self.wait_for(self.out).split("|")
        self.assertEqual(got, [URL, "12.50", "40", title])  # the title arrived as plain text...
        self.assertFalse(os.path.exists(marker))  # ...and nothing ran

    def test_pause_resume_and_seek_keep_the_place(self):
        self.commands(f"printf '%s' \"$MC_POS\" > '{self.out}'; sleep 30")
        self.p.command({"action": "play", "id": "1", "url": URL, "pos": 10, "dur": 100})
        self.wait_for(self.out)
        time.sleep(0.6)
        self.p.command({"action": "pause"})
        at = self.p.pos()
        self.assertGreaterEqual(at, 10.5)
        self.assertLess(at, 11.5)
        self.assertFalse(self.p.playing)
        self.assertIsNone(self.p.proc)
        time.sleep(0.4)
        self.assertAlmostEqual(self.p.pos(), at, places=2)  # a paused song stays where it was
        os.remove(self.out)
        self.p.command({"action": "resume"})
        self.assertEqual(float(self.wait_for(self.out)), round(at, 2))  # it starts again at that second
        self.p.command({"action": "seek", "pos": 55})
        os.remove(self.out)
        self.assertEqual(float(self.wait_for(self.out)), 55.0)
        self.p.command({"action": "pause"})
        self.p.command({"action": "seek", "pos": 70})  # paused: only the place moves
        self.assertFalse(self.p.playing)
        self.assertEqual(round(self.p.pos()), 70)

    def test_a_song_that_ends_is_counted_once(self):
        self.commands("sleep 0.3")
        self.p.command({"action": "play", "id": "1", "url": URL, "pos": 0, "dur": 1})
        self.assertFalse(self.p.check())
        time.sleep(0.6)
        self.assertTrue(self.p.check())
        self.assertEqual(self.p.ended, 1)
        self.assertFalse(self.p.playing)
        self.assertEqual(self.p.pos(), 1)
        self.assertFalse(self.p.check())  # not counted again

    def test_a_player_that_fails_says_why(self):
        self.commands("echo boom >&2; exit 3")
        self.p.command({"action": "play", "id": "1", "url": URL, "pos": 0, "dur": 10})
        time.sleep(0.6)
        self.assertTrue(self.p.check())
        self.assertFalse(self.p.playing)
        self.assertEqual(self.p.ended, 0)
        self.assertIn("3", self.p.error)
        self.assertIn("boom", self.p.error)

    def test_stop_ends_the_player_and_clears_the_song(self):
        self.commands("sleep 30")
        self.p.command({"action": "play", "id": "1", "url": URL, "pos": 0, "dur": 100})
        proc = self.p.proc
        self.assertIsNone(proc.poll())
        self.p.command({"action": "stop"})
        proc.wait(timeout=3)  # the whole player is stopped, not left running
        self.assertIsNone(self.p.track)
        self.assertFalse(self.p.playing)

    def test_volume_runs_your_volume_command_without_restarting_the_song(self):
        vol = os.path.join(self.dir, "vol.txt")
        self.commands("sleep 30", volume=f"printf '%s' \"$MC_VOL\" > '{vol}'")
        self.p.command({"action": "play", "id": "1", "url": URL, "pos": 0, "dur": 100, "vol": 60})
        proc = self.p.proc
        self.p.command({"action": "volume", "vol": 25})
        self.assertEqual(open(vol).read(), "25")
        self.assertIs(self.p.proc, proc)  # the same player process: nothing restarted
        self.p.command({"action": "volume", "vol": "loud"})  # junk keeps the old value
        self.assertEqual(self.p.volume, 25)

    def test_the_commands_file_is_read_again_for_each_song(self):
        self.commands(f"printf one > '{self.out}'; sleep 30")
        self.p.command({"action": "play", "id": "1", "url": URL, "pos": 0, "dur": 100})
        self.assertEqual(self.wait_for(self.out), "one")
        self.commands(f"printf two > '{self.out}'; sleep 30")
        os.remove(self.out)
        self.p.command({"action": "play", "id": "2", "url": URL, "pos": 0, "dur": 100})
        self.assertEqual(self.wait_for(self.out), "two")


if __name__ == "__main__":
    unittest.main()
