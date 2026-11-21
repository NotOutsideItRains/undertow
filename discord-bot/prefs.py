"""Per-server settings the bot keeps between restarts (for now: the channel live lyrics go to). A small JSON file next to the bot."""
import json
import os
from pathlib import Path

FILE = Path(os.environ.get("PREFS_FILE") or Path(__file__).with_name("prefs.json"))


def _load() -> dict:
    try:
        return json.loads(FILE.read_text())
    except (OSError, ValueError):
        return {}


def get(guild_id: int, key: str):
    return _load().get(str(guild_id), {}).get(key)


def put(guild_id: int, key: str, value) -> None:
    data = _load()
    g = data.setdefault(str(guild_id), {})
    if value is None:
        g.pop(key, None)
        if not g:
            data.pop(str(guild_id), None)
    else:
        g[key] = value
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(FILE)
