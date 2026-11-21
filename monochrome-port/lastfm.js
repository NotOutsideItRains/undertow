//js/lastfm.js
// Undertow: Last.fm goes through the server. Undertow holds the API keys and each person's Last.fm connection, so nothing secret lives in this page,
// a song counts once it has really been listened to (not just once a timer ran out), and a song that can't be sent is retried by the server.
import { lastFMStorage } from './storage.js';

const API = '/__off/lastfm';
const post = async (path, body = {}) => {
    const response = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ui' },
        credentials: 'include',
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Last.fm: ${response.status}`);
    return data;
};

export class LastFMScrobbler {
    constructor() {
        this.sessionKey = null; // kept so the settings page can ask "is anyone connected"
        this.username = null;
        this.configured = false;
        this.current = null; // the song being listened to: { track, ts, heard, last, sent }

        this.refreshStatus();
        // The audio elements don't bubble their events, but a capture listener on the document still sees all of them.
        document.addEventListener('timeupdate', (e) => this.onTime(e.target), true);
        document.addEventListener('ended', (e) => this.onTime(e.target, true), true);
        document.addEventListener('pause', () => {
            if (this.current) this.current.last = null;
        }, true);
    }

    async refreshStatus() {
        try {
            const response = await fetch(API, { credentials: 'include' });
            const data = await response.json();
            this.configured = !!data.configured;
            this.sessionKey = data.connected ? 'undertow' : null;
            this.username = data.name || null;
        } catch {
            /* offline: try again later */
        }
    }

    // nothing to load or reload: there are no keys or sessions in this page
    loadCredentials() {}
    reloadCredentials() {}
    loadSession() {}

    isAuthenticated() {
        return !!this.sessionKey && lastFMStorage.isEnabled();
    }

    _getScrobbleArtist(track) {
        if (!track) return 'Unknown Artist';
        let artistName = 'Unknown Artist';
        if (track.artist?.name) artistName = track.artist.name;
        else if (typeof track.artist === 'string') artistName = track.artist;
        else if (track.artists && track.artists.length > 0) {
            const first = track.artists[0]; // only the main artist
            artistName = typeof first === 'string' ? first : first.name || 'Unknown Artist';
        }
        return typeof artistName === 'string' && artistName ? artistName : 'Unknown Artist';
    }

    _payload(track) {
        return {
            title: track.cleanTitle || track.title,
            artist: this._getScrobbleArtist(track),
            album: track.album?.title || '',
            duration: Math.floor(track.duration || 0),
        };
    }

    // ---- connecting: the person approves a token on Last.fm, then this page asks the server to finish ----
    async getAuthUrl() {
        if (!this.configured) await this.refreshStatus();
        return post('/start'); // { token, url }
    }

    async completeAuthentication(token) {
        const result = await post('/complete', { token });
        if (!result.success) throw new Error('Not approved yet'); // the settings page keeps asking
        this.sessionKey = 'undertow';
        this.username = result.name;
        return { success: true, username: result.name };
    }

    async authenticateWithCredentials() {
        throw new Error('Connect through Last.fm\'s own page here; passwords are never typed into this player.');
    }

    // ---- listening ----
    async updateNowPlaying(track) {
        if (!this.isAuthenticated() || !track) return;
        const now = Math.floor(Date.now() / 1000);
        const cur = this.current;
        if (cur && String(cur.track.id) === String(track.id)) {
            // The page announces a song every time it (re)starts playing, including after a pause: that is the same listen, not a new one.
            if (!cur.sent) return;
            const playing = [...document.querySelectorAll('audio')].find((a) => !a.paused);
            if (!playing || playing.currentTime > 5) return; // already counted; only a repeat from the top starts a new listen
        }
        this.current = { track, ts: now, heard: 0, last: null, sent: false };
        try {
            await post('/send', { kind: 'now', ...this._payload(track) });
        } catch (error) {
            console.error('Failed to update now playing:', error);
        }
    }

    async onTrackChange(track) {
        await this.updateNowPlaying(track);
    }

    onPlaybackStop() {
        if (this.current) this.current.last = null;
    }

    onTime(el, ended = false) {
        const cur = this.current;
        if (!cur || cur.sent || !el || el.tagName !== 'AUDIO') return;
        if (el.paused && !ended) {
            cur.last = null;
            return;
        }
        const t = el.currentTime;
        const dt = cur.last == null ? 0 : t - cur.last;
        cur.last = t;
        if (dt > 0 && dt < 2.5) cur.heard += dt; // seeking and skipping don't count as listening
        const duration = cur.track.duration || el.duration || 0;
        if (duration < 30) return; // Last.fm doesn't take songs under 30 seconds
        const need = Math.min(duration * (lastFMStorage.getScrobblePercentage() / 100), 240);
        if (cur.heard >= need) this.scrobble(cur);
    }

    async scrobble(cur) {
        if (cur.sent) return;
        cur.sent = true;
        try {
            const result = await post('/send', { kind: 'scrobble', ts: cur.ts, ...this._payload(cur.track) });
            if (result.disconnected) {
                this.sessionKey = null;
                this.username = null;
            }
        } catch (error) {
            cur.sent = false; // the next tick tries again
            console.error('Failed to scrobble:', error);
        }
    }

    async loveTrack(track) {
        if (!this.isAuthenticated() || !track) return;
        try {
            await post('/send', { kind: 'love', ...this._payload(track) });
        } catch (error) {
            console.error('Failed to love track on Last.fm:', error);
        }
    }

    async disconnect() {
        this.sessionKey = null;
        this.username = null;
        this.current = null;
        try {
            await post('/disconnect');
        } catch (error) {
            console.error('Last.fm disconnect failed:', error);
        }
    }
}
