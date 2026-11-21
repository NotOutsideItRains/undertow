// Undertow: music videos in the fullscreen player, the same idea as in Undertow's first player. Undertow finds the song's real video, saves it, and
// measures how it lines up with the song; here the picture follows the song's clock (the video's own sound stays off).
const available = (() => {
    let answer = null;
    return async () => {
        if (answer === null) {
            try {
                answer = !!(await (await fetch('/mv/available', { credentials: 'include' })).json()).available;
            } catch {
                answer = false;
            }
        }
        return answer;
    };
})();

const artistOf = (track) => {
    if (track.artist?.name) return track.artist.name;
    if (typeof track.artist === 'string') return track.artist;
    const first = track.artists?.[0];
    return typeof first === 'string' ? first : first?.name || '';
};

const KEY = 'ul-music-video';
const FILM = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>';

class UndertowVideo {
    constructor() {
        this.token = 0;
        this.showing = false;
        this.el = null;
        this.audio = null;
        this.loaded = false;
        this.off = 0;
        this.end = 0;
        this.skips = [];
        this.timer = null;
        this.abort = null;
    }

    enabled() {
        try {
            return localStorage.getItem(KEY) !== 'off';
        } catch {
            return true;
        }
    }

    async start(track, audio) {
        this.stop();
        this.track = track; // kept for the on/off switch
        this.button(false);
        if (!track || track.type === 'video' || !track.title || !audio) return;
        const my = ++this.token;
        if (!(await available()) || my !== this.token) return;
        if (!this.enabled()) {
            this.button(true); // off: leave the switch there, to turn it back on
            return;
        }

        const params = new URLSearchParams({
            id: String(track.id),
            title: track.cleanTitle || track.title,
            artist: artistOf(track),
            album: track.album?.title || '',
            duration: String(Math.round(track.duration || 0)),
        });
        this.audio = audio;
        this.abort = new AbortController();
        let sync;
        try {
            for (let attempt = 0; attempt < 3 && !sync; attempt++) {
                const response = await fetch(`/mv/sync?${params}`, { credentials: 'include', signal: this.abort.signal });
                if (response.status === 429 && attempt < 2) {
                    await new Promise((ok) => setTimeout(ok, 8000)); // asked a lot just now: wait a moment and ask again
                    if (my !== this.token) return;
                    continue;
                }
                if (!response.ok) return;
                sync = await response.json();
            }
        } catch {
            return; // stopped, or nothing found
        }
        if (!sync) return;
        if (my !== this.token || !sync.video) return;
        this.button(true); // this song has a video
        this.off = sync.ok ? sync.offset : 0; // not sure enough? start with the song
        this.end = sync.end || 0; // where the music ends inside the video, when known
        this.skips = sync.skips || []; // spoken parts in the middle, which the picture jumps over

        const card = document.getElementById('fullscreen-artwork-card');
        if (!card) return;
        const el = document.createElement('video');
        el.id = 'ul-music-video';
        el.muted = true;
        el.playsInline = true;
        el.preload = 'auto';
        // in the cover's place: the card keeps its width and takes the video's own shape, so nothing is cropped
        el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;z-index:3;display:block';
        el.addEventListener('loadeddata', () => {
            if (my !== this.token) return;
            this.loaded = true;
            this.place(true);
        });
        el.addEventListener('error', () => {
            if (my === this.token) this.hide();
        });
        el.src = `/mv/file?${params}`;
        this.el = el;
        card.style.position = card.style.position || 'relative';
        card.append(el);
        clearInterval(this.timer);
        this.timer = setInterval(() => this.place(), 120);
    }

    // The picture's place is the song's time plus the offset measured by the server; small drifts are smoothed by running a touch faster or
    // slower, big ones by jumping.
    place(jump = false) {
        const el = this.el;
        const audio = this.audio;
        if (!el || !audio || !this.loaded || !el.duration) return;
        let target = audio.currentTime + this.off;
        for (const [a, b] of this.skips) if (target >= a) target += b - a;
        if (target < 0) {
            // the video starts after the song does: wait on its first frame
            if (!el.paused) el.pause();
            if (el.currentTime > 0.05) el.currentTime = 0;
            el.playbackRate = 1;
            return;
        }
        if (target > el.duration || (this.end && target > this.end)) {
            el.pause(); // the video (or its music) ended before the song did: back to the cover
            this.hide();
            return;
        }
        this.show();
        const drift = el.currentTime - target; // positive: the video is ahead
        if (jump || Math.abs(drift) > 0.25) el.currentTime = target;
        el.playbackRate = Math.abs(drift) > 0.04 && Math.abs(drift) <= 0.25 ? (drift > 0 ? 0.96 : 1.04) * audio.playbackRate : audio.playbackRate;
        if (!audio.paused && el.paused) el.play().catch(() => {});
        if (audio.paused && !el.paused) el.pause();
    }

    show() {
        if (this.showing) return;
        this.showing = true;
        this.layout(true);
    }

    hide() {
        if (!this.showing) return;
        this.showing = false;
        this.layout(false);
    }

    layout(on) {
        const overlay = document.getElementById('fullscreen-cover-overlay');
        const card = document.getElementById('fullscreen-artwork-card');
        const image = document.getElementById('fullscreen-cover-image');
        const ring = document.getElementById('cd-ring');
        if (!overlay || !card) return;
        overlay.classList.toggle('ul-music-video-on', on);
        if (image) image.style.display = on ? 'none' : 'block';
        if (ring) ring.style.display = on ? 'none' : '';
        if (on && this.el?.videoWidth && this.el?.videoHeight) card.style.aspectRatio = `${this.el.videoWidth} / ${this.el.videoHeight}`;
        else card.style.removeProperty('aspect-ratio');
    }

    stop() {
        this.token++;
        clearInterval(this.timer);
        this.timer = null;
        if (this.abort) this.abort.abort();
        this.abort = null;
        if (this.el) {
            this.el.pause();
            this.el.removeAttribute('src');
            this.el.load();
            this.el.remove();
        }
        this.el = null;
        this.loaded = false;
        this.hide();
        this.audio = null;
    }

    // a small switch among the fullscreen buttons, to turn the picture off and on
    button(show) {
        // the "hide the interface" eye button sits after the buttons in this row; with one more button, it moves one place along
        document.getElementById('fullscreen-cover-overlay')?.classList.toggle('ul-video-btn', !!show);
        let btn = document.getElementById('ul-video-toggle');
        const bar = document.querySelector('.fullscreen-top-actions');
        if (!btn && bar && show) {
            btn = document.createElement('button');
            btn.id = 'ul-video-toggle';
            btn.innerHTML = FILM;
            btn.addEventListener('click', () => {
                try {
                    localStorage.setItem(KEY, this.enabled() ? 'off' : 'on');
                } catch {
                    /* not saved */
                }
                this.sync(btn);
                if (this.enabled() && this.track && this.audioEl()) this.start(this.track, this.audioEl());
                else this.stop();
            });
            bar.insertBefore(btn, bar.firstChild);
        }
        if (btn) {
            btn.style.display = show ? '' : 'none';
            this.sync(btn);
        }
    }

    audioEl() {
        return [...document.querySelectorAll('audio')].find((a) => !a.paused) || document.getElementById('audio-player');
    }

    sync(btn) {
        const on = this.enabled();
        btn.title = on ? 'Turn music video off' : 'Turn music video on';
        btn.setAttribute('aria-label', btn.title);
        btn.classList.toggle('active', on);
    }
}

export const undertowVideo = new UndertowVideo();
