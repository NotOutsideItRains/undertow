"""A small client for Undertow's /v1 API: search, details, and the audio stream URL."""
import re
import time
from urllib.parse import quote

import aiohttp

TRACK_ID = re.compile(r"^(?:\d+|sub:[a-f0-9]+:.+)$")  # a catalog id, or a song on a Subsonic server
# TIDAL links: tidal.com/track/1, tidal.com/browse/album/1, listen.tidal.com/playlist/<uuid>, .../artist/1, .../mix/<id>.
# A song inside an album link (album/1/track/2) is the song, not the album.
TIDAL_URL = re.compile(r"tidal\.com/(?:browse/|listen/)?(?:album/\d+/)?(track|album|playlist|artist|mix)/([0-9A-Fa-f][0-9A-Fa-f-]*)", re.I)


def parse_tidal_url(text: str):
    """('track', '147542') for a TIDAL link (track, album, playlist, artist or mix), else None."""
    m = TIDAL_URL.search(text or "")
    if not m:
        return None
    kind, ident = m.group(1).lower(), m.group(2)
    ok = ident.isdigit() if kind in ("track", "album", "artist") else bool(ident)
    return (kind, ident.lower() if kind in ("playlist", "mix") else ident) if ok else None


def mmss(seconds) -> str:
    s = max(0, int(seconds or 0))
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


LICENSE_TTL = 60  # seconds a license answer is kept


class UndertowError(Exception):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


def label(track: dict) -> str:
    artists = ", ".join(a["name"] for a in track.get("artists", [])) or "Unknown artist"
    title = track.get("title", "?") + (f" ({track['version']})" if track.get("version") else "")
    return f"{artists} - {title}"


class Undertow:
    def __init__(self, base: str, key: str, quality: str = "CD"):
        self.base = base.rstrip("/")
        self.key = key
        self.quality = quality
        self._http: aiohttp.ClientSession | None = None
        self._lyrics: dict = {}
        self._licenses: dict = {}  # guild id -> (when, answer)

    @property
    def headers(self) -> dict:
        return {"Authorization": f"Bearer {self.key}", "User-Agent": "Undertow-Discord-Bot/1.0"}

    async def start(self):
        self._http = aiohttp.ClientSession(headers=self.headers, timeout=aiohttp.ClientTimeout(total=20))

    async def close(self):
        if self._http:
            await self._http.close()

    async def _get(self, path: str, **params):
        try:
            async with self._http.get(f"{self.base}{path}", params=params or None) as r:
                if r.status == 200:
                    return await r.json()
                try:
                    msg = (await r.json())["error"]["message"]
                except Exception:
                    msg = f"Undertow answered {r.status}"
                raise UndertowError(msg, r.status)
        except aiohttp.ClientError as e:
            raise UndertowError(f"Couldn't reach Undertow: {e}") from e

    async def _post(self, path: str, body: dict):
        try:
            async with self._http.post(f"{self.base}{path}", json=body) as r:
                if r.status == 200:
                    return await r.json()
                try:
                    msg = (await r.json())["error"]["message"]
                except Exception:
                    msg = f"Undertow answered {r.status}"
                raise UndertowError(msg, r.status)
        except aiohttp.ClientError as e:
            raise UndertowError(f"Couldn't reach Undertow: {e}") from e

    async def license_status(self, guild_id: int) -> dict:
        """Whether a Discord server holds a license: {"licensed": bool, ...}. Remembered for a minute; if Undertow can't be reached, the last answer stands."""
        now = time.monotonic()
        hit = self._licenses.get(guild_id)
        if hit and now - hit[0] < LICENSE_TTL:
            return hit[1]
        try:
            res = await self._get(f"/v1/bot/licenses/{guild_id}")
        except UndertowError as e:
            if hit and e.status == 0:
                return hit[1]
            raise
        self._licenses[guild_id] = (now, res)
        return res

    async def redeem_license(self, code: str, guild_id: int, name: str) -> dict:
        res = await self._post("/v1/bot/licenses", {"code": code, "guild": str(guild_id), "name": name})
        self._licenses.pop(guild_id, None)
        return res

    async def search(self, q: str, limit: int = 10) -> list[dict]:
        return (await self._get("/v1/search", q=q, type="track", limit=limit)).get("tracks", [])

    async def track(self, track_id: str) -> dict:
        return await self._get(f"/v1/tracks/{quote(track_id, safe=':')}")

    async def lyrics(self, track_id: str) -> dict:
        """Lyrics from Undertow's lyrics sources. Needs a key made with lyrics turned on. Cached for a few minutes."""
        hit = self._lyrics.get(track_id)
        if hit:
            return hit
        data = await self._get(f"/v1/tracks/{quote(track_id, safe=':')}/lyrics")
        self._lyrics[track_id] = data
        while len(self._lyrics) > 60:
            self._lyrics.pop(next(iter(self._lyrics)))
        return data

    async def playlist(self, playlist_id: str) -> tuple[str, list[dict]]:
        j = await self._get(f"/v1/playlists/{playlist_id}")
        return j.get("title") or "that playlist", j.get("tracks", {}).get("tracks", [])

    async def mix(self, mix_id: str) -> tuple[str, list[dict]]:
        j = await self._get(f"/v1/mixes/{mix_id}")
        return (f"{j['title']} mix" if j.get("title") else "that mix"), j.get("tracks", {}).get("tracks", [])

    async def artist_top(self, artist_id: str) -> tuple[str, list[dict]]:
        tracks = (await self._get(f"/v1/artists/{artist_id}/top-tracks")).get("tracks", [])
        who = ", ".join(a["name"] for a in (tracks[0].get("artists") or [])[:1]) if tracks else ""
        return (f"{who}'s top songs" if who else "that artist's top songs"), tracks

    async def album_tracks(self, album_id: str) -> list[dict]:
        return (await self._get(f"/v1/albums/{album_id}")).get("tracks", {}).get("tracks", [])

    def stream_url(self, track_id: str) -> str:
        return f"{self.base}/v1/tracks/{quote(track_id, safe=':')}/stream?quality={self.quality}"

    async def warm(self, track_id: str):
        """Ask for the first byte, so Undertow has the next song's file ready before it's needed."""
        try:
            async with self._http.get(self.stream_url(track_id), headers={"Range": "bytes=0-0"},
                                      timeout=aiohttp.ClientTimeout(total=60)) as r:
                await r.read()
        except Exception:
            pass


async def fetch_bot_token(base: str, key: str) -> str:
    """The Discord bot's token, kept in Undertow. Needs a key made with the "Discord bot" switch on."""
    ut = Undertow(base, key)
    await ut.start()
    try:
        try:
            return (await ut._get("/v1/bot/token"))["token"]
        except UndertowError as e:
            if e.status == 403:
                raise UndertowError("This API key can't read the bot token. Make a key with the Discord bot switch on (owner only).", 403) from e
            if e.status == 404:
                raise UndertowError("No bot token is saved in Undertow yet. Save it in Users > Discord bot.", 404) from e
            raise
    finally:
        await ut.close()
