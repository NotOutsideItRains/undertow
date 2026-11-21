"""What the bot says about itself to Discord: the platform it appears to be on.

Discord shows a small platform icon next to a user who is online from a phone, a console or a headset, and works that out from the
"properties" the client sends when it connects. discord.py sends its own name there. This replaces those values (for example, so the bot
appears on Discord VR). It's cosmetic and unofficial: Discord doesn't document it and could change how it's shown at any time.
"""
import discord.gateway as gw

PLATFORMS = {
    "vr": {"os": "Horizon OS", "browser": "Discord VR", "device": "Discord VR"},
    "mobile": {"os": "iOS", "browser": "Discord iOS", "device": "iPhone"},
    "desktop": {"os": "Windows", "browser": "Discord Client", "device": "Discord Client"},
}


def rewrite(data: dict, props: dict) -> dict:
    """Puts the chosen values into an IDENTIFY packet and leaves every other packet alone."""
    if isinstance(data, dict) and data.get("op") == gw.DiscordWebSocket.IDENTIFY:
        data.setdefault("d", {}).setdefault("properties", {}).update(props)
    return data


def apply(platform: str) -> bool:
    """Call before the bot connects. Returns whether anything changed ("off" or an unknown name changes nothing)."""
    props = PLATFORMS.get((platform or "").strip().lower())
    if not props or getattr(gw.DiscordWebSocket, "_identity_patched", False):
        return False
    original = gw.DiscordWebSocket.send_as_json

    async def send_as_json(self, data):
        return await original(self, rewrite(data, props))

    gw.DiscordWebSocket.send_as_json = send_as_json
    gw.DiscordWebSocket._identity_patched = True
    return True
