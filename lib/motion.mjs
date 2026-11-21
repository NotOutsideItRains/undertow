// Animated album covers (Apple Music's "motion artwork"): short looping videos Apple publishes on its own media servers, unprotected.
// A community-run lookup service (MOTION_API, set to empty to turn the feature off) says which clip belongs to an album; it only ever sees the
// artist and album names. What it answers is treated as untrusted: only links on Apple's servers are used. The clip is remuxed here to a small
// mp4 once and kept on disk.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { UA } from "./ua.mjs";

const API = String(process.env.MOTION_API ?? "https://artwork.m8tec.top").replace(/\/$/, "");
const DIR = process.env.MOTION_CACHE_DIR || new URL("../motion-cache", import.meta.url).pathname;
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
export const available = () => !!API;
const APPLE_HOST = /(^|\.)(mzstatic\.com|apple\.com|aaplimg\.com)$/i;
const okUrl = (u) => { try { const x = new URL(u); return x.protocol === "https:" && APPLE_HOST.test(x.hostname); } catch { return false; } };
const norm = (x) => String(x || "").toLowerCase().replace(/\(.*?\)|\[.*?\]/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const cleanAlbum = (a) => String(a || "").replace(/\s*[\(\[][^)\]]*[\)\]]/g, "").replace(/\s+-\s+(single|ep|deluxe.*|remaster.*|expanded.*)$/i, "").trim();
const idOf = (artist, album) => `${norm(artist).replace(/ /g, "-").slice(0, 40)}_${norm(album).replace(/ /g, "-").slice(0, 60)}`.replace(/[^\w-]/g, "") || "x";

// ---- asking the lookup service ----
let inflight = 0;
async function lookup(artist, album) {
  if (inflight >= 3) return undefined; // busy: try again next time
  inflight++;
  try {
    const r = await fetch(`${API}/api/v1/artwork/search?${new URLSearchParams({ artist, album })}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return null;
    if (!r.ok) return undefined;
    const j = await r.json().catch(() => null);
    const sq = j && typeof j.url === "string" && okUrl(j.url) ? j.url : null, tall = j && typeof j.url_tall === "string" && okUrl(j.url_tall) ? j.url_tall : null;
    return sq || tall ? { video: sq, tall } : null; // "tall" is the 3:4 version for phones; not every album has one
  } catch { return undefined; } // unreachable or too slow: not remembered for long
  finally { inflight--; }
}

// ---- the playlist, turned into one small mp4 ----
function pickVariant(master, base) { // the biggest H.264 stream up to 768 px (it plays everywhere, and is copied as it is); else the best of what's there
  const lines = master.split(/\r?\n/), out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const res = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]), bw = /(?:^|,)BANDWIDTH=(\d+)/.exec(lines[i]), codec = /CODECS="([^"]*)"/.exec(lines[i]), uri = lines[i + 1]?.trim();
    if (uri && !uri.startsWith("#")) { try { out.push({ w: res ? +res[1] : 0, bw: bw ? +bw[1] : 0, avc: /avc1/.test(codec?.[1] || ""), url: new URL(uri, base).href }); } catch { /* bad line */ } }
  }
  const ok = out.filter((v) => okUrl(v.url) && v.bw <= 4e6), small = ok.filter((v) => v.w && v.w <= 768).sort((a, b) => b.w - a.w || a.bw - b.bw);
  return small.find((v) => v.avc) || small[0] || ok.sort((a, b) => a.w - b.w)[0] || null;
}
async function text(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { invalid: r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429 }); // a client error means the saved address has expired (Apple answers 400)
  return r.text();
}
function ffmpeg(args, ms = 90000) {
  return new Promise((ok, bad) => {
    const c = spawn("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => (err = (err + d).slice(-300)));
    const t = setTimeout(() => { c.kill("SIGKILL"); bad(new Error("ffmpeg timed out")); }, ms);
    c.on("error", (e) => { clearTimeout(t); bad(e); });
    c.on("close", (code) => { clearTimeout(t); code === 0 ? ok() : bad(Object.assign(new Error(err.trim() || `ffmpeg exited ${code}`), { invalid: /returned 4(?!08|29)\d\d/i.test(err) })); });
  });
}
async function build(name, masterUrl) { // name: the file it is saved as
  const file = `${DIR}/${name}.mp4`, tmp = `${file}.part.mp4`, v = pickVariant(await text(masterUrl), masterUrl);
  if (!v) throw new Error("no usable video");
  const input = ["-protocol_whitelist", "https,tls,tcp,crypto", "-user_agent", UA, "-i", v.url, "-t", "60", "-an"];
  try { // an H.264 stream is copied; anything else (HEVC) is made into H.264 so every browser plays it
    await ffmpeg(v.avc ? [...input, "-c:v", "copy", "-movflags", "+faststart", tmp] : [...input, "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-vf", "scale='min(768,iw)':-2", "-movflags", "+faststart", tmp]);
    const size = fs.statSync(tmp).size;
    if (size < 2000 || size > 40e6) throw new Error("unexpected file");
    fs.renameSync(tmp, file);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  prune();
  return file;
}
function prune() { // the newest 80 clips, at most 300 MB
  let n = 0, bytes = 0;
  fs.readdirSync(DIR).filter((f) => f.endsWith(".mp4") && !f.endsWith(".part.mp4")).map((f) => { const st = fs.statSync(`${DIR}/${f}`); return [f, st.mtimeMs, st.size]; }).sort((x, y) => y[1] - x[1])
    .forEach(([f, , size]) => { if (++n > 80 || (bytes += size) > 300e6) fs.rmSync(`${DIR}/${f}`, { force: true }); });
}
for (const f of fs.readdirSync(DIR)) if (f.endsWith(".part.mp4")) fs.rmSync(`${DIR}/${f}`, { force: true }); // an unfinished build from before a restart

// ---- the entry point: an album's clip file, or null when it has none ----
// The playlist address for each album is saved (on disk, so a restart keeps it) and used until Apple's server says it has expired; only then is
// the lookup service asked again. "No animated cover" is remembered for 3 days, since albums rarely gain one.
const URLS_FILE = process.env.MOTION_URLS_FILE || new URL("../motion-urls.json", import.meta.url).pathname;
let urls = {}; // id -> { video: playlist address or null, at }
try { urls = JSON.parse(fs.readFileSync(URLS_FILE, "utf8")); } catch { /* none yet */ }
let saveT = null;
const saveUrls = () => {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const keys = Object.keys(urls);
    if (keys.length > 3000) for (const k of keys.sort((x, y) => urls[x].at - urls[y].at).slice(0, keys.length - 3000)) delete urls[k];
    try { fs.writeFileSync(URLS_FILE, JSON.stringify(urls), { mode: 0o600 }); } catch { /* best effort */ }
  }, 2000);
  saveT.unref?.();
};
const NONE_FOR = 3 * 86400 * 1000, soft = new Map(); // soft: id -> when to try again after the service was unreachable
const jobs = new Map();
// shape "tall" (3:4, for phones) when the album has one, else the square clip. Resolves { file, shape } or null.
export async function forAlbum(artist, album, shape = "square") {
  artist = String(artist || "").split(",")[0].trim().slice(0, 80); album = String(album || "").trim().slice(0, 120);
  if (!API || !artist || !album) return null;
  const id = idOf(artist, album), fileOf = (s) => `${DIR}/${id}${s === "tall" ? "-tall" : ""}.mp4`;
  const have = () => { const s = shape === "tall" && urls[id]?.tall ? "tall" : "square"; return fs.existsSync(fileOf(s)) ? s : null; };
  const done = have();
  if (done) { fs.utimesSync(fileOf(done), new Date(), new Date()); return { file: fileOf(done), shape: done }; }
  let e = urls[id];
  if (e && !e.video && !e.tall) { if (Date.now() - e.at < NONE_FOR) return null; e = undefined; }
  if (!e && (soft.get(id) || 0) > Date.now()) return null;
  const key = `${id}:${shape}`;
  if (!jobs.has(key)) {
    const job = (async () => {
      let entry = e;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!entry) {
          let found = await lookup(artist, album);
          if (found === null && cleanAlbum(album) && norm(cleanAlbum(album)) !== norm(album)) found = await lookup(artist, cleanAlbum(album)); // "Album (Deluxe)" -> "Album"
          if (found === undefined) { soft.set(id, Date.now() + 10 * 60 * 1000); if (soft.size > 2000) soft.delete(soft.keys().next().value); return null; } // service down: try again in 10 minutes
          entry = urls[id] = { video: found?.video || null, tall: found?.tall || null, at: Date.now() }; saveUrls();
          if (!found) return null;
        }
        const s = shape === "tall" && entry.tall ? "tall" : "square", url = s === "tall" ? entry.tall : entry.video;
        if (!url) return null;
        try { return { file: await build(`${id}${s === "tall" ? "-tall" : ""}`, url), shape: s }; }
        catch (err) {
          if (err.invalid && attempt === 0) { delete urls[id]; saveUrls(); entry = undefined; continue; } // the saved address has expired: ask once more
          return null;
        }
      }
      return null;
    })();
    jobs.set(key, job);
    job.catch(() => {}).finally(() => jobs.delete(key));
  }
  return jobs.get(key).catch(() => null);
}
