// Last.fm scrobbling. The owner saves an API key and shared secret from the browser (kept on the server, never sent back out);
// each person then connects their own Last.fm account, and the server keeps only that account's name and session key.
import crypto from "node:crypto";
import { UA } from "./ua.mjs";

const API = process.env.LASTFM_API || "https://ws.audioscrobbler.com/2.0/"; // overridable so the flow can be tested against a stub
const AUTH = process.env.LASTFM_AUTH || "https://www.last.fm/api/auth/";
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");

export class LastfmError extends Error { constructor(code, message) { super(message); this.code = code; } }

async function call(cfg, method, params, post = false) {
  const p = { ...params, method, api_key: cfg.key };
  const sorted = Object.keys(p).sort().map((k) => k + p[k]).join("");
  const body = new URLSearchParams({ ...p, api_sig: md5(sorted + cfg.secret), format: "json" });
  const r = await fetch(post ? API : `${API}?${body}`, {
    method: post ? "POST" : "GET",
    headers: { "User-Agent": UA, ...(post ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: post ? body : undefined,
    signal: AbortSignal.timeout(10000),
  });
  let j = null;
  try { j = await r.json(); } catch { /* not json */ }
  if (!r.ok || j?.error) throw new LastfmError(j?.error || r.status, j?.message || `Last.fm answered ${r.status}`);
  return j;
}

// the owner's keys: checked with Last.fm before they're kept
export async function checkKeys(cfg) { await call(cfg, "auth.getToken", {}); return true; }

// connecting an account: a token, the page to approve it on, then the session key
export async function startAuth(cfg, callbackUrl) {
  const { token } = await call(cfg, "auth.getToken", {});
  if (!token) throw new LastfmError(0, "Last.fm didn't give a token");
  return { token, url: `${AUTH}?${new URLSearchParams({ api_key: cfg.key, token, cb: callbackUrl })}` };
}
export async function finishAuth(cfg, token) {
  const { session } = await call(cfg, "auth.getSession", { token });
  if (!session?.key || !session?.name) throw new LastfmError(0, "Last.fm didn't confirm the account");
  return { name: String(session.name).slice(0, 60), key: String(session.key) };
}

const clean = (s, n) => String(s ?? "").trim().slice(0, n);
export function trackParams(t) {
  const artist = clean(t.artist, 250), track = clean(t.title, 250);
  if (!artist || !track) throw new LastfmError(0, "Needs an artist and a title");
  const p = { artist, track };
  const album = clean(t.album, 250); if (album) p.album = album;
  const d = Math.round(Number(t.duration)); if (Number.isFinite(d) && d >= 30 && d <= 7200) p.duration = String(d);
  return p;
}
export const nowPlaying = (cfg, sk, t) => call(cfg, "track.updateNowPlaying", { ...trackParams(t), sk }, true);
export const scrobble = (cfg, sk, t, ts) => call(cfg, "track.scrobble", { ...trackParams(t), timestamp: String(ts), sk }, true);

// bad key, or the person took the app's access away: the account has to be connected again
export const isAuthError = (e) => e instanceof LastfmError && [4, 9, 10, 26].includes(Number(e.code));
export const love = (cfg, sk, t) => call(cfg, "track.love", { ...trackParams(t), sk }, true);
