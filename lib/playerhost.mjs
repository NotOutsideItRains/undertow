// The second player lives on its own address (player.<your domain>). It is Monochrome's web app, pointed at a small hifi-api style gateway that
// answers from Undertow's own TIDAL accounts, and it sits behind Undertow's logins: the same usernames and passwords, the same roles, and the same
// "members can use the player" switch. Nothing else of Undertow is reachable from that address.
import fs from "node:fs";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import { push as relayPush } from "./rpcrelay.mjs";
import { fileURLToPath } from "node:url";
import { db, save, httpError, findUser, checkPw, createSession, sessionUser, destroySession } from "./store.mjs";
import { serveFile, sendBody } from "./compress.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web-mono");
const ICON = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "icon.svg");
const HOSTS = (process.env.PLAYER_HOST || "otter-player.outsideitrains.com").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8", ".map": "application/json" };

export const userOf = (req) => { const me = sessionUser(cookies(req).sid); return allowed(me) ? me : null; }; // for the party socket, which has its own upgrade path
export const originOk = (req) => { try { return new URL(String(req.headers.origin || "")).hostname.toLowerCase() === hostOf(req); } catch { return false; } };
export const hostOf = (req) => String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
export const isPlayerHost = (req) => HOSTS.includes(hostOf(req));

const cookies = (req) => Object.fromEntries(String(req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), c.slice(i + 1)]; }));
const secure = (req) => req.headers["x-forwarded-proto"] === "https" || req.headers["cf-visitor"]?.includes("https");
const cookie = (req, token, maxAge) => `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure(req) ? "; Secure" : ""}`;
const HEAD = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
const send = (res, status, body, type, extra = {}) => sendBody(res, status, body, { "Content-Type": type, "Cache-Control": "no-store", ...HEAD, ...extra });
const SW_JS = "// Undertow: makes the player installable and nothing more. It caches nothing.\nself.addEventListener('install', () => self.skipWaiting());\nself.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));\nself.addEventListener('fetch', () => {});\n";
const json = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), "application/json; charset=utf-8", extra);

const allowed = (u) => u && !u.disabled && (u.role === "admin" || db.settings.membersUsePlayer !== false);

// ---- bad passwords: 8 per address per 10 minutes, like the main login ----
const fails = new Map();
const tooMany = (ip) => { const f = fails.get(ip); return f && f.until > Date.now() && f.n >= 8; };
const failed = (ip) => { const f = fails.get(ip); fails.set(ip, f && f.until > Date.now() ? { n: f.n + 1, until: f.until } : { n: 1, until: Date.now() + 600000 }); };
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (v.until < now) fails.delete(k); }, 600000).unref();

// ---- the gateway: only the song-lookup routes, only for people who may use the player ----
const GATEWAY = /^\/hifi\/(search|track|trackManifests|info|album|artist|playlist|mix|video|lyrics|recommendations)(\/(similar|bio))?\/?$/;
const used = new Map(); // user id -> [window start, count]
function rate(bucket, userId, max = 300, ms = 60000) { // each kind of request has its own count per person: browsing covers must not use up the music-video allowance
  const key = `${bucket}|${userId}`, now = Date.now(), r = used.get(key);
  if (!r || now - r[0] > ms) { used.set(key, [now, 1]); return; }
  if (++r[1] > max) throw httpError(429, "Slow down a little");
}

// ---- songs on Subsonic servers, shown beside TIDAL's ----
// Their ids in this player are "sub_<server>_<song, base64url>": plain letters and digits, so nothing in the app mistakes them for a URL or a provider prefix.
const subPid = (sid, song) => `sub_${sid}_${Buffer.from(String(song)).toString("base64url")}`;
const subParse = (pid) => { const m = /^sub_([a-f0-9]+)_([A-Za-z0-9_-]+)$/.exec(String(pid || "")); return m && { sid: m[1], song: Buffer.from(m[2], "base64url").toString() }; };
const SUB_COVER_SIZES = [160, 320, 640, 1280];
const originOf = (req) => `${secure(req) ? "https" : "http"}://${String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim()}`;
// a Subsonic song, in the shape TIDAL's own track objects have, which is what the app reads
function subTrack(req, row, id = subPid(...Object.values(subParseId(row.id)))) {
  const cover = row.coverArt ? `${originOf(req)}/cover/${subParseId(row.id).sid}/${encodeURIComponent(row.coverArt)}?size=640` : null;
  const lossless = row.audioQuality === "LOSSLESS";
  return {
    id, title: row.title, duration: Math.round(Number(row.duration) || 0), trackNumber: 0, volumeNumber: 1, explicit: false, version: null, popularity: 0,
    allowStreaming: true, streamReady: true, premiumStreamingOnly: false, url: "", isrc: null, copyright: "", editable: false,
    audioQuality: lossless ? "LOSSLESS" : "HIGH", audioModes: ["STEREO"], mediaMetadata: { tags: lossless ? ["LOSSLESS"] : [] },
    artist: { id: 0, name: row.artist || "Unknown artist", type: "MAIN", picture: null }, artists: [{ id: 0, name: row.artist || "Unknown artist", type: "MAIN", picture: null }],
    album: { id: 0, title: row.album || "", cover, vibrantColor: null, videoCover: null },
    source: row.source || "Subsonic",
  };
}
const subParseId = (id) => { const m = /^sub:([a-f0-9]+):(.+)$/.exec(String(id)); return m && { sid: m[1], song: m[2] }; };
const norm = (x) => String(x || "").toLowerCase().replace(/\(.*?\)|\[.*?\]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// TIDAL's search returns something even for loose matches, so a Subsonic song that matches every word goes first; the rest follow TIDAL's list.
function mergeSongs(tidal, sub, text) {
  const have = new Set(tidal.map((t) => `${norm(t.title)}|${norm(t.artist?.name || t.artists?.[0]?.name).split(" ")[0]}`)), words = norm(text).split(" ").filter(Boolean), strong = [], rest = [];
  for (const t of sub) {
    if (have.has(`${norm(t.title)}|${norm(t.artist.name).split(" ")[0]}`)) continue;
    const hay = norm(`${t.title} ${t.artist.name} ${t.album.title}`);
    (words.length && words.every((w) => hay.includes(w)) ? strong : rest).push(t);
  }
  return [...strong, ...tidal, ...rest];
}

async function gateway(req, res, u, me, ctx) {
  const hifi = ctx.hifi;
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "GET only" }, { Allow: "GET, HEAD" });
  const m = u.pathname.match(GATEWAY);
  if (!m) return json(res, 404, { error: "Not found" });
  rate("hifi", me.id);
  const params = {};
  let n = 0;
  for (const [k, v] of u.searchParams) {
    if (++n > 16 || k.length > 32 || v.length > 400) return json(res, 400, { error: "Bad request" });
    (params[k] ||= []).push(v);
  }
  const upstream = u.pathname.slice("/hifi".length).replace(/\/?$/, "/");
  const sub = upstream === "/info/" ? subParse(u.searchParams.get("id")) : null;
  if (sub) { // one Subsonic song's details
    try {
      const { server, song } = await ctx.subSong(sub.sid, sub.song);
      const row = { id: `sub:${sub.sid}:${sub.song}`, title: song.title, artist: song.artist || song.displayArtist, album: song.album, duration: song.duration, source: server?.label, coverArt: song.coverArt ? String(song.coverArt) : null,
        audioQuality: ["flac", "wav", "alac", "ape", "wv"].includes(String(song.suffix || "").toLowerCase()) ? "LOSSLESS" : "HIGH" };
      return json(res, 200, { version: "2.10", data: subTrack(req, row, u.searchParams.get("id")) }, { "Cache-Control": "private, max-age=120" });
    } catch (e) { return json(res, e.status === 404 ? 404 : 502, { error: "Not found" }); }
  }
  if (upstream === "/search/" && params.s?.[0] && ctx.subSearch) { // TIDAL's song search, with the Subsonic servers' matches beside it
    const text = params.s[0];
    const [tidal, rows] = await Promise.all([hifi(upstream, params, "search").catch((e) => ({ error: e })), ctx.subSearch(text, 12).catch(() => [])]);
    const subs = rows.filter((r) => subParseId(r.id)).map((r) => subTrack(req, r));
    if (tidal.error && !subs.length) { const e = tidal.error; return json(res, e.status === 404 ? 404 : e.status === 429 ? 429 : e.status === 503 ? 503 : 502, { error: e.status === 503 ? "No TIDAL account is available" : "The music service didn't answer" }); }
    const data = tidal.error ? { limit: 25, offset: 0, totalNumberOfItems: 0, items: [] } : tidal.data || { limit: 25, offset: 0, totalNumberOfItems: 0, items: [] };
    const merged = { ...tidal, version: tidal.version || "2.10", data: { ...data, items: mergeSongs(data.items || [], subs, text), totalNumberOfItems: (data.totalNumberOfItems || 0) + subs.length } };
    return json(res, 200, merged, { "Cache-Control": "private, max-age=120" });
  }
  try {
    const kind = /^\/(track|trackManifests)\//.test(upstream) ? "stream" : "search";
    const data = await hifi(upstream, params, kind);
    return json(res, 200, data, { "Cache-Control": kind === "stream" ? "no-store" : "private, max-age=120" });
  } catch (e) {
    if (e.status === 404) return json(res, 404, { error: "Not found" });
    if (e.status === 429) return json(res, 429, { error: "Busy, try again" }, { "Retry-After": String(e.retryAfter || 2) });
    return json(res, e.status === 503 ? 503 : 502, { error: e.status === 503 ? "No TIDAL account is available" : "The music service didn't answer" });
  }
}

// ---- the sign-in page ----
const loginPage = (next, name) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#061820"><title>${name} player</title><link rel="icon" href="/__icon.svg">
<style>
:root{color-scheme:dark light;--bg:#061820;--s:#0c2530;--t:#e4f3ee;--t2:rgba(228,243,238,.7);--h:rgba(160,225,210,.16);--a:#ffb02e;--ink:#1a1203;--bad:#ff5a5f}
@media(prefers-color-scheme:light){:root{--bg:#dce9e5;--s:#f2f8f5;--t:#0b2229;--t2:rgba(11,34,41,.72);--h:rgba(11,34,41,.16);--a:#b25a00;--ink:#fff;--bad:#c62828}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--t);font:400 .9375rem/1.45 "Avenir Next","Segoe UI",system-ui,sans-serif}
main{width:min(380px,100%);background:var(--s);box-shadow:0 0 0 1px var(--h);border-radius:12px;padding:24px;display:grid;gap:16px}
img{width:40px;height:40px;border-radius:8px}h1{margin:0;font-size:1.35rem;line-height:1.2}p{margin:0;color:var(--t2)}
label{display:grid;gap:6px;font-size:.8rem;font-weight:600;color:var(--t2)}
input{font:inherit;font-size:16px;color:var(--t);min-height:44px;padding:0 14px;border:0;border-radius:8px;background:transparent;box-shadow:inset 0 0 0 1px var(--h);outline:none}
input:focus-visible{box-shadow:inset 0 0 0 1px var(--a),0 0 0 3px color-mix(in oklab,var(--a) 28%,transparent)}
button{font:inherit;font-weight:600;min-height:44px;border:0;border-radius:8px;background:var(--a);color:var(--ink);cursor:pointer}button[disabled]{opacity:.5}
.err{color:var(--bad);min-height:1.3em;font-size:.88rem}hr{border:0;border-top:1px solid var(--h);margin:0;width:100%}
.alt{display:grid;place-items:center;min-height:44px;border-radius:8px;box-shadow:inset 0 0 0 1px var(--h);color:var(--t);text-decoration:none;font-weight:600}.alt:focus-visible,.alt:hover{box-shadow:inset 0 0 0 1px var(--a)}
</style></head><body><main><img src="/__icon.svg" alt="" width="40" height="40"><div><h1>Sign in to play</h1><p>Use your ${name} username and password.</p></div>
<form id="f" style="display:grid;gap:16px" autocomplete="on"><label>Username<input name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label><div class="err" role="alert" id="e"></div><button>Sign in</button></form>
<hr><a class="alt" href="/__signin?next=${encodeURIComponent(next)}">Sign in with ${name} (Discord)</a></main>
<script>
const f=document.getElementById("f"),e=document.getElementById("e"),next=${JSON.stringify(next)};
if(new URLSearchParams(location.search).get("problem"))e.textContent="That sign-in didn't complete. Try again.";
f.addEventListener("submit",async(ev)=>{ev.preventDefault();e.textContent="";const b=f.querySelector("button");b.disabled=true;
try{const r=await fetch("/__login",{method:"POST",headers:{"content-type":"application/json","x-requested-with":"ui"},body:JSON.stringify({username:f.username.value,password:f.password.value})});
const j=await r.json().catch(()=>({}));if(r.ok){location.replace(next)}else{e.textContent=j.error||"Couldn't sign in"}}catch{e.textContent="Couldn't reach the server"}b.disabled=false});
</script></body></html>`;

const safeNext = (n) => (typeof n === "string" && /^\/(?!\/)[^\s\\]*$/.test(n) && !n.startsWith("/__") ? n : "/");

async function readJson(req) {
  let body = "";
  for await (const c of req) { body += c; if (body.length > 4096) throw httpError(413, "Too much data"); }
  try { return JSON.parse(body || "{}"); } catch { throw httpError(400, "Send JSON"); }
}

async function serveStatic(req, res, u) {
  let rel = decodeURIComponent(u.pathname);
  if (rel.includes("\0") || rel.split("/").includes("..")) return send(res, 400, "Bad request", "text/plain");
  let file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) return send(res, 400, "Bad request", "text/plain");
  let st = await fs.promises.stat(file).catch(() => null);
  if (st?.isDirectory()) { file = path.join(file, "index.html"); st = await fs.promises.stat(file).catch(() => null); }
  if (!st) { // a route of the single-page app: it has no extension; a missing file with one is a real 404
    if (path.extname(rel)) return send(res, 404, "Not found", "text/plain");
    file = path.join(ROOT, "index.html"); st = await fs.promises.stat(file).catch(() => null);
    if (!st) return send(res, 503, "The player isn't installed on this server yet", "text/plain");
  }
  const ext = path.extname(file).toLowerCase(), hashed = /\/assets\/.+-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/.test(file);
  // a file whose name carries its hash never changes; fonts and pictures with a plain name change rarely; everything else (the page, the scripts) is checked with an ETag each time
  const cache = hashed ? "public, max-age=31536000, immutable" : /^\.(woff2?|ttf)$/.test(ext) ? "public, max-age=604800" : /^\.(png|jpe?g|webp|gif|svg|ico)$/.test(ext) ? "public, max-age=86400" : "no-cache";
  return await serveFile(req, res, file, st, { type: MIME[ext] || "application/octet-stream", cache, headers: HEAD });
}

// ---- the account button and library sync (what Monochrome keeps on its own servers, kept here instead, per Undertow user) ----
const sessionOf = (me, req) => ({
  session: { id: `ut_${me.id}`, userId: me.id, token: "undertow", expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  user: { id: me.id, name: me.displayName, email: `${me.username}@undertow`, emailVerified: true, image: me.avatar ? `${originOf(req)}/avatar/${me.id}.jpg?v=${me.avatar}` : null, createdAt: new Date(me.createdAt || Date.now()).toISOString(), updatedAt: new Date().toISOString() },
});
const clipText = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const SYNC_MAX = 4_000_000;
async function bodyOf(req, max) {
  let body = "", n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw httpError(413, "That's too much to sync"); body += c; }
  try { return JSON.parse(body || "{}"); } catch { throw httpError(400, "Send JSON"); }
}
async function syncRoute(req, res, me) {
  const store = ((db.monoSync ||= {})[me.id] ||= { library: {}, history: [], userPlaylists: {}, userFolders: {} });
  const view = () => ({ library: store.library, history: store.history, userPlaylists: store.userPlaylists, userFolders: store.userFolders });
  if (req.method === "GET") return json(res, 200, { appUserId: me.id, profile: { username: me.username, display_name: me.displayName, avatar_url: me.avatar ? `${originOf(req)}/avatar/${me.id}.jpg?v=${me.avatar}` : null, privacy: { playlists: "private", lastfm: "private" }, favorite_albums: [] }, ...view() });
  if (req.method !== "PATCH") return json(res, 405, { error: "Not allowed" }, { Allow: "GET, PATCH" });
  const origin = req.headers.origin; // only this site's own pages may change what's saved
  if (origin) { try { if (new URL(origin).hostname.toLowerCase() !== hostOf(req)) throw 0; } catch { return json(res, 403, { error: "Not allowed" }); } }
  const b = await bodyOf(req, SYNC_MAX);
  const next = { ...store };
  if (b.library !== undefined) { if (!b.library || typeof b.library !== "object" || Array.isArray(b.library)) throw httpError(400, "Bad library"); next.library = b.library; }
  if (b.history !== undefined) { if (!Array.isArray(b.history)) throw httpError(400, "Bad history"); next.history = b.history.slice(-5000); }
  for (const k of ["userPlaylists", "userFolders"]) if (b[k] !== undefined) { if (!b[k] || typeof b[k] !== "object" || Array.isArray(b[k])) throw httpError(400, "Bad " + k); next[k] = b[k]; }
  if (JSON.stringify(next).length > SYNC_MAX) throw httpError(413, "Your library is too big to sync");
  Object.assign(store, next);
  save();
  return json(res, 200, view());
}

// ---- signing in through the main site (so Discord login, which lives there, works for the player too) ----
// The player starts a handoff and remembers it in a cookie of its own; the main site, once it knows who you are, sends THIS browser back with a one-time code;
// the player only accepts that code from the browser holding the cookie. A link someone else made up can't sign anybody in, because the code only ever travels
// in the browser that approved it, and that one doesn't hold the other person's cookie.
const MAIN = (process.env.MAIN_URL || process.env.PUBLIC_URL || "https://quiet-otter.outsideitrains.com").replace(/\/+$/, "");
const handoffs = new Map(); // id -> { host, next, exp, code?, userId? }
const sweep = () => { const now = Date.now(); for (const [k, v] of handoffs) if (v.exp < now) handoffs.delete(k); };
setInterval(sweep, 120000).unref();
const HID = /^[a-f0-9]{32}$/;

// the main site, asked who this handoff is for: returns where to send the browser next
export function handoffApprove(id, user) {
  sweep();
  const h = HID.test(String(id)) ? handoffs.get(id) : null;
  if (!h || h.code) return null;
  if (!allowed(user)) return { error: "The player is turned off for members" };
  h.code = crypto.randomBytes(24).toString("hex");
  h.userId = user.id;
  h.exp = Date.now() + 120000; // two minutes to arrive
  return { url: `${h.https ? "https" : "http"}://${h.host}/__sso?id=${id}&code=${h.code}` };
}
export const handoffKnown = (id) => { sweep(); return HID.test(String(id)) && handoffs.has(id) && !handoffs.get(id).code; };

export const mainSigninPage = (id, discord, name) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#061820"><title>Sign in to the player</title><link rel="icon" href="/icon.svg?v=3">
<style>
:root{color-scheme:dark light;--bg:#061820;--s:#0c2530;--t:#e4f3ee;--t2:rgba(228,243,238,.7);--h:rgba(160,225,210,.16);--a:#ffb02e;--ink:#1a1203;--d:#5865f2;--bad:#ff5a5f}
@media(prefers-color-scheme:light){:root{--bg:#dce9e5;--s:#f2f8f5;--t:#0b2229;--t2:rgba(11,34,41,.72);--h:rgba(11,34,41,.16);--a:#b25a00;--ink:#fff;--bad:#c62828}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--t);font:400 .9375rem/1.45 "Avenir Next","Segoe UI",system-ui,sans-serif}
main{width:min(380px,100%);background:var(--s);box-shadow:0 0 0 1px var(--h);border-radius:12px;padding:24px;display:grid;gap:16px}
h1{margin:0;font-size:1.3rem;line-height:1.2}p{margin:0;color:var(--t2)}label{display:grid;gap:6px;font-size:.8rem;font-weight:600;color:var(--t2)}
input{font:inherit;font-size:16px;color:var(--t);min-height:44px;padding:0 14px;border:0;border-radius:8px;background:transparent;box-shadow:inset 0 0 0 1px var(--h);outline:none}
input:focus-visible{box-shadow:inset 0 0 0 1px var(--a),0 0 0 3px color-mix(in oklab,var(--a) 28%,transparent)}
button{font:inherit;font-weight:600;min-height:44px;border:0;border-radius:8px;cursor:pointer}button[disabled]{opacity:.5}
.dc{background:var(--d);color:#fff}.go{background:var(--a);color:var(--ink)}.err{color:var(--bad);min-height:1.3em;font-size:.88rem}hr{border:0;border-top:1px solid var(--h);margin:0;width:100%}
</style></head><body><main><div><h1>Sign in to the player</h1><p>The player is asking who you are. Sign in to ${name} here and you'll go straight back.</p></div>
${discord ? `<button class="dc" id="dc">Sign in with Discord</button><hr>` : ""}
<form id="f" style="display:grid;gap:16px"><label>Username<input name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label><div class="err" role="alert" id="e"></div><button class="go">Sign in</button></form></main>
<script>
const H={"content-type":"application/json","x-requested-with":"ui"},e=document.getElementById("e"),id=${JSON.stringify(id)};
const post=async(u,b)=>{const r=await fetch(u,{method:"POST",headers:H,body:JSON.stringify(b)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||"Couldn't sign in");return j};
document.getElementById("f").addEventListener("submit",async(ev)=>{ev.preventDefault();e.textContent="";const f=ev.target;try{await post("/api/login",{username:f.username.value,password:f.password.value});location.reload()}catch(x){e.textContent=x.message}});
document.getElementById("dc")?.addEventListener("click",async(ev)=>{ev.target.disabled=true;try{const j=await post("/api/discord/start",{mode:"login",next:"/player-signin?id="+id});location.href=j.url}catch(x){e.textContent=x.message;ev.target.disabled=false}});
</script></body></html>`;

// `ctx`: { ip, hifi(path, params, kind) -> the answer of one of Undertow's TIDAL accounts, with failover, appName }
export async function handle(req, res, u, ctx) {
  const p = u.pathname;
  try {
    if (p === "/__icon.svg") return send(res, 200, await fs.promises.readFile(ICON), "image/svg+xml", { "Cache-Control": "public, max-age=3600" });
    if (p === "/__login" && req.method === "POST") {
      if (req.headers["x-requested-with"] !== "ui") throw httpError(403, "Not allowed");
      if (tooMany(ctx.ip)) throw httpError(429, "Too many attempts. Try again in a few minutes.");
      const b = await readJson(req);
      const user = findUser(b.username || "");
      const ok = await checkPw(String(b.password || ""), user?.passHash);
      if (!user || !ok || user.disabled) { failed(ctx.ip); throw httpError(401, user?.disabled && ok ? "This account is disabled" : "Wrong username or password"); }
      if (!allowed(user)) throw httpError(403, "The player is turned off for members");
      user.lastLogin = Date.now(); save();
      return json(res, 200, { ok: true }, { "Set-Cookie": cookie(req, createSession(user.id, req.headers["user-agent"], ctx.ip), 2592000) });
    }
    if (p === "/login") return send(res, 302, "", "text/plain", { Location: "/__login" });
    if (p === "/__signin" && req.method === "GET") { // start: remember this browser, and send it to the main site to say who it is
      sweep();
      if (handoffs.size > 500) throw httpError(429, "Try again in a minute");
      const id = crypto.randomBytes(16).toString("hex");
      handoffs.set(id, { host: String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim(), https: secure(req), next: safeNext(u.searchParams.get("next")), exp: Date.now() + 600000 });
      return send(res, 302, "", "text/plain", { Location: `${MAIN}/player-signin?id=${id}`, "Set-Cookie": `ps_id=${id}; HttpOnly; SameSite=Lax; Path=/__sso; Max-Age=600${secure(req) ? "; Secure" : ""}` });
    }
    if (p === "/__sso" && req.method === "GET") { // finish: only the browser that started it, carrying the code the main site made for it
      const id = String(u.searchParams.get("id") || ""), code = String(u.searchParams.get("code") || ""), h = HID.test(id) ? handoffs.get(id) : null;
      handoffs.delete(id); // one try, whatever happens
      const clear = `ps_id=; HttpOnly; SameSite=Lax; Path=/__sso; Max-Age=0${secure(req) ? "; Secure" : ""}`;
      const ok = h && h.code && h.exp > Date.now() && cookies(req).ps_id === id && code.length === h.code.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(h.code));
      const user = ok ? db.users[h.userId] : null;
      if (!ok || !allowed(user)) return send(res, 302, "", "text/plain", { Location: "/__login?problem=1", "Set-Cookie": clear });
      user.lastLogin = Date.now(); save();
      return send(res, 302, "", "text/plain", { Location: h.next, "Set-Cookie": [clear, cookie(req, createSession(user.id, req.headers["user-agent"], ctx.ip), 2592000)] });
    }
    if (p === "/__logout") { destroySession(cookies(req).sid); return send(res, 302, "", "text/plain", { Location: "/__login", "Set-Cookie": cookie(req, "", 0) }); }
    // Installing the player as an app (PWA): the browser asks for the manifest and the icons before anyone is signed in, so those are public (they are the
    // same files for everyone). The service worker caches nothing: it only makes the page installable, and every request still goes to this server.
    if ((req.method === "GET" || req.method === "HEAD") && /^\/(manifest\.json|assets\/icons\/icon-\d+\.webp)$/.test(p)) return await serveStatic(req, res, u);
    if (p === "/__sw.js" && (req.method === "GET" || req.method === "HEAD")) return send(res, 200, SW_JS, "text/javascript; charset=utf-8", { "Service-Worker-Allowed": "/", "Cache-Control": "no-cache" });
    const me = sessionUser(cookies(req).sid);
    if (p === "/__login") {
      if (allowed(me)) return send(res, 302, "", "text/plain", { Location: safeNext(u.searchParams.get("next")) });
      return send(res, 200, loginPage(safeNext(u.searchParams.get("next")), ctx.appName), "text/html; charset=utf-8");
    }
    if (!allowed(me)) {
      if (p.startsWith("/hifi/")) return json(res, 401, { error: "Sign in first" });
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 401, { error: "Sign in first" });
      return send(res, 302, "", "text/plain", { Location: `/__login?next=${encodeURIComponent(p + u.search)}` });
    }
    if (p.startsWith("/hifi/")) return await gateway(req, res, u, me, ctx);
    const au = p.match(/^\/audio\/(\d{1,12}|sub_[a-f0-9]+_[A-Za-z0-9_-]+)$/); // the song itself, from this server: TIDAL's audio servers don't let another site's page read them
    if (au && (req.method === "GET" || req.method === "HEAD")) {
      rate("audio", me.id, 600);
      const sub = subParse(au[1]);
      return sub ? await ctx.subAudio(req, res, sub.sid, sub.song, u.searchParams.get("quality")) : await ctx.audio(req, res, au[1], u.searchParams.get("quality"), u.searchParams.get("fallback"), u.searchParams.get("format"));
    }
    if (p === "/lyrics" && req.method === "GET") { rate("lyrics", me.id, 60); return json(res, 200, await ctx.lyrics(u.searchParams), { "Cache-Control": "private, max-age=300" }); } // Undertow's lyric sources, the same the first player reads
    const tc = p.match(/^\/tcover\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i); // TIDAL cover art: from here, so the page may read it (to put it in a download's tags) and TIDAL's image servers see this server, not each listener
    if (tc && (req.method === "GET" || req.method === "HEAD")) {
      rate("cover", me.id, 600);
      const size = [80, 160, 320, 640, 750, 1080, 1280].includes(Number(u.searchParams.get("size"))) ? Number(u.searchParams.get("size")) : 640;
      try {
        const up = await fetch(`https://resources.tidal.com/images/${tc[1].toLowerCase().replace(/-/g, "/")}/${size}x${size}.jpg`, { signal: AbortSignal.timeout(8000) });
        if (!up.ok) return json(res, 404, { error: "No cover" });
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=604800", ...HEAD });
        if (req.method === "HEAD") return void res.end();
        return void Readable.fromWeb(up.body).on("error", () => res.destroy()).pipe(res);
      } catch { return json(res, 502, { error: "No cover" }); }
    }
    if (p.startsWith("/mv/") && (req.method === "GET" || req.method === "HEAD")) { // music videos for the fullscreen player (found, saved and lined up with the song by this server)
      if (p === "/mv/available") return json(res, 200, { available: !!ctx.mv.available() });
      if (!ctx.mv.available()) return json(res, 404, { error: "Music videos aren't set up on this server" });
      const g = (k, n = 200) => clipText(u.searchParams.get(k), n), sub = subParse(g("id")), rawId = g("id");
      const id = sub ? `sub:${sub.sid}:${sub.song}` : /^\d{1,12}$/.test(rawId) ? rawId : null;
      const title = g("title"), meta = { title, artist: g("artist"), album: g("album"), duration: Number(g("duration")) || 0 };
      if (!id || !title) return json(res, 400, { error: "Say which song" });
      if (p === "/mv/sync") { rate("mv-sync", me.id, 60, 600000); return json(res, 200, await ctx.mv.sync(id, meta), { "Cache-Control": "no-store" }); }
      if (p === "/mv/file") {
        if (!req.headers.range || /^bytes=0-/.test(req.headers.range)) rate("mv-file", me.id, 60, 600000); // the start of a video counts; the seeks inside it don't
        return await ctx.mv.file(req, res, meta);
      }
      return json(res, 404, { error: "Not found" });
    }
    const av = p.match(/^\/avatar\/([a-f0-9]+)\.jpg$/); // a person's photo, for the party's member list
    if (av && req.method === "GET") {
      const file = ctx.avatar(av[1]);
      const body = file ? await fs.promises.readFile(file).catch(() => null) : null;
      if (!body) return json(res, 404, { error: "No photo" });
      return send(res, 200, body, "image/jpeg", { "Cache-Control": "private, max-age=3600" });
    }
    const cv = p.match(/^\/cover\/([a-f0-9]+)\/([^/]+)$/); // a Subsonic song's cover
    if (cv && (req.method === "GET" || req.method === "HEAD")) {
      rate("tcover", me.id, 600);
      const size = SUB_COVER_SIZES.includes(Number(u.searchParams.get("size"))) ? Number(u.searchParams.get("size")) : 640;
      try {
        const up = await ctx.subCover(cv[1], decodeURIComponent(cv[2]), size);
        res.writeHead(200, { "Content-Type": up.headers.get("content-type") || "image/jpeg", "Cache-Control": "private, max-age=86400", ...HEAD });
        if (req.method === "HEAD") return void res.end();
        return void Readable.fromWeb(up.body).on("error", () => res.destroy()).pipe(res);
      } catch (e) { return json(res, e.status || 404, { error: "No cover" }); }
    }
    if (p === "/__off/health") return json(res, 200, { ok: true }); // the parties page asks this before it offers to host one
    if (p === "/__off/get-session") return json(res, 200, sessionOf(me, req)); // Monochrome's account button: who is signed in, taken from Undertow
    if (p === "/__off/sign-out" && req.method === "POST") { destroySession(cookies(req).sid); return json(res, 200, { success: true }, { "Set-Cookie": cookie(req, "", 0) }); }
    if (p === "/__off/api/sync") return await syncRoute(req, res, me, ctx);
    if (p === "/__off/rpc/now" && req.method === "POST") { // what this player is playing, for the Discord presence relay (lib/rpcrelay.mjs)
      if (req.headers["x-requested-with"] !== "ui") throw httpError(403, "Not allowed");
      return json(res, 200, relayPush(me, await bodyOf(req, 4096)));
    }
    if (p === "/__off/speaker") { // the server's own speakers, for the people an admin allowed (the same rule as the first player): the page is the remote
      if (!ctx.speaker.allowed(me)) return json(res, 403, { error: "You can't use the server speakers" });
      if (req.method === "GET") return json(res, 200, await ctx.speaker.status(), { "Cache-Control": "no-store" });
      if (req.method !== "POST") return json(res, 405, { error: "Not allowed" });
      if (req.headers["x-requested-with"] !== "ui") throw httpError(403, "Not allowed");
      rate("speaker", me.id, 240, 60000);
      return json(res, 200, await ctx.speaker.act(me, await bodyOf(req, 4096)), { "Cache-Control": "no-store" });
    }
    if (p === "/__off/rpc" && req.method === "GET") return json(res, 200, ctx.rpc.info("/__off/rpc/file/")); // the Discord presence app: what to download
    const rf = p.match(/^\/__off\/rpc\/file\/([\w.-]+)$/);
    if (rf && (req.method === "GET" || req.method === "HEAD")) return ctx.rpc.file(req, res, rf[1]) ? undefined : json(res, 404, { error: "No such file" });
    if (p === "/__off/lastfm" && req.method === "GET") return json(res, 200, ctx.lastfm.status(me));
    if (p.startsWith("/__off/lastfm/") && req.method === "POST") { // Last.fm, through this server: Undertow holds the keys and each person's connection
      if (req.headers["x-requested-with"] !== "ui") throw httpError(403, "Not allowed");
      const b = await bodyOf(req, 4096);
      if (p === "/__off/lastfm/start") { rate("lf-start", me.id, 20, 600000); return json(res, 200, await ctx.lastfm.start(me, `${originOf(req)}/__lastfm/done`)); }
      if (p === "/__off/lastfm/complete") { rate("lf-complete", me.id, 120, 600000); return json(res, 200, await ctx.lastfm.complete(me, b.token)); }
      if (p === "/__off/lastfm/disconnect") { ctx.lastfm.disconnect(me); return json(res, 200, { ok: true }); }
      if (p === "/__off/lastfm/send") {
        rate("lf-send", me.id, 120, 60000);
        if (!["now", "scrobble", "love"].includes(b.kind)) throw httpError(400, "Unknown action");
        return json(res, 200, await ctx.lastfm.send(me, b.kind, { title: clipText(b.title, 250), artist: clipText(b.artist, 250), album: clipText(b.album, 250), duration: Number(b.duration) || 0 }, Number(b.ts)));
      }
    }
    if (p === "/__lastfm/done") return send(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Last.fm</title><body style="font:16px system-ui;padding:2rem;max-width:30rem;margin:auto"><p>All set. You can close this tab and go back to the player.</p>`, "text/html; charset=utf-8");
    if (p.startsWith("/__off") || p.startsWith("/api/")) return json(res, 404, { error: "Not available here" }); // Monochrome's own account and sync servers are off
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Not allowed" });
    return await serveStatic(req, res, u);
  } catch (e) {
    if (e.status) return json(res, e.status, { error: e.message });
    console.error("player host:", e);
    return json(res, 500, { error: "Something went wrong" });
  }
}
