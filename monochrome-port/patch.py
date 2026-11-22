#!/usr/bin/env python3
"""Turns a checkout of https://github.com/monochrome-music/monochrome into Undertow's second player.

    git clone --depth 1 https://github.com/monochrome-music/monochrome /some/empty/dir
    python3 monochrome-port/patch.py /some/empty/dir
    cd /some/empty/dir && npm install --ignore-scripts --legacy-peer-deps && npx vite build
    # then copy dist/ to web-mono/ next to server.mjs

What it changes, and nothing else:
  - the only API instance is this site's own gateway (/hifi), so searches, albums, playlists and streams answer from Undertow's TIDAL accounts
  - error reporting (Sentry), analytics (Plausible), and Monochrome's own accounts/sync servers are switched off: sign-in is Undertow's
"""
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])


def edit(rel, fn):
    p = root / rel
    s = p.read_text()
    out = fn(s)
    if out == s:
        print("already patched:", rel)
    else:
        p.write_text(out)
        print("patched:", rel)


MARK = "// Undertow:"


def instances(s):
    if MARK in s:
        return s
    old = "    async loadInstancesFromGitHub() {\n"
    assert old in s, "storage.js changed upstream: loadInstancesFromGitHub"
    return s.replace(old, old + (
        f"        {MARK} the one and only instance is this site's own gateway, which answers from Undertow's TIDAL accounts\n"
        "        if (!this.instancesLoaded) {\n"
        "            const own = [{ url: `${location.origin}/hifi`, version: '99' }];\n"
        "            this.defaultInstances = { api: own, streaming: own };\n"
        "            this.instancesLoaded = true;\n"
        "        }\n"
        "        return this.defaultInstances;\n"
    ), 1)


edit("js/storage.js", instances)
edit("js/sentry.js", lambda s: s if MARK in s else MARK + " error reporting is off in this build\nexport const SENTRY_DSN = '';\nexport function initSentry() {}\n")
edit("js/analytics.js", lambda s: s if MARK in s else s.replace("function isAnalyticsEnabled() {\n", "function isAnalyticsEnabled() {\n    return false; " + MARK + " no analytics in this build\n", 1))

OFF = "`${window.location.origin}/__off`"
edit("js/accounts/config.js", lambda s: s if MARK in s else s.replace("const getBaseURL = () => {\n", "const getBaseURL = () => {\n    return " + OFF + "; " + MARK + " Monochrome's own account server is not used; sign-in is Undertow's\n", 1))
edit("js/accounts/authApi.js", lambda s: s if MARK in s else re.sub(r"window\.__POCKETBASE_URL__ \|\| localStorage\.getItem\('monochrome-pocketbase-url'\) \|\| 'https://data\.monochrome\.st'", OFF + " /* " + MARK + " no sync server */", s, count=1))
edit("js/accounts/pocketbase.js", lambda s: s if MARK in s else s.replace("const DEFAULT_POCKETBASE_URL = 'https://data.monochrome.st';", "const DEFAULT_POCKETBASE_URL = " + OFF + "; " + MARK + " no sync server", 1))

# Monochrome's own sources: it asks tracks.monochrome.st first, then Apple Music (through a third-party token service), then TIDAL straight from the
# browser with its own app token, and only then the configured instances. Here the instance (this site's gateway) is the only source, so each of the
# others is pointed at an address that answers "not available" at once and the app falls through to it.
def swap(rel, old, new):
    def fn(s):
        if new in s:
            return s
        assert old in s, f"{rel} changed upstream: {old[:50]}"
        return s.replace(old, new, 1)
    edit(rel, fn)


swap("js/tracks-api.js", "export const TRACKS_API_BASE_URL = 'https://tracks.monochrome.st';", "export const TRACKS_API_BASE_URL = " + OFF + "; " + MARK + " not used")
swap("js/apple-music-api.js", "const TOKEN_URL = 'https://am-mint.binimum.org/token';", "const TOKEN_URL = " + OFF + " + '/token'; " + MARK + " not used")
swap("js/ui.js", "fetch('https://tracks.monochrome.st/goal')", "fetch('/__off/goal')")
swap("js/api.js", "const shouldTryNative =\n            type !== 'streaming' || relativePath.startsWith('/trackManifests') || relativePath.startsWith('/track');", "const shouldTryNative = false; " + MARK + " never straight from the browser to TIDAL: everything goes through the gateway")
swap("js/app.js", "token: localStorage.getItem('hifi_token') || undefined,", "token: 'undertow-unused', " + MARK + " no app token is fetched from TIDAL")
swap("js/app.js", "document.head.appendChild(plausibleScript);", "/* " + MARK + " no analytics script */")
swap("js/tracker.js", "fetch('https://artists.artistgrid.cx/artists.csv')", "fetch('/__off/artists.csv')")
swap("js/autoeq-importer.js", "`https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/${encodedPath}/${encodedFileName}`", "`/__off/autoeq/${encodedPath}/${encodedFileName}`")
# Playing: Monochrome 5 resolves audio through its own tracks service, and the older route (the instance's /trackManifests/) hands the browser TIDAL CDN addresses
# that don't allow another site to read them. So the song is asked of Undertow's own /audio/<id> instead, which serves the file from its cache.
swap("js/api.js", "        if (devModeSettings.isEnabled()) {\n            const lookup = await this.getTrackFromDevMode(id, quality);", "        { " + MARK + " always ask the gateway for the stream\n            const lookup = await this.getTrack(id, quality);")
swap("js/music-api.js", "        let track = options?.track || this.getCachedTracksTrack(id) || this.getCachedAppleTrack(id);\n\n        if (!track && (this.isTracksId(id)", "        return { url: `${window.location.origin}/audio/${encodeURIComponent(this.stripProviderPrefix(id))}?quality=${encodeURIComponent(quality || 'LOSSLESS')}`, rgInfo: null }; " + MARK + " the song comes from Undertow itself: TIDAL's audio servers refuse other sites' pages (no CORS)\n        // eslint-disable-next-line no-unreachable\n        let track = options?.track || this.getCachedTracksTrack(id) || this.getCachedAppleTrack(id);\n\n        if (!track && (this.isTracksId(id)")
edit("index.html", lambda s: s.replace('        <link rel="preconnect" href="https://tracks.monochrome.st" crossorigin />\n', "", 1))

# The sidebar: no Donate, Download (Mobile), Discord or GitHub entries.
def drop_nav(s):
    if "{ id: 'sidebar-nav-donate', href" not in s:
        return s  # already done
    for entry in (
        "    { id: 'sidebar-nav-donate', href: '/donate', label: 'Donate', icon: icons.handHeart },\n",
        "    { id: 'sidebar-nav-mobile', href: '/mobile', label: 'Mobile', icon: icons.smartphone },\n",
        "    { id: 'sidebar-nav-discordbtn', href: 'discord.html', label: 'Discord', icon: icons.discord, target: '_blank' },\n",
        "    {\n        id: 'sidebar-nav-githubbtn',\n        href: 'https://github.com/monochrome-music/monochrome',\n        label: 'GitHub',\n        icon: icons.github,\n        target: '_blank',\n        hidden: true,\n    },\n",
    ):
        assert entry in s, "AppNavigation.tsx changed upstream: " + entry[:60]
        s = s.replace(entry, "", 1)
    return s


edit("src/app/AppNavigation.tsx", drop_nav)


def drop_html_nav(s):
    import re as _re
    return _re.sub(r'[ \t]*<li class="nav-item" id="sidebar-nav-(?:donate|mobile|discordbtn|githubbtn)"[^>]*>.*?</li>\s*\n', "", s, flags=_re.S)


edit("index.html", drop_html_nav)

# ---- files that Undertow serves next to the app ----
import re as _re
import shutil
from pathlib import Path as _Path

PORT = _Path(__file__).resolve().parent
UT = PORT.parent
pub = root / "public" / "vendor"
pub.mkdir(parents=True, exist_ok=True)
shutil.copyfile(UT / "web/vendor/monocraft.woff2", pub / "monocraft.woff2")
print("copied: monocraft into public/vendor")

# ---- lyrics: Monochrome's own (am-lyrics and its sources); only the Genius button goes, since it needs another website's proxy ----
edit("js/lyrics.js", lambda s: _re.sub(r'<button id="genius-toggle-btn".*?</button>\s*', "", s, count=1, flags=_re.S))

# ---- Unreleased is gone from the sidebar ----
def drop_unreleased_ts(s):
    entry = "    { id: 'sidebar-nav-unreleased', href: '/unreleased', label: 'Unreleased', icon: icons.squares },\n"
    return s.replace(entry, "", 1)


edit("src/app/AppNavigation.tsx", drop_unreleased_ts)
edit("index.html", lambda s: _re.sub(r'[ \t]*<li class="nav-item" id="sidebar-nav-unreleased"[^>]*>.*?</li>\s*\n', "", s, flags=_re.S))

# ---- Monocraft is the default typeface ----
swap("js/storage.js", "            type: 'preset',\n            family: 'Inter',", "            type: 'preset',\n            family: 'Monocraft', // Undertow: the pixel face from Undertow, served from this site")
edit("styles.css", lambda s: s if "@font-face { font-family: 'Monocraft'" in s else (
    "@font-face { font-family: 'Monocraft'; src: url('/vendor/monocraft.woff2') format('woff2'); font-display: swap; }\n" + s.replace("--font-family:\n        'Inter',", "--font-family:\n        'Monocraft', 'Inter',", 1).replace("--font-family-ja:\n        'Inter',", "--font-family-ja:\n        'Monocraft', 'Inter',", 1)))

# ---- the name says where the songs come from ----
edit("index.html", lambda s: s if "songs from Undertow" in s else s.replace("<title>Monochrome</title>", "<title>Monochrome · songs from Undertow</title>", 1)
     .replace('<span>Monochrome</span>\n                        </a>\n                        <button\n                            id="sidebar-toggle"', '<span class="ul-brand">Monochrome<small>songs from Undertow</small></span>\n                        </a>\n                        <button\n                            id="sidebar-toggle"', 1)
     .replace('content="Monochrome" />', 'content="Monochrome (Undertow)" />', 1))
edit("styles.css", lambda s: s if ".ul-brand" in s else s + "\n.ul-brand { display: inline-flex; flex-direction: column; line-height: 1.1; }\n.ul-brand small { font-family: var(--font-family); font-size: 0.58rem; font-weight: 500; opacity: 0.7; letter-spacing: 0; margin-top: 2px; white-space: nowrap; }\n.sidebar.collapsed .ul-brand small { display: none; }\n")
edit("public/manifest.json", lambda s: s.replace('"name": "Monochrome Music"', '"name": "Monochrome · songs from Undertow"', 1).replace('"short_name": "Monochrome"', '"short_name": "Monochrome"', 1))

# ---- downloads: the file is asked of Undertow itself (TIDAL's audio servers refuse another site's page), and the tags are written as usual ----
swap("js/api.js", "            const enriched =\n                options.enriched ||\n                legacyEnrichedInput ||\n                (await this.enrichTrack(inputTrackObj || id, { downloadQuality }));",
     "            const enriched =\n                options.enriched ||\n                legacyEnrichedInput ||\n                (inputTrackObj && inputTrackObj.type !== 'video' // Undertow: the song itself comes from /audio, so nothing needs looking up first\n                    ? { lookup: { info: { audioQuality: downloadQuality } }, enrichedTrack: inputTrackObj, isVideo: false, externalStreamUrl: `${window.location.origin}/audio/${encodeURIComponent(String(id))}?quality=${encodeURIComponent(downloadQuality)}` }\n                    : await this.enrichTrack(inputTrackObj || id, { downloadQuality }));")

# ---- listening parties: the party server is Undertow's (lib/partyhost.mjs), people appear under their Undertow names, so there is no nickname to ask for ----
swap("js/listening-party.js", "    async showJoinModal(user, pbUser = null) {\n", "    async showJoinModal(user, pbUser = null) {\n        return { profile: null }; // Undertow: you're already signed in to Undertow, and that name is used\n")

swap("js/ui.js", "        if (authManager.user) {\n            if (authRequired) authRequired.style.display = 'none';\n        } else {", "        if (true || authManager.user) { // Undertow: you're already signed in to Undertow, so there is no \"sign in\" step here\n            if (authRequired) authRequired.style.display = 'none';\n        } else {")
edit("styles.css", lambda s: s if ".ul-sidebar-fit" in s else s + "\n/* .ul-sidebar-fit: the pixel face is wide, so the sidebar's labels are a touch smaller to fit */\n.sidebar .nav-item a span { font-size: 0.82rem; }\n.sidebar-logo-link { gap: 0.5rem; }\n")

# ---- the song file and the covers come from Undertow itself (downloads read both; TIDAL's servers refuse another site's page) ----
swap("js/tracks-api.js", "        const streamUrl = `${this.baseUrl}/track/${rawId}`;", "        const streamUrl = `${window.location.origin}/audio/${encodeURIComponent(rawId)}?quality=${encodeURIComponent(quality)}`; " + MARK + " Undertow serves the file")
swap("js/api.js", "        const formattedId = String(id).replace(/-/g, '/');\n        return `https://resources.tidal.com/images/${formattedId}/${size}x${size}.jpg`;", "        return `/tcover/${encodeURIComponent(String(id))}?size=${size}`; " + MARK + " covers come through Undertow")

# ---- the font choice is kept under a new name (an old saved "Inter" would otherwise win over the default a moment after the page loads) ----
swap("js/storage.js", "    STORAGE_KEY: 'monochrome-font-config-v2',", "    STORAGE_KEY: 'undertow-font-config-v1', // Undertow: a new name, so a choice saved by an older build can't overrule the default\n    LEGACY_STORAGE_KEY: 'monochrome-font-config-v2',")
edit("index.html", lambda s: s if "Monocraft</option>" in s else s.replace("<option value=\"'Inter', sans-serif\">Inter</option>", "<option value=\"'Monocraft', sans-serif\">Monocraft</option>\n                                        <option value=\"'Inter', sans-serif\">Inter</option>", 1))

# ---- the account button is Undertow's: you are signed in already, and your library follows you between devices (lib/playerhost.mjs keeps it) ----
edit("index.html", lambda s: s if "__AUTH_GATE__" in s else s.replace("<head>", "<head>\n        <script>window.__AUTH_GATE__ = true; /* Undertow: sign-in is Undertow's */</script>", 1))
swap("js/accounts/auth.js", "statusText.textContent = user ? `Signed in as ${user.email}` : 'Signed in';", "statusText.textContent = user ? `Signed in to Undertow as ${user.name || user.email}. Your library syncs with it.` : 'Signed in';")

# the account menu: your Undertow name and Sign Out (Monochrome's public profiles aren't part of this)
def account_menu(s):
    if "header-open-account" in s:
        return s
    a = s.index("                const data = await syncManager.getUserData();\n                const hasProfile")
    b = s.index("                document.getElementById('header-sign-out').onclick = () => authManager.signOut();")
    new = (
        "                // Undertow: who is signed in, and a way out. Profiles are Undertow's, not Monochrome's.\n"
        "                headerAccountDropdown.innerHTML = `\n"
        "                    <span id=\"header-account-name\" style=\"font-size:0.8rem;color:var(--muted-foreground);padding:0.25rem 0.5rem\"></span>\n"
        "                    <button class=\"btn-secondary\" id=\"header-open-account\">Account</button>\n"
        "                    <button class=\"btn-secondary danger\" id=\"header-sign-out\">Sign Out</button>\n"
        "                `;\n"
        "                document.getElementById('header-account-name').textContent = user.name || user.email || 'Undertow';\n"
        "                document.getElementById('header-open-account').onclick = () => {\n"
        "                    navigate('/account');\n"
        "                    headerAccountDropdown.classList.remove('active');\n"
        "                };\n"
    )
    return s[:a] + new + s[b:]


edit("js/app.js", account_menu)
edit("styles.css", lambda s: s if "#view-my-profile-btn" in s else s + "\n#view-my-profile-btn { display: none !important; } /* profiles are Undertow's */\n")

# ---- autoplay: on by default, and the recommendations come from the gateway (Monochrome fetched them from TIDAL through its own web proxy) ----
swap("js/storage.js", "    isEnabled() {\n        try {\n            return localStorage.getItem(this.ENABLED_KEY) === 'true';\n        } catch {\n            return false;\n        }\n    },\n\n    setEnabled(enabled) {\n        localStorage.setItem(this.ENABLED_KEY, enabled ? 'true' : 'false');",
     "    isEnabled() {\n        try {\n            const v = localStorage.getItem(this.ENABLED_KEY); // Undertow: on unless someone turned it off\n            return v === null ? true : v === 'true';\n        } catch {\n            return true;\n        }\n    },\n\n    setEnabled(enabled) {\n        localStorage.setItem(this.ENABLED_KEY, enabled ? 'true' : 'false');")


def recs(s):
    if "Undertow: recommendations" in s:
        return s
    a = s.index("    async getTrackRecommendations(id) {")
    b = s.index("\n    }\n", a) + len("\n    }\n")
    new = """    async getTrackRecommendations(id) {
        // Undertow: recommendations come from the gateway (a mix built around the song), not from TIDAL through someone else's proxy
        const cached = await this.cache.get('recommendations', id);
        if (cached) return cached;

        try {
            const response = await this.fetchWithRetry(`/recommendations/?id=${encodeURIComponent(String(id))}`);
            const json = await response.json();
            const rawItems = json.data?.items || json.items || [];
            const tracks = rawItems
                .map((entry) => entry.track || entry.item || entry)
                .filter((item) => item && item.id && item.title && String(item.id) !== String(id))
                .map((item) => this.prepareTrack(item));

            await this.cache.set('recommendations', id, tracks);
            return tracks;
        } catch (error) {
            console.error('Failed to fetch recommendations:', error);
            return [];
        }
    }
"""
    return s[:a] + new + s[b:]


edit("js/api.js", recs)

# ---- scrobbling: Last.fm goes through Undertow (its keys, each person's connection), and a song counts once it has really been listened to ----
shutil.copyfile(PORT / "lastfm.js", root / "js" / "lastfm.js")
print("replaced: js/lastfm.js")
swap("js/settings.js", "            const maxAttempts = 5;", "            const maxAttempts = 60; // Undertow: two minutes to approve it on Last.fm, not ten seconds")
edit("styles.css", lambda s: s if "#lastfm-credential-auth" in s else s + "\n/* Last.fm connects through Undertow: no own keys, no password form */\n#lastfm-custom-creds-toggle-setting, #lastfm-custom-creds-setting, #lastfm-credential-auth, #lastfm-credential-form { display: none !important; }\n")
swap("js/storage.js", "    isEnabled() {\n        try {\n            return localStorage.getItem(this.STORAGE_KEY) === 'true';\n        } catch {\n            return false;\n        }\n    },\n\n    setEnabled(enabled) {\n        localStorage.setItem(this.STORAGE_KEY, enabled ? 'true' : 'false');\n    },\n\n    shouldLoveOnLike", "    isEnabled() {\n        try {\n            return localStorage.getItem(this.STORAGE_KEY) !== 'false'; // Undertow: being connected is what turns it on, on every device\n        } catch {\n            return true;\n        }\n    },\n\n    setEnabled(enabled) {\n        localStorage.setItem(this.STORAGE_KEY, enabled ? 'true' : 'false');\n    },\n\n    shouldLoveOnLike")

# ---- Discord presence: "Listening to" on your profile through the Undertow Presence app (see undertow-rpc.js), switched on from the account menu ----
shutil.copyfile(PORT / "undertow-rpc.js", root / "js" / "undertow-rpc.js")
print("copied: js/undertow-rpc.js")


def rpc_events(s):
    if "undertowRpc" in s:
        return s
    first = s.index("import ")  # before the first import (it may span several lines)
    s = s[:first] + "import { undertowRpc } from './undertow-rpc.js'; // Undertow: Discord presence\n" + s[first:]
    old = "        element.addEventListener('playing', () => {\n            if (player.activeElement !== element) return;"
    new = ("        for (const ev of ['play', 'playing', 'pause', 'seeked', 'timeupdate']) {\n"
           "            element.addEventListener(ev, () => {\n"
           "                if (player.activeElement === element) undertowRpc.sync(player.currentTrack, element, player); // Undertow: Discord presence, when it's on\n"
           "            });\n"
           "        }\n\n") + old
    assert old in s, "events.js changed upstream (playing listener)"
    return s.replace(old, new, 1)


edit("js/events.js", rpc_events)
swap("js/events.js", "undertowRpc.sync(player.currentTrack, element);", "undertowRpc.sync(player.currentTrack, element, player);")


def rpc_menu(s):
    if "header-rpc" in s:
        return s
    if "import { undertowRpc }" not in s:
        first = s.index("import ")  # before the first import (it may span several lines)
        s = s[:first] + "import { undertowRpc } from './undertow-rpc.js'; // Undertow: Discord presence\n" + s[first:]
    old = "                    <button class=\"btn-secondary danger\" id=\"header-sign-out\">Sign Out</button>\n"
    new = ("                    <button class=\"btn-secondary\" id=\"header-rpc\"></button>\n") + old
    assert old in s, "app.js: account menu not found"
    s = s.replace(old, new, 1)
    old2 = "                document.getElementById('header-open-account').onclick = () => {"
    new2 = (
        "                const rpcBtn = document.getElementById('header-rpc');\n"
        "                rpcBtn.textContent = undertowRpc.enabled() ? 'Discord presence: on' : 'Discord presence: off';\n"
        "                rpcBtn.onclick = async () => {\n"
        "                    const r = await undertowRpc.toggle();\n"
        "                    if (r.missing) {\n"
        "                        alert('The Undertow Presence app is not running on this computer.\\n\\nDownload it from the Discord tab on ' + r.help + ', start it, then try again. Your browser may ask to let this site reach local devices: allow it.');\n"
        "                    } else if (r.on && !r.discord) {\n"
        "                        alert('The app is running, but Discord was not found. Open the Discord desktop app.');\n"
        "                    }\n"
        "                    rpcBtn.textContent = undertowRpc.enabled() ? 'Discord presence: on' : 'Discord presence: off';\n"
        "                };\n"
    ) + old2
    assert old2 in s, "app.js: open-account handler not found"
    return s.replace(old2, new2, 1)


edit("js/app.js", rpc_menu)


HTML_RPC = """                            <div class="settings-group" id="rpc-settings">
                                <div class="setting-item">
                                    <div class="info">
                                        <span class="label">Discord presence</span>
                                        <span class="description" id="rpc-status">Looking for the Undertow Presence app…</span>
                                    </div>
                                    <div style="display: flex; gap: 8px; flex-wrap: wrap">
                                        <button id="rpc-toggle-btn" class="btn-secondary">Turn on</button>
                                        <button id="rpc-test-btn" class="btn-secondary">Test card</button>
                                        <button id="rpc-check-btn" class="btn-secondary">Check again</button>
                                    </div>
                                </div>
                                <div class="setting-item">
                                    <div class="info">
                                        <span class="label">Show on my computer's Discord</span>
                                        <span class="description">Tells Undertow what you play here, so the Undertow Presence app on your computer shows it on Discord even though this device can't reach it (a phone, say). Set up the key on the Discord tab of Undertow.</span>
                                    </div>
                                    <button id="rpc-relay-btn" class="btn-secondary">Turn on</button>
                                </div>
                                <div class="setting-item">
                                    <div class="info">
                                        <span class="label">Get the app</span>
                                        <span class="description">Small, runs on your computer, and only talks to Discord and this player. Linux: make it executable, then run it. Windows: SmartScreen may warn because it is not signed.</span>
                                    </div>
                                    <div id="rpc-downloads" style="display: flex; gap: 8px; flex-wrap: wrap"></div>
                                </div>
                            </div>

"""


def rpc_html(s):
    if 'id="rpc-settings"' in s:
        return s
    old = '                            <div class="settings-group">\n                                <div class="setting-item">\n                                    <div class="info">\n                                        <span class="label">Last.fm Scrobbling</span>'
    assert old in s, "index.html: Last.fm settings group moved"
    return s.replace(old, HTML_RPC + old, 1)


edit("index.html", rpc_html)


def rpc_settings(s):
    if "initRpcSettings" in s:
        return s
    first = s.index("import ")
    s = s[:first] + "import { initRpcSettings } from './undertow-rpc.js'; // Undertow: Discord presence\n" + s[first:]
    old = "export async function initializeSettings(scrobbler, player, api, ui) {\n"
    assert old in s, "settings.js changed upstream"
    return s.replace(old, old + "    initRpcSettings(); // Undertow: the Discord presence section\n", 1)


edit("js/settings.js", rpc_settings)

# ---- with no lyrics beside it, the music video takes the room (a wide card instead of the cover-sized one) ----
edit("styles.css", lambda s: s if "ul-video-wide" in s else s + """
/* ul-video-wide: no lyrics (hidden, or none for this song) means the music video can be big */
@media (min-width: 900px) {
    #fullscreen-cover-overlay.ul-music-video-on:is(.lyrics-hidden, .lyrics-unavailable) .fullscreen-main-view {
        --fs-media-column-size: minmax(420px, 1fr);
        --fs-lyrics-column-size: minmax(0, 0fr);
        width: min(1100px, 100%);
        gap: 0;
    }
    #fullscreen-cover-overlay.ul-music-video-on:is(.lyrics-hidden, .lyrics-unavailable) .fullscreen-media-column {
        justify-self: center;
        width: min(920px, 100%);
        transform: none;
    }
    #fullscreen-cover-overlay.ul-music-video-on:is(.lyrics-hidden, .lyrics-unavailable) .fullscreen-artwork-card {
        width: min(920px, 100%, calc((100vh - 360px) * 16 / 9));
        max-width: none;
        margin: 0 auto;
    }
    #fullscreen-cover-overlay.ul-music-video-on.lyrics-unavailable .fullscreen-lyrics-pane { display: none; }
}
""")

# ---- ... and the title, progress bar and buttons line up with the wide video instead of staying in a cover-sized column ----
edit("styles.css", lambda s: s if "ul-video-wide-2" in s else s + """
/* ul-video-wide-2 */
@media (min-width: 900px) {
    #fullscreen-cover-overlay.ul-music-video-on:is(.lyrics-hidden, .lyrics-unavailable) .fullscreen-media-column {
        --ul-w: min(920px, 100%, calc((100vh - 360px) * 16 / 9));
        align-items: center;
    }
    #fullscreen-cover-overlay.ul-music-video-on:is(.lyrics-hidden, .lyrics-unavailable) .fullscreen-artwork-card,
    #fullscreen-cover-overlay.ul-music-video-on:is(.lyrics-hidden, .lyrics-unavailable) .fullscreen-track-info,
    #fullscreen-cover-overlay.ul-music-video-on:is(.lyrics-hidden, .lyrics-unavailable) .fullscreen-controls {
        width: var(--ul-w);
        max-width: none;
        margin-left: auto;
        margin-right: auto;
    }
}
""")

# ---- long playlists: Monochrome asked for them 100 songs at a time, one request after another; ask for big pages and fetch the rest side by side ----
def playlist_pages(s):
    if "Undertow: playlist pages" in s:
        return s
    a = s.index("    async getPlaylist(id) {")
    b = s.index("        // Enrich tracks with album release dates", a)
    seg = s[a:b]
    old_first = "const response = await this.fetchWithRetry(`/playlist/?id=${id}`);"
    assert old_first in seg, "api.js: getPlaylist changed upstream (first request)"
    seg = seg.replace(old_first, "const response = await this.fetchWithRetry(`/playlist/?id=${id}&limit=100`); // Undertow: playlist pages (TIDAL allows 100 a page)", 1)
    c = seg.index("        // Handle pagination if there are more tracks")
    new = """        // Undertow: the rest of the pages are fetched side by side (four at a time), in order
        if (playlist.numberOfTracks > tracks.length && tracks.length > 0) {
            const step = tracks.length;
            const total = Math.min(playlist.numberOfTracks, 10000);
            const offsets = [];
            for (let o = step; o < total; o += step) offsets.push(o);
            const pages = new Array(offsets.length);
            let next = 0;
            const worker = async () => {
                while (next < offsets.length) {
                    const k = next++;
                    try {
                        const r = await this.fetchWithRetry(`/playlist/?id=${id}&limit=${step}&offset=${offsets[k]}`);
                        const j = await r.json();
                        const d = j.data || j;
                        const items = d.items || (Array.isArray(d) ? d.find((e) => e && Array.isArray(e.items))?.items : null) || [];
                        pages[k] = items.map((i) => this.prepareTrack(i.item || i));
                    } catch (error) {
                        console.error(`Error fetching playlist tracks at offset ${offsets[k]}:`, error);
                        pages[k] = [];
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(4, offsets.length) }, worker));
            const seen = new Set(tracks.map((t) => t.id));
            for (const pg of pages) {
                for (const t of pg || []) {
                    if (!seen.has(t.id)) {
                        seen.add(t.id);
                        tracks.push(t);
                    }
                }
            }
        }

"""
    seg = seg[:c] + new
    return s[:a] + seg + s[b:]


edit("js/api.js", playlist_pages)

# ---- Dolby Atmos: the server sends the E-AC-3 file; a browser without a decoder gets it decoded by ffmpeg.wasm (see undertow-atmos.js) ----
shutil.copyfile(PORT / "undertow-atmos.js", root / "js" / "undertow-atmos.js")
print("copied: js/undertow-atmos.js")


def atmos_stream(s):
    if "undertow-atmos" in s:
        return s
    first = s.index("import ")
    s = s[:first] + "import { atmosUrl } from './undertow-atmos.js'; // Undertow: Dolby Atmos\n" + s[first:]
    old = "        return { url: `${window.location.origin}/audio/${encodeURIComponent(this.stripProviderPrefix(id))}?quality=${encodeURIComponent(quality || 'LOSSLESS')}`, rgInfo: null };"
    new = ("        { // Undertow: a Dolby Atmos file goes through the decoder first when this browser can't play it\n"
           "            const file = `${window.location.origin}/audio/${encodeURIComponent(this.stripProviderPrefix(id))}?quality=${encodeURIComponent(quality || 'LOSSLESS')}`;\n"
           "            return { url: /^DOLBY_ATMOS/i.test(String(quality || '')) ? await atmosUrl(file) : file, rgInfo: null };\n"
           "        }")
    assert old in s, "music-api.js: stream URL line changed upstream"
    return s.replace(old, new, 1)


edit("js/music-api.js", atmos_stream)

# ---- the Atmos note in Settings was wrong once Undertow decodes it in the page ----
def atmos_note(s):
    if "Undertow: decoded in the page" in s or "atmos-note-v" in s:
        return s
    old = "`This browser does not report ${isAc4 ? 'AC-4' : 'E-AC-3'} playback support, so this quality cannot be streamed here. You can still use it for downloads.`;"
    new = ("isAc4\n"
           "                        ? 'This browser does not report AC-4 playback support, so this quality cannot be streamed here. You can still use it for downloads.'\n"
           "                        : \"This browser can't play Dolby Atmos itself, so Undertow decodes it in the page (a few seconds per song, a bigger download the first time). \"\n"
           "                          + 'You get the 6-channel mix; turn on the spatial (binaural) setting to hear it around you. Songs without an Atmos mix play in stereo.'; // Undertow: decoded in the page")
    assert old in s, "settings.js: Atmos note changed upstream"
    return s.replace(old, new, 1)


edit("js/settings.js", atmos_note)

# ---- the Atmos note: green when this browser decodes Dolby itself, a warning that ffmpeg (WebAssembly) does it when it can't ----
def atmos_note_v2(s):
    if "atmos-note-v" in s:
        return s
    a = s.index("            const showWarning = isAc4 || (isEac3 && !supported);")
    b = s.index("        updateStreamingQualityDetails();\n", a)
    new = """            // atmos-note-v2 (Undertow)
            const showWarning = isAc4 || isEac3;
            if (atmosWarning) atmosWarning.style.display = showWarning ? '' : 'none';
            if (showWarning && atmosWarningText) {
                if (isAc4) {
                    atmosWarningText.style.color = '';
                    atmosWarningText.textContent = supported
                        ? 'AC-4 streaming support is experimental and may still fail in this browser. AC-4 downloads remain available.'
                        : 'This browser does not report AC-4 playback support, so this quality cannot be streamed here. You can still use it for downloads.';
                } else if (supported) {
                    atmosWarningText.style.color = '#4ade80';
                    atmosWarningText.textContent = 'Great! You can decode Dolby Tracks natively on this device.';
                } else {
                    atmosWarningText.style.color = '';
                    atmosWarningText.textContent =
                        'This browser has no Dolby decoder, so it works through WebAssembly ffmpeg: each song is decoded in the page first (a few seconds per song, and a bigger download the first time).';
                }
            }
        };
"""
    return s[:a] + new + s[b:]


edit("js/settings.js", atmos_note_v2)

# ---- "Prefer Dolby Atmos" asks for the Atmos mix (falling back to the quality you chose), and the notes in Settings cover it too ----
def atmos_prefer(s):
    if "atmos-prefer-v2" in s:
        return s
    if "preferDolbyAtmosSettings" not in s.split("export class")[0]:
        s = s.replace("import { musicProviderSettings } from './storage.js';", "import { musicProviderSettings, preferDolbyAtmosSettings } from './storage.js';", 1)
        assert "preferDolbyAtmosSettings" in s, "music-api.js: storage import changed upstream"
    a = s.index("            const file = `${window.location.origin}/audio/${encodeURIComponent(this.stripProviderPrefix(id))}?quality=${encodeURIComponent(quality || 'LOSSLESS')}`;\n            return { url: /^DOLBY_ATMOS/i")
    b = s.index("\n", s.index("return { url: /^DOLBY_ATMOS/i", a)) + 1
    new = (
        "            // atmos-prefer-v2: an Atmos quality, or \"Prefer Dolby Atmos\" on, asks for the Atmos mix and names the quality to fall back to\n"
        "            const q = String(quality || 'LOSSLESS');\n"
        "            const chosen = /^DOLBY_ATMOS/i.test(q);\n"
        "            const wantAtmos = chosen || (preferDolbyAtmosSettings.isEnabled() && !/^FFMPEG_/i.test(q));\n"
        "            const file = `${window.location.origin}/audio/${encodeURIComponent(this.stripProviderPrefix(id))}?quality=${encodeURIComponent(wantAtmos && !chosen ? 'DOLBY_ATMOS_EAC3_HIGH' : q)}${wantAtmos && !chosen ? `&fallback=${encodeURIComponent(q)}` : ''}`;\n"
        "            return { url: wantAtmos ? await atmosUrl(file) : file, rgInfo: null };\n"
    )
    return s[:a] + new + s[b:]


edit("js/music-api.js", atmos_prefer)


def atmos_note_v3(s):
    if "atmos-note-v3" in s:
        return s
    a = s.index("            // atmos-note-v2 (Undertow)")
    b = s.index("        };\n        updateStreamingQualityDetails();\n", a)
    new = """            // atmos-note-v3 (Undertow): the note also shows when "Prefer Dolby Atmos" is on
            const preferOn = preferDolbyAtmosSettings.isEnabled();
            const showWarning = isAc4 || isEac3 || preferOn;
            const okHere = isEac3 || !isAc4 ? canBrowserStreamAtmosQuality('DOLBY_ATMOS_EAC3_HIGH') : supported;
            if (atmosWarning) atmosWarning.style.display = showWarning ? '' : 'none';
            if (showWarning && atmosWarningText) {
                if (isAc4) {
                    atmosWarningText.style.color = '';
                    atmosWarningText.textContent = supported
                        ? 'AC-4 streaming support is experimental and may still fail in this browser. AC-4 downloads remain available.'
                        : 'This browser does not report AC-4 playback support, so this quality cannot be streamed here. You can still use it for downloads.';
                } else if (okHere) {
                    atmosWarningText.style.color = '#4ade80';
                    atmosWarningText.textContent = 'Great! You can decode Dolby Tracks natively on this device.';
                } else {
                    atmosWarningText.style.color = '';
                    atmosWarningText.textContent =
                        'This browser has no Dolby decoder, so it works through WebAssembly ffmpeg: each Dolby song is decoded in the page first (a few seconds per song, and a bigger download the first time). Songs without a Dolby mix play normally.';
                }
            }
            window.__ulAtmosNote = updateStreamingQualityDetails;
"""
    return s[:a] + new + s[b:]


edit("js/settings.js", atmos_note_v3)
swap("js/settings.js", "            preferDolbyAtmosSettings.setEnabled(e.target.checked);\n        });", "            preferDolbyAtmosSettings.setEnabled(e.target.checked);\n            window.__ulAtmosNote?.(); // Undertow: refresh the Dolby note\n        });")

# ---- what the player is told about an Atmos request: the Dolby badge for a real Atmos file, the right badge for a fallback, and no spatial effect on our stereo mix ----
def atmos_info(s):
    if "atmos-info-v3" in s:
        return s
    old = "            return { url: wantAtmos ? await atmosUrl(file) : file, rgInfo: null };\n"
    new = (
        "            if (!wantAtmos) return { url: file, rgInfo: null };\n"
        "            // atmos-info-v3: say what really came back, so the badge is right\n"
        "            const got = await atmosUrl(file);\n"
        "            if (got.kind === 'atmos') return { url: got.url, rgInfo: null, codec: 'eac3-joc', quality: 'DOLBY_ATMOS_EAC3_HIGH', lossless: false, ulDownmix: got.downmix };\n"
        "            if (got.kind === 'flac') return { url: got.url, rgInfo: null, codec: 'flac', lossless: true, quality: chosen ? 'HI_RES_LOSSLESS' : q };\n"
        "            return { url: got.url, rgInfo: null, codec: 'aac', lossless: false, quality: chosen ? 'HIGH' : q };\n"
    )
    assert old in s, "music-api.js: stream return changed"
    return s.replace(old, new, 1)


edit("js/music-api.js", atmos_info)


def atmos_badge(s):
    if "ulDownmix" in s:
        return s
    old = "            if (isAtmosPlaying) {\n                if (binauralDspSettings.getAutoEnableForSpatial()"
    new = ("            if (isAtmosPlaying && this.currentStreamInfo?.ulDownmix) {\n"
           "                // Undertow: Dolby Atmos decoded in the page and mixed to stereo: the Dolby badge, but no spatial effect on a stereo mix\n"
           "                void audioContextManager.notifyBinauralChannelCount(2);\n"
           "                badgeEl.className = 'quality-badge quality-atmos shaka-quality-badge';\n"
           "                badgeEl.innerHTML = SVG_ATMOS(20);\n"
           "                badgeEl.style.display = 'inline-flex';\n"
           "                return;\n"
           "            }\n\n") + old
    assert old in s, "player.js: Atmos badge block changed upstream"
    return s.replace(old, new, 1)


edit("js/player.js", atmos_badge)

# ---- file info under the artist in the fullscreen player: codec, kHz, bit depth, kbps, channels (read by the server with ffprobe, see undertow-info.js) ----
shutil.copyfile(PORT / "undertow-info.js", root / "js" / "undertow-info.js")
print("copied: js/undertow-info.js")


def info_hook(s):
    if "trackAudioInfo" in s:
        return s
    first = s.index("import ")
    s = s[:first] + "import { trackAudioInfo } from './undertow-info.js'; // Undertow: file info\n" + s[first:]
    old = "            if (!wantAtmos) return { url: file, rgInfo: null };\n"
    new = ("            if (!wantAtmos) {\n"
           "                trackAudioInfo(id, file); // Undertow: file info for the fullscreen player\n"
           "                return { url: file, rgInfo: null };\n"
           "            }\n")
    assert old in s, "music-api.js: the stream return changed upstream (info)"
    s = s.replace(old, new, 1)
    old2 = "            const got = await atmosUrl(file);\n"
    assert old2 in s, "music-api.js: the Atmos result changed upstream (info)"
    return s.replace(old2, old2 + "            trackAudioInfo(id, file, got.kind === 'atmos' && got.downmix);\n", 1)


edit("js/music-api.js", info_hook)

# ---- the quality badge reads the real file (bit depth, sample rate) instead of the quality that was asked for ----
def info_facts(s):
    if "streamFacts" in s:
        return s
    s = s.replace("import { trackAudioInfo } from './undertow-info.js';", "import { trackAudioInfo, streamFacts } from './undertow-info.js';", 1)
    pairs = [
        ("                trackAudioInfo(id, file); // Undertow: file info for the fullscreen player\n                return { url: file, rgInfo: null };",
         "                const real = await trackAudioInfo(id, file); // Undertow: the file's real details, for the badge and the fullscreen line\n                return { url: file, rgInfo: null, ...streamFacts(real) };"),
        ("            trackAudioInfo(id, file, got.kind === 'atmos' && got.downmix);\n",
         "            const real = await trackAudioInfo(id, file, got.kind === 'atmos' && got.downmix);\n"),
        ("codec: 'flac', lossless: true, quality: chosen ? 'HI_RES_LOSSLESS' : q };",
         "codec: 'flac', lossless: true, ...streamFacts(real), quality: chosen ? 'HI_RES_LOSSLESS' : q };"),
        ("codec: 'aac', lossless: false, quality: chosen ? 'HIGH' : q };",
         "codec: 'aac', lossless: false, ...streamFacts(real), quality: chosen ? 'HIGH' : q };"),
    ]
    for old, new in pairs:
        assert old in s, "music-api.js changed (info facts): " + old[:50]
        s = s.replace(old, new, 1)
    return s


edit("js/music-api.js", info_facts)

# ---- install as an app (PWA): a service worker that caches nothing (served by Undertow at /__sw.js), a manifest with the right icon type ----
def pwa_register(s):
    if "/__sw.js" in s:
        return s
    old = "        console.log('PWA disabled for auth gate');\n        await disablePwaForAuthGate().catch(console.error);"
    new = ("        // Undertow: installable, but nothing is cached (the old Monochrome worker and its caches are removed; ours only makes the page installable)\n"
           "        console.log('PWA: install only, no offline cache');\n"
           "        try {\n"
           "            const regs = await navigator.serviceWorker.getRegistrations();\n"
           "            const own = (r) => String((r.active || r.waiting || r.installing)?.scriptURL || '').endsWith('/__sw.js');\n"
           "            await Promise.all(regs.filter((r) => !own(r)).map((r) => r.unregister()));\n"
           "            if ('caches' in window) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));\n"
           "            await navigator.serviceWorker.register('/__sw.js', { scope: '/' });\n"
           "        } catch (error) {\n"
           "            console.warn('Service worker failed:', error);\n"
           "        }")
    assert old in s, "app.js: the auth-gate PWA branch changed upstream"
    return s.replace(old, new, 1)


edit("js/app.js", pwa_register)
edit("public/manifest.json", lambda s: s.replace('"type": "image/png"', '"type": "image/webp"'))

# ---- the host's own party page showed "Paused" for good: it only learns playback from other people's messages ----
def party_host_label(s):
    if "Undertow: the host's own view" in s:
        return s
    old = "            } catch (_e) {}\n        };\n        ['play', 'pause', 'seeked'].forEach((ev) => {"
    new = ("            } catch (_e) {}\n"
           "            // Undertow: the host's own view follows what the host plays (the server only tells everyone else)\n"
           "            const cp = this.currentParty;\n"
           "            if (cp && (cp.is_playing !== !el.paused || String(cp.current_track?.id) !== String(sharedTrack?.id))) {\n"
           "                cp.is_playing = !el.paused;\n"
           "                cp.current_track = sharedTrack;\n"
           "                this.updatePartyHeader?.();\n"
           "            }\n"
           "        };\n"
           "        ['play', 'pause', 'seeked'].forEach((ev) => {")
    assert old in s, "listening-party.js changed upstream"
    return s.replace(old, new, 1)


edit("js/listening-party.js", party_host_label)

# ---- music videos in the fullscreen player (the real video of the song, found and lined up by Undertow; see lib/playerhost.mjs /mv/) ----
shutil.copyfile(PORT / "undertow-video.js", root / "js" / "undertow-video.js")
print("copied: js/undertow-video.js")


def video_ui(s):
    if "undertowVideo" in s:
        return s
    first = s.index("\n", s.index("import "))  # after the first import line
    s = s[:first + 1] + "import { undertowVideo } from './undertow-video.js'; // Undertow: music videos\n" + s[first + 1:]
    pairs = [
        ("            if (image) image.style.display = 'block';\n            if (visualizerContainer) visualizerContainer.style.display = 'block';",
         "            if (image) image.style.display = undertowVideo.showing ? 'none' : 'block'; // Undertow: the music video stands in for the cover while it plays\n            if (visualizerContainer) visualizerContainer.style.display = 'block';"),
        ("    closeFullscreenCover() {\n        const overlay = document.getElementById('fullscreen-cover-overlay');",
         "    closeFullscreenCover() {\n        undertowVideo.stop();\n        const overlay = document.getElementById('fullscreen-cover-overlay');"),
        ("        this.setupFullscreenControls();\n        overlay.style.display = 'flex';",
         "        this.setupFullscreenControls();\n        overlay.style.display = 'flex';\n        undertowVideo.start(track, activeElement); // Undertow: the song's music video, when there is one"),
    ]
    for old, new in pairs:
        assert old in s, "ui.js changed upstream: " + old[:60]
        s = s.replace(old, new, 1)
    return s


edit("js/ui.js", video_ui)
edit("styles.css", lambda s: s if "#ul-video-toggle" in s else s + "\n/* the music-video switch looks like its neighbours in the fullscreen top row, last in line */\n#fullscreen-cover-overlay .fullscreen-top-actions #ul-video-toggle { order: 4; position: static; margin: 0; opacity: 1; }\n#fullscreen-cover-overlay .fullscreen-top-actions #ul-video-toggle.active { color: rgb(255 255 255 / 0.96); background: rgb(255 255 255 / 0.12); }\n")

edit("styles.css", lambda s: s if "ul-video-toggle-v2" in s else s + """
/* ul-video-toggle-v2: the music-video switch is drawn exactly like the lyrics switch next to it (same size, same translucent disc, lit when on), between the lyrics and visualizer buttons */
#fullscreen-cover-overlay .fullscreen-top-actions #ul-video-toggle {
    order: 3; position: static; margin: 0; opacity: 1; width: 40px; height: 40px; padding: 0; border: none !important; box-shadow: none !important;
    border-radius: 999px; display: flex; align-items: center; justify-content: center;
    background: rgb(9 12 18 / 0.34) !important; color: rgb(255 255 255 / 0.72) !important; backdrop-filter: blur(10px); transform: none !important;
}
#fullscreen-cover-overlay .fullscreen-top-actions #ul-video-toggle.active { color: rgb(255 255 255 / 0.96) !important; background: rgb(255 255 255 / 0.12) !important; }
#fullscreen-cover-overlay .fullscreen-top-actions #ul-video-toggle:hover { color: rgb(255 255 255 / 0.96) !important; }
#fullscreen-cover-overlay .fullscreen-top-actions #ul-video-toggle svg { width: 20px; height: 20px; }
#fullscreen-cover-overlay .fullscreen-top-actions #fs-visualizer-btn { order: 4; }
""")

# no donation prompt (it popped up in the corner)
swap("js/storage.js", "export const donationPromptSettings = {\n    STORAGE_KEY: 'donation-prompts-enabled',\n\n    isEnabled() {\n        try {\n            const value = localStorage.getItem(this.STORAGE_KEY);\n            return value === null ? true : value === 'true';\n        } catch {\n            return true;\n        }\n    },",
     "export const donationPromptSettings = {\n    STORAGE_KEY: 'donation-prompts-enabled',\n\n    isEnabled() {\n        return false; // Undertow: no donation pop-ups\n    },")
edit("styles.css", lambda s: s if "ul-video-btn" in s else s + "\n/* the music-video switch takes a place in the top row, so the eye (hide interface) button moves along one */\n#fullscreen-cover-overlay.ul-video-btn #toggle-ui-btn { left: calc(1.5rem + env(safe-area-inset-left) + (40px * 4) + (0.4rem * 4)); }\n")

# ---- the About page: a modified instance that uses Undertow, with credit to the original project and the open-source software behind this one ----
ABOUT_DESC = """<p class="about-description">
                            This is a <strong>modified instance of Monochrome</strong>, a high-fidelity music player. It isn't the official site: it takes its songs,
                            covers, sign-in, library sync, listening parties, Last.fm scrobbling and music videos from an <strong>Undertow</strong> server.
                            <br />
                        </p>"""
ABOUT_CREDITS = """<div class="about-credits" style="max-width: 680px; margin: 2rem auto 0; text-align: left; line-height: 1.55">
                            <h3 style="text-align: center; margin-bottom: 0.75rem">Credits</h3>
                            <p>
                                The player is <a href="https://github.com/monochrome-music/monochrome" target="_blank" rel="noopener noreferrer" style="text-decoration: underline">Monochrome</a>
                                by Edideaur and its contributors (listed below), released under the
                                <a href="/LICENSE-monochrome.txt" target="_blank" rel="noopener noreferrer" style="text-decoration: underline">Apache License 2.0</a>.
                                If you like it, please support the original project on GitHub, not this copy.
                            </p>
                            <p style="margin-top: 0.75rem"><strong>What was changed:</strong> songs, search, covers and audio come from Undertow's own music accounts instead of Monochrome's services;
                                you sign in with your Undertow account, and your library syncs through Undertow; listening parties, Last.fm scrobbling and music videos run on Undertow's
                                server; lyrics, recommendations and downloads were reconnected to it; the default typeface is Monocraft; and the donation prompts, analytics, error
                                reporting and Monochrome's own accounts were removed. Every change is in the open <code>patch.py</code> of the Undertow project.</p>
                            <h4 style="margin: 1.25rem 0 0.5rem">Open-source software behind it</h4>
                            <ul style="padding-left: 1.25rem; display: grid; gap: 0.35rem">
                                <li><a href="https://github.com/sachinsenal0x64/hifi" target="_blank" rel="noopener noreferrer" style="text-decoration: underline">hifi-api</a> (MIT): the gateway Undertow uses to reach TIDAL.</li>
                                <li><a href="https://github.com/IdreesInc/Monocraft" target="_blank" rel="noopener noreferrer" style="text-decoration: underline">Monocraft</a> by Idrees Hassan (SIL Open Font License 1.1): the typeface.</li>
                                <li><a href="https://github.com/yt-dlp/yt-dlp" target="_blank" rel="noopener noreferrer" style="text-decoration: underline">yt-dlp</a> (Unlicense) and <a href="https://ffmpeg.org" target="_blank" rel="noopener noreferrer" style="text-decoration: underline">FFmpeg</a> (LGPL/GPL): find, save and line up music videos, on the server.</li>
                                <li><a href="https://www.npmjs.com/package/@uimaxbai/am-lyrics" target="_blank" rel="noopener noreferrer" style="text-decoration: underline">am-lyrics</a> by uimaxbai (MPL-2.0): the lyrics display.</li>
                                <li><a href="https://github.com/shaka-project/shaka-player" target="_blank" rel="noopener noreferrer" style="text-decoration: underline">Shaka Player</a> (Apache-2.0) and <a href="https://github.com/video-dev/hls.js" target="_blank" rel="noopener noreferrer" style="text-decoration: underline">hls.js</a> (Apache-2.0): streaming playback.</li>
                                <li><a href="https://github.com/ffmpegwasm/ffmpeg.wasm" target="_blank" rel="noopener noreferrer" style="text-decoration: underline">ffmpeg.wasm</a> (MIT, core GPL-2.0-or-later): tagging and converting downloads in your browser.</li>
                                <li><a href="https://github.com/jberg/butterchurn" target="_blank" rel="noopener noreferrer" style="text-decoration: underline">Butterchurn</a> (MIT): the visualizer.</li>
                                <li><a href="https://github.com/better-lyrics/kawarp" target="_blank" rel="noopener noreferrer" style="text-decoration: underline">Kawarp</a> (MIT): animated backgrounds.</li>
                                <li><a href="https://github.com/krisk/Fuse" target="_blank" rel="noopener noreferrer" style="text-decoration: underline">Fuse.js</a> (Apache-2.0): search.</li>
                            </ul>
                        </div>"""


def about_page(s):
    if "about-credits" in s:
        return s
    a = s.index('<p class="about-description">')
    b = s.index("</p>", a) + 4
    s = s[:a] + ABOUT_DESC + s[b:]
    a = s.index('<div class="about-donate">')
    b = s.index('<p style="text-align: center; color: grey">\n                            made with')
    s = s[:a] + ABOUT_CREDITS + "\n                        " + s[b:]
    s = _re.sub(r'<p style="text-align: center; color: grey">\s*We also take paid code commissions.*?</p>\s*', "", s, count=1, flags=_re.S)
    return s


edit("index.html", about_page)


def about_made_by(s):
    if "undertow-made-by" in s:
        return s
    old = "Every change is in the open <code>patch.py</code> of the Undertow project.</p>"
    assert old in s, "index.html: the About credits moved"
    new = (old + "\n"
           "                            <p id=\"undertow-made-by\" style=\"margin-top: 0.75rem\"><strong>Who made the Undertow changes:</strong> they were created by "
           "<a href=\"https://www.anthropic.com/claude\" target=\"_blank\" rel=\"noopener noreferrer\" style=\"text-decoration: underline\">Claude Sonnet 5.5</a>, an AI model by Anthropic, "
           "working with Undertow's author. That covers everything listed above, plus Discord presence, Dolby Atmos decoding and the file details line.</p>")
    return s.replace(old, new, 1)


edit("index.html", about_made_by)

# ---- Monocraft in the Font preset list (it is the default here, so it goes first and Inter loses the "(Default)") ----
swap("index.html", '<option value="Inter">Inter (Default)</option>', '<option value="Monocraft">Monocraft (Default)</option>\n                                                <option value="Inter">Inter</option>')

# ---- the contributors on the About page: a saved copy of GitHub's list (Monochrome's own list is served to its own site only, so it failed here) ----
shutil.copyfile(PORT / "contributors.json", root / "public" / "contributors.json")
swap("js/app.js", "const response = await fetch('https://tracks.monochrome.st/contributors');", "const response = await fetch('/contributors.json'); // Undertow: a saved copy of https://github.com/monochrome-music/monochrome/graphs/contributors")
print("done")


# ---- "play as" ALAC or MP3: the server converts the song on the fly (for a weaker device, or just for fun) ----
def recode_html(s):
    if "UNDERTOW_ALAC" in s:
        return s
    old = '                                        <option value="LOW">Low</option>\n                                    </select>'
    assert old in s, "index.html: streaming quality list changed upstream"
    return s.replace(old, '                                        <option value="LOW">Low</option>\n                                        <option value="UNDERTOW_ALAC">Lossless as ALAC (converted by Undertow)</option>\n                                        <option value="UNDERTOW_MP3">MP3 V0 (converted by Undertow, plays anywhere)</option>\n                                    </select>', 1)


edit("index.html", recode_html)


def alac_warn_html(s):
    if "undertow-alac-warn" in s:
        return s
    assert "    </body>" in s, "index.html: no </body>"
    return s.replace("    </body>", ALAC_WARN + "    </body>", 1)


ALAC_WARN = r'''    <script>/* undertow-alac-warn: ALAC only plays in Safari and on Apple devices */
(() => { try {
  const ok = !!document.createElement("audio").canPlayType('audio/mp4; codecs="alac"');
  const sel = document.getElementById("streaming-quality-setting"); if (!sel) return;
  const opt = sel.querySelector('option[value="UNDERTOW_ALAC"]');
  if (opt && !ok) opt.textContent += " (this browser says it can't play it)";
  const note = (m) => { const d = document.createElement("div"); d.textContent = m; d.style.cssText = "position:fixed;left:50%;bottom:90px;transform:translateX(-50%);max-width:90vw;padding:10px 16px;border-radius:8px;background:#7a1f1f;color:#fff;font:14px sans-serif;z-index:99999"; document.body.appendChild(d); setTimeout(() => d.remove(), 7000); };
  sel.addEventListener("change", () => { if (sel.value === "UNDERTOW_ALAC" && !ok) note("This browser says it can't play ALAC, so songs may stay silent. ALAC works in Safari and on Apple devices. Pick MP3 or Lossless instead."); });
} catch {} })();
</script>
'''
edit("index.html", alac_warn_html)

MOBILE_META_CLAMP = r'''
/* ul-mobile-meta-clamp: a long title or album name on a phone took three lines and crowded the fullscreen player. Title: 2 lines, album and artist: 1 line each, with an ellipsis. */
@media (max-width: 768px) {
  #fullscreen-cover-overlay #fullscreen-track-title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
  #fullscreen-cover-overlay #fullscreen-track-album, #fullscreen-cover-overlay #fullscreen-track-artist { display: block; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #fullscreen-cover-overlay #fullscreen-track-album { font-size: .84rem; }
  /* both are grids with auto columns, which grow to fit no-wrap text instead of cutting it */
  #fullscreen-cover-overlay .fullscreen-track-info, #fullscreen-cover-overlay .fullscreen-track-text { grid-template-columns: minmax(0, 1fr); min-width: 0; }
}
'''
edit("styles.css", lambda s: s if "ul-mobile-meta-clamp" in s else s + MOBILE_META_CLAMP)

TOUCH_TARGETS = r'''
/* ul-touch-targets: the like heart and the three-dot menu in song rows were about 24px on a phone, too small to press. The hit area is 44px; negative margins keep the row layout as it was. */
@media (max-width: 768px), (pointer: coarse) {
  .track-item { min-height: 48px; }
  .track-item .track-row-like-btn, .track-item .track-menu-btn, .track-item .track-action-btn {
    box-sizing: border-box; min-width: 44px; min-height: 44px; padding: 0; margin: -6px -6px;
    display: inline-flex; align-items: center; justify-content: center; -webkit-tap-highlight-color: transparent;
  }
  .track-item .track-row-like-btn svg, .track-item .track-menu-btn svg, .track-item .track-action-btn svg { width: 20px; height: 20px; }
}
'''
edit("styles.css", lambda s: s if "ul-touch-targets" in s else s + TOUCH_TARGETS)


def recode_api(s):
    if "undertow-recode" in s:
        return s
    old = "            const q = String(quality || 'LOSSLESS');\n            const chosen = /^DOLBY_ATMOS/i.test(q);\n            const wantAtmos = chosen || (preferDolbyAtmosSettings.isEnabled() && !/^FFMPEG_/i.test(q));\n"
    assert old in s, "music-api.js: atmos-prefer block changed"
    new = ("            // undertow-recode: ALAC / MP3 are made by the server from the best file, so they never take the Atmos path\n"
           "            const asFmt = /^UNDERTOW_(ALAC|MP3)$/i.exec(String(quality || ''));\n"
           "            const q = asFmt ? 'HI_RES_LOSSLESS' : String(quality || 'LOSSLESS');\n"
           "            const chosen = /^DOLBY_ATMOS/i.test(q);\n"
           "            const wantAtmos = !asFmt && (chosen || (preferDolbyAtmosSettings.isEnabled() && !/^FFMPEG_/i.test(q)));\n")
    s = s.replace(old, new, 1)
    old = "${wantAtmos && !chosen ? `&fallback=${encodeURIComponent(q)}` : ''}`;\n"
    assert old in s
    return s.replace(old, "${wantAtmos && !chosen ? `&fallback=${encodeURIComponent(q)}` : ''}${asFmt ? `&format=${asFmt[1].toLowerCase()}` : ''}`;\n", 1)


edit("js/music-api.js", recode_api)
