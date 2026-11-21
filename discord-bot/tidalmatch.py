"""Finding the TIDAL version of a song that came from a link (YouTube and the like), so it plays in lossless instead of the page's own audio.

A match has to be right, not just close: the title and an artist must agree, the length must be about the same, and a remix, live version or
cover is never taken for the original. When nothing passes, the caller plays the link itself."""
import re
import unicodedata

NOISE = re.compile(
    r"[\(\[\{][^\)\]\}]*\b(official|video|audio|lyrics?|lyric video|visuali[sz]er|hd|hq|4k|8k|remaster(ed)?|music video|mv|m/v|full|explicit|clip|performance video|"
    r"topic|provided to youtube)\b[^\)\]\}]*[\)\]\}]", re.I)
TAIL = re.compile(r"\s*[-–—|]\s*(official\s+)?(music\s+)?(video|audio|lyrics?|visuali[sz]er)\s*$", re.I)
FEAT = re.compile(r"[\(\[]?\b(feat\.?|ft\.?|featuring|with)\b[^\)\]]*[\)\]]?", re.I)
# a version word has to be on both sides or neither: asking for the original must not give the remix
VERSIONS = ("remix", "live", "acoustic", "instrumental", "karaoke", "cover", "sped", "slowed", "reverb", "nightcore", "demo", "edit", "mashup", "piano", "orchestral", "8d")
FILLER = {"the", "a", "an", "of", "and", "feat", "ft", "official", "video", "audio", "lyrics", "remastered", "remaster", "version"}


def fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", s.replace("&", " and "))).strip()


def clean(s: str) -> str:
    s = NOISE.sub(" ", str(s or ""))
    s = TAIL.sub("", s)
    return re.sub(r"\s+", " ", s).strip(" -–—|")


def words(s: str) -> list[str]:
    return [w for w in fold(FEAT.sub(" ", s)).split() if w not in FILLER]


def versions(s: str) -> set[str]:
    f = fold(s).split()
    return {v for v in VERSIONS if v in f}


def channel_artist(uploader: str) -> str:
    return re.sub(r"\s*(-\s*topic|vevo|official|music)$", "", str(uploader or ""), flags=re.I).strip(" -")


def guess(entry: dict) -> tuple[str, str]:
    """(artist, title) for a link's song: from the page's own song fields when it has them, else from "Artist - Title", else from the channel name."""
    title, artist = clean(entry.get("title", "")), channel_artist(entry.get("artist", ""))
    if entry.get("exact"):
        return artist, title
    m = re.match(r"^(.{1,80}?)\s+[-–—]\s+(.+)$", title)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return artist, title


def score(cand: dict, artist: str, title: str, seconds: int, hay: str) -> int:
    """How well a TIDAL track fits; 0 means no. `hay` is every name the link mentions (title, channel), for an artist check."""
    ctitle = cand.get("title", "")
    full = ctitle + (f" {cand['version']}" if cand.get("version") else "")
    year = re.compile(r"^(19|20)\d\d$")  # "Remastered 2011" on one side only isn't a different song
    want, got = [w for w in words(title) if not year.match(w) and w not in VERSIONS], [w for w in words(ctitle) if not year.match(w) and w not in VERSIONS]
    if not want or not got or want != got:  # titles must agree word for word
        return 0
    if versions(full) != versions(title):
        return 0
    names = [fold(a.get("name", "")) for a in cand.get("artists", []) if a.get("name")]
    seen = fold(f"{artist} {hay}")
    if not names or not any(n and re.search(rf"\b{re.escape(n)}\b", seen) for n in names):
        return 0
    s = 100
    if artist and any(n == fold(artist) for n in names):
        s += 20
    d = cand.get("duration") or 0
    if seconds and d:
        gap = abs(d - seconds)
        if gap > 12:
            return 0
        s -= gap
    return s


def best(cands: list[dict], entry: dict) -> dict | None:
    artist, title = guess(entry)
    hay = f"{entry.get('title', '')} {entry.get('artist', '')}"
    ranked = sorted(((score(c, artist, title, int(entry.get("duration") or 0), hay), c) for c in cands if str(c.get("id", "")).isdigit()), key=lambda x: -x[0])
    return ranked[0][1] if ranked and ranked[0][0] > 0 else None


def query(entry: dict) -> str:
    artist, title = guess(entry)
    return f"{artist} {title}".strip()[:150]
