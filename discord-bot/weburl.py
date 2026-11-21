"""Playing from a link: a direct audio file or radio stream, or a page on a site yt-dlp understands (YouTube, SoundCloud, Bandcamp...).

Anything the bot is told to open goes through here first. Links to private or local addresses are refused (so nobody can use the bot to poke at the
machine's own network), a direct link has to actually be audio, and a page link has to be on a site in the allow-list."""
import asyncio
import hashlib
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urljoin, urlparse

import aiohttp

UA = "Mozilla/5.0 (X11; Linux x86_64) Undertow-Discord-Bot/1.0"
URL_RE = re.compile(r"https?://[^\s<>\"']+", re.I)
AUDIO_EXT = (".mp3", ".flac", ".wav", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".wma", ".aiff", ".aif", ".m3u8", ".weba")
AUDIO_TYPES = {"application/ogg", "application/x-mpegurl", "application/vnd.apple.mpegurl"}
DEFAULT_SITES = "youtube.com,youtu.be,music.youtube.com,soundcloud.com,bandcamp.com,mixcloud.com,vimeo.com,twitch.tv,audiomack.com"
PLAYLIST_MAX = 25
BIN = Path(sys.executable).parent  # the bot's own environment holds yt-dlp and its JavaScript runtime


def find_url(text: str) -> str | None:
    m = URL_RE.search(text or "")
    return m.group(0).rstrip(").,;>]") if m else None


def sites() -> list[str] | None:
    """Hosts a page link may be on; None means any (URL_SITES=*)."""
    raw = os.environ.get("URL_SITES", DEFAULT_SITES).strip()
    return None if raw == "*" else [h.strip().lower() for h in raw.split(",") if h.strip()]


def site_ok(url: str) -> bool:
    allowed = sites()
    host = (urlparse(url).hostname or "").lower()
    return allowed is None or any(host == d or host.endswith("." + d) for d in allowed)


def web_id(url: str) -> str:
    return "web:" + hashlib.sha1(url.encode()).hexdigest()[:12]


async def safe_host(url: str) -> bool:
    """True only for http(s) links with no login in them, whose host resolves to public addresses only."""
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password:
        return False
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(u.hostname, None, type=socket.SOCK_STREAM)
    except OSError:
        return False
    addrs = {i[4][0].split("%")[0] for i in infos}
    return bool(addrs) and all(ipaddress.ip_address(a).is_global for a in addrs)


def _title_from(url: str, headers) -> str:
    name = headers.get("icy-name") or headers.get("ice-name")
    if name:
        return str(name).strip()[:100]
    base = unquote(os.path.basename(urlparse(url).path)) or urlparse(url).hostname or "Audio"
    return re.sub(r"\.[A-Za-z0-9]{2,5}$", "", base).replace("_", " ").strip()[:100] or "Audio"


async def probe_direct(url: str, allow_private: bool = False) -> dict | None:
    """If the link is itself audio (a file or a radio stream), says so: {"url": final address, "title", "live"}. Redirects are followed by hand, so each hop is checked."""
    cur = url
    timeout = aiohttp.ClientTimeout(total=12, sock_read=8)
    async with aiohttp.ClientSession(timeout=timeout, headers={"User-Agent": UA, "Icy-MetaData": "0"}) as s:
        for _ in range(4):
            if not allow_private and not await safe_host(cur):
                return None
            try:
                async with s.get(cur, allow_redirects=False) as r:
                    if r.status in (301, 302, 303, 307, 308) and r.headers.get("Location"):
                        cur = urljoin(cur, r.headers["Location"])
                        continue
                    if r.status != 200:
                        return None
                    ct = r.headers.get("Content-Type", "").split(";")[0].strip().lower()
                    path = urlparse(cur).path.lower()
                    audio = ct.startswith("audio/") or ct in AUDIO_TYPES or (ct in ("application/octet-stream", "binary/octet-stream") and path.endswith(AUDIO_EXT))
                    if not audio:
                        return None
                    return {"url": cur, "title": _title_from(cur, r.headers), "live": r.headers.get("Content-Length") is None}
            except (aiohttp.ClientError, asyncio.TimeoutError):
                return None
    return None


def _ytdlp_cmd(*args: str) -> list[str]:
    cmd = [str(BIN / "yt-dlp"), "--no-warnings", "--no-call-home"]
    deno = BIN / "deno"
    if deno.exists():
        cmd += ["--js-runtimes", f"deno:{deno}"]  # YouTube needs a JavaScript runtime
    return cmd + list(args)


async def _run(cmd: list[str], seconds: int) -> str:
    p = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, _ = await asyncio.wait_for(p.communicate(), seconds)
    except asyncio.TimeoutError:
        p.kill()
        raise RuntimeError("timed out")
    if p.returncode != 0:
        raise RuntimeError("couldn't read that link")
    return out.decode("utf-8", "replace")


def _is_playlist_link(url: str) -> bool:
    u = urlparse(url)
    q = u.query
    return ("list=" in q and "v=" not in q) or "/playlist" in u.path or "/sets/" in u.path or "/album/" in u.path


def _entry(j: dict, fallback: str) -> dict:
    who = j.get("artist") or j.get("uploader") or j.get("channel") or ""
    title = j.get("track") or j.get("title") or "Untitled"
    return {"url": j.get("webpage_url") or j.get("url") or fallback, "title": str(title)[:120], "artist": str(who)[:80], "duration": int(j.get("duration") or 0),
            "exact": bool(j.get("track") and j.get("artist")),  # the page names the song and artist itself (YouTube Music does), so they needn't be guessed from the title
            "thumb": j.get("thumbnail") or (j.get("thumbnails") or [{}])[-1].get("url")}


async def ytdlp_info(url: str) -> list[dict]:
    """One entry for a single track, up to PLAYLIST_MAX for a playlist or album link."""
    if _is_playlist_link(url):
        j = json.loads(await _run(_ytdlp_cmd("--flat-playlist", "--playlist-end", str(PLAYLIST_MAX), "-J", url), 60))
        entries = [e for e in (j.get("entries") or []) if e]
        out = [_entry(e, url) for e in entries]
        if j.get("thumbnails") or j.get("thumbnail"):
            for e in out:
                e["thumb"] = e["thumb"] or j.get("thumbnail")
        return [e for e in out if e["url"] and e["url"] != url][:PLAYLIST_MAX] or [_entry(j, url)]
    j = json.loads(await _run(_ytdlp_cmd("--no-playlist", "--skip-download", "-J", url), 45))
    return [_entry(j, url)]


def ytdlp_stream(page_url: str) -> subprocess.Popen:
    """yt-dlp downloading the best audio of a page to its standard output, for ffmpeg to read. YouTube refuses a plain ffmpeg fetch of its links
    (403), so yt-dlp does the fetching, the way it does it for everything else. The caller stops it when the song is over."""
    return subprocess.Popen(_ytdlp_cmd("-q", "--no-progress", "-f", "bestaudio/best", "--no-playlist", "-o", "-", page_url), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def ffmpeg_headers(headers: dict) -> str:
    """Header lines for ffmpeg's -headers option: each ends in CRLF, and nothing in a value can break out of the quotes."""
    clean = lambda v: re.sub(r'["\r\n]', "", str(v))
    return "".join(f"{clean(k)}: {clean(v)}\r\n" for k, v in headers.items())
