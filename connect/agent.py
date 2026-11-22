#!/usr/bin/env python3
"""Monochrome Connect receiver: turns this computer (a Raspberry Pi with a Bluetooth speaker, say) into a device Monochrome can play on.

    First run (pairs it with your account):
        python3 monochrome-connect.py --server https://your-monochrome-address --name "Living room"
    It prints a short code. In Monochrome, click the speaker button, choose "Add a device" and type the code.

    After that, just run it (or run it as a service, see --print-systemd):
        python3 monochrome-connect.py

Needs Python 3.8+ (standard library only) and a player: mpv (best) or ffplay. Nothing else is installed.

What it may be told: play (an address and a start second), pause, resume, seek, volume, stop. The server never sends it anything to run. The commands it
runs are YOUR shell commands in commands.ini (see the file it creates next to the pairing). The values it is told (the song's address, the start second,
the volume, the title) are handed to those commands in environment variables (MC_URL, MC_POS, MC_DUR, MC_VOL, MC_TITLE) and are never pasted into a
command line, so a song with a clever name cannot run anything. Use them in double quotes, as the examples do.
"""
import argparse
import configparser
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import urllib.parse
from queue import Queue, Empty

VERSION = "1.0"
PAIR_WAIT = 600  # seconds the code stays valid
IDLE_SECONDS = 300  # a quiet spell after which "after" runs and the next song runs "before" again
CONFIG_DIR = os.environ.get("MC_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".config", "monochrome-connect")
DEVICE_FILE = os.path.join(CONFIG_DIR, "device.json")
COMMANDS_FILE = os.path.join(CONFIG_DIR, "commands.ini")

DEFAULT_COMMANDS = """\
# Monochrome Connect: the commands this receiver runs. They are shell commands.
#
# The server never sends a command. It only says "play this address from this second", and the receiver hands those values to your
# commands in environment variables:
#   MC_URL    the address of the song
#   MC_POS    the second to start from
#   MC_DUR    the song's length in seconds (0 if not known)
#   MC_VOL    the volume, 0 to 100
#   MC_TITLE  the song's name
# Always put them in double quotes, as in the examples. Never build a command out of them in any other way.
#
# This file is read again for every song, so you can edit it while the receiver runs.

[commands]
# Plays ONE song and exits when the song ends (the receiver restarts it for pause and seek).
# Empty means: use mpv if it is installed, otherwise ffplay.
#   play = mpv --no-video --no-terminal --really-quiet --start="$MC_POS" --volume="$MC_VOL" "$MC_URL"
#   play = ffplay -nodisp -autoexit -loglevel error -ss "$MC_POS" "$MC_URL"
play =

# Sets the volume (optional). Without it, mpv uses its own --volume and other players keep the system volume.
#   volume = wpctl set-volume @DEFAULT_AUDIO_SINK@ "$MC_VOL%"
#   volume = pactl set-sink-volume @DEFAULT_SINK@ "$MC_VOL%"
#   volume = amixer -q sset PCM "$MC_VOL%"
volume =

# Runs before the first song after a quiet spell (about 5 minutes): wake or connect a Bluetooth speaker, for example.
#   before = bluetoothctl connect AA:BB:CC:DD:EE:FF
before =

# Runs when playback is stopped, or after a quiet spell: disconnect the speaker, for example.
#   after = bluetoothctl disconnect AA:BB:CC:DD:EE:FF
after =
"""

SYSTEMD_USER_UNIT = """\
# Save as ~/.config/systemd/user/monochrome-connect.service, then:
#   systemctl --user daemon-reload && systemctl --user enable --now monochrome-connect
#   sudo loginctl enable-linger $USER      # so it starts at boot, without logging in
# A user service (not a system one) because the sound (PipeWire/PulseAudio) and the Bluetooth speaker belong to your login.
[Unit]
Description=Monochrome Connect receiver
After=network-online.target sound.target
Wants=network-online.target

[Service]
ExecStart={python} {script}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
"""


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Revoked(Exception):
    """The server says this device was removed."""


# ---------------------------------------------------------------------------------------------------------------- talking to the server
class Server:
    def __init__(self, base, token=None):
        self.base = base.rstrip("/")
        self.token = token

    def call(self, method, path, body=None, timeout=35):
        headers = {"User-Agent": f"monochrome-connect/{VERSION}", "Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise Revoked() from None
            detail = ""
            try:
                detail = json.loads(e.read() or b"{}").get("error", "")
            except Exception:
                pass
            raise RuntimeError(f"{e.code} {detail}".strip()) from None
        return json.loads(raw or b"{}")


# ---------------------------------------------------------------------------------------------------------------- pairing and settings
def save_device(d):
    os.makedirs(CONFIG_DIR, mode=0o700, exist_ok=True)
    tmp = DEVICE_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # the token is a secret: only you can read the file
    with os.fdopen(fd, "w") as f:
        json.dump(d, f, indent=1)
    os.replace(tmp, DEVICE_FILE)


def load_device():
    try:
        with open(DEVICE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def ensure_commands_file():
    if not os.path.exists(COMMANDS_FILE):
        os.makedirs(CONFIG_DIR, mode=0o700, exist_ok=True)
        with open(COMMANDS_FILE, "w") as f:
            f.write(DEFAULT_COMMANDS)
        log("wrote", COMMANDS_FILE, "- the commands this receiver runs; edit it for your speaker")


def pair(server_url, name):
    srv = Server(server_url)
    try:
        r = srv.call("POST", "/__off/connect/pair/start", {})
    except Exception as e:
        sys.exit(f"Could not reach {server_url}: {e}")
    print(f"\n  Pairing code:  {r['code']}\n\n  In Monochrome: click the speaker button, choose \"Add a device\" and type the code.\n"
          f"  It is valid for {int(r['expiresIn'] // 60)} minutes.\n", flush=True)
    end = time.time() + min(PAIR_WAIT, r["expiresIn"])
    while time.time() < end:
        time.sleep(2)
        try:
            p = srv.call("GET", "/__off/connect/pair/poll?t=" + urllib.parse.quote(r["poll"]))
        except Exception as e:
            sys.exit(f"Pairing stopped: {e}")
        if p.get("status") == "paired":
            save_device({"server": server_url.rstrip("/"), "id": p["id"], "name": p["name"], "token": p["token"]})
            log(f"paired as \"{p['name']}\" on the account of {p.get('owner') or 'someone'}. If that is not you, remove the device in Monochrome and run --unpair here.")
            return load_device()
    sys.exit("The code expired before it was used. Run the receiver again for a new one.")


def read_commands():
    cp = configparser.ConfigParser(interpolation=None)  # no interpolation: the commands are full of % and $
    try:
        cp.read(COMMANDS_FILE)
    except configparser.Error as e:
        log("commands.ini has a mistake:", e)
    g = lambda k: (cp.get("commands", k, fallback="") or "").strip()
    return {k: g(k) for k in ("play", "volume", "before", "after")}


def default_play():
    if shutil.which("mpv"):
        return 'mpv --no-video --no-terminal --really-quiet --start="$MC_POS" --volume="$MC_VOL" "$MC_URL"'
    if shutil.which("ffplay"):
        return 'ffplay -nodisp -autoexit -loglevel error -ss "$MC_POS" "$MC_URL"'
    return ""


def clean_num(v, hi, default=0.0):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    return max(0.0, min(v, hi)) if v == v else default  # v == v: not NaN


# ---------------------------------------------------------------------------------------------------------------- the player
class Player:
    """One song at a time, played by a command of yours. Pause and seek stop it and start it again at the right second; where it is
    is the start second plus the time since it started (a command that plays to a sound card reports nothing else)."""

    def __init__(self, server_base, volume=60):
        self.server_base = server_base
        self.proc = None
        self.track = None  # {"id", "url", "dur", "title"}
        self.base = 0.0
        self.t0 = None
        self.playing = False
        self.ended = 0
        self.error = None
        self.volume = volume
        self.stderr_tail = b""
        self.killed = False

    def pos(self):
        p = self.base + (time.monotonic() - self.t0 if self.playing and self.t0 else 0.0)
        dur = self.track["dur"] if self.track else 0
        return min(p, dur) if dur else p

    def env(self, pos):
        t = self.track or {}
        e = dict(os.environ)
        e.update({"MC_URL": t.get("url", ""), "MC_POS": f"{pos:.2f}", "MC_DUR": f"{t.get('dur', 0):.0f}", "MC_VOL": str(int(self.volume)), "MC_TITLE": t.get("title", ""), "MC_ID": t.get("id", "")})
        return e

    def run_hook(self, name):
        cmd = read_commands().get(name)
        if not cmd:
            return
        try:
            r = subprocess.run(cmd, shell=True, executable="/bin/sh", env=self.env(self.pos()), timeout=30, capture_output=True)
            if r.returncode:
                log(f'"{name}" command failed ({r.returncode}):', (r.stderr or b"").decode(errors="replace").strip()[-200:])
        except subprocess.TimeoutExpired:
            log(f'"{name}" command took more than 30 seconds; carrying on')
        except OSError as e:
            log(f'"{name}" command could not run:', e)

    def kill(self):
        p, self.proc = self.proc, None
        if not p:
            return
        self.killed = True
        try:
            os.killpg(p.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            p.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            p.wait()

    def start(self, pos):
        self.kill()
        cmd = read_commands().get("play") or default_play()
        if not cmd:
            self.error = "No player found. Install mpv (sudo apt install mpv) or set play in commands.ini."
            self.playing = False
            return
        self.base, self.t0, self.playing, self.error, self.stderr_tail, self.killed = pos, time.monotonic(), True, None, b"", False
        try:
            self.proc = subprocess.Popen(cmd, shell=True, executable="/bin/sh", env=self.env(pos), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.PIPE, start_new_session=True)
        except OSError as e:
            self.error, self.playing, self.proc = f"Could not start the player: {e}", False, None
            return
        threading.Thread(target=self._drain, args=(self.proc,), daemon=True).start()

    def _drain(self, p):
        try:
            for line in p.stderr:
                self.stderr_tail = (self.stderr_tail + line)[-300:]
        except Exception:
            pass

    def check(self):
        """Has the song ended (or the player failed)? True when something changed that should be reported."""
        p = self.proc
        if not p or p.poll() is None:
            return False
        self.proc = None
        if not self.playing:
            return False
        code = p.returncode
        if code == 0:
            self.ended += 1
            self.base = self.track["dur"] if self.track and self.track["dur"] else self.pos()
        else:
            self.base = self.pos()
            self.error = f"The player stopped ({code}): " + self.stderr_tail.decode(errors="replace").strip().splitlines()[-1:][0] if self.stderr_tail.strip() else f"The player stopped ({code})"
        self.playing = False
        return True

    # ---- commands from Monochrome
    def command(self, c):
        a = c.get("action")
        if a == "play":
            url = str(c.get("url", ""))
            if not url.startswith(self.server_base + "/__off/connect/audio/"):
                log("refused a song address that is not on the paired server")
                return
            vol = c.get("vol")
            if vol is not None:
                self.volume = int(clean_num(vol, 100, self.volume))
            self.track = {"id": str(c.get("id", ""))[:80], "url": url, "dur": clean_num(c.get("dur"), 7200), "title": str(c.get("title", ""))[:120]}
            self.start(clean_num(c.get("pos"), 7200))
            log("playing", self.track["title"] or self.track["id"], f"from {self.base:.0f}s")
        elif a == "pause" and self.playing:
            self.base = self.pos()
            self.kill()
            self.playing = False
        elif a == "resume" and not self.playing and self.track:
            self.start(self.base)
        elif a == "seek" and self.track:
            at = clean_num(c.get("pos"), 7200)
            if self.playing:
                self.start(at)
            else:
                self.base = at
        elif a == "volume":
            self.volume = int(clean_num(c.get("vol"), 100, self.volume))
            if read_commands().get("volume"):
                self.run_hook("volume")  # the system's volume: nothing restarts
            elif self.playing:
                self.start(self.pos())  # the player's own volume is set when it starts
        elif a == "stop":
            self.kill()
            self.playing = False
            self.track, self.base = None, 0.0

    def state(self):
        return {"id": self.track["id"] if self.track else None, "playing": self.playing, "pos": round(self.pos(), 1), "dur": self.track["dur"] if self.track else 0,
                "ended": self.ended, "volume": self.volume, "error": self.error}


# ---------------------------------------------------------------------------------------------------------------- the receiver
def run(dev):
    srv = Server(dev["server"], dev["token"])
    player = Player(dev["server"])
    cmds: "Queue[dict]" = Queue()
    stop = threading.Event()
    revoked = threading.Event()

    def poller():
        seq, backoff = None, 1
        while not stop.is_set():
            try:
                r = srv.call("GET", "/__off/connect/poll" + ("" if seq is None else f"?since={seq}"), timeout=45)
                backoff = 1
                seq = r["seq"]
                for c in r.get("commands", []):
                    cmds.put(c)
            except Revoked:
                revoked.set()
                return
            except Exception as e:
                log("cannot reach the server:", e, f"(trying again in {backoff}s)")
                stop.wait(backoff)
                backoff = min(backoff * 2, 30)

    threading.Thread(target=poller, daemon=True).start()
    log(f"ready as \"{dev['name']}\" on {dev['server']} - waiting for Monochrome")
    last_report, last_state, session, quiet_since = 0.0, None, False, time.monotonic()

    def report():
        nonlocal last_report, last_state
        s = player.state()
        try:
            srv.call("POST", "/__off/connect/report", s, timeout=10)
            last_report, last_state = time.monotonic(), s
        except Revoked:
            revoked.set()
        except Exception as e:
            log("report failed:", e)

    try:
        while not revoked.is_set():
            changed = False
            try:
                while True:
                    c = cmds.get(timeout=0.25)
                    if c.get("action") == "play" and not session:
                        player.run_hook("before")
                        session = True
                    player.command(c)
                    if c.get("action") == "stop" and session:
                        player.run_hook("after")
                        session = False
                    changed = True
            except Empty:
                pass
            if player.check():
                changed = True
            now = time.monotonic()
            if player.playing:
                quiet_since = now
            elif session and now - quiet_since > IDLE_SECONDS:
                player.run_hook("after")
                session = False
            interval = 1.0 if player.playing else 5.0
            if changed or now - last_report >= interval:
                report()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        player.kill()
    if revoked.is_set():
        sys.exit("This device was removed in Monochrome. Run the receiver with --server again to pair it anew (delete " + DEVICE_FILE + " first).")


def main():
    ap = argparse.ArgumentParser(description="Monochrome Connect receiver")
    ap.add_argument("--server", help="your Monochrome address, for pairing (https://...)")
    ap.add_argument("--name", default=None, help="the name this device shows in Monochrome")
    ap.add_argument("--print-systemd", action="store_true", help="print a systemd user service for it and exit")
    ap.add_argument("--unpair", action="store_true", help="forget the pairing on this computer (also remove the device in Monochrome)")
    ap.add_argument("--version", action="version", version=VERSION)
    a = ap.parse_args()
    if a.print_systemd:
        print(SYSTEMD_USER_UNIT.format(python=sys.executable, script=os.path.abspath(__file__)))
        return
    if a.unpair:
        try:
            os.remove(DEVICE_FILE)
            print("Forgotten.")
        except OSError:
            print("Nothing to forget.")
        return
    ensure_commands_file()
    dev = load_device()
    if a.server and (not dev or dev["server"] != a.server.rstrip("/")):
        dev = pair(a.server, a.name or os.uname().nodename)
    if not dev:
        ap.error("this receiver is not paired yet: run it with --server https://your-monochrome-address")
    if not (read_commands().get("play") or default_play()):
        log("no player found: install mpv (sudo apt install mpv), or set play in", COMMANDS_FILE)
    run(dev)


if __name__ == "__main__":
    main()
