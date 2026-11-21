// Undertow: Dolby Atmos (E-AC-3) for browsers that can't play it. The server sends the Atmos file as it is; when this browser has no E-AC-3
// decoder (Chromium on Linux, Firefox), ffmpeg.wasm turns it into a FLAC with the same channels, which the browser plays and the player's
// own spatial (binaural) settings can work on. Browsers that can play E-AC-3 get the file untouched.
import { ffmpeg } from './ffmpeg.js';
import { showNotification } from './download-service.js';

const cache = new Map(); // file address -> promise of a playable address
const KEEP = 3;

export const canPlayEac3 = () => {
    try {
        return !!new Audio().canPlayType('audio/mp4; codecs="ec-3"');
    } catch {
        return false;
    }
};

export function atmosUrl(url) {
    // resolves to { url, kind: 'atmos' | 'flac' | 'aac', downmix }; 'atmos' with downmix means decoded here and mixed to stereo
    if (cache.has(url)) return cache.get(url);
    const job = (async () => {
        // what came back? A plain FLAC or AAC (the song has no Atmos mix) streams as usual; only a real E-AC-3 file needs decoding
        const head = await fetch(url, { credentials: 'same-origin', headers: { Range: 'bytes=0-16383' } });
        if (!head.ok) throw new Error(`Atmos file: ${head.status}`);
        const text = new TextDecoder('latin1').decode(await head.arrayBuffer());
        if (!/ec-3/.test(text)) return { url, kind: text.startsWith('fLaC') ? 'flac' : 'aac', downmix: false };
        if (canPlayEac3()) return { url, kind: 'atmos', downmix: false }; // this browser decodes Dolby itself
        const r = await fetch(url, { credentials: 'same-origin' });
        if (!r.ok) throw new Error(`Atmos file: ${r.status}`);
        const blob = await r.blob();
        showNotification('Decoding Dolby Atmos in your browser…');
        // Mix the 5.1 bed down to stereo ourselves (front, centre and surrounds at the usual levels, a little of the bass channel): the browser's own
        // 5.1 to stereo mix drops the bass channel and the player's spatial effect on top of it sounds wrong.
        const mix = 'pan=stereo|FL=0.5*c0+0.354*c2+0.354*c4+0.25*c3|FR=0.5*c1+0.354*c2+0.354*c5+0.25*c3';
        const encode = (args, onProgress = null) =>
            ffmpeg(blob, { args, outputName: 'output.flac', outputMime: 'audio/flac', logConsole: false, onProgress });
        const flac = ['-c:a', 'flac', '-sample_fmt', 's16', '-compression_level', '0'];
        let out;
        try {
            // Atmos mixes are mastered much quieter than stereo ones (and a mix-down is quieter still), so measure the level first and lift it to
            // about a normal master's level, never past a safe peak.
            let mean = null;
            let max = null;
            await encode(['-vn', '-af', `${mix},volumedetect`, ...flac], (p) => {
                const m = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(p?.message || '');
                const x = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(p?.message || '');
                if (m) mean = parseFloat(m[1]);
                if (x) max = parseFloat(x[1]);
            });
            let gain = 0;
            if (mean !== null && max !== null) gain = Math.max(0, Math.min(-16 - mean, -1 - max));
            out = await encode(['-vn', '-af', `${mix},volume=${gain.toFixed(2)}dB,alimiter=limit=0.97`, ...flac]);
        } catch {
            out = await encode(['-vn', '-ac', '2', ...flac]);
        }
        return { url: URL.createObjectURL(out), kind: 'atmos', downmix: true };
    })();
    cache.set(url, job);
    job.catch(() => cache.delete(url));
    while (cache.size > KEEP) {
        const old = cache.keys().next().value;
        cache.get(old)?.then((r) => r.url.startsWith('blob:') && URL.revokeObjectURL(r.url)).catch(() => {});
        cache.delete(old);
    }
    return job;
}
