# Undertow Discord bot

Plays TIDAL in a Discord voice channel. It doesn't talk to TIDAL itself: search and audio both come from **your Undertow server**, so it uses your TIDAL accounts, their failover and Undertow's file cache.

## 1. An API key with audio

In Undertow: **Users → API keys → New key**, turn on **Allow audio streaming** and **Discord bot** (the second is owner-only and lets the bot fetch its token), create it and copy the key (it's shown once). Keep a separate key for the bot, so you can see its use or remove it on its own.

## 2. A Discord application

1. https://discord.com/developers/applications → **New Application** → **Bot** tab → **Reset Token** and copy it.
   Then in Undertow, **Users → Discord bot → Set token** and paste it there. Undertow checks it with Discord, keeps it on the server, and never shows it again. The same card gives you the **Invite link** for the bot, so you don't have to build one.
2. On the same tab, turn on **Message Content Intent**. It's needed so the bot can read `g+play …`. (If you only want `/` commands, you can leave it off, but then remove `intents.message_content = True` in `bot.py`, or the bot won't start.)
3. Invite it with the **Invite link** button in Undertow (it appears once the token is saved). Or build the link yourself, with your application's ID where it says `CLIENT_ID`. It asks for Connect, Speak, Send Messages and Embed Links:

   `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=3172352`

## 3. Run it

Needs Python 3.10+ and `ffmpeg`.

```bash
cd discord-bot
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env     # then fill in UNDERTOW_URL and UNDERTOW_KEY (the token comes from Undertow)
.venv/bin/python bot.py
```

To keep it running, copy `undertow-bot.service` to `/etc/systemd/system/`, fix the paths in it, then `systemctl enable --now undertow-bot`.

## Commands

Every command works two ways: as a slash command (`/play`) and with the prefix **`g+`** (`g+play ordinary world`). Change the prefix with `PREFIX` in `.env`. Short names: `g+p`, `g+s`, `g+q`, `g+np`, `g+vol`, `g+rm`, `g+leave`. `g+help` lists them.

| | |
|---|---|
| `/play <song or link>` | Search (with suggestions as you type), or paste a link: TIDAL track, album, playlist, artist or mix; a direct audio file or radio stream; or a YouTube, SoundCloud or Bandcamp page (see Links below) |
| `/skip` `/pause` `/resume` `/stop` | `/stop` clears the queue and leaves |
| `/queue` `/nowplaying` | What's playing and what's next |
| `/volume 0-100` `/loop off\|track\|queue` `/shuffle` `/remove <n>` | |

It leaves a voice channel after a few minutes with nothing to play, or when everyone has left.

## Links

`/play` takes links as well as names:

- **TIDAL** track, album, playlist, artist (top songs) and mix links. They go through Undertow, so they use your TIDAL accounts. A song inside an album link (`album/1/track/2`) plays just that song.
- **A direct audio link or radio stream** (an `.mp3`, `.flac`, an Icecast station...). The bot checks it really is audio before queueing it.
- **A page on YouTube, SoundCloud, Bandcamp, Mixcloud, Vimeo, Twitch or Audiomack**, read with yt-dlp (a playlist or album link queues up to 25). Set `URL_SITES` in `.env` to change that list, or `URL_SITES=*` to allow any site yt-dlp knows.

Links to private or local addresses are always refused, so nobody can use the bot to poke at the machine's network. Songs from a link have no lyrics. yt-dlp isn't updated by itself: when a site stops working, update it on purpose with `.venv/bin/pip install -U yt-dlp`.

## Appearance

- The line under the bot's name reads **Playing hifi-api via Undertow**. Change or clear it with `PRESENCE` in `.env`.
- The bot connects as **Discord VR** (`os` Horizon OS, `browser` and `device` Discord VR), so it shows the headset platform icon. `PLATFORM` can be `vr`, `mobile`, `desktop` or `off` (off is discord.py's normal identity). This is cosmetic and unofficial: Discord doesn't document it, so how it looks can change, and if it ever causes trouble, set `PLATFORM=off`.

## Notes

- Voice needs `davey` below 0.2 (it's pinned in `requirements.txt`). Version 0.2.0 doesn't work with discord.py 2.7.1: the call connects, but the bot's audio goes out unencrypted and Discord drops it, so everyone hears nothing. If you ever see that, run `pip list | grep davey`. `VOICE_DEBUG=1` in `.env` adds a log line that says whether encryption is on.
- Audio is CD quality (16-bit FLAC) by default. Discord sends 48 kHz at most, so more is wasted. Change it with `QUALITY` in `.env`.
- The first play of a song can take a few seconds while Undertow prepares the file. The bot asks for the next song early, so the queue moves on smoothly.
- The bot's own API key is the only secret on the bot's machine. If you'd rather not even keep that long-term, remove the key in Undertow and the bot stops.
- The key is sent to ffmpeg as a header, so on a shared machine other users could see it in the process list. Run the bot as its own user, or on a machine only you use.
- Tests: `.venv/bin/python -m unittest` (no Discord or Undertow needed).
- Streaming TIDAL into a Discord channel is for your own private server and accounts. Check TIDAL's terms before opening it up to others.

## Player channel (live lyrics and buttons, only the bot posts)

`/livelrc-channel #channel` turns a text channel into the server's player: one message that shows the live lyrics and carries the buttons
(previous, pause/resume, next, stop, loop, shuffle, volume down/up, 24/7). By default it also locks the channel so only the bot can post there; for that the
bot needs **Manage Channels** (or Manage Roles) in the channel, otherwise it tells you and you can deny Send Messages for @everyone yourself.
Run the command again with no channel to remove it. People use the buttons from inside the bot's voice channel; the 24/7 button needs **Manage Server**.

`/247` (or the 24/7 button) keeps the bot in its voice channel when the music ends and brings it back after a restart. Settings are kept in `prefs.json`.
