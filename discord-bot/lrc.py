"""Lyrics helpers with no Discord in them: turning Undertow's answer into plain lines, finding the line for a moment in the song,
and laying lines out for an embed. Karaoke (word-by-word) lyrics are flattened to lines, since a message can't be edited every few milliseconds."""
import bisect

PAGE = 3800  # an embed description holds 4096 characters; leave room


def to_lines(lyrics: dict) -> list[tuple[int, str, str]]:
    """[(start_ms, text, background), ...] in time order, or [] if the lyrics aren't timed. `background` is the backing vocal sung with the line
    (empty if none), kept apart from the verse. Word timing, if any, is dropped on purpose."""
    out = []
    for ln in lyrics.get("lines") or []:
        text = str(ln.get("text") or "").strip()
        start = ln.get("startMs")
        if text and isinstance(start, (int, float)):
            out.append((int(start), text, str(ln.get("background") or "").strip()))
    out.sort(key=lambda x: x[0])
    return out


def is_timed(lyrics: dict) -> bool:
    lines = to_lines(lyrics)
    return len(lines) >= 3 and len({ln[0] for ln in lines}) >= 3  # a few lines at one moment is plain text pretending


def line_at(lines: list[tuple[int, str, str]], pos_ms: int) -> int:
    """Index of the line being sung at pos_ms: -1 before the first line starts."""
    return bisect.bisect_right([ln[0] for ln in lines], pos_ms) - 1


def _esc(t: str) -> str:
    return t.replace("*", "\\*").replace("_", "\\_")


def window(lines: list[tuple[int, str, str]], idx: int, before: int = 2, after: int = 3) -> str:
    """The embed text: a couple of lines behind, the current one in bold, a few ahead. A backing vocal goes on its own small line under its verse
    line (Discord's `-#` small gray text) instead of being stuck to it. Before the first line, only what's coming."""
    out = []

    def add(text: str, bg: str, style: str):
        out.append(style.format(_esc(text)))
        if bg:
            out.append(f"-# {_esc(bg)}")  # Discord's small gray text; it has to start the line

    if idx < 0:
        out.append("**♪**")
        for _, text, bg in lines[:after + 1]:
            add(text, bg, "{}")
    else:
        for k in range(max(0, idx - before), min(len(lines), idx + after + 1)):
            _, text, bg = lines[k]
            add(text, bg, "**▸ {}**" if k == idx else ("*{}*" if k < idx else "{}"))
        if idx >= len(lines) - 1:
            out.append("**♪**")
    return "\n".join(out)[:3900]


def pages(text: str, size: int = PAGE) -> list[str]:
    """Plain lyrics split into pages at line breaks, so none is cut mid-line."""
    pages_, cur = [], ""
    for raw in str(text).replace("\r", "").split("\n"):
        line = raw if len(raw) <= size else raw[:size]
        if len(line.strip()) > 2 and line.strip().startswith("(") and line.strip().endswith(")"):
            line = "-# " + line.strip()  # a line wholly in brackets is a backing vocal: small and gray
        if len(cur) + len(line) + 1 > size and cur:
            pages_.append(cur.rstrip())
            cur = ""
        cur += line + "\n"
    if cur.strip():
        pages_.append(cur.rstrip())
    return pages_ or [""]


def credits(lyrics: dict) -> str:
    """Who the lyrics are from, for an embed's footer: the person who contributed them (Unison says who) and the songwriters, when known."""
    out = []
    sb = lyrics.get("submitter") or {}
    if sb.get("name"):
        extra = [f"level {int(sb['level'])}"] if isinstance(sb.get("level"), (int, float)) else []
        if sb.get("badge"):
            extra.append(str(sb["badge"]))
        out.append(f"Submitted by {str(sb['name'])[:40]}" + (f" ({', '.join(extra)})" if extra else ""))
    writers = [str(w) for w in (lyrics.get("songwriters") or []) if w]
    if writers:
        out.append("Written by " + ", ".join(writers[:6]) + (" and others" if len(writers) > 6 else ""))
    return " · ".join(out)
