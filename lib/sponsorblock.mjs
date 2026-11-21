// SponsorBlock's volunteers mark the parts of a music video that aren't the song (a spoken intro, a skit, an outro).
// That gives a quick estimate of where the music starts and ends inside the video, without decoding any audio.
// The lookup sends only the first 4 characters of a hash of the video id, so SponsorBlock never learns which video was asked about.
import crypto from "node:crypto";
import { UA } from "./ua.mjs";

const HOST = "https://sponsor.ajay.app";
const CATS = encodeURIComponent(JSON.stringify(["music_offtopic", "intro", "outro"]));
const cache = new Map(); // video id -> { at, segs, dur }
const EDGE = 2.5; // an off-topic part this close to the start or end of the video counts as the intro or outro

async function load(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < (hit.segs ? 24 : 1) * 3600 * 1000) return hit;
  const prefix = crypto.createHash("sha256").update(id).digest("hex").slice(0, 4);
  let segs = [], dur = 0;
  try {
    const r = await fetch(`${HOST}/api/skipSegments/${prefix}?categories=${CATS}&actionTypes=%5B%22skip%22%5D`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const mine = (await r.json()).find((v) => v.videoID === id);
      for (const s of mine?.segments || []) {
        if (!Array.isArray(s.segment) || !(s.votes >= 0) || !(s.segment[1] > s.segment[0])) continue; // downvoted or nonsense marks don't count
        segs.push([Number(s.segment[0]), Number(s.segment[1])]);
        dur = Math.max(dur, Number(s.videoDuration) || 0);
      }
    }
  } catch { return { at: Date.now(), segs: [], dur: 0, failed: true }; } // unreachable: don't remember it for long
  const out = { at: Date.now(), segs, dur };
  cache.set(id, out);
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return out;
}

// Where the music is inside a video: { start, end, length, match, ... } in video seconds, or null when nobody marked anything.
// match = the music's length agrees with the song's, so the estimate can be trusted (videoTime = songTime + start).
export async function range(id, songSeconds) {
  if (!/^[\w-]{11}$/.test(id || "")) return null;
  const { segs, dur } = await load(id);
  if (!segs.length) return null;
  const sorted = segs.map(([a, b]) => [a, dur ? Math.min(b, dur) : b]).sort((x, y) => x[0] - y[0]);
  let start = 0, end = dur || Infinity, middle = 0; const inside = [];
  for (const [a, b] of sorted) {
    if (a <= start + EDGE) start = Math.max(start, b); // chains onto the intro
    else if (dur && b >= dur - EDGE) end = Math.min(end, a);
    else { middle += b - a; inside.push([a, b]); } // an interruption inside the song: the video jumps over it while the song plays on
  }
  if (!dur && !Number.isFinite(end)) return { start, end: null, length: null, match: false, partial: true };
  const length = end - start - middle;
  const skips = []; // the interruptions, merged, in video seconds
  for (const [a, b] of inside.filter(([a, b]) => a >= start && b <= end)) { const l = skips[skips.length - 1]; if (l && a <= l[1]) l[1] = Math.max(l[1], b); else skips.push([+a.toFixed(2), +b.toFixed(2)]); }
  const tol = Math.max(4, (songSeconds || 0) * 0.03);
  return { start: +start.toFixed(2), end: Number.isFinite(end) ? +end.toFixed(2) : null, length: +length.toFixed(2), videoDuration: dur || null, skips, match: !!songSeconds && length > 0 && Math.abs(length - songSeconds) <= tol };
}
