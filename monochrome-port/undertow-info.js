// Undertow: what is in the file that is playing (codec, sample rate, bit depth, bit rate, channels), shown under the artist in the fullscreen player.
// The server reads the file with ffprobe and sends it in a header (X-Audio-Info); a one-byte request picks it up without waiting for the song.
let PlayerClass = null; // loaded after start-up: a plain import here makes a circle with player.js and breaks the page
const infos = new Map(); // track id -> { info, decoded }

const byUrl = new Map(); // file address -> promise of its info

// Asks the server what is in the file (it waits for the file to be ready, as the player would) and remembers it for the fullscreen line.
export function trackAudioInfo(id, url, decoded = false) {
    if (!byUrl.has(url)) {
        byUrl.set(
            url,
            fetch(url, { credentials: 'same-origin', headers: { Range: 'bytes=0-0' } })
                .then((r) => {
                    const h = r.headers.get('X-Audio-Info');
                    return h ? JSON.parse(h) : null;
                })
                .catch(() => null)
        );
        while (byUrl.size > 60) byUrl.delete(byUrl.keys().next().value);
    }
    return byUrl.get(url).then((info) => {
        if (info) {
            infos.set(String(id), { info, decoded });
            while (infos.size > 60) infos.delete(infos.keys().next().value);
        }
        return info;
    });
}

// The facts the quality badge reads (so "HD" only shows for real hi-res, not for what was asked for)
export const streamFacts = (info) =>
    info
        ? {
              codec: info.codec === 'eac3' ? 'eac3' : info.codec,
              bitDepth: info.bitDepth || undefined,
              sampleRateHz: info.sampleRate || undefined,
              bitrateKbps: info.bitrateKbps || undefined,
              lossless: ['flac', 'alac'].includes(String(info.codec).toLowerCase()) || /^pcm/i.test(info.codec || ''),
          }
        : {};

const khz = (hz) => (hz ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz` : '');
const codecName = (i) => {
    const c = String(i.codec || '').toLowerCase();
    if (c === 'eac3') return /atmos/i.test(i.profile || '') ? 'E-AC-3 JOC' : 'E-AC-3';
    return { flac: 'FLAC', aac: 'AAC', alac: 'ALAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', ac3: 'AC-3' }[c] || c.toUpperCase();
};
const channelsText = (n) => (n === 6 ? '5.1' : n === 8 ? '7.1' : n === 2 ? 'Stereo' : n === 1 ? 'Mono' : n ? `${n} ch` : '');

export function describe(entry) {
    if (!entry?.info) return '';
    const i = entry.info;
    const parts = [
        codecName(i),
        khz(i.sampleRate),
        i.bitDepth ? `${i.bitDepth}-bit` : '',
        i.bitrateKbps ? `${i.bitrateKbps.toLocaleString('en-US')} kbps` : '',
        channelsText(i.channels),
    ].filter(Boolean);
    let text = parts.join(' · ');
    if (entry.decoded) text += ' → stereo (ffmpeg.wasm)';
    return text;
}

function render() {
    const host = document.getElementById('fullscreen-track-subtext');
    if (!host) return;
    let el = document.getElementById('ul-audio-info');
    if (!el) {
        el = document.createElement('div');
        el.id = 'ul-audio-info';
        el.style.cssText = 'font-size:0.72rem;opacity:0.6;margin-top:0.2rem;letter-spacing:0.01em;font-variant-numeric:tabular-nums';
        host.append(el);
    }
    const id = PlayerClass?.instance?.currentTrack?.id;
    el.textContent = id != null ? describe(infos.get(String(id))) : '';
}

setTimeout(() => import('./player.js').then((m) => (PlayerClass = m.Player)).catch(() => {}), 3000);
setInterval(render, 1000);
