# Undertow

A self-hosted music server and player built around TIDAL. **Open source**: read it, run it, change it, share it, even sell it (see [LICENSE](LICENSE)). The bundled Monochrome code keeps its own license (`web-mono/LICENSE-monochrome.txt`).

The whole app is vibe-coded: it was written with AI (Claude Code) from plain-language requests, not by hand.

Plain Node.js (ESM) with no npm dependencies. One process serves everything on `:7000` (`PORT` to change it).

## Quick start

You need Node.js 20 or newer, `ffmpeg` and `ffprobe`, and a TIDAL backend (`hifi-api`, see below).

```bash
# Debian / Ubuntu / Raspberry Pi OS
sudo apt install -y nodejs ffmpeg git python3 python3-venv
```

```bash
git clone https://github.com/NotOutsideItRains/undertow.git
cd undertow
```

```bash
node server.mjs
```

Then open http://localhost:7000. On the first start there are no users, so the server writes a one-time setup code to `.setup-code` (and prints where it is). Open the site, enter the code and create the first (admin) account.

```bash
cat .setup-code
```

**The TIDAL backend.** Undertow talks to TIDAL through [binimum/hifi-api](https://github.com/binimum/hifi-api), a separate project that is not part of this repository. Clone it into `hifi-api/` next to `server.mjs`, make a virtual environment in `hifi-api/.venv` with its requirements, and log in to TIDAL from the admin page. Undertow starts and restarts it for you. To use one that is already running somewhere else, set `HIFI_API_URL` (for example `HIFI_API_URL=http://127.0.0.1:8000 node server.mjs`).

**Run it all the time (systemd).** Save this as `/etc/systemd/system/undertow.service` (change the path and user):

```ini
[Unit]
Description=Undertow
After=network-online.target

[Service]
WorkingDirectory=/opt/undertow
ExecStart=/usr/bin/node server.mjs
Environment=PORT=7000
Restart=always
User=undertow

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now undertow
```

```bash
journalctl -u undertow -f
```

**Your addresses.** Nothing is tied to one domain: you set your own with environment variables. Without them it runs on `http://localhost:7000` and the Monochrome player is off. To put it online, use a reverse proxy or a Cloudflare tunnel with HTTPS and set these (in the systemd unit as `Environment=` lines, or on the command line):

| Variable | Example | Meaning |
| --- | --- | --- |
| `PUBLIC_URL` | `https://music.example.com` | The main site's public address. |
| `PLAYER_HOST` | `player.example.com` | The hostname that serves the Monochrome player. Point it at the same server. Several can be listed, separated by commas. Empty means the player is off. |
| `TRUSTED_PROXIES` | `127.0.0.1,10.0.0.5` | Your proxy's IP addresses, so the real visitor address is believed. |

```ini
Environment=PUBLIC_URL=https://music.example.com
Environment=PLAYER_HOST=player.example.com
Environment=TRUSTED_PROXIES=127.0.0.1
```

Trying it on one machine? `PLAYER_HOST=127.0.0.1 node server.mjs` serves the Monochrome player on http://127.0.0.1:7000, while http://localhost:7000 stays the main site.

**Using it in BitChord and Eclipse.** The addon for BitChord and Eclipse only works over a **public domain with HTTPS** (for example `https://music.example.com`, set as `PUBLIC_URL`). Those apps will not install an addon from `http://localhost`, a bare IP address or a plain-HTTP address. Get the addon links on the Users page (`https://music.example.com/<token>` for BitChord, and `.../<token>/eclipse` for Eclipse).

**Updating.**

```bash
git pull && sudo systemctl restart undertow
```

A restart ends live listening parties, since they live in memory.

## Settings

All optional, set as environment variables.

| Variable | What it does |
| --- | --- |
| `PORT` | Port to listen on (default 7000). |
| `PUBLIC_URL`, `MAIN_URL` | The public address of the main site. |
| `PLAYER_HOST` | Hostname(s) that serve the Monochrome player (comma separated). |
| `TRUSTED_PROXIES` | Proxy IPs whose forwarded client address is believed. |
| `HIFI_API_URL`, `HIFI_DIR`, `HIFI_CMD` | Where the TIDAL backend is, where it lives, and how to start it. |
| `DATA_FILE`, `ACCOUNTS_DIR`, `AUDIO_CACHE_DIR` | Where state and the audio cache are kept. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Sign in with Discord (optional). |
| `SPEAKER_DEVICE`, `SPEAKER_NAME`, `SPEAKER_CARD` | Pick the sound card for the server speakers. |

## More things you can run

- **Raspberry Pi / Bluetooth speaker receiver** (Monochrome Connect): `connect/README.md`.
- **Discord voice bot**: `discord-bot/README.md`.
- **Discord Rich Presence app**: `rpc-app/`. It is built with your addresses inside it, so **recompile it on your own computer** (needs Go, plus `rsvg-convert` and a type-2 AppImage for the Linux AppImage): `ORIGINS=https://music.example.com,https://player.example.com ./build.sh`, then copy the results from `rpc-app/dist/` to `downloads/`. Without `ORIGINS` it only trusts `http://localhost:7000`. A build you already have can be told about another site with `--allow https://music.example.com`. By default it shows the shared "Monochrome Player" Discord card, which anyone may use; set `CLIENT_ID=` to use your own Discord application.

## Contributing

Issues and pull requests are welcome. There are no dependencies to install. Check what you changed with `node --check <file>`, and run the receiver tests with `python3 -m unittest discover -s connect -v`. `web-mono/` is generated by `monochrome-port/patch.py`, so change the sources in `monochrome-port/` and rebuild rather than editing it by hand.

## License

The [Undertow Community License](LICENSE): free to use, modify, redistribute and even sell, as long as you keep the copyright notice and the source stays open. The bundled Monochrome code keeps its own license (`web-mono/LICENSE-monochrome.txt`).

## What is in here

| Path | What it is |
| --- | --- |
| `server.mjs` | The server: accounts, the BitChord/Eclipse addon, audio and video cache, routing for both players and the public API. |
| `lib/` | Server modules: accounts, Discord sign-in and bot support, chat, listening parties (`partyhost.mjs`), the second player's host (`playerhost.mjs`), Subsonic servers, lyrics, video, the Discord presence downloads and relay (`rpcdl.mjs`, `rpcrelay.mjs`). |
| `web/` | The main site and the in-house player (plain HTML/JS/CSS). |
| `web-mono/` | The second player: a patched build of Monochrome. Generated, do not edit by hand. |
| `monochrome-port/` | The patch script (`patch.py`) and the extra modules that make Monochrome work with Undertow (Atmos decoding, file info, Discord presence). |
| `rpc-app/` | The Discord Rich Presence app in Go (Windows `.exe` and Linux AppImage). `build.sh` builds it into `rpc-app/dist/`; copy the results to `downloads/`. |
| `discord-bot/` | The Discord voice bot (Python). See its own README. |
| `maintenance/` | A tiny "back soon" page for when Undertow is down. |
| `downloads/` | The built presence apps and `SHA256SUMS`. The binaries are not in git. |

Not in git (see `.gitignore`): `data.json` and the other runtime state, `.secret`, `.webhook`, accounts and avatars, caches, and `hifi-api/` (a separate clone).

## Speed

`lib/compress.mjs` makes both sites (Undertow's pages and Monochrome's) cheaper to load:

- **Compression:** text (pages, scripts, styles, JSON, SVG) is sent brotli- or gzip-compressed when the browser accepts it. A file on disk is compressed once per version (its size and time) and kept in memory, and `server.mjs` compresses the two sites' files in the background at startup so the first visitor does not wait. Pages and JSON built on the fly are gzip-compressed when they are over 1 KB. Images, fonts, audio and video are never compressed, and range requests and streams are untouched.
- **ETag:** files are sent with a weak ETag, so a file the browser already has costs a 304 and a few bytes.
- **Cache lifetime:** `app.js` and `style.css` are named with `?v=<their own time>` by the page, so with a `v` they are kept for a year. Monochrome's hashed files were already kept for a year. Fonts with a plain name are kept for a week and pictures with a plain name for a day. Everything else (the pages, `seasonal.js`, `speaker.js`) is checked with its ETag on each visit.
- **Behind Cloudflare:** its "Browser Cache TTL" setting (4 hours by default) can replace the `no-cache` on the files without a version, so `seasonal.js`, `speaker.js`, Monochrome's page and the other plain-named files may be kept by browsers for up to 4 hours (seen on the live site: `max-age=14400`). Files with a version or hash in their name are not affected. A change to a plain-named file can therefore take a few hours to reach people who visited recently, and after a Monochrome rebuild (new hashed file names) a recent visitor's cached page may point at files that no longer exist until it expires. In the Cloudflare dashboard, set Caching → Configuration → Browser Cache TTL to "Respect Existing Headers" to make the server's own headers count.
- To use it for a new file route: `serveFile(req, res, file, stat, { type, cache, headers })` for a file on disk, `sendBody(res, status, body, headers)` for an answer built on the fly (it needs `res.req`, which Node sets).

## Server speakers in Monochrome

For the people an admin allowed (the same rule as the first player: an admin, or a member with the speaker permission), Monochrome has a speaker button in the player bar. With it on, the song plays out of the server's sound card (ffmpeg into ALSA, `lib/speaker.mjs`) and the page is the remote: play, pause, seek and the next song work as usual, and a small panel above the player bar has the device name, a volume slider and Stop. People without access see nothing (the server answers 403 and the button is never added).

- Server: `/__off/speaker` in `lib/playerhost.mjs` (GET for the status, POST for the actions), backed by `speakerAllowed` and `speakerAct` in `server.mjs`, which the first player's `/api/play/speaker` uses too, so the two players share one rule and one speaker.
- Client: `monochrome-port/undertow-speaker.js`, loaded as `/speaker.js` (`patch.py` copies it into a rebuild and adds the script tag; `web-mono/speaker.js` is the built copy). It reads the song from the audio element's address (`/audio/<id>?quality=...`), so Monochrome's own player code is not patched. The page's own copy of the song keeps playing, muted, so the progress bar and lyrics follow its clock; every second it is pulled back to the server's place. When the server's copy ends, the page's copy ends a moment later and Monochrome goes on to the next song, shuffle or repeat itself.
- A song that is not one of Undertow's (no `/audio/<id>` address) plays on the device instead. The choice is remembered per browser.
- The sound card is picked as for the first player (`SPEAKER_DEVICE`, `SPEAKER_NAME` and `SPEAKER_CARD` in the environment override the detection).

## Monochrome Connect

Like Spotify Connect: the speaker button in Monochrome lists your devices next to the server speakers, and a song can play on any of them while the page is the remote (play, pause, seek, volume and the next song all work). Three kinds of device:

- **A Raspberry Pi (or any Linux box)**: `connect/agent.py`, one Python file (3.8+, standard library only) that the server also hands out at `/__off/connect/agent.py`. It plays with mpv or ffplay, or with **your own shell commands** in `~/.config/monochrome-connect/commands.ini` (play, volume, before/after, for waking a Bluetooth speaker and so on). See `connect/README.md`.
- **Another screen**: open `/connect` in any browser, press Start, and that phone, laptop or TV is a device.
- **The server speakers**: the existing sound-card speaker, in the same picker (still needs the speaker permission).

How it is built (`lib/connect.mjs`, routes in `lib/playerhost.mjs` under `/__off/connect/`):

- Receivers call the server, never the other way round: a long poll (`poll?since=N`, about 25 s) for commands and a status report about once a second. So it works behind NAT and the Cloudflare tunnel, and the server never connects to or runs anything on a device.
- The only commands are play, pause, resume, seek, volume and stop. The server sends no shell. The values (song address, start second, volume, title) reach your commands only as environment variables (`MC_URL`, `MC_POS`, `MC_DUR`, `MC_VOL`, `MC_TITLE`), never pasted into a command line.
- Pairing works like a TV app: the receiver shows a code (`ABCD-EFGH`, valid 10 minutes, single use), you type it into Monochrome, and the receiver then collects its own token. Only a hash of the token is stored, and removing the device in Monochrome revokes it. The receiver prints which account paired it.
- Devices are owner-only (you only see and control your own, at most 10 each). Any signed-in user can use Connect; the server speakers keep their own permission.
- Players get signed audio links (HMAC with the file key, bound to device, song and quality, 6 hours), so mpv or a browser tab needs no cookie. The agent refuses song addresses that are not on the server it paired with.
- Client: `monochrome-port/undertow-speaker.js` (the picker) and `monochrome-port/connect-receiver.{html,js}` (the `/connect` page), copied by `patch.py` into a rebuild; `web-mono/` holds the built copies (they must stay identical).
- Tests for the receiver: `python3 -m unittest discover -s connect -v`.

## Seasonal touches

`web/seasonal.js` adds small special-day effects to the Undertow site and to Monochrome (one file, loaded by both; `patch.py` copies it into the Monochrome build, and `web-mono/seasonal.js` is that copy, so edit `web/seasonal.js` and copy it over). It uses the visitor's own clock and time zone, not the server's, and does nothing on an ordinary day.

| When | What |
| --- | --- |
| December | Snow |
| 31 December / 1 January | A countdown in the last 10 seconds, fireworks at midnight; one short show the first time the site is opened on 1 January |
| 24-26 December | A Santa hat on the logo |
| 14 February | Hearts |
| 1-8 March (Romanian) | A red-and-white Martisor logo |
| 17 March | Shamrocks |
| 1 April | The logos are upside down |
| 4 May | "May the Fourth be with you" and a lightsaber sweeping across the screen (once per tab session) |
| June | A rainbow logo |
| 21 June (World Music Day) | Music notes |
| 23 September - 15 November | Autumn leaves |
| 31 October | Pumpkins and bats (instead of leaves) |
| 1 December, 24 January, 9 May (Romanian) | The logo and tab icon become the Romanian flag |

"Romanian" means the browser's language is Romanian, or its time zone is Bucharest or Chisinau. The logo changes cover Undertow's icon, Monochrome's sidebar icon and its empty player cover, and the browser-tab icon.

- Off switch: the small ✦ tab on the right edge (remembered per browser). The device's reduce-motion setting and Undertow's reduced-effects setting are respected. Without graphics acceleration (software rendering) the animations stay off, on Undertow through its own reduced-effects mode and on Monochrome through the same check made by the script; the ✦ tab turns them on anyway. The logo changes are not animations, so they still show.
- To try one on any day: add `?seasonal=snow`, `hearts`, `shamrocks`, `music`, `leaves`, `halloween`, `hat`, `rainbow`, `flag`, `martisor`, `april`, `newyear` or `may4` to the address. To try a date and time: `?seasonal_date=2026-12-31T23:59:45`.
- To add a day: add it to the `today` table in `web/seasonal.js`, and a new falling thing to `KINDS` or a new logo to `SKINS` if it needs one.

## Rebuilding the second player

**Careful: the upstream commit that `web-mono/` was built from is not recorded.** A fresh clone of Monochrome's `main` has moved on and gives different file hashes for every file, so a rebuild pulls in unrelated upstream changes (and a recent visitor's cached page may point at files that were replaced). Prefer patching the files in `web-mono/` directly, with the same change in `patch.py`, and if you do rebuild, build from a pinned commit and write it here: `git -C /tmp/mono rev-parse HEAD`. Upstream commit used for the current build: _unknown_.


```bash
git clone --depth 1 https://github.com/monochrome-music/monochrome /tmp/mono
python3 monochrome-port/patch.py /tmp/mono      # safe to run twice; stops if upstream changed
cd /tmp/mono && npm install --ignore-scripts --legacy-peer-deps && npx vite build
rm -rf web-mono && cp -r dist web-mono && cp license web-mono/LICENSE-monochrome.txt
```

## Deploying

The server runs as the `undertow` systemd service under `/opt/undertow`. Pack the changed paths (`server.mjs lib web web-mono downloads monochrome-port`), copy them over, unpack, and restart the service.

Static-only changes (files in `web/` or `web-mono/`) need no restart. **A restart ends live listening parties**, since they live in memory, so warn people first.

## Features

- Lossless and Hi-Res playback, quality choice per player, and converting on the fly to ALAC or MP3.
- Real Dolby Atmos: the server finds the Atmos version of a song, and browsers without a Dolby decoder decode it in the page with ffmpeg.wasm.
- Listening parties shared between both players.
- Discord Rich Presence from a small desktop app, plus a relay so playback on a phone shows on the PC's Discord.
- Discord voice bot, friends and chat, lyrics, music videos, playlists and a public API.
- Installable as an app (PWA).

## Requirements

Node.js 20 or newer, and `ffmpeg` and `ffprobe` on the server.
