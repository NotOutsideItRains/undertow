# Undertow

A self-hosted music server and player built around TIDAL. It is closed source and private: all rights reserved, not for redistribution. The bundled Monochrome code keeps its own license (`web-mono/LICENSE-monochrome.txt`).

Plain Node.js (ESM) with no npm dependencies. One process serves everything on `:7000` (`PORT` to change it).

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

## Rebuilding the second player

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
