// Undertow: Discord "Listening to" presence, through the Undertow Presence app on this computer (http://127.0.0.1:8892).
// Off until it's turned on in the account menu. The browser asks once to let this site reach local devices.
const BASE = 'http://127.0.0.1:8892';
const KEY = 'undertow-rpc';
const RELAY = 'undertow-rpc-relay'; // also tell Undertow, so the presence app on another computer can show it
const MAIN = 'https://quiet-otter.outsideitrains.com/';

const enabled = () => {
    try {
        return localStorage.getItem(KEY) === '1';
    } catch {
        return false;
    }
};

const call = async (path, body) => {
    const r = await fetch(BASE + path, {
        cache: 'no-store',
        ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
};

const coverOf = (track) => {
    const id = track?.album?.cover || track?.cover;
    return typeof id === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
        ? `https://resources.tidal.com/images/${id.replaceAll('-', '/')}/640x640.jpg`
        : '';
};

// what is playing, in words: Hi-Res Lossless, Lossless, AAC 320, Dolby Atmos ...
const qualityOf = (track, player) => {
    const info = player?.currentStreamInfo || {};
    const q = String(info.quality || player?.quality || '').toUpperCase();
    const codec = String(info.codec || '').toLowerCase();
    if (codec.includes('eac3') || codec.includes('ec-3') || q.startsWith('DOLBY_ATMOS')) return info.ulDownmix ? 'Dolby Atmos (via ffmpeg.wasm)' : 'Dolby Atmos'; // decoded in the page, not by the device
    if (codec === 'ac4' || codec === 'ac-4') return 'Dolby Atmos (AC-4)';
    if (codec.includes('alac')) return 'ALAC';
    if (codec.includes('opus')) return 'Opus';
    if (codec.includes('mp3')) return 'MP3';
    if (codec.includes('aac') || q === 'HIGH') return q === 'LOW' ? 'AAC 96' : 'AAC 320';
    if (q === 'LOW') return 'AAC 96';
    if (q === 'HI_RES_LOSSLESS') return track?.audioQuality === 'HI_RES_LOSSLESS' || (track?.mediaMetadata?.tags || []).includes('HIRES_LOSSLESS') ? 'Hi-Res Lossless' : 'Lossless';
    if (q === 'LOSSLESS' || codec.includes('flac')) return 'Lossless';
    return '';
};

const relayOn = () => {
    try {
        return localStorage.getItem(RELAY) === '1';
    } catch {
        return false;
    }
};
const relayPost = (p) => {
    if (relayOn()) fetch('/__off/rpc/now', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ui' }, body: JSON.stringify(p), cache: 'no-store', keepalive: true }).catch(() => {});
};

let last = { key: '', at: 0, pos: 0, playing: null };
let down = 0;

export const undertowRpc = {
    enabled,
    relayEnabled: relayOn,
    setRelay(on) {
        try { localStorage.setItem(RELAY, on ? '1' : '0'); } catch { /* private window */ }
        if (!on) relayPost({ playing: false });
        else relayOn();
    },
    status: () => call('/status').catch(() => null),
    async toggle() {
        if (enabled()) {
            try { localStorage.setItem(KEY, '0'); } catch { /* private window */ }
            last = { key: '', at: 0, pos: 0, playing: null };
            call('/clear', {}).catch(() => {});
            return { on: false };
        }
        const st = await this.status();
        if (!st) return { on: false, missing: true, help: MAIN };
        try { localStorage.setItem(KEY, '1'); } catch { /* private window */ }
        down = 0;
        return { on: true, discord: !!st.discord?.connected };
    },
    // Call it freely: it only talks to the app when the song, play/pause or position jumped, or every 15 s while playing.
    sync(track, audio, player) {
        if ((!enabled() && !relayOn()) || !track || !audio) return;
        const playing = !audio.paused && !audio.ended;
        const pos = audio.currentTime || 0;
        const now = Date.now();
        const key = String(track.id);
        const moved = Math.abs(pos - (last.pos + (last.playing ? (now - last.at) / 1000 : 0))) > 3;
        if (key === last.key && playing === last.playing && !moved && now - last.at < 15000) return;
        last = { key, at: now, pos, playing };
        const artists = Array.isArray(track.artists) ? track.artists.map((a) => a?.name).filter(Boolean).join(', ') : track.artist?.name || '';
        const body = {
            title: track.title || '',
            artist: artists,
            album: [track.album?.title, qualityOf(track, player)].filter(Boolean).join(' · '), // the quality sits beside the album on Discord
            durationMs: Math.round((audio.duration || track.duration || 0) * 1000),
            positionMs: Math.round(pos * 1000),
            playing,
            coverUrl: coverOf(track),
            tidalId: /^\d+$/.test(String(track.id)) ? String(track.id) : '',
            source: 'monochrome',
        };
        relayPost(body);
        if (enabled() && Date.now() >= down) {
            call('/presence', body).catch(() => {
                down = Date.now() + 30000; // the app isn't running: try again in 30 s
            });
        }
    },
};

// The Discord section of Settings > Scrobbling: status, on/off, a test card, and the app to download.
export async function initRpcSettings() {
    const box = document.getElementById('rpc-settings');
    if (!box || box.dataset.ready) return;
    box.dataset.ready = '1';
    const status = document.getElementById('rpc-status');
    const toggle = document.getElementById('rpc-toggle-btn');
    const test = document.getElementById('rpc-test-btn');
    const dl = document.getElementById('rpc-downloads');
    const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

    const refresh = async () => {
        const st = await undertowRpc.status();
        const on = undertowRpc.enabled();
        toggle.textContent = on ? 'Turn off' : 'Turn on';
        toggle.disabled = !st;
        test.disabled = !st?.discord?.connected;
        status.textContent = !st
            ? 'The Undertow Presence app was not found on this computer. Download it below, start it, then press Check again. Your browser may ask to let this site reach local devices: allow it.'
            : !st.discord?.connected
              ? 'The app is running, but Discord was not found. Open the Discord desktop app.'
              : `${on ? 'On.' : 'Off.'} Connected to Discord${st.discord.user ? ` as ${st.discord.user}` : ''}. Shows what you play, with the cover, a progress bar and a button that opens the song on TIDAL.`;
    };
    toggle.onclick = async () => {
        await undertowRpc.toggle();
        await refresh();
    };
    test.onclick = async () => {
        try {
            await call('/presence', { title: 'Test card', artist: 'Undertow', album: '', durationMs: 180000, positionMs: 0, playing: true, source: 'test' });
            setTimeout(() => call('/clear', {}).catch(() => {}), 15000);
        } catch {
            status.textContent = 'Could not reach the app.';
        }
    };
    const relayBtn = document.getElementById('rpc-relay-btn');
    if (relayBtn) {
        const paint = () => { relayBtn.textContent = undertowRpc.relayEnabled() ? 'Turn off' : 'Turn on'; };
        relayBtn.onclick = () => {
            undertowRpc.setRelay(!undertowRpc.relayEnabled());
            paint();
        };
        paint();
    }
    document.getElementById('rpc-check-btn').onclick = refresh;
    refresh();
    try {
        const info = await (await fetch('/__off/rpc', { cache: 'no-store' })).json();
        const win = /Windows/i.test(navigator.userAgent);
        dl.replaceChildren();
        for (const f of [...info.files].sort((a, b) => (b.os === (win ? 'windows' : 'linux')) - (a.os === (win ? 'windows' : 'linux')))) {
            const a = document.createElement('a');
            a.className = 'btn-secondary';
            a.href = f.url;
            a.download = '';
            a.title = `${f.name} · SHA-256 ${f.sha256 || 'n/a'}`;
            a.style.cssText = 'padding:6px 12px;font-size:0.85rem;text-decoration:none';
            a.textContent = `${f.label} · ${kb(f.size)}`;
            dl.append(a);
        }
    } catch {
        dl.textContent = '';
    }
}
