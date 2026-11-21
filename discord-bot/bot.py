"""Undertow Discord bot: plays TIDAL in a voice channel, with everything coming through your Undertow server."""
import asyncio
import json
import logging
import os
import re
import time
from collections import deque
from pathlib import Path

import discord
from typing import Literal

from discord.ext import commands

import identity
import lrc
import prefs
import tidalmatch
import weburl
from playqueue import PlayQueue, LOOP_MODES
from undertow_client import TRACK_ID, Undertow, UndertowError, fetch_bot_token, label, mmss, parse_tidal_url

log = logging.getLogger("undertow-bot")


def load_env(path: Path):
    """Reads KEY=value lines from .env, without overriding what's already set. No extra package needed."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env(Path(__file__).with_name(".env"))
TOKEN = os.environ.get("DISCORD_TOKEN", "")
BASE = os.environ.get("UNDERTOW_URL", "")
KEY = os.environ.get("UNDERTOW_KEY", "")
GUILD_ID = os.environ.get("GUILD_ID", "").strip()
QUALITY = os.environ.get("QUALITY", "CD").strip().upper() or "CD"
IDLE_SECONDS = max(1, int(os.environ.get("IDLE_MINUTES", "3") or 3)) * 60
PREFIX = os.environ.get("PREFIX", "g+")
LRC_LEAD_MS = int(os.environ.get("LRC_LEAD_MS", "400") or 0)  # show each live lyric line a little early, to make up for the time an edit takes
PRESENCE = os.environ.get("PRESENCE", "hifi-api via Undertow").strip()  # shown as "Playing …" under the bot's name; blank for none
PLATFORM = os.environ.get("PLATFORM", "vr").strip()  # the platform icon Discord shows: vr, mobile, desktop, or off
TIDAL_MATCH = os.environ.get("TIDAL_MATCH", "on").strip().lower() not in ("off", "0", "no", "false")  # look a link's song up on TIDAL first
LICENSE_REQUIRED = os.environ.get("LICENSE_REQUIRED", "on").strip().lower() not in ("off", "0", "no", "false")  # servers need a license from the Undertow owner
ACCENT = discord.Colour.from_rgb(94, 129, 244)


def item(track: dict, who: str) -> dict:
    """What the queue keeps about a song."""
    album = track.get("album") or {}
    return {"id": track["id"], "label": label(track), "title": track.get("title", "?"), "duration": track.get("duration") or 0,
            "album": album.get("title"), "cover": (album.get("cover") or {}).get("640"), "by": who}


def dur(t: dict) -> str:
    """A song's length for display; links to streams and files with no known length say so."""
    return mmss(t["duration"]) if t.get("duration") else ("live" if t.get("live") else "?:??")


async def web_items(url: str, who: str) -> tuple[list[dict], str]:
    """Songs for a link (a direct audio file or stream, or a page on a site yt-dlp reads), and the message to send. Raises CheckFailure with something readable."""
    if not await weburl.safe_host(url):
        raise commands.CheckFailure("I can't open that link.")
    direct = await weburl.probe_direct(url)
    if direct:
        t = direct["title"]
        return [{"id": weburl.web_id(direct["url"]), "label": t, "title": t, "duration": 0, "live": direct["live"], "album": None, "cover": None, "by": who,
                 "web": {"kind": "direct", "url": direct["url"]}}], f"Queued **{t}**"
    if not weburl.site_ok(url):
        raise commands.CheckFailure("That link isn't an audio file, and it isn't on a site I'm set up to read (YouTube, SoundCloud, Bandcamp and a few more).")
    try:
        entries = await weburl.ytdlp_info(url)
    except Exception:
        raise commands.CheckFailure("I couldn't read that link.")
    gate = asyncio.Semaphore(4)

    async def one(e: dict) -> dict:
        """The song on TIDAL if it's there, else the link's own audio."""
        if TIDAL_MATCH:
            async with gate:
                try:
                    hit = tidalmatch.best(await bot.ut.search(tidalmatch.query(e), 10), e)
                except Exception:
                    hit = None
            if hit:
                return {**item(hit, who), "matched": True}
        return {"id": weburl.web_id(e["url"]), "label": f"{e['artist']} - {e['title']}" if e["artist"] else e["title"], "title": e["title"], "duration": e["duration"], "live": False,
                "album": None, "cover": e["thumb"], "by": who, "web": {"kind": "ytdlp", "url": e["url"]}}

    items = list(await asyncio.gather(*(one(e) for e in entries)))
    hits = sum(1 for t in items if t.get("matched"))
    if len(items) == 1:
        return items, f"Queued **{items[0]['label']}**" + (" (TIDAL)" if hits else " (from the link)")
    return items, f"Added **{len(items)}** songs from that link" + (f", {hits} of them from TIDAL." if hits else ".")


class PipedAudio(discord.FFmpegPCMAudio):
    """Audio that yt-dlp downloads and ffmpeg decodes, one feeding the other. When the song ends or is skipped, both stop."""

    def __init__(self, proc):
        super().__init__(proc.stdout, pipe=True, options="-vn")
        self._ytdlp = proc

    def cleanup(self):
        try:  # yt-dlp first: the feeding thread then sees the end of the data and closes ffmpeg's input itself, before discord.py tidies it away
            self._ytdlp.kill()
            self._ytdlp.wait(timeout=3)
        except Exception:
            pass
        feeder = getattr(self, "_pipe_writer_thread", None)
        if feeder:
            feeder.join(timeout=2)
        super().cleanup()


class GuildPlayer:
    def __init__(self, bot: "UndertowBot", guild: discord.Guild):
        self.bot, self.guild = bot, guild
        self.q = PlayQueue()
        self.vc: discord.VoiceClient | None = None
        self.channel: discord.abc.Messageable | None = None
        self.volume = 0.5
        self.started = 0.0
        self.skipping = False
        self.idle: asyncio.Task | None = None
        self.acc_ms = 0  # play time before the last pause (discord.py restarts its frame count on resume)
        self.live: "LiveLyrics | None" = None

    @property
    def stay(self) -> bool:
        """24/7 mode: this server asked me to stay in the voice channel."""
        return bool(prefs.get(self.guild.id, "stay"))

    @property
    def panel_channel(self):
        cid = prefs.get(self.guild.id, "live_channel")
        return self.guild.get_channel(cid) if cid else None

    def ensure_panel(self):
        """If this server has a player channel, its panel (live lyrics and buttons) runs from the moment I'm in voice."""
        ch = self.panel_channel
        if ch and not self.live:
            self.live = LiveLyrics(self, ch, panel=True)
            self.live.start()

    # ---- voice ----
    async def join(self, channel: discord.VoiceChannel):
        if self.vc and self.vc.is_connected():
            if self.vc.channel.id != channel.id:
                await self.vc.move_to(channel)
        else:
            self.vc = await channel.connect(self_deaf=True)

    def position_ms(self) -> int:
        """How far into the current song the audio being sent is, in milliseconds."""
        player = getattr(self.vc, "_player", None)
        return self.acc_ms + int(getattr(player, "loops", 0)) * 20

    def pause(self):
        self.vc.pause()

    def resume(self):
        player = getattr(self.vc, "_player", None)
        self.acc_ms += int(getattr(player, "loops", 0)) * 20  # frames counted so far; the count restarts at zero on resume
        self.vc.resume()

    def snapshot(self) -> dict | None:
        """What it takes to pick the music back up after a restart: the voice channel, the song playing and the queue. None when there's nothing to resume."""
        if not (self.vc and self.vc.is_connected() and self.vc.channel and (self.q.current or self.q.upcoming)):
            return None
        return {"vc": self.vc.channel.id, "text": self.channel.id if self.channel else None, "loop": self.q.loop, "volume": self.volume,
                "items": ([self.q.current] if self.q.current else []) + list(self.q.upcoming)[:200]}

    async def leave(self, tidy: bool = True, forget: bool = True):
        if forget:  # I'm leaving on purpose (or was told to): nothing to pick up later
            prefs.put(self.guild.id, "resume", None)
            self.bot.snap_last.pop(self.guild.id, None)
        if self.live:
            self.live.stop()
            self.live = None
        if tidy:
            await show_idle_panel(self.guild)
        self.cancel_idle()
        self.q.clear()
        self.q.current = None
        if self.vc:
            try:
                await self.vc.disconnect()
            except Exception:
                pass
        self.vc = None

    # ---- playing ----
    async def start(self):
        """Plays the next song if nothing is playing."""
        if not self.vc or self.vc.is_playing() or self.vc.is_paused():
            return
        await self.play_next()

    def audio_for(self, t: dict) -> discord.FFmpegPCMAudio:
        """The audio source for a song: from Undertow, straight from a direct link, or piped through yt-dlp (YouTube and the like refuse a bare ffmpeg)."""
        web = t.get("web")
        if web and web["kind"] == "ytdlp":
            return PipedAudio(weburl.ytdlp_stream(web["url"]))
        if web:
            before = f'-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -headers "{weburl.ffmpeg_headers({"User-Agent": weburl.UA})}"'
            return discord.FFmpegPCMAudio(web["url"], before_options=before, options="-vn")
        # The key goes in a header, not the URL, so it doesn't end up in logs. ffmpeg wants each header line to end in CRLF.
        before = f'-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -headers "Authorization: Bearer {KEY}\r\n"'
        return discord.FFmpegPCMAudio(self.bot.ut.stream_url(t["id"]), before_options=before, options="-vn")

    async def stop_playing(self):
        """Stop and empty the queue. In 24/7 mode I stay in the channel; otherwise I leave."""
        if not self.stay:
            return await self.leave()
        self.q.clear()
        self.q.current = None
        self.skipping = True
        if self.vc and (self.vc.is_playing() or self.vc.is_paused()):
            self.vc.stop()
        await self.refresh_panel()

    async def step_back(self):
        """Back to the song before this one (or the start of this one, if it's been playing a while)."""
        playing = self.vc and (self.vc.is_playing() or self.vc.is_paused())
        if playing and (self.position_ms() > 5000 or not self.q.history):
            ok = self.q.restart()
        else:
            ok = self.q.back()
        if not ok:
            return None
        name = self.q.upcoming[0]["label"]  # the song lined up to play now
        self.skipping = True
        if playing:
            self.vc.stop()  # when it ends, the next song is the one lined up
        else:
            await self.start()
        return name

    async def refresh_panel(self):
        if self.live:
            await self.live.refresh()

    async def play_next(self, skip: bool = False):
        self.cancel_idle()
        t = self.q.advance(skip=skip)
        if t is None:
            self.arm_idle()
            return
        try:
            audio = self.audio_for(t)
        except Exception:
            await self.say(content=f"Couldn't open **{t['label']}**. Moving on.")
            return await self.play_next()
        src = discord.PCMVolumeTransformer(audio, volume=self.volume)
        self.started, self.skipping, self.acc_ms = time.monotonic(), False, 0
        self.vc.play(src, after=lambda err: asyncio.run_coroutine_threadsafe(self.on_end(err, t), self.bot.loop))
        if os.environ.get("VOICE_DEBUG") == "1":
            asyncio.create_task(self.dave_report())
        if self.q.upcoming and not self.q.upcoming[0].get("web"):
            asyncio.create_task(self.bot.ut.warm(self.q.upcoming[0]["id"]))  # have the next file ready
        if self.panel_channel is None:  # with a player channel, the panel already shows what's playing
            await self.say(embed=self.card(t, "Now playing"))

    async def dave_report(self):
        """Debug only: says whether this voice connection's audio is really being encrypted, a few times while a song plays."""
        for wait in (2, 6, 15):
            await asyncio.sleep(wait)
            try:
                c = self.vc._connection
                d = c.dave_session
                log.info("DAVE: version=%s can_encrypt=%s ready=%s status=%s epoch=%s members=%s downgraded=%s playing=%s",
                         c.dave_protocol_version, c.can_encrypt, getattr(d, "ready", None), getattr(d, "status", None),
                         getattr(d, "epoch", None), d.get_user_ids() if d else None, c.dave_downgraded, self.vc.is_playing())
            except Exception as e:
                log.info("DAVE: couldn't read state: %r", e)

    async def on_end(self, err, t):
        if err:
            log.warning("playback error: %s", err)
        if not (self.vc and self.vc.is_connected()):
            return  # stopped, or the bot was moved out of the channel
        failed = not self.skipping and time.monotonic() - self.started < 3
        if failed:
            await self.say(content=f"Couldn't play **{t['label']}**. Moving on.")
        await self.play_next(skip=failed or self.skipping)

    def card(self, t: dict, heading: str) -> discord.Embed:
        e = discord.Embed(title=t["title"], description=t["label"].rsplit(" - ", 1)[0], colour=ACCENT)
        e.set_author(name=heading)
        if t["album"]:
            e.add_field(name="Album", value=t["album"])
        e.add_field(name="Length", value=dur(t))
        e.set_footer(text=f"Requested by {t['by']}")
        if t["cover"]:
            e.set_thumbnail(url=t["cover"])
        return e

    async def say(self, **kw):
        if self.channel:
            try:
                await self.channel.send(**kw)
            except discord.HTTPException:
                pass

    # ---- leaving when there's nothing to do ----
    def arm_idle(self):
        self.cancel_idle()
        if not self.stay:  # 24/7 mode never leaves on its own
            self.idle = asyncio.create_task(self._idle())

    def cancel_idle(self):
        if self.idle:
            self.idle.cancel()
            self.idle = None

    async def _idle(self):
        try:
            await asyncio.sleep(IDLE_SECONDS)
            await self.say(content="Nothing playing, so I'm leaving the voice channel.")
            await self.leave()
        except asyncio.CancelledError:
            pass


def status_line(p: "GuildPlayer") -> str:
    loop = {"off": "Loop off", "track": "Looping the song", "queue": "Looping the queue"}[p.q.loop]
    return f"{loop} · Volume {round(p.volume * 100)}%" + (" · 24/7" if p.stay else "")


def controls_embed(p: "GuildPlayer | None", guild: discord.Guild, cur: dict | None) -> discord.Embed:
    """The second embed of the panel: what's playing, what's next, and the settings the buttons change."""
    e = discord.Embed(colour=ACCENT)
    e.set_author(name="Controls")
    if p:
        e.description = status_line(p)
    else:
        e.description = "Loop off · Volume 50%" + (" · 24/7" if prefs.get(guild.id, "stay") else "")
    if cur:
        e.add_field(name="Now playing", value=f"{cur['label'][:100]} ({dur(cur)})" + (f"\nRequested by {cur['by']}" if cur.get("by") else ""), inline=False)
    if p and p.q.upcoming:
        nxt = list(p.q.upcoming)[:3]
        e.add_field(name=f"Up next ({len(p.q.upcoming)})", value="\n".join(f"`{n}.` {t['label'][:70]}" for n, t in enumerate(nxt, 1)), inline=False)
    return e


def idle_embeds(guild: discord.Guild) -> list[discord.Embed]:
    e = discord.Embed(title="Nothing playing", description=f"Play something with `/play` or `{PREFIX}play`. The buttons below work once I'm in a voice channel with you.", colour=ACCENT)
    e.set_author(name="Live lyrics")
    return [e, controls_embed(bot.players.get(guild.id), guild, None)]


async def panel_message(guild: discord.Guild):
    """The player channel and its panel message, if the server has them."""
    cid, mid = prefs.get(guild.id, "live_channel"), prefs.get(guild.id, "live_msg")
    ch = guild.get_channel(cid) if cid else None
    if not ch:
        return None, None
    try:
        return ch, (await ch.fetch_message(mid)) if mid else None
    except discord.HTTPException:
        return ch, None


async def show_idle_panel(guild: discord.Guild):
    """The panel goes to its resting state, in its newest layout. A panel message that's gone (or was never posted) is posted again."""
    cid, mid = prefs.get(guild.id, "live_channel"), prefs.get(guild.id, "live_msg")
    ch = guild.get_channel(cid) if cid else None
    if not ch:
        return
    try:
        msg = await ch.fetch_message(mid) if mid else None
    except discord.NotFound:
        msg = None
    except discord.HTTPException:
        return  # can't tell right now: leave it alone rather than post a second one
    try:
        if msg:
            await msg.edit(embeds=idle_embeds(guild), view=PanelView())
        else:
            prefs.put(guild.id, "live_msg", (await ch.send(embeds=idle_embeds(guild), view=PanelView())).id)
    except discord.HTTPException:
        pass


class LiveLyrics:
    """The lyrics under a song as it plays: one message, edited as each line comes up. Follows the queue from song to song until turned off.
    In a server's player channel (panel=True) it is also the control panel: the same message carries the buttons, and it lives on between songs."""

    def __init__(self, player: GuildPlayer, channel, panel: bool = False):
        self.p, self.channel, self.panel = player, channel, panel
        self.msg = None
        self.track_id = None
        self.lines: list[tuple[int, str]] = []
        self.who = ""
        self.credit = ""
        self.note = ""
        self.idx = -2
        self.last_edit = 0.0
        self.task: asyncio.Task | None = None
        self.lock = asyncio.Lock()  # one send or edit at a time, so a resend can't race the scrolling
        self.was_idle = False

    def start(self):
        self.task = asyncio.create_task(self.run())

    def stop(self):
        if self.task:
            self.task.cancel()
            self.task = None

    def embeds(self, cur: dict | None) -> list[discord.Embed]:
        """The lyrics; in the player channel, the controls embed too."""
        if cur is None:
            return idle_embeds(self.p.guild) if self.panel else idle_embeds(self.p.guild)[:1]
        e = discord.Embed(title=cur["label"][:250], description=(lrc.window(self.lines, self.idx) if self.lines else self.note) or "♪", colour=ACCENT)
        e.set_author(name="Live lyrics")
        e.set_footer(text=(f"Lyrics from {self.who}\n" if self.who else "") + (self.credit + "\n" if self.credit else "")
                     + "On mobile this can lag or fall out of sync. That's Discord's app, not the bot.")
        if cur.get("cover"):
            e.set_thumbnail(url=cur["cover"])
        return [e, controls_embed(self.p, self.p.guild, cur)] if self.panel else [e]

    async def _store(self, msg):
        self.msg = msg
        if self.panel:
            prefs.put(self.p.guild.id, "live_msg", msg.id)

    async def show(self, cur: dict | None):
        async with self.lock:
            self.last_edit = time.monotonic()
            view = PanelView() if self.panel else None
            try:
                if self.msg is None and self.panel and prefs.get(self.p.guild.id, "live_msg"):  # pick up the panel message from before a restart
                    try:
                        self.msg = await self.channel.fetch_message(prefs.get(self.p.guild.id, "live_msg"))
                    except discord.NotFound:
                        self.msg = None
                if self.msg is None:
                    await self._store(await self.channel.send(embeds=self.embeds(cur), view=view))
                else:
                    await self.msg.edit(embeds=self.embeds(cur), view=view)
            except discord.NotFound:
                if self.panel:  # someone removed the panel message: put it back
                    self.msg = None
                    try:
                        await self._store(await self.channel.send(embeds=self.embeds(cur), view=view))
                    except discord.HTTPException:
                        pass
                    return
                self.p.live = None  # the message was deleted: the mode ends
                raise asyncio.CancelledError
            except discord.Forbidden:
                self.p.live = None  # I can't write here any more: the mode ends
                raise asyncio.CancelledError
            except discord.HTTPException:
                pass

    async def refresh(self):
        """Redraws the message now (after a button changed something), without waiting for the next line."""
        if time.monotonic() - self.last_edit < 0.6:
            await asyncio.sleep(0.6)
        await self.show(self.p.q.current)

    async def resend(self, channel):
        """Moves the lyrics to a fresh message at the bottom of `channel` (the old one is removed)."""
        async with self.lock:
            old, self.msg, self.channel = self.msg, None, channel
            if old:
                try:
                    await old.delete()
                except discord.HTTPException:
                    pass
        await self.show(self.p.q.current)

    async def load(self, cur: dict):
        self.track_id, self.lines, self.who, self.credit, self.note, self.idx = cur["id"], [], "", "", "", -2
        if cur.get("web"):
            self.note = "Lyrics aren't available for songs played from a link."
            return await self.show(cur)
        try:
            j = await bot.ut.lyrics(cur["id"])
            lines = lrc.to_lines(j)
            if lrc.is_timed(j):
                self.lines, self.who, self.credit = lines, j.get("name") or j.get("source") or "", lrc.credits(j)
            else:
                self.note = f"These lyrics have no timing, so they can't scroll along. Use `{PREFIX}lyrics` to read them."
        except UndertowError as e:
            if e.status == 403:
                self.note = "My API key isn't allowed to read lyrics. An admin can turn on **Allow lyrics** for it in Undertow."
            elif e.status == 404:
                self.note = "No lyrics found for this song."
            else:
                self.note = "Couldn't get the lyrics just now."
        await self.show(cur)

    async def run(self):
        try:
            while True:
                await asyncio.sleep(0.3)
                cur = self.p.q.current
                if cur is None:
                    if self.panel and not self.was_idle and self.p.vc and self.p.vc.is_connected():
                        self.was_idle, self.track_id = True, None
                        await self.show(None)  # the queue ran out: back to the resting panel
                    continue
                self.was_idle = False
                if not (self.p.vc and self.p.vc.is_connected()):
                    continue  # between songs, or nothing playing
                if cur["id"] != self.track_id:
                    await self.load(cur)
                if not self.lines:
                    continue
                idx = lrc.line_at(self.lines, self.p.position_ms() + LRC_LEAD_MS)
                if idx != self.idx and time.monotonic() - self.last_edit >= 1.0:  # Discord allows about five edits in five seconds
                    self.idx = idx
                    await self.show(cur)
        except asyncio.CancelledError:
            pass


async def panel_guard(i: discord.Interaction, manage: bool = False):
    """Shared checks for the panel's buttons: the server must be licensed, and the person must be in my voice channel."""
    if not i.guild:
        return None
    try:
        if LICENSE_REQUIRED and not (await bot.ut.license_status(i.guild.id)).get("licensed"):
            await i.response.send_message("This server isn't licensed for me.", ephemeral=True)
            return None
    except UndertowError:
        await i.response.send_message("I can't check the license right now. Try again in a moment.", ephemeral=True)
        return None
    p = bot.players.get(i.guild.id)
    if not p or not p.vc or not p.vc.is_connected():
        await i.response.send_message("I'm not in a voice channel. Start something with `/play`.", ephemeral=True)
        return None
    if manage:
        if not i.user.guild_permissions.manage_guild:
            await i.response.send_message("Only someone with **Manage Server** can change that.", ephemeral=True)
            return None
    elif not i.user.voice or i.user.voice.channel != p.vc.channel:
        await i.response.send_message("Join my voice channel to use these buttons.", ephemeral=True)
        return None
    return p


async def confirm(i: discord.Interaction, text: str):
    """Tells only the person who pressed what happened: a reply that vanishes for everyone else."""
    if i.response.is_done():
        await i.followup.send(text, ephemeral=True)
    else:
        await i.response.send_message(text, ephemeral=True)


class PanelView(discord.ui.View):
    """The buttons under the live lyrics in a server's player channel. They keep working after a restart (custom ids don't change)."""

    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(emoji="⏮", style=discord.ButtonStyle.secondary, custom_id="ut:prev", row=0)
    async def prev(self, i: discord.Interaction, b):
        if p := await panel_guard(i):
            name = await p.step_back()
            await confirm(i, f"Going back to **{name}**." if name else "There's nothing before this.")

    @discord.ui.button(emoji="⏯", style=discord.ButtonStyle.primary, custom_id="ut:pause", row=0)
    async def pause_btn(self, i: discord.Interaction, b):
        if p := await panel_guard(i):
            if p.vc.is_paused():
                p.resume()
                await confirm(i, "Resumed.")
            elif p.vc.is_playing():
                p.pause()
                await confirm(i, "Paused.")
            else:
                await confirm(i, "Nothing is playing.")
            await p.refresh_panel()

    @discord.ui.button(emoji="⏭", style=discord.ButtonStyle.secondary, custom_id="ut:next", row=0)
    async def next_btn(self, i: discord.Interaction, b):
        if p := await panel_guard(i):
            if p.q.current:
                name = p.q.current["label"]
                p.skipping = True
                p.vc.stop()
                await confirm(i, f"Skipped **{name}**.")
            else:
                await confirm(i, "Nothing is playing.")

    @discord.ui.button(emoji="⏹", style=discord.ButtonStyle.danger, custom_id="ut:stop", row=0)
    async def stop_btn(self, i: discord.Interaction, b):
        if p := await panel_guard(i):
            await i.response.defer(ephemeral=True, thinking=True)  # leaving the channel can take a moment
            stayed = p.stay
            await p.stop_playing()
            await confirm(i, "Stopped. I'm staying in the channel (24/7 is on)." if stayed else "Stopped and left the voice channel.")

    @discord.ui.button(emoji="🔁", style=discord.ButtonStyle.secondary, custom_id="ut:loop", row=0)
    async def loop_btn(self, i: discord.Interaction, b):
        if p := await panel_guard(i):
            mode = p.q.cycle_loop()
            await confirm(i, {"off": "Loop is off.", "track": "Looping this song.", "queue": "Looping the whole queue."}[mode])
            await p.refresh_panel()

    @discord.ui.button(emoji="🔀", style=discord.ButtonStyle.secondary, custom_id="ut:shuffle", row=1)
    async def shuffle_btn(self, i: discord.Interaction, b):
        if p := await panel_guard(i):
            p.q.shuffle()
            await confirm(i, f"Shuffled the {len(p.q.upcoming)} songs up next." if p.q.upcoming else "Nothing queued to shuffle.")
            await p.refresh_panel()

    @discord.ui.button(emoji="🔉", style=discord.ButtonStyle.secondary, custom_id="ut:voldown", row=1)
    async def vol_down(self, i: discord.Interaction, b):
        if p := await panel_guard(i):
            await set_volume(p, p.volume - 0.1, refresh=False)
            await confirm(i, f"Volume {round(p.volume * 100)}%.")
            await p.refresh_panel()

    @discord.ui.button(emoji="🔊", style=discord.ButtonStyle.secondary, custom_id="ut:volup", row=1)
    async def vol_up(self, i: discord.Interaction, b):
        if p := await panel_guard(i):
            await set_volume(p, p.volume + 0.1, refresh=False)
            await confirm(i, f"Volume {round(p.volume * 100)}%.")
            await p.refresh_panel()

    @discord.ui.button(label="24/7", style=discord.ButtonStyle.secondary, custom_id="ut:247", row=1)
    async def stay_btn(self, i: discord.Interaction, b):
        if p := await panel_guard(i, manage=True):
            await set_stay(p, not p.stay, refresh=False)
            await confirm(i, "24/7 is on. I'll stay in this voice channel, even after a restart." if p.stay else "24/7 is off.")
            await p.refresh_panel()


async def set_volume(p: GuildPlayer, value: float, refresh: bool = True):
    p.volume = max(0.0, min(1.0, round(value, 2)))
    if p.vc and isinstance(p.vc.source, discord.PCMVolumeTransformer):
        p.vc.source.volume = p.volume
    if refresh:
        await p.refresh_panel()


async def set_stay(p: GuildPlayer, on: bool, refresh: bool = True):
    """24/7 mode: stay in this voice channel for good, and come back to it after a restart."""
    if on and p.vc and p.vc.channel:
        prefs.put(p.guild.id, "stay", p.vc.channel.id)
        p.cancel_idle()
    else:
        prefs.put(p.guild.id, "stay", None)
        if not (p.vc and (p.vc.is_playing() or p.vc.is_paused())):
            p.arm_idle()  # nothing playing: the usual idle timer applies again
    if refresh:
        await p.refresh_panel()


class Pager(discord.ui.View):
    """Plain lyrics, a page at a time."""

    def __init__(self, title: str, pages: list[str], footer: str):
        super().__init__(timeout=180)
        self.title, self.pages, self.footer, self.n, self.message = title, pages, footer, 0, None
        self.prev.disabled = True
        self.next.disabled = len(pages) < 2
        if len(pages) < 2:
            self.clear_items()

    def embed(self) -> discord.Embed:
        e = discord.Embed(title=self.title[:250], description=self.pages[self.n], colour=ACCENT)
        e.set_footer(text=f"{self.footer} · page {self.n + 1}/{len(self.pages)}" if len(self.pages) > 1 else self.footer)
        return e

    async def go(self, i: discord.Interaction, d: int):
        self.n = max(0, min(len(self.pages) - 1, self.n + d))
        self.prev.disabled, self.next.disabled = self.n == 0, self.n == len(self.pages) - 1
        await i.response.edit_message(embed=self.embed(), view=self)

    @discord.ui.button(label="◀", style=discord.ButtonStyle.secondary)
    async def prev(self, i: discord.Interaction, _):
        await self.go(i, -1)

    @discord.ui.button(label="▶", style=discord.ButtonStyle.secondary)
    async def next(self, i: discord.Interaction, _):
        await self.go(i, 1)

    async def on_timeout(self):
        if self.message:
            try:
                await self.message.edit(view=None)
            except discord.HTTPException:
                pass


class UndertowBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True  # needed to read "g+play …"; turn on "Message Content Intent" for the bot in the Developer Portal
        super().__init__(command_prefix=commands.when_mentioned_or(PREFIX), intents=intents, help_command=None,
                         allowed_mentions=discord.AllowedMentions.none(),  # nothing I send pings anyone: not @everyone, not roles, not people (a song title could contain one)
                         activity=discord.Activity(type=discord.ActivityType.playing, name=PRESENCE) if PRESENCE else None)
        self.ut = Undertow(BASE, KEY, QUALITY)
        self.players: dict[int, GuildPlayer] = {}
        self.snap_last: dict[int, str] = {}  # what was last written for each server, so a quiet server isn't rewritten every few seconds

    def player(self, guild: discord.Guild) -> GuildPlayer:
        return self.players.setdefault(guild.id, GuildPlayer(self, guild))

    async def setup_hook(self):
        await self.ut.start()
        try:
            await self.ut.search("test", 1)
        except UndertowError as e:
            raise SystemExit(f"Undertow said no: {e}. Check UNDERTOW_URL and UNDERTOW_KEY.")
        self.add_view(PanelView())  # the player panels' buttons, from before a restart, work again
        if LICENSE_REQUIRED:
            self.license_task = asyncio.create_task(self.license_sweep())
        if GUILD_ID:
            g = discord.Object(id=int(GUILD_ID))
            self.tree.copy_global_to(guild=g)
            await self.tree.sync(guild=g)
        else:
            await self.tree.sync()

    async def on_ready(self):
        if getattr(self, "_started", False):
            return  # Discord reconnects fire this again
        self._started = True
        for g in self.guilds:
            try:
                await self.restore(g)
            except Exception as e:
                log.warning("start-up for %s: %r", g.id, e)
        self.snap_task = asyncio.create_task(self.snapshot_loop())

    async def restore(self, g: discord.Guild):
        """After a restart: back into the voice channel I was in (24/7, or with music playing), and carry on with the queue."""
        res, stay = prefs.get(g.id, "resume"), prefs.get(g.id, "stay")
        chan = g.get_channel((res or {}).get("vc") or stay or 0)
        if not isinstance(chan, (discord.VoiceChannel, discord.StageChannel)):
            prefs.put(g.id, "resume", None)
            return await show_idle_panel(g)  # a panel left over from before the restart goes back to resting
        if LICENSE_REQUIRED and not (await self.ut.license_status(g.id)).get("licensed"):
            return
        if res and not [m for m in chan.members if not m.bot] and not stay:
            prefs.put(g.id, "resume", None)  # nobody was listening any more: no point starting the music
            return await show_idle_panel(g)
        p = self.player(g)
        await p.join(chan)
        if res and res.get("items"):
            p.q.upcoming = deque(res["items"])
            p.q.loop = res.get("loop") if res.get("loop") in LOOP_MODES else "off"
            p.volume = float(res.get("volume") or p.volume)
            p.channel = g.get_channel(res.get("text") or 0) or p.channel
        p.ensure_panel()
        if p.q.upcoming:
            log.info("resuming %d songs in %s", len(p.q.upcoming), g.id)
            await p.start()

    def save_state(self):
        for gid, p in self.players.items():
            snap = p.snapshot()
            if snap is None and not (p.vc and p.vc.is_connected()):
                continue  # not in a channel (or going away): leave what's saved alone
            key = json.dumps(snap, sort_keys=True)
            if self.snap_last.get(gid) == key:
                continue
            self.snap_last[gid] = key
            prefs.put(gid, "resume", snap)  # None clears it: the queue ran out

    async def snapshot_loop(self):
        while True:
            await asyncio.sleep(5)
            try:
                self.save_state()
            except Exception as e:
                log.warning("saving the queue: %r", e)

    async def license_sweep(self):
        """Every couple of minutes: a server whose license was turned off stops hearing the bot, even in the middle of a song."""
        while True:
            await asyncio.sleep(120)
            for gid, p in list(self.players.items()):
                if not p.vc:
                    continue
                try:
                    if (await self.ut.license_status(gid)).get("licensed"):
                        continue
                except UndertowError:
                    continue  # can't tell; keep playing rather than cut the music over a hiccup
                if p.channel:
                    try:
                        await p.channel.send("This server's bot license is no longer active, so I'm leaving.")
                    except discord.HTTPException:
                        pass
                await p.leave()

    async def close(self):
        try:
            self.save_state()  # the queue as it is now, to come back to
        except Exception as e:
            log.warning("saving the queue: %r", e)
        for p in self.players.values():
            await p.leave(forget=False)
        await self.ut.close()
        await super().close()

    async def on_voice_state_update(self, member, before, after):
        p = self.players.get(member.guild.id)
        if not p or not p.vc or not p.vc.channel or member.id == self.user.id:
            return
        if not [m for m in p.vc.channel.members if not m.bot]:  # everyone left: don't play to an empty room
            if p.vc.is_playing():
                p.pause()
            p.arm_idle()
        elif before.channel != after.channel and after.channel == p.vc.channel:
            p.cancel_idle()


bot = UndertowBot()


async def licensed(ctx: commands.Context):
    """Every command but /license and /help only works in a server that holds a license."""
    if not LICENSE_REQUIRED or (ctx.command and ctx.command.name in ("license", "help", "status")):
        return True
    if not ctx.guild:
        raise commands.CheckFailure("Use this in a server.")
    try:
        ok = (await bot.ut.license_status(ctx.guild.id)).get("licensed")
    except UndertowError:
        raise commands.CheckFailure("I can't check this server's license right now. Try again in a moment.")
    if not ok:
        raise commands.CheckFailure(f"This server doesn't have a license for me. Ask the Undertow owner for one, then someone with **Manage Server** runs `{PREFIX}license <code>` here.")
    return True


bot.add_check(licensed)


def in_voice(ctx: commands.Context):
    if not ctx.guild:
        raise commands.CheckFailure("Use this in a server.")
    if not ctx.author.voice or not ctx.author.voice.channel:
        raise commands.CheckFailure("Join a voice channel first.")
    return True


def with_me(ctx: commands.Context):
    p = bot.players.get(ctx.guild.id) if ctx.guild else None
    if not p or not p.vc or not p.vc.is_connected():
        raise commands.CheckFailure("I'm not playing anything here.")
    if not ctx.author.voice or ctx.author.voice.channel != p.vc.channel:
        raise commands.CheckFailure("Join my voice channel to control the music.")
    return True


async def song_choices(i: discord.Interaction, current: str):
    if len(current.strip()) < 2 or parse_tidal_url(current):
        return []
    try:
        if LICENSE_REQUIRED and not (i.guild and (await bot.ut.license_status(i.guild.id)).get("licensed")):
            return []
        tracks = await asyncio.wait_for(bot.ut.search(current.strip(), 8), 2.5)
    except Exception:
        return []
    out = []
    for t in tracks:
        value = f"id:{t['id']}"
        if len(value) > 100:  # Discord refuses the whole list if one value is too long
            continue
        mark = "" if t.get("source", "TIDAL") == "TIDAL" else f" · {t['source']}"  # songs from a Subsonic server say so
        out.append(discord.app_commands.Choice(name=(label(t)[: 100 - len(mark)] + mark), value=value))
    return out


async def queue_up(guild: discord.Guild, channel, member: discord.Member, items: list[dict]):
    """Joins the member's voice channel and queues the songs. Returns (player, how many were added, whether something was already playing).
    Raises CheckFailure with a message the person can read."""
    voice = member.voice.channel if member.voice else None
    if not voice:
        raise commands.CheckFailure("Join a voice channel first.")
    p = bot.player(guild)
    if p.vc and p.vc.is_connected() and p.vc.channel != voice and (p.vc.is_playing() or p.vc.is_paused()):
        raise commands.CheckFailure("I'm already playing in another voice channel.")
    p.channel = channel
    try:
        await p.join(voice)
    except Exception as e:
        raise commands.CheckFailure(f"Couldn't join that voice channel: {e}")
    added = p.q.add(items)
    p.ensure_panel()
    return p, added, p.vc.is_playing() or p.vc.is_paused()


class PickView(discord.ui.View):
    """A menu under the search results: pick one song, or several, and they're queued."""

    def __init__(self, owner: discord.abc.User, tracks: list[dict]):
        super().__init__(timeout=90)
        self.owner, self.tracks, self.message = owner, tracks, None
        opts = []
        for n, t in enumerate(tracks):
            who = ", ".join(a["name"] for a in t.get("artists", [])) or "Unknown artist"
            src = "" if t.get("source", "TIDAL") == "TIDAL" else f" · {t['source']}"
            opts.append(discord.SelectOption(label=f"{n + 1}. {t.get('title', '?')}"[:100], description=f"{who}{src} · {mmss(t.get('duration'))}"[:100], value=str(n)))
        self.menu = discord.ui.Select(placeholder="Pick a song (or several) to play", min_values=1, max_values=len(opts), options=opts)
        self.menu.callback = self.picked
        self.add_item(self.menu)

    async def picked(self, i: discord.Interaction):
        if i.user.id != self.owner.id:
            return await i.response.send_message("This menu belongs to whoever searched. Run your own search.", ephemeral=True)
        items = [item(self.tracks[int(v)], i.user.display_name) for v in self.menu.values]
        try:
            p, added, playing = await queue_up(i.guild, i.channel, i.user, items)
        except commands.CheckFailure as e:
            return await i.response.send_message(str(e), ephemeral=True)
        names = "\n".join(f"• **{t['label']}**" for t in items[:added])
        note = "" if added == len(items) else " (the queue was full, so some were left out)"
        self.stop()
        await i.response.edit_message(content=f"Queued{note}:\n{names}" + ("" if playing else "\nStarting now."), embed=None, view=None)
        await p.start()

    async def on_timeout(self):
        if self.message:
            try:
                await self.message.edit(content="Search timed out. Run it again if you still want something.", embed=None, view=None)
            except discord.HTTPException:
                pass


# Each command works as a slash command and as a prefix command ("g+play ordinary world"), from one definition.
@bot.hybrid_command(aliases=["p"], description="Play a song: search, or paste a TIDAL link, or a link to audio, YouTube, SoundCloud...")
@discord.app_commands.describe(song="Song name, or a link")
@commands.check(in_voice)
async def play(ctx: commands.Context, *, song: str):
    await ctx.defer()
    who = ctx.author.display_name
    try:
        link = parse_tidal_url(song)
        if song.startswith("id:") and TRACK_ID.match(song[3:]):
            link = ("track", song[3:])
        web = None if link else weburl.find_url(song)
        if web:
            items, msg = await web_items(web, who)
        elif link and link[0] in ("album", "playlist", "mix", "artist"):
            kind = link[0]
            if kind == "album":
                name, tracks = "that album", await bot.ut.album_tracks(link[1])
            elif kind == "playlist":
                name, tracks = await bot.ut.playlist(link[1])
            elif kind == "mix":
                name, tracks = await bot.ut.mix(link[1])
            else:
                name, tracks = await bot.ut.artist_top(link[1])
            items = [item(t, who) for t in tracks if t.get("id")]
            if not items:
                return await ctx.send(f"I couldn't find any songs in {name}.")
            msg = f"Added **{len(items)}** songs from {name}."
        elif link:
            items = [item(await bot.ut.track(link[1]), who)]
            msg = f"Queued **{items[0]['label']}**"
        else:
            found = await bot.ut.search(song.strip(), 1)
            if not found:
                return await ctx.send("I couldn't find that.")
            items = [item(found[0], who)]
            msg = f"Queued **{items[0]['label']}**"
    except UndertowError as e:
        return await ctx.send(f"Undertow: {e}")
    except commands.CheckFailure as e:
        return await ctx.send(str(e))
    try:
        p, added, playing = await queue_up(ctx.guild, ctx.channel, ctx.author, items)
    except commands.CheckFailure as e:
        return await ctx.send(str(e))
    if added < len(items):
        msg += f" (the queue is full, so only {added} were added)"
    await ctx.send(msg if playing else f"{msg}\nStarting now.")
    await p.start()


play.autocomplete("song")(song_choices)


@bot.hybrid_command(aliases=["find", "sr"], description="Search and pick what to play")
@discord.app_commands.describe(query="What to look for")
@commands.check(in_voice)
async def search(ctx: commands.Context, *, query: str):
    await ctx.defer()
    try:
        tracks = (await bot.ut.search(query.strip(), 10))[:10]
    except UndertowError as e:
        return await ctx.send(f"Undertow: {e}")
    if not tracks:
        return await ctx.send("I couldn't find that.")
    lines = []
    for n, t in enumerate(tracks, 1):
        src = "" if t.get("source", "TIDAL") == "TIDAL" else f" · *{t['source']}*"
        lines.append(f"`{n}.` {label(t)} · {mmss(t.get('duration'))}{src}")
    e = discord.Embed(title=f"Results for “{query.strip()[:80]}”", description="\n".join(lines), colour=ACCENT)
    e.set_footer(text="Pick from the menu below. Only you can use it.")
    view = PickView(ctx.author, tracks)
    view.message = await ctx.send(embed=e, view=view)


@bot.hybrid_command(name="lyrics", aliases=["ly"], description="Show the lyrics of the current song, or of a song you name")
@discord.app_commands.describe(song="A song to look up (leave blank for the current one)")
async def lyrics_cmd(ctx: commands.Context, *, song: str | None = None):
    await ctx.defer()
    try:
        if song and song.strip():
            found = await bot.ut.search(song.strip(), 1)
            if not found:
                return await ctx.send("I couldn't find that song.")
            tid, name = found[0]["id"], label(found[0])
        else:
            p = bot.players.get(ctx.guild.id) if ctx.guild else None
            if not p or not p.q.current:
                return await ctx.send(f"Nothing is playing. Name a song: `{PREFIX}lyrics <song>`")
            if p.q.current.get("web"):
                return await ctx.send(f"Lyrics aren't available for songs played from a link. Name a song instead: `{PREFIX}lyrics <song>`")
            tid, name = p.q.current["id"], p.q.current["label"]
        j = await bot.ut.lyrics(tid)
    except UndertowError as e:
        if e.status == 403:
            return await ctx.send("My API key isn't allowed to read lyrics. An admin can turn on **Allow lyrics** for it in Undertow (Users, API keys, Edit).")
        return await ctx.send("No lyrics found for that song." if e.status == 404 else f"Undertow: {e}")
    text = str(j.get("text") or "").strip()
    if not text:
        return await ctx.send("No lyrics found for that song.")
    view = Pager(name, lrc.pages(text), f"Lyrics from {j.get('name') or j.get('source') or 'Undertow'}" + (f" · {lrc.credits(j)}" if lrc.credits(j) else ""))
    view.message = await ctx.send(embed=view.embed(), view=view if view.children else None)


@bot.hybrid_command(name="realtime-lrc", aliases=["rlrc", "live"], description="Show the lyrics live under the song, turning it on or off")
@commands.check(with_me)
async def realtime_lrc(ctx: commands.Context):
    p = bot.player(ctx.guild)
    if p.panel_channel:
        return await ctx.send(f"The player panel in {p.panel_channel.mention} already shows live lyrics, all the time.", ephemeral=True)
    if p.live:
        p.live.stop()
        p.live = None
        return await ctx.send("Live lyrics are off.")
    p.live = LiveLyrics(p, ctx.channel)
    p.live.start()
    await ctx.send("Live lyrics are on. They'll follow the music from song to song. Run this again to turn them off.", delete_after=8)


@bot.hybrid_command(name="resendlivelrc", aliases=["relive", "relrc"], description="Send the live lyrics again at the bottom of the chat")
@commands.check(with_me)
async def resend_live_lrc(ctx: commands.Context):
    p = bot.player(ctx.guild)
    if not p.live:
        return await ctx.send(f"Live lyrics aren't on. Start them with `{PREFIX}realtime-lrc`.", ephemeral=True)
    target = p.panel_channel or ctx.channel
    await p.live.resend(target)
    await ctx.send("Sent the live lyrics again." + (f" They're in {target.mention}." if target.id != ctx.channel.id else ""), delete_after=6)


async def lock_channel(ch: discord.TextChannel, me: discord.Member) -> str | None:
    """Only I can write in `ch`. Returns None on success, or what went wrong."""
    try:
        mine = ch.overwrites_for(me)
        mine.update(view_channel=True, send_messages=True, embed_links=True)
        await ch.set_permissions(me, overwrite=mine, reason="Undertow player channel: I post here")  # first, so I can't lock myself out
        everyone = ch.overwrites_for(ch.guild.default_role)
        everyone.update(send_messages=False, send_messages_in_threads=False, create_public_threads=False, create_private_threads=False, add_reactions=False)
        await ch.set_permissions(ch.guild.default_role, overwrite=everyone, reason="Undertow player channel: only the bot posts here")
    except discord.Forbidden:
        return "I'm not allowed to change that channel's permissions. Give me **Manage Channels** (or Manage Roles) there."
    except discord.HTTPException:
        return "Discord refused the permission change."
    return None


async def unlock_channel(ch: discord.TextChannel, me: discord.Member):
    try:
        everyone = ch.overwrites_for(ch.guild.default_role)
        everyone.update(send_messages=None, send_messages_in_threads=None, create_public_threads=None, create_private_threads=None, add_reactions=None)
        await ch.set_permissions(ch.guild.default_role, overwrite=None if everyone.is_empty() else everyone, reason="Undertow player channel removed")
        await ch.set_permissions(me, overwrite=None, reason="Undertow player channel removed")
    except discord.HTTPException:
        pass


@bot.hybrid_command(name="livelrc-channel", aliases=["lrc-channel", "player-channel"], description="Make a channel the player: live lyrics and buttons. Run with no channel to remove it")
@discord.app_commands.describe(channel="The text channel to use", lock="Stop everyone else from posting there (needs Manage Channels for me). On by default")
async def livelrc_channel(ctx: commands.Context, channel: discord.TextChannel | None = None, lock: bool = True):
    if not ctx.guild:
        raise commands.CheckFailure("Use this in a server.")
    if not ctx.author.guild_permissions.manage_guild:
        raise commands.CheckFailure("Only someone with **Manage Server** can do that.")
    g, me = ctx.guild, ctx.guild.me
    p = bot.player(g)
    current = g.get_channel(prefs.get(g.id, "live_channel") or 0)

    async def drop_old():
        """Takes the player down from the channel it was in: the message goes, and the lock is lifted."""
        if p.live and p.live.panel:
            p.live.stop()
            p.live = None
        if current:
            _, msg = await panel_message(g)
            if msg:
                try:
                    await msg.delete()
                except discord.HTTPException:
                    pass
            if prefs.get(g.id, "locked"):
                await unlock_channel(current, me)
        for k in ("live_channel", "live_msg", "locked"):
            prefs.put(g.id, k, None)

    if channel is None:
        if not current:
            return await ctx.send(f"No player channel yet. Make one with `{PREFIX}livelrc-channel #channel`.", ephemeral=True)
        await drop_old()
        return await ctx.send("Player channel removed. Live lyrics are back to `realtime-lrc`.")
    perms = channel.permissions_for(me)
    if not (perms.view_channel and perms.send_messages and perms.embed_links):
        raise commands.CheckFailure(f"I can't post embeds in {channel.mention}. Give me **View Channel**, **Send Messages** and **Embed Links** there first.")
    if current and current.id != channel.id:
        await drop_old()
    prefs.put(g.id, "live_channel", channel.id)
    notes = []
    if lock:
        err = await lock_channel(channel, me)
        if err:
            notes.append(f"It isn't locked: {err} Or deny **Send Messages** for the everyone role there yourself.")
        else:
            prefs.put(g.id, "locked", True)
            notes.append("Only I can post there now.")
    if p.vc and p.vc.is_connected():
        p.ensure_panel()
    else:
        await show_idle_panel_in(channel)
    await ctx.send(f"The player is now in {channel.mention}: live lyrics and buttons. " + " ".join(notes))


async def show_idle_panel_in(channel: discord.TextChannel):
    """Posts the resting panel into a channel that has none yet."""
    msg = await channel.send(embeds=idle_embeds(channel.guild), view=PanelView())
    prefs.put(channel.guild.id, "live_msg", msg.id)


@bot.hybrid_command(name="247", aliases=["stay"], description="Stay in the voice channel all the time (or stop doing that)")
@commands.check(with_me)
async def twenty_four_seven(ctx: commands.Context):
    if not ctx.author.guild_permissions.manage_guild:
        raise commands.CheckFailure("Only someone with **Manage Server** can do that.")
    p = bot.player(ctx.guild)
    await set_stay(p, not p.stay)
    await ctx.send(f"24/7 is **{'on' if p.stay else 'off'}**." + (f" I'll stay in {p.vc.channel.mention}, even after a restart." if p.stay else ""))


@bot.hybrid_command(name="previous", aliases=["prev", "back"], description="Go back to the previous song (or the start of this one)")
@commands.check(with_me)
async def previous(ctx: commands.Context):
    p = bot.player(ctx.guild)
    name = await p.step_back()
    if not name:
        return await ctx.send("There's nothing before this.", ephemeral=True)
    await ctx.send(f"Going back to **{name}**.", delete_after=6)


@bot.hybrid_command(aliases=["s", "next"], description="Skip the current song")
@commands.check(with_me)
async def skip(ctx: commands.Context):
    p = bot.player(ctx.guild)
    if not p.q.current:
        return await ctx.send("Nothing is playing.", ephemeral=True)
    p.skipping = True
    await ctx.send(f"Skipped **{p.q.current['label']}**")
    p.vc.stop()


@bot.hybrid_command(description="Pause the music")
@commands.check(with_me)
async def pause(ctx: commands.Context):
    p = bot.player(ctx.guild)
    if p.vc.is_playing():
        p.pause()
        await ctx.send("Paused.")
    else:
        await ctx.send("Nothing is playing.", ephemeral=True)


@bot.hybrid_command(aliases=["unpause"], description="Resume the music")
@commands.check(with_me)
async def resume(ctx: commands.Context):
    p = bot.player(ctx.guild)
    if p.vc.is_paused():
        p.resume()
        p.cancel_idle()
        await ctx.send("Resumed.")
    else:
        await ctx.send("It isn't paused.", ephemeral=True)


@bot.hybrid_command(aliases=["leave", "dc"], description="Stop, clear the queue and leave")
@commands.check(with_me)
async def stop(ctx: commands.Context):
    p = bot.player(ctx.guild)
    stayed = p.stay
    await p.stop_playing()
    await ctx.send("Stopped. I'm staying in the channel (24/7 is on)." if stayed else "Stopped and left.")


@bot.hybrid_command(aliases=["q"], description="Show what's playing and what's next")
@commands.check(with_me)
async def queue(ctx: commands.Context):
    p = bot.player(ctx.guild)
    if not p.q.current and not p.q.upcoming:
        return await ctx.send("The queue is empty.", ephemeral=True)
    lines = [f"**Now:** {p.q.current['label']} ({dur(p.q.current)})"] if p.q.current else []
    for n, t in enumerate(list(p.q.upcoming)[:10], 1):
        lines.append(f"`{n}.` {t['label']} ({dur(t)})")
    if len(p.q.upcoming) > 10:
        lines.append(f"…and {len(p.q.upcoming) - 10} more")
    lines.append(f"\nLoop: **{p.q.loop}**")
    await ctx.send("\n".join(lines))


@bot.hybrid_command(name="nowplaying", aliases=["np"], description="Show the current song")
@commands.check(with_me)
async def nowplaying(ctx: commands.Context):
    p = bot.player(ctx.guild)
    if not p.q.current:
        return await ctx.send("Nothing is playing.", ephemeral=True)
    await ctx.send(embed=p.card(p.q.current, "Now playing"))


@bot.hybrid_command(aliases=["vol"], description="Set the volume, 0 to 100")
@discord.app_commands.describe(percent="0 to 100")
@commands.check(with_me)
async def volume(ctx: commands.Context, percent: commands.Range[int, 0, 100]):
    await set_volume(bot.player(ctx.guild), percent / 100)
    await ctx.send(f"Volume {percent}%")


@bot.hybrid_command(name="loop", description="Loop the song, the whole queue, or neither")
@commands.check(with_me)
async def loop_cmd(ctx: commands.Context, mode: Literal["off", "track", "queue"] | None = None):
    await ctx.send(f"Loop: **{bot.player(ctx.guild).q.cycle_loop(mode)}**")


@bot.hybrid_command(description="Shuffle the queue")
@commands.check(with_me)
async def shuffle(ctx: commands.Context):
    bot.player(ctx.guild).q.shuffle()
    await ctx.send("Shuffled.")


@bot.hybrid_command(aliases=["rm"], description="Take a song out of the queue")
@discord.app_commands.describe(position="Its number in the queue")
@commands.check(with_me)
async def remove(ctx: commands.Context, position: int):
    try:
        gone = bot.player(ctx.guild).q.remove(position)
    except IndexError:
        return await ctx.send("There's no song at that position.", ephemeral=True)
    await ctx.send(f"Removed **{gone['label']}**")


@bot.hybrid_command(description="Unlock me in this server with a license from the Undertow owner")
@discord.app_commands.describe(code="The license code, like UT-ABCD-EFGH-JKLM")
async def license(ctx: commands.Context, *, code: str = ""):
    if not ctx.guild:
        raise commands.CheckFailure("Use this in a server.")
    if not ctx.author.guild_permissions.manage_guild:
        raise commands.CheckFailure("Only someone with **Manage Server** can do that.")
    hidden = True
    if ctx.interaction is None:  # a typed code stays in the channel for everyone: take it down first thing
        try:
            await ctx.message.delete()
        except discord.HTTPException:
            hidden = False
    if not code.strip():
        state = (await bot.ut.license_status(ctx.guild.id)) if LICENSE_REQUIRED else {"licensed": True}
        if state.get("licensed"):
            return await ctx.send("This server is licensed." + (f" Held by **{state['holder']}**." if state.get("holder") else ""), ephemeral=True)
        return await ctx.send(f"This server isn't licensed. Run `{PREFIX}license <code>` with the code the Undertow owner gave you.", ephemeral=True)
    try:
        res = await bot.ut.redeem_license(code.strip(), ctx.guild.id, ctx.guild.name)
    except UndertowError as e:
        return await ctx.send(f"Couldn't use that license: {e}", ephemeral=True)
    await ctx.send(f"Licensed. This server is unlocked, thanks to **{res.get('holder') or 'the owner'}**. Try `{PREFIX}play`."
                   + ("" if hidden else f"\nI couldn't delete your message with the code. Give me **Manage Messages**, or use `/license` (only you see that) next time."))


STARTED = time.time()


@bot.hybrid_command(aliases=["info"], description="This server's license, and whether Undertow and TIDAL are working")
async def status(ctx: commands.Context):
    if not ctx.guild:
        raise commands.CheckFailure("Use this in a server.")
    await ctx.defer()
    lic = {"licensed": True}
    if LICENSE_REQUIRED:
        try:
            lic = await bot.ut.license_status(ctx.guild.id)
        except UndertowError:
            lic = {"error": True}
    if lic.get("error"):
        license_line = "Couldn't check right now"
    elif lic.get("licensed"):
        since = f" since <t:{int(lic['since'] // 1000)}:D>" if lic.get("since") else ""
        license_line = f"Licensed{since}" + (f" · held by **{lic['holder']}**" if lic.get("holder") else "") + (f" · {lic['label']}" if lic.get("label") else "")
    else:
        license_line = f"Not licensed. Ask the Undertow owner for a code, then `{PREFIX}license <code>`."
    api = "Down"
    try:
        t0 = time.perf_counter()
        found = await asyncio.wait_for(bot.ut.search("a", 1), 8)
        ms = int((time.perf_counter() - t0) * 1000)
        api = f"Up · {ms} ms" if found else f"Reachable, but TIDAL search came back empty · {ms} ms"
    except asyncio.TimeoutError:
        api = "Too slow (no answer in 8 s)"
    except UndertowError as e:
        api = f"Down: {e}"[:120]
    p = bot.players.get(ctx.guild.id)
    playing = "Idle"
    if p and p.q.current:
        playing = f"Playing **{p.q.current['label']}**" + (f" · {len(p.q.upcoming)} queued" if p.q.upcoming else "")
    up = int(time.time() - STARTED)
    e = discord.Embed(title="Status", colour=ACCENT)
    e.add_field(name="License", value=license_line, inline=False)
    e.add_field(name="Undertow API", value=api, inline=False)
    e.add_field(name="Here", value=playing, inline=False)
    e.set_footer(text=f"Up {up // 86400}d {up % 86400 // 3600}h {up % 3600 // 60}m · {round(bot.latency * 1000)} ms to Discord · {len(bot.guilds)} server{'s' if len(bot.guilds) != 1 else ''}")
    await ctx.send(embed=e)


@bot.hybrid_command(aliases=["commands"], description="What I can do")
async def help(ctx: commands.Context):
    await ctx.send(
        f"Use `/` commands or the `{PREFIX}` prefix.\n"
        f"`{PREFIX}play <song or link>` (`{PREFIX}p`) · `{PREFIX}search <words>` (`find`) · `{PREFIX}lyrics` (`ly`) · `{PREFIX}realtime-lrc` (`rlrc`) · `{PREFIX}previous` · `{PREFIX}resendlivelrc` · `{PREFIX}livelrc-channel` · `{PREFIX}247` · `{PREFIX}skip` (`s`) · `{PREFIX}pause` · `{PREFIX}resume` · `{PREFIX}stop` (`leave`)\n"
        f"`{PREFIX}queue` (`q`) · `{PREFIX}np` · `{PREFIX}volume 0-100` · `{PREFIX}loop off|track|queue` · `{PREFIX}shuffle` · `{PREFIX}remove <n>` · `{PREFIX}status` · `{PREFIX}license <code>`"
    )


@bot.event
async def on_command_error(ctx: commands.Context, err: commands.CommandError):
    err = getattr(err, "original", err)
    if isinstance(err, commands.CommandNotFound):
        return  # someone just typed the prefix in a normal message
    if isinstance(err, commands.CheckFailure):
        msg = str(err) or "You can't do that here."
    elif isinstance(err, commands.MissingRequiredArgument):
        msg = f"Say what to play: `{PREFIX}play <song or TIDAL link>`" if err.param.name == "song" else f"Missing **{err.param.name}**."
    elif isinstance(err, (commands.BadArgument, commands.RangeError)):
        msg = str(err) or "That doesn't look right."
    else:
        log.exception("command failed", exc_info=err)
        msg = "Something went wrong."
    try:
        await ctx.send(msg, ephemeral=True)
    except discord.HTTPException:
        pass


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if os.environ.get("VOICE_DEBUG") == "1":  # only the voice parts, so the log never carries the login token
        class Hide(logging.Filter):  # tokens never reach the log
            def filter(self, rec):
                rec.msg = re.sub(r"""(['"]token['"]\s*:\s*['"])[^'"]+""", r"\1***", str(rec.getMessage()))
                rec.args = ()
                return True
        for h in logging.getLogger().handlers:
            h.addFilter(Hide())
        for n in ("discord.voice_state", "discord.voice_client", "discord.player", "discord.gateway"):
            logging.getLogger(n).setLevel(logging.DEBUG)
    missing = [n for n, v in (("UNDERTOW_URL", BASE), ("UNDERTOW_KEY", KEY)) if not v]
    if missing:
        raise SystemExit(f"Set {', '.join(missing)} in .env (see .env.example).")
    if not TOKEN:  # no token in the environment: it's kept in Undertow
        try:
            TOKEN = asyncio.run(fetch_bot_token(BASE, KEY))
        except UndertowError as e:
            raise SystemExit(f"Couldn't get the bot token from Undertow: {e}")
    if identity.apply(PLATFORM):
        log.info("Appearing on Discord as: %s", PLATFORM)
    try:
        bot.run(TOKEN, log_handler=None)
    except discord.PrivilegedIntentsRequired:
        raise SystemExit(f"Turn on \"Message Content Intent\" for the bot (Developer Portal, Bot tab) so '{PREFIX}' commands can be read, then start it again.")
