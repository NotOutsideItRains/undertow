// Undertow's public API: catalog METADATA (search, tracks, albums, artists), and, only for keys an admin marks "stream", the audio of a track (for bots).
// No video, no lyrics, no one's library or listening.
// Every request needs an API key an admin made in the app. Keys are kept as SHA-256 hashes, so a key can be shown once and never again.
import crypto from "node:crypto";
import { db, save, rid, httpError } from "./store.mjs";
import * as licenses from "./botlicense.mjs";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const keys = () => (db.apiKeys ||= {});
const byHash = () => new Map(Object.values(keys()).map((k) => [k.hash, k]));
export const MAX_KEYS = 50, DEFAULT_PER_MIN = 60;

// ---- keys ----
export function createKey(name, by, perMin, stream = false, bot = false, lyrics = false) {
  if (Object.keys(keys()).length >= MAX_KEYS) throw httpError(400, `That's the most keys allowed (${MAX_KEYS}). Remove one first.`);
  const label = String(name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
  if (!label) throw httpError(400, "Give the key a name, so you know what it's for");
  const per = Math.max(1, Math.min(600, Math.round(Number(perMin)) || DEFAULT_PER_MIN));
  const secret = `ut_${crypto.randomBytes(24).toString("base64url")}`;
  const k = { id: rid(6), name: label, hash: sha(secret), prefix: secret.slice(0, 7), perMin: per, stream: stream === true || bot === true, lyrics: lyrics === true || bot === true, bot: bot === true, createdAt: Date.now(), createdBy: by, lastUsed: null, uses: 0 };
  keys()[k.id] = k;
  save();
  return { key: secret, info: view(k) }; // the only time the key itself exists outside the owner's copy
}
const view = (k) => ({ id: k.id, name: k.name, prefix: k.prefix, perMin: k.perMin, stream: k.stream === true, lyrics: k.lyrics === true || k.bot === true, bot: k.bot === true, createdAt: k.createdAt, createdBy: k.createdBy, lastUsed: k.lastUsed, uses: k.uses });
export const listKeys = () => Object.values(keys()).sort((a, b) => b.createdAt - a.createdAt).map(view);
export function removeKey(id) { if (!keys()[id]) throw httpError(404, "No such key"); delete keys()[id]; save(); }
export function renameKey(id, body) {
  const k = keys()[id]; if (!k) throw httpError(404, "No such key");
  if (body.name !== undefined) { const n = String(body.name).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40); if (!n) throw httpError(400, "Give the key a name"); k.name = n; }
  if (body.stream !== undefined) k.stream = body.stream === true || k.bot === true; // a bot key always keeps audio
  if (body.lyrics !== undefined) k.lyrics = body.lyrics === true || k.bot === true;
  if (body.perMin !== undefined) k.perMin = Math.max(1, Math.min(600, Math.round(Number(body.perMin)) || DEFAULT_PER_MIN));
  save();
  return view(k);
}

// ---- limits: per key, and a stricter one for addresses that keep sending wrong keys ----
const hits = new Map(), bad = new Map();
const windowed = (map, id, max, ms) => {
  const now = Date.now(), list = (map.get(id) || []).filter((t) => now - t < ms);
  const over = list.length >= max;
  if (!over) list.push(now);
  map.set(id, list);
  if (map.size > 5000) map.delete(map.keys().next().value);
  return { over, left: Math.max(0, max - list.length), reset: Math.max(1, Math.ceil(((list[0] || now) + ms - now) / 1000)) };
};
let lastSave = 0;

// ---- how upstream catalog data becomes our shape ----
const IMG = "https://resources.tidal.com/images/";
const art = (id, sizes) => (id ? Object.fromEntries(sizes.map((s) => [String(s), `${IMG}${String(id).replace(/-/g, "/")}/${s}x${s}.jpg`])) : null);
const artists = (t) => (t.artists || (t.artist ? [t.artist] : [])).map((a) => ({ id: String(a.id), name: a.name, ...(a.type ? { type: a.type } : {}) }));
const track = (t) => ({
  source: "TIDAL", id: String(t.id), title: t.title, version: t.version || null, artists: artists(t),
  album: t.album ? { id: String(t.album.id), title: t.album.title, cover: art(t.album.cover, [320, 640, 1280]) } : null,
  duration: t.duration ?? null, trackNumber: t.trackNumber ?? null, volumeNumber: t.volumeNumber ?? null, explicit: !!t.explicit,
  isrc: t.isrc || null, popularity: t.popularity ?? null, audioQuality: t.audioQuality || null, audioModes: t.audioModes || null,
  copyright: t.copyright || null, releaseDate: t.streamStartDate ? String(t.streamStartDate).slice(0, 10) : null, url: t.url || null,
});
const album = (a) => ({
  id: String(a.id), title: a.title, type: a.type || null, artists: artists(a), cover: art(a.cover, [320, 640, 1280]),
  releaseDate: a.releaseDate || null, duration: a.duration ?? null, numberOfTracks: a.numberOfTracks ?? null, numberOfVolumes: a.numberOfVolumes ?? null,
  explicit: !!a.explicit, upc: a.upc || null, popularity: a.popularity ?? null, audioQuality: a.audioQuality || null, copyright: a.copyright || null, url: a.url || null,
});
const artist = (a) => ({ id: String(a.id), name: a.name, picture: art(a.picture || a.selectedAlbumCoverFallback, [160, 320, 750]), popularity: a.popularity ?? null, roles: (a.artistRoles || []).map((r) => r.category).filter(Boolean), url: a.url || null });
// Songs that live on a Subsonic server are listed beside the catalog's. Their ids look like "sub:<server>:<song>".
const SUB_ID = "sub:[a-f0-9]+:[^/]+";
const subRow = (r, cover = null) => ({
  id: String(r.id), title: r.title, version: null, artists: r.artist ? [{ id: null, name: r.artist }] : [],
  album: r.album ? { id: null, title: r.album, cover } : null, duration: r.duration ?? null, trackNumber: null, volumeNumber: null, explicit: false,
  isrc: null, popularity: null, audioQuality: r.audioQuality || null, audioModes: null, copyright: null, releaseDate: null, url: null, source: r.source || "Subsonic",
});
const subSong = ({ server, song }, id, cover) => subRow({ id, title: song.title, artist: song.artist || song.displayArtist, album: song.album, duration: song.duration, source: server?.label,
  audioQuality: ["flac", "wav", "alac", "ape", "wv"].includes(String(song.suffix || "").toLowerCase()) ? "LOSSLESS" : "HIGH" }, cover);
const norm = (x) => String(x || "").toLowerCase().replace(/\(.*?\)|\[.*?\]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// TIDAL's search returns something even for loose matches, so a Subsonic song that matches every word goes first (a bot plays the top result).
function merge(tidal, sub, text) {
  const have = new Set(tidal.map((t) => `${norm(t.title)}|${norm(t.artists?.[0]?.name).split(" ")[0]}`)), words = norm(text).split(" ").filter(Boolean), strong = [], rest = [];
  for (const t of sub) {
    if (have.has(`${norm(t.title)}|${norm(t.artists?.[0]?.name).split(" ")[0]}`)) continue;
    const hay = norm(`${t.title} ${t.artists?.[0]?.name || ""} ${t.album?.title || ""}`);
    (words.length && words.every((w) => hay.includes(w)) ? strong : rest).push(t);
  }
  return [...strong, ...tidal, ...rest];
}
const items = (v) => (Array.isArray(v) ? v : Array.isArray(v?.items) ? v.items : []);
const list = (kind, arr, total, offset, limit) => ({ [kind]: arr, total: total ?? null, offset, limit });


// ---- lyrics: whatever a provider sent, as lines with a start time (and words, when the song is word-synced) ----
// Background vocals ("(ooh)", "(back to let you know)") arrive stuck to the end of the line. They're split off into `background`, so a client can show them
// apart from the verse. A line that is only a background vocal keeps its text in brackets and is marked `backgroundOnly`.
const decode = (t) => String(t).replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/\s+/g, " ").trim();
function splitBg(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  let m;
  if ((m = t.match(/^\(([^()]+)\)$/))) return { main: `(${m[1].trim()})`, bg: "", only: true };
  if ((m = t.match(/^(.*\S)\s+\(([^()]+)\)$/))) return { main: m[1].trim(), bg: m[2].trim() };
  if ((m = t.match(/^\(([^()]+)\)\s+(\S.*)$/))) return { main: m[2].trim(), bg: m[1].trim() };
  return { main: t, bg: "" };
}
const unparen = (t) => String(t || "").replace(/\s+/g, " ").trim().replace(/^\(\s*([^()]*?)\s*\)$/, "$1").trim();
const lineOf = (start, dur, sp, words) => ({ startMs: start, durationMs: dur || 0, text: sp.main, ...(sp.bg ? { background: sp.bg } : {}), ...(sp.only ? { backgroundOnly: true } : {}), ...(words?.length > 1 ? { words } : {}) });
const allText = (lines) => lines.map((l) => (l.background ? `${l.text}\n(${l.background})` : l.text)).join("\n");
function ttmlTime(v) { // 00:27.395, 1:02:03.5, 27.395s, 27395ms or plain seconds
  const t = String(v || "").trim(); let m;
  if ((m = t.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/))) return Math.round(((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000);
  if ((m = t.match(/^(\d+(?:\.\d+)?)ms$/))) return Math.round(Number(m[1]));
  if ((m = t.match(/^(\d+(?:\.\d+)?)s?$/))) return Math.round(Number(m[1]) * 1000);
  return null;
}
const attr = (tag, name) => (new RegExp(`\\b${name}="([^"]*)"`).exec(tag) || [])[1];
// the part of a TTML line marked as a background vocal (ttm:role="x-bg"), taken out whole, nested spans and all
function takeBg(inner) {
  const open = /<span\b[^>]*role="x-bg"[^>]*>/.exec(inner);
  if (!open) return { rest: inner, bg: "" };
  let depth = 1, i = open.index + open[0].length;
  for (const m of inner.slice(i).matchAll(/<(\/?)span\b[^>]*>/g)) { depth += m[1] ? -1 : 1; if (!depth) { const end = i + m.index + m[0].length; return { rest: inner.slice(0, open.index) + " " + inner.slice(end), bg: unparen(decode(inner.slice(i, i + m.index))) }; } }
  return { rest: inner, bg: "" };
}
function fromTtml(text) {
  const out = [];
  for (const m of String(text).matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const start = ttmlTime(attr(m[1], "begin")), end = ttmlTime(attr(m[1], "end"));
    if (start == null) continue;
    const { rest, bg } = takeBg(m[2]), main = decode(rest);
    const sp = main ? (bg ? { main, bg } : splitBg(main)) : bg ? { main: `(${bg})`, bg: "", only: true } : null;
    if (!sp || !sp.main) continue;
    const words = [...rest.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/g)].map((w) => ({ startMs: ttmlTime(attr(w[1], "begin")), end: ttmlTime(attr(w[1], "end")), text: decode(w[2]) })).filter((w) => w.startMs != null && w.text)
      .map((w) => ({ startMs: w.startMs, durationMs: w.end != null ? Math.max(0, w.end - w.startMs) : 0, text: w.text }));
    out.push(lineOf(start, end != null ? Math.max(0, end - start) : 0, sp, words));
  }
  return out;
}
function fromLrc(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const line = decode(raw.replace(/\[[^\]]*\]/g, "").replace(/<\d+:\d+(?:\.\d+)?>/g, ""));
    if (!line) continue;
    for (const st of stamps) out.push(lineOf(Math.round((Number(st[1]) * 60 + Number(st[2])) * 1000), 0, splitBg(line)));
  }
  out.sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < out.length - 1; i++) out[i].durationMs = Math.max(0, out[i + 1].startMs - out[i].startMs);
  return out;
}
export function normalizeLyrics(entry) {
  const x = entry.payload || {}, base = { provider: entry.key, name: entry.name, sync: entry.sync, source: x.source || null, sourceHref: x.sourceHref || null, songwriters: x.songwriters || [], submitter: x.submitter ? { name: x.submitter.name, level: x.submitter.level ?? null, badge: x.submitter.badge || null, avatar: x.submitter.avatar || null } : null };
  if (x.lyrics) { // rows from a provider: the whole line's text, with word parts (some marked as background) when it's karaoke
    const lines = [];
    for (const r of x.lyrics) {
      if (r.isInstrumental) continue;
      const raw = r.parts || [], parts = raw.filter((w) => String(w.words || "").trim()); // the spaces between words are parts too: kept for the text, left out of the word list
      const bgWords = raw.filter((w) => w.isBackground), mainWords = raw.filter((w) => !w.isBackground);
      let sp;
      if (bgWords.length) {
        const main = mainWords.map((w) => w.words).join("").replace(/\s+/g, " ").trim(), bg = unparen(bgWords.map((w) => w.words).join(""));
        sp = main ? { main, bg } : { main: `(${bg})`, bg: "", only: true };
      } else sp = splitBg(r.words);
      if (!sp.main) continue;
      const words = parts.map((w) => ({ startMs: w.startTimeMs, durationMs: w.durationMs || 0, text: String(w.words).trim(), ...(w.isBackground ? { background: true } : {}) }));
      lines.push(lineOf(r.startTimeMs, r.durationMs, sp, words));
    }
    return entry.sync === "plain" ? { ...base, lines: null, text: allText(lines) } : { ...base, lines, text: allText(lines) };
  }
  const t = String(x.text || ""), fmt = x.format;
  if (fmt === "ttml") { const lines = fromTtml(t); return { ...base, lines, text: allText(lines) }; }
  if (fmt === "lrc") { const lines = fromLrc(t); return { ...base, lines, text: allText(lines) }; }
  const plain = t.replace(/\r/g, "").trim().split("\n").map((l) => { const sp = splitBg(l); return l.trim() === "" ? "" : sp.bg ? `${sp.main}\n(${sp.bg})` : sp.main; }).join("\n");
  return { ...base, sync: "plain", lines: null, text: plain };
}

// a short cache, so a busy client can't turn into a busy TIDAL account
const cache = new Map();
async function cached(key, fn, ttl = 300000) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return v;
}
const int = (v, d, lo, hi) => { if (v == null || String(v).trim() === "") return d; const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; }; // a missing value is the default, not zero

async function route(u, call, ext = {}) {
  const p = u.pathname.slice(3).replace(/\/$/, ""), q = u.searchParams; let m;
  if (p === "/search") {
    const text = (q.get("q") || "").trim().slice(0, 200), type = q.get("type") || "track";
    if (!text) throw httpError(400, "Add ?q= with what to search for");
    if (!["track", "album", "artist"].includes(type)) throw httpError(400, "type is track, album or artist");
    const limit = int(q.get("limit"), 20, 1, 50), offset = int(q.get("offset"), 0, 0, 500);
    return cached(`s|${type}|${text.toLowerCase()}|${limit}|${offset}`, async () => {
      if (type === "track") { // the catalog and any Subsonic servers, asked together; one failing doesn't hide the other
        let fail = null;
        const [r, sub] = await Promise.all([call("/search/", { s: text, limit, offset }).catch((e) => { fail = e; return null; }), offset || !ext.subsonicSearch ? [] : ext.subsonicSearch(text, limit).catch(() => [])]);
        const tidal = items(r?.data).map(track), subs = sub.map((x) => subRow(x, x.coverArt ? ext.subCover?.(ext.origin, x.id, x.coverArt) ?? null : null));
        if (!tidal.length && !subs.length && fail) throw fail;
        return list("tracks", merge(tidal, subs, text).slice(0, limit), (r?.data?.totalNumberOfItems ?? 0) + subs.length || null, offset, limit);
      }
      const r = await call("/search/", type === "album" ? { al: text, limit, offset } : { a: text, limit, offset }), d = r.data || {};
      if (type === "album") { const a = items(d.albums); return list("albums", a.map(album), d.albums?.totalNumberOfItems, offset, limit); }
      const a = items(d.artists); return list("artists", a.map(artist), d.artists?.totalNumberOfItems, offset, limit);
    }, type === "track" ? 30000 : 300000);
  }
  if ((m = p.match(new RegExp(`^/tracks/(\\d+|${SUB_ID})/lyrics$`)))) {
    if (!ext.lyricsOk) throw httpError(403, "This key can't read lyrics. Make a key with lyrics turned on, or edit this one.");
    if (!ext.lyrics) throw httpError(404, "Lyrics aren't available here");
    const id = decodeURIComponent(m[1]), want = (q.get("provider") || "").slice(0, 30);
    return cached(`l|${id}|${want}`, async () => {
      let meta;
      if (/^\d+$/.test(id)) { const r = await call("/info/", { id }); const t = track(r.data ?? r); meta = { title: t.version ? `${t.title} (${t.version})` : t.title, artist: t.artists.map((a) => a.name).join(", "), album: t.album?.title, duration: t.duration || 0, isrc: t.isrc }; }
      else { const r = await ext.subsonicSong(id); meta = { title: r.song.title, artist: r.song.artist || r.song.displayArtist || "", album: r.song.album, duration: r.song.duration || 0 }; }
      const list = await ext.lyrics(meta);
      if (!list.length) throw httpError(404, "No lyrics found for that song");
      const pick = list.find((x) => x.key === want) || list[0];
      return { id, ...normalizeLyrics(pick), options: list.map(({ key, name, sync }) => ({ provider: key, name, sync })) };
    }, 600000);
  }
  if ((m = p.match(new RegExp(`^/tracks/(${SUB_ID})$`)))) {
    const id = decodeURIComponent(m[1]);
    if (!ext.subsonicSong) throw httpError(404, "No such track");
    return cached(`t|${id}`, async () => { const r = await ext.subsonicSong(id); return subSong(r, id, r.song.coverArt ? ext.subCover?.(ext.origin, id, String(r.song.coverArt)) ?? null : null); }, 60000);
  }
  if ((m = p.match(/^\/tracks\/(\d+)$/))) return cached(`t|${m[1]}`, async () => { const r = await call("/info/", { id: m[1] }); return track(r.data ?? r); });
  if ((m = p.match(/^\/albums\/(\d+)$/))) {
    const limit = int(q.get("limit"), 100, 1, 500), offset = int(q.get("offset"), 0, 0, 5000);
    return cached(`a|${m[1]}|${limit}|${offset}`, async () => {
      const a = (await call("/album/", { id: m[1], limit, offset })).data || {};
      const tracks = items(a.items).map((x) => x.item || x).filter((x) => x && x.id).map(track);
      return { ...album(a), tracks: list("tracks", tracks, a.numberOfTracks, offset, limit) };
    });
  }
  if ((m = p.match(/^\/playlists\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i))) {
    const limit = int(q.get("limit"), 100, 1, 500), offset = int(q.get("offset"), 0, 0, 5000), id = m[1].toLowerCase();
    return cached(`pl|${id}|${limit}|${offset}`, async () => {
      const r = await call("/playlist/", { id, limit, offset }), pl = r.playlist || {};
      const tracks = items(r.items).filter((x) => (x.type || "track") === "track").map((x) => x.item || x).filter((x) => x && x.id && x.title).map(track);
      return { id, title: pl.title || null, description: pl.description || null, creator: pl.creator?.name || null, numberOfTracks: pl.numberOfTracks ?? null, duration: pl.duration ?? null,
        image: art(pl.squareImage || pl.image, [320, 640, 1280]), url: pl.url || null, tracks: list("tracks", tracks, pl.numberOfTracks, offset, limit) };
    });
  }
  if ((m = p.match(/^\/mixes\/([0-9a-f]{10,64})$/i))) {
    const id = m[1].toLowerCase();
    return cached(`mx|${id}`, async () => {
      const r = await call("/mix/", { id }), mx = r.mix || {};
      const tracks = items(r.items).map((x) => x.item || x).filter((x) => x && x.id && x.title).map(track);
      return { id, title: mx.title || null, description: mx.subTitle || mx.description || null, tracks: list("tracks", tracks, tracks.length, 0, tracks.length) };
    });
  }
  if ((m = p.match(/^\/artists\/(\d+)$/))) return cached(`r|${m[1]}`, async () => artist((await call("/artist/", { id: m[1] })).artist || {}));
  if ((m = p.match(/^\/artists\/(\d+)\/(albums|top-tracks)$/))) {
    const r = await cached(`rr|${m[1]}`, () => call("/artist/", { f: m[1], skip_tracks: "true" }));
    return m[2] === "albums"
      ? list("albums", items(r.albums).map(album), null, 0, items(r.albums).length)
      : list("tracks", items(r.tracks).map(track), null, 0, items(r.tracks).length);
  }
  throw httpError(404, "No such endpoint. See /v1/openapi.json");
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Authorization, X-API-Key", "Access-Control-Max-Age": "86400", "Access-Control-Expose-Headers": "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After" };
const send = (res, status, body, extra = {}) => { const s = JSON.stringify(body); res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...CORS, ...extra }); res.end(s); };
const fail = (res, status, message, extra) => send(res, status, { error: { status, message } }, extra);

// The address other people (and Discord) can reach this server at. The bot asks over the local network, where the address would be useless to them.
const PUBLIC = (process.env.PUBLIC_URL || "http://localhost:7000").replace(/\/+$/, "");
const LOCAL_HOST = /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;
const publicOrigin = (req) => { const host = String(req.headers["x-forwarded-host"] || req.headers.host || ""); return LOCAL_HOST.test(host) ? PUBLIC : `${req.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${host}`; };

const streams = new Map(); // key id -> audio streams in flight
export async function handle(req, res, u, { ip, call, spec, stream, botToken, subsonicSearch, subsonicSong, subCover, lyrics }) {
  if (req.method === "OPTIONS") return void res.writeHead(204, CORS).end();
  const redeeming = req.method === "POST" && u.pathname === "/v1/bot/licenses"; // the one thing here that writes: a server redeeming its license
  if (req.method !== "GET" && req.method !== "HEAD" && !redeeming) return fail(res, 405, "This API only reads", { Allow: "GET, OPTIONS" });
  if (u.pathname === "/v1/openapi.json") { // the description itself is open: it says how to use the API, not what's in it
    const origin = `${req.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${req.headers["x-forwarded-host"] || req.headers.host}`;
    return send(res, 200, spec(origin), { "Cache-Control": "public, max-age=300" });
  }
  const h = String(req.headers.authorization || ""), given = (/^Bearer\s+(\S+)$/i.exec(h)?.[1] || String(req.headers["x-api-key"] || "")).trim();
  if (!given) return fail(res, 401, "An API key is needed: send it as 'Authorization: Bearer <key>' or an 'X-API-Key' header", { "WWW-Authenticate": 'Bearer realm="Undertow"' });
  const k = /^ut_[A-Za-z0-9_-]{20,64}$/.test(given) ? byHash().get(sha(given)) : null;
  if (!k) {
    const b = windowed(bad, ip, 20, 60000);
    if (b.over) return fail(res, 429, "Too many wrong keys. Wait a minute.", { "Retry-After": String(b.reset) });
    return fail(res, 401, "That API key isn't valid", { "WWW-Authenticate": 'Bearer realm="Undertow", error="invalid_token"' });
  }
  const r = windowed(hits, k.id, k.perMin, 60000), rl = { "X-RateLimit-Limit": String(k.perMin), "X-RateLimit-Remaining": String(r.left), "X-RateLimit-Reset": String(r.reset) };
  if (r.over) return fail(res, 429, "Slow down: this key is over its limit", { ...rl, "Retry-After": String(r.reset) });
  k.uses++; k.lastUsed = Date.now();
  if (Date.now() - lastSave > 60000) { lastSave = Date.now(); save(); }
  try {
    if (u.pathname === "/v1/bot/token") { // the Discord bot picks up its token here at startup, so it never has to be written on the bot's machine
      if (!k.bot) throw httpError(403, "This key can't read the bot token. Make a key with the Discord bot switch on.");
      const t = botToken();
      if (!t) throw httpError(404, "No Discord bot token is saved in Undertow yet");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...CORS, ...rl });
      return void res.end(JSON.stringify({ token: t }));
    }
    if (u.pathname === "/v1/bot/licenses" || u.pathname.startsWith("/v1/bot/licenses/")) { // which Discord servers may use the bot, and redeeming a license for one
      if (!k.bot) throw httpError(403, "This key can't check licenses. Make a key with the Discord bot switch on.");
      if (redeeming) {
        let body = ""; for await (const c of req) { body += c; if (body.length > 4096) throw httpError(413, "Too much data"); }
        let b; try { b = JSON.parse(body || "{}"); } catch { throw httpError(400, "Send JSON"); }
        return send(res, 200, licenses.redeem(b.code, b.guild, b.name), rl);
      }
      const g = u.pathname.slice("/v1/bot/licenses/".length);
      return send(res, 200, licenses.status(g), rl);
    }
    let sm;
    if ((sm = u.pathname.match(new RegExp(`^/v1/tracks/(\\d{1,12}|${SUB_ID.replace("[^/]+", "[^/]+?")})/stream$`)))) { // the audio itself, only for keys that were given it
      if (!k.stream) throw httpError(403, "This key can't stream audio. Make a key with audio streaming turned on.");
      const n = streams.get(k.id) || 0;
      if (n >= 3) return fail(res, 429, "This key already has 3 audio streams open", { ...rl, "Retry-After": "5" });
      streams.set(k.id, n + 1);
      res.on("close", () => streams.set(k.id, Math.max(0, (streams.get(k.id) || 1) - 1)));
      for (const [h, v] of Object.entries({ ...CORS, ...rl })) res.setHeader(h, v);
      return await stream(req, res, decodeURIComponent(sm[1]), u.searchParams.get("quality"));
    }
    const out = await route(u, call, { subsonicSearch, subsonicSong, subCover, origin: publicOrigin(req), lyrics, lyricsOk: k.lyrics === true || k.bot === true });
    const body = JSON.stringify(out);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff", ...CORS, ...rl });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (e) {
    if (e.status && e.status < 500) return fail(res, e.status, e.message, rl);
    const up = /\b404\b|not found/i.test(String(e.message)) || e.status === 404;
    if (up) return fail(res, 404, "Nothing found for that id", rl);
    console.log(new Date().toISOString(), "public api:", String(e.message || e).slice(0, 200));
    return fail(res, 502, "The music catalog didn't answer. Try again in a moment.", rl);
  }
}

// ---- OpenAPI 3.1 ----
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^\\d+$" }, description: "The catalog id, as returned by search" };
const trackIdParam = { name: "id", in: "path", required: true, schema: { type: "string" }, description: "A track id from search: digits for the catalog, or `sub:<server>:<song>` for a song on a Subsonic server (URL-encode it)" };
const page = (name, desc) => ({ name, in: "query", schema: { type: "integer" }, description: desc });
const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const ok = (schema, description = "OK") => ({ 200: { description, content: { "application/json": { schema } } }, 401: { $ref: "#/components/responses/Unauthorized" }, 429: { $ref: "#/components/responses/TooMany" } });
const pageOf = (kind, item) => ({ type: "object", properties: { [kind]: { type: "array", items: ref(item) }, total: { type: ["integer", "null"] }, offset: { type: "integer" }, limit: { type: "integer" } } });
const cover = { type: ["object", "null"], additionalProperties: { type: "string", format: "uri" }, description: "Image URLs by pixel size" };
const nullable = (t, extra = {}) => ({ type: [t, "null"], ...extra });
export const openapi = (origin) => ({
  openapi: "3.1.0",
  info: { title: "Undertow metadata API", version: "1.0.0", description: "Read-only music catalog metadata: search, tracks, albums and artists. Audio is available only through `/tracks/{id}/stream`, and only for keys an admin turned audio streaming on for. Lyrics are available through `/tracks/{id}/lyrics`, only for keys an admin gave lyrics access to. There is no video here, and nothing about anyone's account or listening.\n\nSend your API key on every request, as `Authorization: Bearer <key>` or an `X-API-Key` header. Keys are made by an admin in the app. Each key has a requests-per-minute limit, shown in the `X-RateLimit-*` headers. Responses are cached for a few minutes." },
  servers: [{ url: `${origin}/v1` }],
  security: [{ bearer: [] }, { apiKey: [] }],
  paths: {
    "/search": { get: { operationId: "search", summary: "Search the catalog", parameters: [{ name: "q", in: "query", required: true, schema: { type: "string", maxLength: 200 } }, { name: "type", in: "query", schema: { type: "string", enum: ["track", "album", "artist"], default: "track" } }, { ...page("limit", "1 to 50, default 20") }, { ...page("offset", "0 to 500") }], responses: { ...ok({ oneOf: [pageOf("tracks", "Track"), pageOf("albums", "Album"), pageOf("artists", "Artist")] }, "A page of tracks, albums or artists, depending on `type`"), 400: { $ref: "#/components/responses/BadRequest" } } } },
    "/tracks/{id}": { get: { operationId: "getTrack", summary: "One track", parameters: [trackIdParam], responses: { ...ok(ref("Track")), 404: { $ref: "#/components/responses/NotFound" } } } },
    "/albums/{id}": { get: { operationId: "getAlbum", summary: "An album and its tracks", parameters: [idParam, page("limit", "Tracks to return, 1 to 500, default 100"), page("offset", "Tracks to skip")], responses: { ...ok({ allOf: [ref("Album"), { type: "object", properties: { tracks: pageOf("tracks", "Track") } }] }), 404: { $ref: "#/components/responses/NotFound" } } } },
    "/playlists/{id}": { get: { operationId: "getPlaylist", summary: "A playlist and its tracks", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "The playlist's UUID, as in a TIDAL playlist link" }, page("limit", "Tracks to return, 1 to 500, default 100"), page("offset", "Tracks to skip")], responses: { ...ok({ type: "object", properties: { id: { type: "string" }, title: nullable("string"), description: nullable("string"), creator: nullable("string"), numberOfTracks: nullable("integer"), duration: nullable("integer"), image: cover, url: nullable("string"), tracks: pageOf("tracks", "Track") } }), 404: { $ref: "#/components/responses/NotFound" } } } },
    "/mixes/{id}": { get: { operationId: "getMix", summary: "A TIDAL mix and its tracks", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "The mix id, as in a TIDAL mix link" }], responses: { ...ok({ type: "object", properties: { id: { type: "string" }, title: nullable("string"), description: nullable("string"), tracks: pageOf("tracks", "Track") } }), 404: { $ref: "#/components/responses/NotFound" } } } },
    "/artists/{id}": { get: { operationId: "getArtist", summary: "One artist", parameters: [idParam], responses: { ...ok(ref("Artist")), 404: { $ref: "#/components/responses/NotFound" } } } },
    "/artists/{id}/albums": { get: { operationId: "getArtistAlbums", summary: "An artist's albums, EPs and singles", parameters: [idParam], responses: { ...ok(pageOf("albums", "Album")), 404: { $ref: "#/components/responses/NotFound" } } } },
    "/artists/{id}/top-tracks": { get: { operationId: "getArtistTopTracks", summary: "An artist's top tracks", parameters: [idParam], responses: { ...ok(pageOf("tracks", "Track")), 404: { $ref: "#/components/responses/NotFound" } } } },
    "/tracks/{id}/stream": { get: { operationId: "streamTrack", summary: "The audio of a track (keys with audio streaming only)", description: "Works for catalog tracks and for songs on Subsonic servers. Returns the audio file (FLAC, or AAC for LOW and HIGH) and supports `Range` requests. The first request for a track can take a few seconds while it's prepared. Only keys an admin made with audio streaming turned on may use this; others get 403. At most 3 streams per key at once.", parameters: [trackIdParam, { name: "quality", in: "query", schema: { type: "string", enum: ["LOW", "HIGH", "CD", "HI_RES"], default: "CD" }, description: "LOW and HIGH are AAC; CD is 16-bit FLAC; HI_RES is the best available FLAC" }], responses: { 200: { description: "Audio", content: { "audio/flac": { schema: { type: "string", format: "binary" } }, "audio/mp4": { schema: { type: "string", format: "binary" } } } }, 206: { description: "Partial audio, for a Range request" }, 401: { $ref: "#/components/responses/Unauthorized" }, 403: { description: "This key can't stream audio", content: { "application/json": { schema: ref("Error") } } }, 429: { $ref: "#/components/responses/TooMany" }, 404: { $ref: "#/components/responses/NotFound" } } } },
    "/tracks/{id}/lyrics": { get: { operationId: "getLyrics", summary: "A song's lyrics (keys with lyrics turned on only)", description: "Asks the same lyrics sources as the web player and returns the best answer: word-by-word first, then line-by-line, then plain text. Lyrics are copyrighted, so this needs a key an admin gave lyrics access to.", parameters: [trackIdParam, { name: "provider", in: "query", schema: { type: "string" }, description: "A provider from `options`, to get that one instead of the best" }], responses: { ...ok(ref("Lyrics")), 403: { description: "This key can't read lyrics", content: { "application/json": { schema: ref("Error") } } }, 404: { $ref: "#/components/responses/NotFound" } } } },
    "/openapi.json": { get: { operationId: "getSpec", summary: "This description", security: [], responses: { 200: { description: "OpenAPI 3.1 document" } } } },
  },
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "An Undertow API key, `ut_…`" }, apiKey: { type: "apiKey", in: "header", name: "X-API-Key" } },
    responses: {
      Unauthorized: { description: "Missing or wrong API key", content: { "application/json": { schema: ref("Error") } } },
      TooMany: { description: "Over the key's limit; see `Retry-After`", headers: { "Retry-After": { schema: { type: "integer" } } }, content: { "application/json": { schema: ref("Error") } } },
      BadRequest: { description: "A parameter is missing or wrong", content: { "application/json": { schema: ref("Error") } } },
      NotFound: { description: "Nothing with that id", content: { "application/json": { schema: ref("Error") } } },
    },
    schemas: {
      Error: { type: "object", properties: { error: { type: "object", properties: { status: { type: "integer" }, message: { type: "string" } } } } },
      ArtistRef: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, type: { type: "string" } } },
      Track: { type: "object", properties: { source: { type: "string", description: "TIDAL, or the name of the Subsonic server the song is on" }, id: { type: "string" }, title: { type: "string" }, version: nullable("string"), artists: { type: "array", items: ref("ArtistRef") }, album: nullable("object", { properties: { id: { type: "string" }, title: { type: "string" }, cover } }), duration: nullable("integer", { description: "Seconds" }), trackNumber: nullable("integer"), volumeNumber: nullable("integer"), explicit: { type: "boolean" }, isrc: nullable("string"), popularity: nullable("integer"), audioQuality: nullable("string"), audioModes: { type: ["array", "null"], items: { type: "string" } }, copyright: nullable("string"), releaseDate: nullable("string", { format: "date" }), url: nullable("string") } },
      Album: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, type: nullable("string", { description: "ALBUM, EP or SINGLE" }), artists: { type: "array", items: ref("ArtistRef") }, cover, releaseDate: nullable("string", { format: "date" }), duration: nullable("integer"), numberOfTracks: nullable("integer"), numberOfVolumes: nullable("integer"), explicit: { type: "boolean" }, upc: nullable("string"), popularity: nullable("integer"), audioQuality: nullable("string"), copyright: nullable("string"), url: nullable("string") } },
      Lyrics: { type: "object", properties: { id: { type: "string" }, provider: { type: "string" }, name: { type: "string" }, sync: { type: "string", enum: ["word", "line", "plain"] }, source: nullable("string"), songwriters: { type: "array", items: { type: "string" } }, submitter: nullable("object", { description: "Who contributed these lyrics, when the source says (Unison does)", properties: { name: { type: "string" }, level: nullable("integer"), badge: nullable("string"), avatar: nullable("string") } }),
        lines: { type: ["array", "null"], description: "Null for plain lyrics", items: { type: "object", properties: { startMs: { type: "integer" }, durationMs: { type: "integer" }, text: { type: "string", description: "The main line, without background vocals" }, background: { type: "string", description: "Background vocals sung with this line, if any" }, backgroundOnly: { type: "boolean", description: "True when the whole line is a background vocal (its text is in brackets)" }, words: { type: "array", description: "Only for word-synced songs", items: { type: "object", properties: { startMs: { type: "integer" }, durationMs: { type: "integer" }, text: { type: "string" }, background: { type: "boolean" } } } } } } },
        text: { type: "string", description: "All the lyrics as plain text. Each background vocal is on its own line, in brackets, under the line it goes with." }, options: { type: "array", items: { type: "object", properties: { provider: { type: "string" }, name: { type: "string" }, sync: { type: "string" } } } } } },
      Artist: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, picture: cover, popularity: nullable("integer"), roles: { type: "array", items: { type: "string" } }, url: nullable("string") } },
    },
  },
});
