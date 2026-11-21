// Music videos for Eclipse, found on YouTube with yt-dlp. Only real video uploads count: YouTube's
// auto-generated "Artist - Topic" channels are just the audio over a still picture, so they never match.
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { db, save } from "./store.mjs";

const VENV = new URL("../venv/bin/", import.meta.url).pathname;
const BIN = process.env.YTDLP || `${VENV}yt-dlp`;
// yt-dlp needs a JavaScript runtime for YouTube; deno from the same environment (its solver scripts come from yt-dlp-ejs).
const ARGS = ["--no-warnings", "--no-playlist", "--js-runtimes", process.env.YTDLP_JS || `deno:${VENV}deno`];
export const available = () => fs.existsSync(BIN);

let busy = 0;
const queue = [];
const slot = () => (busy >= 2 && queue.length >= 12 ? Promise.reject(Object.assign(new Error("Busy: too many videos queued"), { status: 429, retryAfter: "5" })) : new Promise((ok) => { const go = () => { busy++; ok(); }; busy < 2 ? go() : queue.push(go); })); // at most 12 waiting
const free = () => { busy--; queue.shift()?.(); };
async function ytdlp(args, ms = 25000, onLine = null) {
  await slot();
  try {
    return await new Promise((ok, bad) => {
      const c = spawn(BIN, [...ARGS, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      let buf = "";
      c.stdout.on("data", (d) => { out += d; if (onLine) { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } } }); // progress lines, as they come
      c.stderr.on("data", (d) => (err += d));
      const t = setTimeout(() => { c.kill("SIGKILL"); bad(new Error("yt-dlp timed out")); }, ms);
      c.on("error", bad);
      c.on("close", (code) => { clearTimeout(t); code === 0 ? ok(out) : bad(new Error(err.slice(-200) || `yt-dlp exited ${code}`)); });
    });
  } finally { free(); }
}

const norm = (x) => String(x || "").toLowerCase().replace(/\(.*?\)|\[.*?\]|【.*?】/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// A song is known by its first artist and its title, so the two players (one sends every artist, the other only the first) find the same video.
const firstArtist = (a) => String(a || "").split(/\s*,\s*|\s+(?:feat\.?|ft\.?|&)\s+/i)[0];
export const keyOf = (artist, title) => `${norm(firstArtist(artist))}|${norm(title)}`;
const legacyKey = (artist, title) => `${norm(artist)}|${norm(title)}`; // how a video set by hand was saved before: every artist in the key
const handFor = (meta) => {
  const all = overrides(), key = keyOf(meta.artist, meta.title);
  return all[key] || all[legacyKey(meta.artist, meta.title)] || Object.values(all).find((o) => o && keyOf(o.artist, o.title) === key); // an old entry (every artist in its key) still matches by its first artist
};
// Videos that search can't find (unlisted, or the wrong one comes first) are set by hand: song -> YouTube id.
const YT = /(?:v=|youtu\.be\/|shorts\/|embed\/|^)([\w-]{11})(?:[&?/]|$)/;
const sources = new Map(); // video id -> the page yt-dlp reads it from
// A link from YouTube keeps its own 11-character id; any other site gets a stable id made from the link.
export function idFrom(link) {
  link = String(link || "").trim();
  if (/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(link) || /^[\w-]{11}$/.test(link)) { const m = link.match(YT); if (m) { sources.set(m[1], `https://www.youtube.com/watch?v=${m[1]}`); return m[1]; } return null; }
  if (/^https?:\/\/[^\s]{4,500}$/i.test(link)) { const id = `x${crypto.createHash("sha1").update(link).digest("base64url").slice(0, 10)}`; sources.set(id, link); return id; }
  return null;
}
export const overrides = () => db.videos || (db.videos = {});
export const overrideFor = (meta) => (meta?.title ? handFor(meta) : undefined);
// A YouTube link or a bare id, and nothing else: what a member may submit (an admin can use any site yt-dlp reads).
export function youtubeId(link) {
  link = String(link || "").trim();
  if (!(/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(link) || /^[\w-]{11}$/.test(link))) return null;
  return (link.match(YT) || [])[1] || null;
}
// Checks a YouTube video before it is saved for a song: it exists, it isn't a live stream, and it's the length of a music video.
export async function probe(id) {
  let j;
  try { j = JSON.parse(await ytdlp(["--dump-single-json", "--skip-download", `https://www.youtube.com/watch?v=${id}`], 30000)); }
  catch { throw Object.assign(new Error("That video isn't available"), { status: 400 }); }
  if (j.is_live || j.live_status === "is_live" || j.live_status === "is_upcoming") throw Object.assign(new Error("That's a live stream, not a music video"), { status: 400 });
  if (!(j.duration >= 30 && j.duration <= 900)) throw Object.assign(new Error("A music video should be between 30 seconds and 15 minutes"), { status: 400 });
  return { title: String(j.title || "").slice(0, 120), duration: j.duration, channel: String(j.channel || j.uploader || "").slice(0, 60) };
}
// extra: offset (video time = song time + offset, seconds, may be negative), end (where the music stops inside the video), hidden (no video for this song), by.
export function setOverride(artist, title, link, extra = {}) {
  const id = idFrom(link);
  if (!id || !String(title || "").trim()) throw Object.assign(new Error("Enter the song and a link to the video"), { status: 400 });
  const key = keyOf(artist, title), num = (x) => (x === "" || x == null ? NaN : Number(x));
  const offset = num(extra.offset), end = num(extra.end);
  overrides()[key] = {
    id, url: sources.get(id), artist: String(artist || "").trim().slice(0, 80), title: String(title).trim().slice(0, 120), at: Date.now(),
    ...(extra.by ? { by: extra.by } : {}), ...(Number.isFinite(offset) ? { offset: Math.max(-120, Math.min(120, offset)) } : {}),
    ...(end > 0 ? { end: Math.min(3600, end) } : {}), ...(extra.hidden ? { hidden: true } : {}),
  };
  found.delete(key);
  save();
  return key;
}
export function removeOverride(key) { delete overrides()[key]; found.delete(key); save(); }
const JUNK = /\b(cover|remix|slowed|sped up|speed up|nightcore|reverb|8d|instrumental|karaoke|reaction|tribute|1 hour|loop|live|acoustic|lyrics?|lyric video|fan ?made|amv|mashup)\b/i;
const isTopic = (e) => /-\s*topic$/i.test(String(e.channel || e.uploader || ""));

export function pick(entries, { title, artist, duration }) {
  const t = norm(title), a = norm(artist).split(" ")[0];
  let best = null;
  for (const e of entries || []) {
    if (!e?.id || isTopic(e)) continue;                                      // not the Spotify-like audio upload
    const et = norm(e.title), who = norm(`${e.channel || ""} ${e.uploader || ""}`);
    if (!t || !et.includes(t)) continue;                                      // the song's name has to be in the video's
    if (a && !(et.includes(a) || who.includes(a))) continue;                  // and the artist in the title or the channel
    if (JUNK.test(e.title) && !JUNK.test(title)) continue;                    // covers, remixes, lyric videos…
    const diff = duration && e.duration ? Math.abs(e.duration - duration) : 0;
    if (duration && e.duration && diff > Math.max(10, duration * 0.08)) continue;
    const score = (norm(e.channel || e.uploader) === norm(artist) ? 3 : who.includes(a) ? 1.5 : 0) + (/official/i.test(e.title) ? 1 : 0) - diff / 10;
    if (!best || score > best.score) best = { score, id: e.id, duration: e.duration || null, channel: e.channel || e.uploader };
  }
  return best;
}

// ---- videos that are only a still picture (an official "audio" upload: the song over an album cover or a title card) ----
// Not a music video, so they never count: a frame every few seconds is compared with the one before, and a picture that never changes is remembered here.
const STILL_FILE = process.env.VIDEO_STILL_FILE || new URL("../video-still.json", import.meta.url).pathname;
const STILL = new Set();
try { for (const id of JSON.parse(fs.readFileSync(STILL_FILE, "utf8"))) STILL.add(id); } catch { /* none yet */ }
const CHECKED = new Set(); // ids that were checked and do move
export const isStill = (id) => STILL.has(id);
function markStill(id) {
  STILL.add(id);
  try { fs.writeFileSync(STILL_FILE, JSON.stringify([...STILL]), { mode: 0o600 }); } catch { /* not saved: found again next time */ }
  for (const [k, h] of found) if (h.v?.id === id) found.delete(k); // look again: the next best match may be a real video
}
function stillPicture(file) {
  return new Promise((resolve) => {
    const W = 32, H = 18, N = W * H, chunks = [];
    const p = spawn("ffmpeg", ["-v", "error", "-i", file, "-an", "-vf", `fps=1/6,scale=${W}:${H},format=gray`, "-frames:v", "40", "-f", "rawvideo", "-"], { stdio: ["ignore", "pipe", "ignore"] });
    const kill = setTimeout(() => p.kill("SIGKILL"), 60000);
    p.stdout.on("data", (d) => chunks.push(d));
    p.on("error", () => { clearTimeout(kill); resolve(false); });
    p.on("close", () => {
      clearTimeout(kill);
      const b = Buffer.concat(chunks), n = Math.floor(b.length / N);
      if (n < 4) return resolve(false); // too short to tell
      let most = 0;
      for (let f = 1; f < n; f++) { let d = 0; for (let i = 0; i < N; i++) d += Math.abs(b[f * N + i] - b[(f - 1) * N + i]); most = Math.max(most, d / N); }
      resolve(most < 1.5); // the average change in brightness between frames, out of 255: compression noise only
    });
  });
}
// true when this saved video is just a picture (deleted and remembered); false when it moves, or isn't saved yet
async function checkStill(id) {
  if (STILL.has(id)) return true;
  if (CHECKED.has(id)) return false;
  const file = `${DIR}/${id}.mp4`;
  if (!fs.existsSync(file)) return false;
  if (await stillPicture(file)) { markStill(id); fs.rmSync(file, { force: true }); return true; }
  CHECKED.add(id);
  return false;
}
const found = new Map(); // "artist|title" -> { at, v }
const ALLOWED = new Set(); // only ids we found ourselves can go through the proxy
export const allowed = (id) => ALLOWED.has(id);

async function search(meta) {
  const q = `${String(meta.artist || "").split(",")[0]} ${meta.title}`.trim();
  const out = await ytdlp(["--flat-playlist", "-J", `ytsearch8:${q}`]);
  return pick((JSON.parse(out).entries || []).filter((e) => !STILL.has(e?.id)), meta);
}
// ---- the videos themselves: downloaded once with yt-dlp and kept on disk (newest 100, at most 1 GB) ----------------
// YouTube refuses its direct links to some videos when a server asks, so the file is fetched the way yt-dlp does it and served from here.
// This also covers streaming playlists (HLS) and plain file links: yt-dlp saves them all as one mp4.
const DIR = process.env.VIDEO_CACHE_DIR || new URL("../video-cache", import.meta.url).pathname;
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
function prune(boot = false) {
  const files = fs.readdirSync(DIR);
  for (const f of files) if (!f.endsWith(".mp4") && (boot || Date.now() - fs.statSync(`${DIR}/${f}`).mtimeMs > 15 * 60 * 1000)) fs.rmSync(`${DIR}/${f}`, { force: true }); // leftovers of a download that didn't finish
  let n = 0, bytes = 0;
  files.filter((f) => f.endsWith(".mp4")).map((f) => { const st = fs.statSync(`${DIR}/${f}`); return [f, st.mtimeMs, st.size]; }).sort((x, y) => y[1] - x[1])
    .forEach(([f, , size]) => { if (++n > 100 || (bytes += size) > 1e9) fs.rmSync(`${DIR}/${f}`, { force: true }); });
}
prune(true);
const downloads = new Map();
// How a video's download is going, for the player's progress bar: queued, then downloading (pct 0-100 over the video and audio parts), then finishing.
const prog = new Map(); // id -> { state, pct, at }
const setProg = (id, v) => { prog.set(id, { ...v, at: Date.now() }); if (prog.size > 200) prog.delete(prog.keys().next().value); };
export function fileFor(id) {
  const file = `${DIR}/${id}.mp4`;
  if (fs.existsSync(file)) { fs.utimesSync(file, new Date(), new Date()); return checkStill(id).then((still) => { if (still) throw Object.assign(new Error("still picture"), { still: true }); return file; }); }
  if (!downloads.has(id)) {
    const page = sources.get(id) || `https://www.youtube.com/watch?v=${id}`;
    // Eclipse wants one file with picture and sound together (muxed) so it plays everywhere: 480p h264 plus the audio, merged into one mp4
    setProg(id, { state: "queued", pct: 0 });
    let part = 0, last = "", top = 0;
    const onLine = (l) => { // "PRG <file> <downloaded> <total> <estimated total>": the video part is most of the work, the audio part the rest
      const m = /^PRG (\S+) (\d+) (\d+) (\d+)/.exec(l);
      if (!m) return;
      if (last && m[1] !== last) part++; // a new file started: the audio after the video
      last = m[1];
      const total = Number(m[3]) || Number(m[4]) || 0, f = total ? Math.min(1, Number(m[2]) / total) : 0;
      const pct = part === 0 ? f * 88 : 88 + f * 10; // 0-88% the picture, 88-98% the sound, then putting them together
      top = Math.max(top, Math.round(pct));
      setProg(id, { state: "downloading", pct: top });
    };
    const job = ytdlp(["-f", "bv*[height<=480][vcodec^=avc1]+ba[ext=m4a]/b[height<=480][vcodec^=avc1]/18/b[height<=480]/b", "--merge-output-format", "mp4", "--remux-video", "mp4", "--max-filesize", "80M", "--progress", "--newline", "--progress-template", "download:PRG %(progress.filename)s %(progress.downloaded_bytes|0)s %(progress.total_bytes|0)s %(progress.total_bytes_estimate|0)s", "-o", `${DIR}/${id}.%(ext)s`, page], 120000, onLine)
      .then(async () => {
        if (!fs.existsSync(file)) throw new Error("no video file");
        prune();
        if (await checkStill(id)) throw Object.assign(new Error("still picture"), { still: true }); // only a picture: not a music video
        setProg(id, { state: "ready", pct: 100 });
        return file;
      });
    downloads.set(id, job);
    job.catch((e) => setProg(id, { state: "error", pct: 0, error: String(e.message || e).slice(0, 120) })).finally(() => downloads.delete(id));
  }
  return downloads.get(id);
}

// What the player should show while a song's video comes: finding it, queued, downloading (with how far), ready, or none.
export function statusFor(meta) {
  if (!available() || !meta?.title) return { state: "none" };
  const k = known(meta);
  if (k === null) return { state: "none" };
  if (k === undefined) return { state: "finding" };
  if (fs.existsSync(`${DIR}/${k.id}.mp4`)) return { state: "ready", pct: 100 };
  const p = prog.get(k.id);
  if (!p) return { state: downloads.has(k.id) ? "queued" : "finding", pct: 0 };
  if (p.state === "downloading" && p.pct >= 98) return { state: "finishing", pct: p.pct }; // both parts are in; they're being joined
  return { state: p.state, pct: p.pct, ...(p.error ? { error: p.error } : {}) };
}
const sizes = new Map();
function sizeOf(id) { // width and height of the saved file, once it exists
  if (sizes.has(id)) return sizes.get(id);
  const file = `${DIR}/${id}.mp4`;
  if (!fs.existsSync(file)) return {};
  const o = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim().split(",").map(Number);
  const v = o.length === 2 && o[0] && o[1] ? { width: o[0], height: o[1] } : {};
  sizes.set(id, v);
  return v;
}
// What's already known about a song's video: undefined = never looked up, null = looked up and none, else the video.
export function known(meta) {
  if (!available() || !meta?.title) return null;
  const key = keyOf(meta.artist, meta.title), hand = handFor(meta);
  if (hand) return hand.hidden ? null : { id: hand.id, ...sizeOf(hand.id) };
  const hit = found.get(key);
  if (!hit || Date.now() - hit.at > (hit.v ? 24 : 1) * 3600 * 1000) return undefined;
  return hit.v && (STILL.has(hit.v.id) ? null : { ...hit.v, ...sizeOf(hit.v.id) });
}
// The video for a song, or null. Cached, so only a song's first play pays for the lookup.
export async function forTrack(meta, again = false) {
  if (!available() || !meta?.title) return null;
  const key = keyOf(meta.artist, meta.title), hand = handFor(meta);
  if (hand) { if (hand.hidden) return null; ALLOWED.add(hand.id); fileFor(hand.id).catch(() => {}); return { id: hand.id, channel: "set by hand" }; }
  const hit = found.get(key);
  if (hit && Date.now() - hit.at < (hit.v ? 24 : 1) * 3600 * 1000) {
    if (hit.v && (await checkStill(hit.v.id))) return again ? null : forTrack(meta, true); // a video that is only a picture: pick another
    if (hit.v) fileFor(hit.v.id).catch(() => {});
    return hit.v;
  }
  try {
    let m = await search(meta);
    if (m && (await checkStill(m.id))) return again ? null : forTrack(meta, true); // already saved from before, and only a picture: look again
    if (m) { sources.set(m.id, `https://www.youtube.com/watch?v=${m.id}`); ALLOWED.add(m.id); if (ALLOWED.size > 2000) ALLOWED.delete(ALLOWED.values().next().value); fileFor(m.id).catch(() => {}); }
    found.set(key, { at: Date.now(), v: m });
    if (found.size > 3000) found.delete(found.keys().next().value);
    return m;
  } catch { return null; }
}

// ---- lining the video up with the song --------------------------------------------------------------
// A music video often starts earlier or later than the song (an intro, a different cut). Both soundtracks are decoded to a low-rate
// mono signal and cross-correlated (with an FFT); the peak says how far apart they are: videoTime = songTime + offset.
const RATE = 2000;
const SYNC_FILE = process.env.VIDEO_SYNC_FILE || new URL("../video-sync.json", import.meta.url).pathname;
let syncs = {};
try { syncs = JSON.parse(fs.readFileSync(SYNC_FILE, "utf8")); } catch { /* none yet */ }
export const syncGet = (key) => syncs[key];
export function syncSet(key, v) {
  syncs[key] = v;
  const keys = Object.keys(syncs);
  if (keys.length > 1500) delete syncs[keys[0]];
  try { fs.writeFileSync(SYNC_FILE, JSON.stringify(syncs)); } catch { /* best effort */ }
}
function pcm(input, seconds) {
  return new Promise((ok, bad) => {
    const c = spawn("ffmpeg", ["-v", "error", "-nostdin", "-t", String(seconds), "-i", input.file || "pipe:0", "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "pipe:1"], { stdio: [input.stream ? "pipe" : "ignore", "pipe", "pipe"] });
    const chunks = []; let err = "";
    c.stdout.on("data", (d) => chunks.push(d));
    c.stderr.on("data", (d) => (err += d));
    if (input.stream) { c.stdin.on("error", () => {}); input.stream.on("error", () => c.kill()); input.stream.pipe(c.stdin); }
    const t = setTimeout(() => { c.kill("SIGKILL"); bad(new Error("decoding timed out")); }, 60000);
    c.on("close", () => {
      clearTimeout(t);
      input.stream?.destroy();
      const b = Buffer.concat(chunks), n = b.length >> 1, out = new Float64Array(n);
      if (n < RATE * 3) return bad(new Error(err.slice(-120) || "no audio"));
      let mean = 0;
      for (let i = 0; i < n; i++) mean += out[i] = b.readInt16LE(i * 2);
      mean /= n;
      for (let i = 0; i < n; i++) out[i] -= mean;
      ok(out);
    });
  });
}
function fft(re, im, inv) { // in place, size a power of two
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? -2 : 2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < h; j++) {
        const a = i + j, b = a + h, vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
const inflight = new Map();
// audio: { file } or { stream } of the song. Resolves { offset (seconds), ok, confidence }.
export function align(videoFile, audio, key) {
  if (!inflight.has(key)) {
    const job = (async () => {
      const [a, v] = await Promise.all([pcm(audio, 130), pcm({ file: videoFile }, 200)]);
      let N = 1; while (N < a.length + v.length) N <<= 1;
      const ar = new Float64Array(N), ai = new Float64Array(N), vr = new Float64Array(N), vi = new Float64Array(N);
      ar.set(a); vr.set(v);
      fft(ar, ai, false); fft(vr, vi, false);
      for (let i = 0; i < N; i++) { const r = ar[i] * vr[i] + ai[i] * vi[i], m = ar[i] * vi[i] - ai[i] * vr[i]; ar[i] = r; ai[i] = m; } // conj(song) * video
      fft(ar, ai, true); // ar[k] is now how well the video at time n+k matches the song at time n
      const reach = 60 * RATE, at = (k) => ar[k >= 0 ? k : N + k];
      let best = -Infinity, bk = 0;
      for (let k = -reach; k <= reach; k++) { const x = at(k); if (x > best) { best = x; bk = k; } }
      let second = 0;
      for (let k = -reach; k <= reach; k++) if (Math.abs(k - bk) > 0.2 * RATE) second = Math.max(second, at(k));
      const confidence = best > 0 ? (second > 0 ? best / second : 99) : 0;
      return { offset: bk / RATE, ok: best > 0 && confidence >= 1.4, confidence: +confidence.toFixed(2) };
    })();
    inflight.set(key, job);
    job.catch(() => {}).finally(() => inflight.delete(key));
  }
  return inflight.get(key);
}

// ---- an edited video: the song and the video compared section by section -----------------------------------------------------------------
// A radio edit or a music video often cuts parts of the song, so one offset fits only a piece of it. Here the song is matched in 10 second windows
// against the video; where the offset changes the picture jumps to the right place, and where the video has nothing that matches (a part that
// was cut, or the video ending early) the player shows the cover until the video picks up again.
const R2 = 1000; // the windows are matched at 1 kHz
const down2 = (x) => { const n = x.length >> 1, o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = x[2 * i] + x[2 * i + 1]; return o; };
function xcorr(win, region) { // lag k: how well the region at k matches the window
  let N = 1; while (N < region.length + win.length) N <<= 1;
  const ar = new Float64Array(N), ai = new Float64Array(N), vr = new Float64Array(N), vi = new Float64Array(N);
  ar.set(win); vr.set(region);
  fft(ar, ai, false); fft(vr, vi, false);
  for (let i = 0; i < N; i++) { const r = ar[i] * vr[i] + ai[i] * vi[i], m = ar[i] * vi[i] - ai[i] * vr[i]; ar[i] = r; ai[i] = m; }
  fft(ar, ai, true);
  return ar;
}
const tick = () => new Promise((r) => setImmediate(r)); // the matching is heavy: give the server a breath between windows
function legacyOffset(a, v) { // the single best offset from the first minutes (what align() finds)
  const A = a.subarray(0, 130 * RATE), V = v.subarray(0, 200 * RATE);
  let N = 1; while (N < A.length + V.length) N <<= 1;
  const ar = new Float64Array(N), ai = new Float64Array(N), vr = new Float64Array(N), vi = new Float64Array(N);
  ar.set(A); vr.set(V);
  fft(ar, ai, false); fft(vr, vi, false);
  for (let i = 0; i < N; i++) { const r = ar[i] * vr[i] + ai[i] * vi[i], m = ar[i] * vi[i] - ai[i] * vr[i]; ar[i] = r; ai[i] = m; }
  fft(ar, ai, true);
  const reach = 60 * RATE, at = (k) => ar[k >= 0 ? k : N + k];
  let best = -Infinity, bk = 0;
  for (let k = -reach; k <= reach; k++) { const x = at(k); if (x > best) { best = x; bk = k; } }
  let second = 0;
  for (let k = -reach; k <= reach; k++) if (Math.abs(k - bk) > 0.2 * RATE) second = Math.max(second, at(k));
  const confidence = best > 0 ? (second > 0 ? best / second : 99) : 0;
  return { offset: bk / RATE, ok: best > 0 && confidence >= 1.4, confidence: +confidence.toFixed(2) };
}
async function windows(a, v, first) {
  const a1 = down2(a), v1 = down2(v), W = 10 * R2, HOP = 5 * R2, n = a1.length;
  if (n < 3 * W || v1.length < 3 * W) return null;
  const pv = new Float64Array(v1.length + 1);
  for (let i = 0; i < v1.length; i++) pv[i + 1] = pv[i] + v1[i] * v1[i];
  // 1. for every window: its few best candidate matches in the video (a repeated chorus gives several)
  const K = 4, J = 0.6, REACH = 75 * R2, base = first.ok ? first.offset : 0, cands = [];
  for (let i = 0; i + W <= n; i += HOP) {
    const list = [], centre = i + Math.round(base * R2), r0 = Math.max(0, centre - REACH), r1 = Math.min(v1.length, centre + W + REACH);
    if (r1 - r0 >= W + 200) {
      const win = a1.subarray(i, i + W); let Ew = 0;
      for (let q = 0; q < W; q++) Ew += win[q] * win[q];
      if (Ew / W > 2e4) { // not silence
        const c = xcorr(win, v1.subarray(r0, r1)), top = r1 - r0 - W, ncc = new Float64Array(top + 1), used = [];
        for (let k = 0; k <= top; k++) ncc[k] = c[k] / Math.sqrt(Ew * (pv[r0 + k + W] - pv[r0 + k] + 1e-9));
        for (let m = 0; m < K; m++) {
          let b = 0.12, bk = -1;
          for (let k = 0; k <= top; k++) if (ncc[k] > b && used.every((u) => Math.abs(u - k) > 0.5 * R2)) { b = ncc[k]; bk = k; }
          if (bk < 0) break;
          used.push(bk); list.push({ off: (r0 + bk - i) / R2, ncc: b });
        }
      }
    }
    cands.push(list);
    await tick();
  }
  // 2. the path through them with the most total match: staying at an offset is free, a jump costs J, and the video never runs backwards.
  //    (Deciding window by window gets pulled to a look-alike chorus elsewhere in the video and can't get back.)
  const best = cands.map((l) => l.map(() => ({ s: 0, from: null })));
  let topAt = null, topS = 0;
  cands.forEach((list, i) => list.forEach((cd, ci) => {
    let bs = cd.ncc, from = null;
    for (let jx = Math.max(0, i - 8); jx < i; jx++) cands[jx].forEach((pj, cj) => {
      const same = Math.abs(pj.off - cd.off) <= 0.3;
      if (!same && i * 5 + cd.off < jx * 5 + pj.off - 1) return; // not back in the video
      const sc = best[jx][cj].s + cd.ncc - (same ? 0 : J);
      if (sc > bs) { bs = sc; from = [jx, cj]; }
    });
    best[i][ci] = { s: bs, from };
    if (bs > topS) { topS = bs; topAt = [i, ci]; }
  }));
  const offs = new Array(cands.length).fill(null);
  for (let at = topAt; at; at = best[at[0]][at[1]].from) offs[at[0]] = cands[at[0]][at[1]].off;
  // consecutive windows with the same offset make a run; a lone window is more likely a false match than a real section
  const runs = [];
  offs.forEach((o, i) => {
    if (o == null) return;
    const last = runs[runs.length - 1];
    if (last && Math.abs(o - last.off) <= 0.3 && i - last.end <= 6) { last.end = i; last.sum += o; last.n++; last.off = last.sum / last.n; } // the same offset after a short silence or look-alike stretch: one run
    else runs.push({ start: i, end: i, off: o, sum: o, n: 1 });
  });
  const keep = runs.filter((r) => r.n >= 2);
  if (!keep.length) return null;
  // how well one second of the song matches the video at an offset (-1 when the video isn't there)
  const sim = (t, off) => {
    const B = R2, ia = Math.round(t * R2), iv = ia + Math.round(off * R2);
    if (ia < 0 || ia + B > n || iv < 0 || iv + B > v1.length) return -1;
    let xy = 0, xx = 0, yy = 0;
    for (let j = 0; j < B; j++) { const x = a1[ia + j], y = v1[iv + j]; xy += x * y; xx += x * x; yy += y * y; }
    return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : -1;
  };
  const dur = n / R2;
  for (const r of keep) { // find where each run really begins and ends, to half a second
    // the windows overlap the cut by at least half, so the middle of the run is certainly inside it: start there and walk outwards while it still matches
    const t0 = r.start * 5, t1 = r.end * 5 + 10, mid = [];
    for (let t = t0 + 5; t < t1 - 5; t += 1) mid.push(sim(t, r.off));
    const ref = mid.sort((x, y) => x - y)[mid.length >> 1] || 0.2, thr = Math.max(0.08, ref * 0.4);
    let from = t0 + 5, to = t1 - 5;
    for (let t = from - 1; t > Math.max(-1, t0 - 10); t -= 0.5) { if (sim(t, r.off) >= thr) from = t; else break; }
    for (let t = to; t < Math.min(dur - 1, t1 + 10); t += 0.5) { if (sim(t, r.off) >= thr) to = t + 1; else break; }
    r.from = from <= 1 ? 0 : from; r.to = to >= dur - 1 ? dur : Math.min(dur, to);
  }
  const segs = [], gaps = [];
  keep.forEach((r, i) => {
    if (i === 0 && r.from >= 2) gaps.push([0, +r.from.toFixed(2)]); // the video hasn't begun yet
    if (i > 0) { const prev = keep[i - 1]; if (r.from - prev.to >= 2) gaps.push([+prev.to.toFixed(2), +r.from.toFixed(2)]); }
    segs.push({ from: +(i === 0 ? 0 : r.from).toFixed(2), off: +r.off.toFixed(3) });
  });
  const lastRun = keep[keep.length - 1];
  if (lastRun.to < dur - 2) gaps.push([+lastRun.to.toFixed(2), 1e6]); // the video ends before the song does
  return { segs, gaps, offs };
}
// Like align(), but the answer can say the video changes offset (segs: from song second, offset) or isn't there for a while (gaps: song seconds).
export function analyze(videoFile, audio, key) {
  const k = `analyze:${key}`;
  if (!inflight.has(k)) {
    const job = (async () => {
      const [a, v] = await Promise.all([pcm(audio, 900), pcm({ file: videoFile }, 900)]);
      const first = legacyOffset(a, v);
      let w = null;
      try { w = await windows(a, v, first); } catch { /* the single offset still stands */ }
      if (!w || (w.segs.length === 1 && !w.gaps.length)) return w?.segs.length === 1 ? { ...first, offset: w.segs[0].off, ok: true } : first; // one offset fits it all: as before
      return { offset: w.segs[0].off, ok: true, confidence: first.confidence, segs: w.segs, gaps: w.gaps };
    })();
    inflight.set(k, job);
    job.catch(() => {}).finally(() => inflight.delete(k));
  }
  return inflight.get(k);
}

export const _debug = { windows, legacyOffset, pcm, stillPicture }; // for tests

// yt-dlp breaks now and then when YouTube changes, but an automatic update would run whatever PyPI serves that day as the account that holds the
// secrets. So it only updates when asked: run tools/update-ytdlp.sh, or set YTDLP_AUTOUPDATE=1 to bring the daily update back.
if (available() && fs.existsSync(`${VENV}pip`) && process.env.YTDLP_AUTOUPDATE === "1") {
  const update = () => { spawn(`${VENV}pip`, ["install", "--no-cache-dir", "-q", "-U", "yt-dlp[default]", "deno"], { stdio: "ignore" }).on("error", () => {}); };
  setTimeout(update, 120000).unref();
  setInterval(update, 24 * 3600 * 1000).unref();
}
// Videos set by hand are allowed through the proxy again after a restart.
for (const v of Object.values(overrides())) { if (v.id && v.url) { sources.set(v.id, v.url); ALLOWED.add(v.id); } }
