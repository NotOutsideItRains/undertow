# The second player (Monochrome)

`web-mono/` is [Monochrome](https://github.com/monochrome-music/monochrome) (Apache-2.0), built with `patch.py` applied. Undertow serves it on its own address
(`PLAYER_HOST`, default `otter-player.outsideitrains.com`), behind Undertow's logins, with a gateway at `/hifi/` that answers from Undertow's TIDAL accounts.
The server side is `lib/playerhost.mjs`.

Rebuild after a Monochrome update:

    git clone --depth 1 https://github.com/monochrome-music/monochrome /tmp/mono
    python3 monochrome-port/patch.py /tmp/mono
    cd /tmp/mono && npm install --ignore-scripts --legacy-peer-deps && npx vite build
    rm -rf web-mono && cp -r /tmp/mono/dist web-mono && cp /tmp/mono/license web-mono/LICENSE-monochrome.txt

`patch.py` stops with a message if upstream moved something it needs to change.
