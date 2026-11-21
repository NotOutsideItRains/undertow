// Subsonic-compatible servers (gonic, Navidrome, …) used as a backup when TIDAL has no answer.
// The password is only used once, to sign in: after that the server keeps the Subsonic token
// (md5 of password + a random salt) and the salt. The password itself is never stored, and
// neither the salt nor the token ever leaves this server (the UI and listeners only get views).
import crypto from "node:crypto";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { db, save, rid, httpError } from "./store.mjs";

const VERSION = "1.16.1", CLIENT = "undertow";
const rt = new Map();
const R = (id) => { let r = rt.get(id); if (!r) rt.set(id, (r = { requests: 0, errors: 0, avgMs: 0, lastOkAt: null })); return r; };
const servers = () => Object.values(db.subsonic || (db.subsonic = {}));

function cleanUrl(raw) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`); } catch { throw httpError(400, "That doesn't look like a server address"); }
  if (u.username || u.password) throw httpError(400, "Leave the login out of the address");
  return u.origin + u.pathname.replace(/\/+$/, "").replace(/\/rest$/, "");
}
const endpoint = (s, name, params = {}) => {
  const url = new URL(`${s.url}/rest/${name}.view`);
  for (const [k, v] of Object.entries({ u: s.username, t: s.token, s: s.salt, v: VERSION, c: CLIENT, f: "json", ...params })) url.searchParams.set(k, v);
  return url;
};

async function ask(s, name, params, ms = 8000) {
  const r = R(s.id), t0 = Date.now();
  r.requests++;
  try {
    const res = await fetch(endpoint(s, name, params), { signal: AbortSignal.timeout(ms) });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { down: true });
    const body = (await res.json())["subsonic-response"];
    if (body?.status !== "ok") throw Object.assign(new Error(body?.error?.message || "Server said no"), { code: body?.error?.code, bad: true });
    r.avgMs = r.avgMs ? r.avgMs * 0.8 + (Date.now() - t0) * 0.2 : Date.now() - t0;
    r.lastOkAt = Date.now();
    if (s.status !== "ok") { s.status = "ok"; s.lastError = null; save(); }
    return body;
  } catch (e) {
    r.errors++;
    const dead = e.bad && [40, 41, 42, 43, 44].includes(e.code); // wrong login or unsupported auth
    s.status = dead ? "dead" : "down";
    s.lastError = e.name === "TimeoutError" ? "Timed out" : e.bad || e.down ? e.message : "Can't reach the server";
    save();
    throw e;
  }
}

// Sign in once with the password, keep only the salted token.
function credentials(password) {
  const salt = crypto.randomBytes(8).toString("hex");
  return { salt, token: crypto.createHash("md5").update(password + salt).digest("hex") };
}
export async function addServer({ label, url, username, password }) {
  username = String(username || "").trim();
  password = String(password || "");
  if (!username || !password) throw httpError(400, "Enter the username and password");
  const s = { id: rid(4), label: String(label || "").trim().slice(0, 30), url: cleanUrl(String(url || "").trim()), username: username.slice(0, 60), ...credentials(password), enabled: true, status: "starting", addedAt: Date.now() };
  s.label ||= new URL(s.url).hostname;
  if (servers().some((x) => x.url === s.url && x.username === s.username)) throw httpError(400, "That server is already added");
  try { await ask(s, "ping", {}, 10000); } catch (e) {
    throw httpError(400, e.bad ? (e.code === 40 ? "Wrong username or password" : e.message) : `Couldn't reach it: ${e.message}`);
  }
  db.subsonic[s.id] = s;
  save();
  return s;
}
export async function setPassword(s, password) {
  const old = { salt: s.salt, token: s.token };
  Object.assign(s, credentials(String(password)));
  try { await ask(s, "ping", {}, 10000); } catch (e) { Object.assign(s, old); throw httpError(400, e.bad ? "Wrong username or password" : `Couldn't reach it: ${e.message}`); }
  save();
}
export function removeServer(id) {
  if (!db.subsonic?.[id]) throw httpError(404, "No such server");
  delete db.subsonic[id];
  rt.delete(id);
  save();
}
export function setDirect(s, on) {
  if (on && !/^https:\/\//.test(s.url)) throw httpError(400, "Direct streaming needs an https:// address the phone can reach");
  s.direct = !!on;
}
// Cover art for the web player, fetched with the server's login so the picture never carries it.
export async function cover(sid, coverId, size = 400) {
  const s = get(sid);
  if (!s || !s.enabled) throw httpError(404, "That server isn't available");
  const url = endpoint(s, "getCoverArt", { id: coverId, size });
  url.searchParams.delete("f");
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok || !/^image\//.test(res.headers.get("content-type") || "")) throw httpError(404, "No cover");
  return res;
}
export const get = (id) => db.subsonic?.[id];
export async function test(s) { try { await ask(s, "ping", {}, 10000); } catch { /* status is set */ } return s; }
export const any = () => servers().some((s) => s.enabled && s.status !== "dead");

export const view = (s) => ({ id: s.id, label: s.label, url: s.url, username: s.username, enabled: s.enabled, direct: !!s.direct, normalize: !!s.normalize, status: s.enabled ? s.status : "disabled", lastError: s.lastError || null, addedAt: s.addedAt, requests: R(s.id).requests, errors: R(s.id).errors, avgMs: Math.round(R(s.id).avgMs), lastOkAt: R(s.id).lastOkAt });
export const allViews = () => servers().map(view);

export function boot() {
  for (const s of servers()) { s.status = "starting"; test(s); }
  setInterval(() => { for (const s of servers()) if (s.enabled && s.status !== "ok") test(s); }, 5 * 60 * 1000).unref();
}

// ---- search and streaming ----------------------------------------------------------------------
const LOSSLESS = new Set(["flac", "alac", "wav", "aiff", "aif", "ape", "wv", "dsf", "dff", "wma lossless"]);
export const rowId = (s, songId) => `sub:${s.id}:${songId}`;
export const parseId = (id) => { const m = /^sub:([a-f0-9]+):(.+)$/.exec(id); return m && { server: m[1], song: m[2] }; };

const songsFor = async (s, query, count) => [].concat((await ask(s, "search3", { query, songCount: count, artistCount: 0, albumCount: 0 }, 6000)).searchResult3?.song || []);
// Whole-library fallback: list every song (empty search3, cached 10 min) and match the words against title, artist and album.
const libs = new Map();
async function library(s) {
  const hit = libs.get(s.id);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.songs;
  const all = [];
  for (let off = 0; off < 20000; off += 500) {
    const page = [].concat((await ask(s, "search3", { query: "", songCount: 500, songOffset: off, artistCount: 0, albumCount: 0 }, 15000)).searchResult3?.song || []);
    all.push(...page);
    if (page.length < 500) break;
  }
  libs.set(s.id, { at: Date.now(), songs: all });
  return all;
}
async function local(s, q, count) {
  const w = norm(q).split(" ").filter(Boolean);
  if (!w.length) return [];
  return (await library(s)).filter((t) => { const h = norm(`${t.title} ${t.artist} ${t.displayArtist || ""} ${t.album || ""}`); return t.id && t.title && w.every((x) => h.includes(x)); }).slice(0, count);
}
export async function search(q, { count = 25 } = {}) {
  const live = servers().filter((s) => s.enabled && s.status !== "dead" && s.status !== "down");
  const lists = await Promise.all(live.map(async (s) => {
    try {
      let songs = await songsFor(s, q, count);
      // Many servers only match titles, so "artist title" finds nothing: retry with words trimmed off the ends.
      if (!songs.length) {
        const w = norm(q).split(" ").filter(Boolean), tried = new Set([w.join(" ")]);
        const cands = [];
        for (let len = w.length - 1; len >= Math.max(2, Math.ceil(w.length / 2)); len--) for (let i = 0; i + len <= w.length; i++) cands.push(w.slice(i, i + len).join(" "));
        for (const c of cands.slice(0, 6)) {
          if (tried.has(c)) continue;
          tried.add(c);
          songs = (await songsFor(s, c, count)).filter((t) => w.filter((x) => norm(`${t.title} ${t.artist} ${t.album || ""}`).includes(x)).length >= w.length / 2);
          if (songs.length) break;
        }
      }
      if (!songs.length) songs = await local(s, q, count); // e.g. artist-only queries, or titles the server's own search can't match
      return songs.map((t) => {
        const suffix = String(t.suffix || "").toLowerCase();
        return {
          id: rowId(s, t.id), title: t.title, artist: t.artist || "", album: t.album, duration: t.duration,
          format: suffix || undefined, audioQuality: LOSSLESS.has(suffix) ? "LOSSLESS" : "HIGH", source: s.label, ...(t.coverArt ? { coverArt: String(t.coverArt) } : {}),
        };
      });
    } catch { return []; }
  }));
  // Interleave so one server can't bury another.
  const out = [];
  for (let i = 0; out.length < count && lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && out.length < count) out.push(l[i]);
  return out;
}

export async function song(sid, songId) {
  const s = get(sid);
  if (!s || !s.enabled) throw httpError(404, "That server isn't available");
  let body;
  try { body = await ask(s, "getSong", { id: songId }, 6000); } catch (e) { throw httpError(e.bad ? 404 : 502, "Not found on the Subsonic server"); }
  if (!body.song) throw httpError(404, "Not found on the Subsonic server");
  return { server: s, song: body.song };
}
const KBPS = { HIGH: 320, LOW: 96 };
// Lossy tiers of a lossless file become our own AAC when ffmpeg is installed here (else the server's mp3); lossy files are never re-encoded.
// With "normalize" on, every song is re-encoded at a fixed loudness: lossless stays FLAC at the lossless tiers, anything else becomes AAC.
const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const TARGET_LUFS = -14;
const plan = (song, tier, server) => {
  const suffix = String(song.suffix || "").toLowerCase(), lossless = LOSSLESS.has(suffix), lossyTier = tier === "HIGH" || tier === "LOW";
  if (server?.normalize && HAS_FFMPEG) {
    if (lossless && !lossyTier) return { mode: "flac", ext: "flac", norm: true, codec: "flac", container: "flac", kbps: undefined };
    return { mode: "aac", ext: "m4a", norm: true, codec: "aac", container: "mp4", kbps: tier === "LOW" ? KBPS.LOW : KBPS.HIGH };
  }
  const convert = lossless && lossyTier;
  const mode = !convert ? "raw" : HAS_FFMPEG ? "aac" : "mp3";
  return mode === "raw" ? { mode, codec: suffix || "mp3", container: suffix || undefined, kbps: song.bitRate } : { mode, ext: "m4a", codec: mode, container: mode === "aac" ? "mp4" : "mp3", kbps: KBPS[tier] };
};
const built = (p) => p.mode === "aac" || p.mode === "flac";

// ---- converted songs: kept on disk, newest 100 (and at most 3 GB) ------------------------------------
const CACHE_DIR = process.env.AUDIO_CACHE_DIR || new URL("../audio-cache", import.meta.url).pathname;
const CACHE_MAX = 100, CACHE_BYTES = 3e9;
fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
function prune(boot = false) {
  const files = fs.readdirSync(CACHE_DIR);
  for (const f of files) if (/\.(part|src)$/.test(f) && (boot || Date.now() - fs.statSync(`${CACHE_DIR}/${f}`).mtimeMs > 15 * 60 * 1000)) fs.rmSync(`${CACHE_DIR}/${f}`, { force: true }); // never another build's work in progress
  let bytes = 0, n = 0;
  files.filter((f) => /\.(m4a|flac)$/.test(f)).map((f) => { const st = fs.statSync(`${CACHE_DIR}/${f}`); return [f, st.mtimeMs, st.size]; }).sort((x, y) => y[1] - x[1])
    .forEach(([f, , size]) => { if (++n > CACHE_MAX || (bytes += size) > CACHE_BYTES) fs.rmSync(`${CACHE_DIR}/${f}`, { force: true }); });
}
prune(true);
const builds = new Map();
let busy = 0;
const queue = [];
const slot = () => (busy >= 2 && queue.length >= 12 ? Promise.reject(Object.assign(httpError(429, "Busy: too many conversions queued"), { retryAfter: "5" })) : new Promise((ok) => { const go = () => { busy++; ok(); }; busy < 2 ? go() : queue.push(go); })); // two at a time: the box has two cores; at most 12 waiting
const free = () => { busy--; queue.shift()?.(); };
const run = (cmd, args, ms, input) => new Promise((ok, bad) => {
  const c = spawn(cmd, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
  let out = "", err = "";
  c.stdout.on("data", (d) => (out += d));
  c.stderr.on("data", (d) => (err += d));
  if (input) { c.stdin.on("error", () => {}); input.on("error", () => c.kill()); input.pipe(c.stdin); }
  const t = setTimeout(() => { c.kill("SIGKILL"); bad(new Error("conversion timed out")); }, ms);
  c.on("close", (code) => { clearTimeout(t); code === 0 ? ok({ out, err }) : bad(new Error(`${cmd} failed: ${err.slice(-200)}`)); });
});
// One steady gain per song (measured once) plus a limiter just under full scale, so quiet songs come up without clipping.
async function gainFor(src) {
  const { err } = await run("ffmpeg", ["-nostdin", "-i", src, "-vn", "-af", `loudnorm=I=${TARGET_LUFS}:TP=-1:LRA=11:print_format=json`, "-f", "null", "-"], 240000);
  const lufs = Number((err.match(/"input_i"\s*:\s*"(-?[\d.]+|-?inf)"/) || [])[1]);
  return Number.isFinite(lufs) ? Math.max(-12, Math.min(18, TARGET_LUFS - lufs)) : 0;
}
async function depthOf(src) {
  try {
    const { out } = await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=bits_per_raw_sample,bits_per_sample", "-of", "csv=p=0", src], 15000);
    return Math.max(16, ...out.trim().split(/[,\s]+/).map(Number).filter(Number.isFinite));
  } catch { return 16; }
}
export function convert(sid, songId, tier) {
  const job = (async () => {
    const { server, song: t } = await song(sid, songId), p = plan(t, tier, server);
    if (!built(p)) throw httpError(400, "Nothing to convert");
    const key = `${sid}-${songId}-${tier}-${p.ext}${p.norm ? "-n" : ""}`.replace(/[^\w.-]/g, "_"), file = `${CACHE_DIR}/${key}.${p.ext}`;
    if (fs.existsSync(file)) { fs.utimesSync(file, new Date(), new Date()); return file; }
    if (!builds.has(key)) {
      const work = (async () => {
        await slot();
        const tmp = `${file}.part`, src = `${file}.src`;
        try {
          const res = await fetch(endpoint(server, "stream", { id: songId, format: "raw" }), { signal: AbortSignal.timeout(180000) }); // the login never goes on ffmpeg's command line
          if (!res.ok || /json|xml/.test(res.headers.get("content-type") || "")) throw httpError(502, "The Subsonic server wouldn't stream that");
          const body = Readable.fromWeb(res.body);
          const codec = p.mode === "aac" ? ["-c:a", "aac", "-b:a", `${p.kbps}k`, "-movflags", "+faststart", "-f", "mp4"] : null;
          let args, input = null;
          if (p.norm) { // measure first, so the song is saved to a file
            await new Promise((ok, bad) => body.pipe(fs.createWriteStream(src)).on("finish", ok).on("error", bad));
            const gain = await gainFor(src), af = Math.abs(gain) > 0.3 ? ["-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=0.891:level=0`] : [];
            const depth = p.mode === "flac" ? await depthOf(src) : 16;
            args = ["-v", "error", "-nostdin", "-i", src, "-vn", "-map_metadata", "-1", ...af, ...(codec || ["-c:a", "flac", "-sample_fmt", depth > 16 ? "s32" : "s16", ...(depth > 16 ? ["-bits_per_raw_sample", String(depth)] : []), "-f", "flac"]), "-y", tmp];
          } else { args = ["-v", "error", "-nostdin", "-i", "pipe:0", "-vn", "-map_metadata", "-1", ...codec, "-y", tmp]; input = body; }
          await run("ffmpeg", args, 300000, input);
          fs.renameSync(tmp, file);
          prune();
          return file;
        } catch (e) { fs.rmSync(tmp, { force: true }); throw e.status ? e : httpError(502, e.message); } finally { fs.rmSync(src, { force: true }); free(); }
      })();
      builds.set(key, work);
      work.catch(() => {}).finally(() => builds.delete(key));
    }
    return builds.get(key);
  })();
  return job;
}
// Servers like gonic don't report sample rate or bit depth, so read them from the FLAC header (first bytes of the file).
const probed = new Map();
async function probe(server, songId) {
  const key = `${server.id}/${songId}`;
  if (probed.has(key)) return probed.get(key);
  let info = {};
  try {
    const res = await fetch(endpoint(server, "stream", { id: songId, format: "raw" }), { headers: { Range: "bytes=0-4095" }, signal: AbortSignal.timeout(6000) });
    const b = Buffer.from(await res.arrayBuffer()).subarray(0, 4096);
    if (b.length >= 22 && b.subarray(0, 4).toString() === "fLaC") info = { rate: (b[18] << 12) | (b[19] << 4) | (b[20] >> 4), depth: (((b[20] & 1) << 4) | (b[21] >> 4)) + 1 };
  } catch { /* best effort */ }
  probed.set(key, info);
  if (probed.size > 5000) probed.delete(probed.keys().next().value);
  return info;
}
// The stream response BitChord gets. The URL is this server's own proxy, so the Subsonic login stays hidden.
export async function streamBody({ server, song: t }, tier, base, signQ) {
  const p = plan(t, tier, server);
  let rate = t.samplingRate, depth = t.bitDepth;
  if ((p.mode === "raw" || p.mode === "flac") && p.codec === "flac" && (!rate || !depth)) { const i = await probe(server, t.id); rate ||= i.rate; depth ||= i.depth; }
  const lossless = LOSSLESS.has(String(t.suffix || "").toLowerCase()) && p.mode === "raw";
  if (built(p)) convert(server.id, t.id, tier).catch(() => {}); // start converting while the player connects
  // "Direct" servers hand the player their own URL (it carries the server's login token), so audio skips this server. Converted songs can't go direct.
  const url = server.direct && !built(p) ? (() => { const u = endpoint(server, "stream", { id: t.id, ...(p.mode === "mp3" ? { format: "mp3", maxBitRate: p.kbps } : { format: "raw" }) }); u.searchParams.delete("f"); return u.href; })() : `${base}/sub/${server.id}/${encodeURIComponent(t.id)}?q=${tier}${signQ ? `&${signQ(`${server.id}/${t.id}`, tier)}` : ""}`;
  return {
    url, format: p.codec, codec: p.codec, container: p.container, manifest: "none", encrypted: false,
    quality: p.mode === "aac" ? `AAC ${p.kbps} kbps${p.norm ? " · normalized" : ""}` : p.mode === "flac" ? (rate && depth ? `Lossless · ${depth}-bit / ${rate / 1000} kHz · normalized` : "Lossless · normalized") : p.mode === "mp3" ? `MP3 ${p.kbps} kbps` : lossless ? (rate && depth ? `Lossless · ${depth}-bit / ${rate / 1000} kHz` : "Lossless") : `Original ${String(t.suffix || "").toUpperCase()}`,
    ...(p.kbps ? { bitrate: p.kbps * 1000 } : {}), ...(rate ? { sampleRate: rate } : {}), ...(depth ? { bitDepth: depth } : {}),
  };
}
// Opens the audio for the proxy route: { file } for a converted song, else the server's own response (with Range, so players can seek).
export async function open(sid, songId, tier, range, signal) {
  const { server, song: t } = await song(sid, songId);
  const p = plan(t, tier, server);
  if (built(p)) return { file: await convert(sid, songId, tier), mime: p.mode === "flac" ? "audio/flac" : "audio/mp4" };
  const url = endpoint(server, "stream", { id: songId, ...(p.mode === "mp3" ? { format: "mp3", maxBitRate: KBPS[tier] } : { format: "raw" }) });
  const res = await fetch(url, { headers: range && p.mode === "raw" ? { Range: range } : {}, signal });
  if (!res.ok || /json|xml/.test(res.headers.get("content-type") || "")) throw httpError(502, "The Subsonic server wouldn't stream that");
  R(server.id).requests++;
  return res;
}

// Stand-in for a TIDAL track that fails: look for the same title and length on the Subsonic servers.
const norm = (x) => String(x || "").toLowerCase().replace(/\(.*?\)|\[.*?\]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export async function stand({ title, artist, duration }) {
  if (!any() || !title) return null;
  const rows = await search(`${artist ? artist.split(",")[0] + " " : ""}${title}`.trim(), { count: 20 });
  const t = norm(title), a = norm(artist);
  return rows.find((r) => {
    const rt_ = norm(r.title);
    const sameTitle = rt_ === t || (rt_.length > 3 && t.length > 3 && (rt_.includes(t) || t.includes(rt_)));
    const sameLen = !duration || !r.duration || Math.abs(r.duration - duration) <= 4;
    const sameArtist = !a || !norm(r.artist) || norm(r.artist).includes(a.split(" ")[0]) || a.includes(norm(r.artist).split(" ")[0]);
    return sameTitle && sameLen && sameArtist;
  }) || null;
}
