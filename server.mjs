// BitChord addon backed by self-hosted hifi-api instances, plus the web UI that manages them.
// Run: ADDON_SECRET=... DISCORD_WEBHOOK_URL=... node server.mjs   (see lib/ for the pieces)
import http from "node:http";
import fs from "node:fs";
import {
  APP_NAME, db, save, noteStream, usage, inflight, linkIndex, logEvent, createLink, httpError, activity, inviteState, sessionUser,
} from "./lib/store.mjs";
import * as accounts from "./lib/accounts.mjs";
import * as subsonic from "./lib/subsonic.mjs";
import * as video from "./lib/video.mjs";
import * as speaker from "./lib/speaker.mjs";
import * as sponsorblock from "./lib/sponsorblock.mjs";
import * as motion from "./lib/motion.mjs";
import * as library from "./lib/library.mjs";
import { createBLyricsProvider, createLRCLibSyncedProvider, createLRCLibPlainProvider, createLegatoProvider, createPortatoProvider, createBinimumProvider } from "./lib/vendor/lyrics-providers.mjs";
import { slowdownAlert, missAlert, inviteOpenedAlert } from "./lib/notify.mjs";
import { handleApi, AVATAR_DIR, lastfmSend, lastfmStatus, lastfmPlayerStart, lastfmPlayerComplete, lastfmDisconnect, ipOf } from "./lib/api.mjs";
import * as publicApi from "./lib/publicapi.mjs";
import * as playerHost from "./lib/playerhost.mjs";
import { rpcInfo, rpcFile } from "./lib/rpcdl.mjs";
import * as partyHost from "./lib/partyhost.mjs";
import { discordOn } from "./lib/discord.mjs";
import { Readable } from "node:stream";
import os from "node:os";
import { assemble } from "./lib/remux.mjs";
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 7000);
const SECRET = (process.env.ADDON_SECRET || "").replace(/^\/+|\/+$/g, ""); // becomes the first link ("Original link")
const WEB = new URL("./web/", import.meta.url).pathname;

const BASE_MANIFEST = {
  id: "com.tidalchord.hifi",
  version: "1.0.0",
  resources: ["search", "stream"],
  bitchordAuth: true, // BitChord ignores an addon without this
  allowDownloads: 0,
};
const QUALITY_OPTIONS = {
  HI_RES: [["LOSSLESS", "Lossless (FLAC, up to 24-bit hi-res)"], ["HIGH", "High (AAC 320)"], ["LOW", "Low (AAC 96)"]],
  CD: [["LOSSLESS", "Lossless (FLAC 16-bit)"], ["HIGH", "High (AAC 320)"], ["LOW", "Low (AAC 96)"]],
  HIGH: [["HIGH", "High (AAC 320)"], ["LOW", "Low (AAC 96)"]],
  LOW: [["LOW", "Low (AAC 96)"]],
};
let upstreamVersion = { v: null, at: 0 };
async function version() {
  if (Date.now() - upstreamVersion.at < 5 * 60 * 1000) return upstreamVersion.v;
  try { upstreamVersion = { v: String((await accounts.call(accounts.pick(), "/")).version), at: Date.now() }; } catch { upstreamVersion.at = Date.now() - 4 * 60 * 1000; }
  return upstreamVersion.v;
}
async function manifestFor(link) {
  const opts = QUALITY_OPTIONS[link.limits.maxQuality] || QUALITY_OPTIONS.HI_RES;
  const v = await version();
  return {
    ...BASE_MANIFEST, ...(v ? { version: v } : {}), allowDownloads: link.limits.downloads ? 1 : 0, checkValidLossless: link.limits.losslessCheck ? 1 : 0,
    // One id per link so a person can add several without BitChord treating them as the same addon.
    id: link.primary ? BASE_MANIFEST.id : `${BASE_MANIFEST.id}.${link.id}`,
    name: link.addonName || APP_NAME,
    settings: [{ key: "quality", type: "select", label: "Quality", options: opts.map(([value, label]) => ({ value, label })), default: opts[0][0] }], // best first
  };
}

// Eclipse (https://eclipsemusic.app/docs) reads the same kind of addon, from its own base URL: /<token>/eclipse.
const semver = (v) => String(v || "1.0.0").split(".").concat(["0", "0"]).slice(0, 3).join(".");
async function eclipseManifest(link) {
  const m = await manifestFor(link);
  return {
    id: `${m.id}.eclipse`, name: m.name, version: semver(m.version), description: "Lossless and hi-res music from TIDAL.",
    resources: ["search", "stream", "isrc", "resolve", "settings"], types: ["track"], contentType: "music",
    settings: [...m.settings, ...(video.available() ? [{ key: "video", type: "toggle", label: "Music videos", help: "From YouTube, when a song has a real video. Adds a short wait the first time a song plays.", default: true }] : [])],
  };
}
const json = (res, body, status = 200, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Requested tier (BitChord's "lossless" includes hi-res) clamped to what the link allows.
const RANK = { LOW: 0, HIGH: 1, CD: 2, HI_RES: 3 };
const wantedTier = (q) => {
  const s = String(q || "").toUpperCase().replace(/[\s-]/g, "_");
  if (s.includes("LOSSLESS") || s === "FLAC") return "HI_RES";
  return s === "LOW" ? "LOW" : s === "HIGH" ? "HIGH" : "HI_RES";
};
const tierFor = (q, max) => (RANK[wantedTier(q)] <= RANK[max] ? wantedTier(q) : max);

// Tidal lists Atmos mixes as their own catalogue rows (audioModes is only DOLBY_ATMOS).
const isAtmosOnly = (modes = []) => modes.includes("DOLBY_ATMOS") && !modes.includes("STEREO");
const toRow = (t) => ({
  id: String(t.id),
  title: t.version ? `${t.title} (${t.version})` : t.title,
  artist: (t.artists || (t.artist ? [t.artist] : [])).map((a) => a.name).join(", "),
  album: t.album?.title,
  duration: t.duration,
  artworkURL: t.album?.cover ? `https://resources.tidal.com/images/${t.album.cover.replace(/-/g, "/")}/640x640.jpg` : undefined,
  audioQuality: t.audioQuality,
  ...(t.isrc ? { isrc: t.isrc } : {}),
  ...(isAtmosOnly(t.audioModes) ? { atmos: true, audioModes: t.audioModes } : {}),
});

// Run fn against an account; if that account's login turns out dead, fail over to another one.
async function withAccount(link, fn, kind = "search") {
  const tried = [];
  for (let last;;) {
    let a;
    try { a = accounts.pick({ pinned: link.accountId, exclude: tried, kind }); } catch (e) { throw last || e; }
    accounts.lease(a, 1);
    try { return await fn(a); } catch (e) {
      if (!e.loginFailed || link.accountId) throw e;
      tried.push(a.id);
      last = e;
    } finally { accounts.lease(a, -1); }
  }
}

const known = new Map(); // track id -> "Artist - Title", from search results
const knownMeta = new Map(); // track id -> { title, artist, duration }, to find the same song on a Subsonic backup
const nameKey = (x) => String(x || "").toLowerCase().replace(/\(.*?\)|\[.*?\]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
async function search(q, link) {
  // TIDAL always returns something, even loose matches, so the Subsonic backup is searched alongside it.
  const backup = q && subsonic.any() ? subsonic.search(q).catch(() => []) : Promise.resolve([]);
  let tracks = [], failure = null;
  try {
    const r = await withAccount(link, (a) => accounts.call(a, "/search/", { s: q, limit: 25 }));
    tracks = (r.data?.items || []).filter((t) => t.allowStreaming !== false).map(toRow);
    if (!link.limits.atmos) tracks = tracks.filter((t) => !t.atmos);
  } catch (e) { failure = e; }
  const have = new Set(tracks.map((t) => `${nameKey(t.title)}|${nameKey(t.artist).split(" ")[0]}`));
  // TIDAL wins when it has the same song. A Subsonic song that matches every word goes first: BitChord only looks at the top rows.
  const words = nameKey(q).split(" ").filter(Boolean), strong = [];
  for (const t of await backup) {
    if (have.has(`${nameKey(t.title)}|${nameKey(t.artist).split(" ")[0]}`)) continue;
    const hay = nameKey(`${t.title} ${t.artist} ${t.album || ""}`);
    if (words.length && words.every((x) => hay.includes(x))) strong.push(t); else tracks.push(t);
  }
  tracks = [...strong, ...tracks];
  if (!tracks.length && failure) throw failure;
  for (const t of tracks) {
    known.set(t.id, `${t.artist} - ${t.title}`);
    knownMeta.set(t.id, { title: t.title, artist: t.artist, duration: t.duration });
  }
  for (const m of [known, knownMeta]) if (m.size > 5000) m.delete(m.keys().next().value);
  return { tracks };
}

async function stream(a, id, tier, wantAtmos, allowAtmos) {
  if (!/^\d+$/.test(id)) throw httpError(404, "bad id");
  const manifest = (formats) => // soft403: a 403 about one song (no such format, a ghost row, a region block) is not a verdict on the login. 401s and searches still catch a dead one.
    accounts.call(a, "/trackManifests/", { id, formats, manifestType: "MPEG_DASH", uriScheme: "HTTPS" }, { poll: true, soft403: true })
      .then((r) => r.data?.data?.attributes)
      .catch((e) => (e.status === 429 || e.loginFailed ? Promise.reject(e) : null));

  let atmos = wantAtmos && allowAtmos;
  if (!atmos) {
    const info = await accounts.call(a, "/info/", { id }, { soft403: true }).catch(() => null);
    if (isAtmosOnly(info?.data?.audioModes)) {
      if (!allowAtmos) throw httpError(404, "atmos disabled for this link");
      atmos = true;
    }
  }
  if (atmos) { // Dolby Atmos: EAC3_JOC only; fall back to stereo when absent
    try {
      const at = await manifest(["EAC3_JOC"]);
      if (at?.uri && (at.formats || []).includes("EAC3_JOC")) return { url: at.uri, codec: "eac3-joc", container: "mp4", manifest: "dash", encrypted: false };
    } catch (e) { if (e.status === 429 || e.loginFailed) throw e; }
  }
  const wanted = { HI_RES: ["FLAC_HIRES", "FLAC"], CD: ["FLAC"], HIGH: ["AACLC"], LOW: ["HEAACV1"] }[tier]; // FLAC only, so a player can't pick the lossy rendition
  let at = await manifest(wanted);
  if (!at?.uri && wanted.includes("FLAC")) at = await manifest([...wanted, "AACLC"]); // no FLAC for this track
  if (!at?.uri) throw httpError(404, "no manifest");
  const codec = (at.formats || []).some((x) => x.startsWith("FLAC")) ? "flac" : "aac";
  return { url: at.uri, codec, container: "mp4", manifest: "dash", encrypted: false };
}

// The Dolby Atmos mix of a song is a catalogue row of its own (Cracker Island has one album for the stereo masters and another for the Atmos mixes).
// To play the Atmos version of a stereo track, look for the Atmos row that is the same song: same title, same artist, nearly the same length, and the same album when there is a choice.
const twins = new Map(); // track id -> { id: Atmos twin or "", at }
async function atmosTwin(link, id) {
  const hit = twins.get(id);
  if (hit && Date.now() - hit.at < (hit.id ? 7 * 864e5 : 6 * 3600e3)) return hit.id;
  const found = await withAccount(link, async (a) => {
    const info = (await accounts.call(a, "/info/", { id }))?.data;
    if (!info) return "";
    if (isAtmosOnly(info.audioModes)) return String(id); // already the Atmos row
    const artists = (info.artists || (info.artist ? [info.artist] : [])).map((x) => nameKey(x.name)).filter(Boolean);
    const title = nameKey(info.title), lead = artists[0] || "";
    const r = await accounts.call(a, "/search/", { s: `${info.artist?.name || ""} ${info.title}`.trim(), limit: 25 }).catch(() => null);
    const same = (r?.data?.items || []).filter((t) => t.allowStreaming !== false && isAtmosOnly(t.audioModes) && nameKey(t.title) === title
      && (t.artists || (t.artist ? [t.artist] : [])).some((x) => nameKey(x.name) === lead || artists.includes(nameKey(x.name)))
      && (!info.duration || !t.duration || Math.abs(t.duration - info.duration) <= 4));
    same.sort((x, y) => (nameKey(y.album?.title) === nameKey(info.album?.title)) - (nameKey(x.album?.title) === nameKey(info.album?.title)) || Math.abs((x.duration || 0) - (info.duration || 0)) - Math.abs((y.duration || 0) - (info.duration || 0)));
    return same[0] ? String(same[0].id) : "";
  }).catch(() => null);
  if (found === null) return ""; // the lookup itself failed: don't remember it
  twins.set(id, { id: found, at: Date.now() });
  if (twins.size > 5000) twins.delete(twins.keys().next().value);
  return found;
}

// Manifest URLs stay valid ~60 min, so cache for 10: BitChord prefetches the whole queue, and each
// hifi-api serves one playback request at a time, so repeats and bursts are costly.
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map(); // key -> { at, promise }
const pending = []; // labels of uncached stream requests in flight
function cachedStream(link, id, tier, wantAtmos, label) {
  const allow = link.limits.atmos;
  const key = `${id}|${tier}|${wantAtmos && allow}|${allow}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return { promise: hit.promise, cached: true };
  const promise = withAccount(link, async (a) => ({ body: await stream(a, id, tier, wantAtmos, allow), account: a.label }), "stream");
  cache.set(key, { at: Date.now(), promise });
  pending.push(label);
  if (pending.length >= 2) {
    const top = [];
    for (const l of Object.values(db.links)) for (const [n, d] of Object.entries(l.devices)) top.push([`${l.name} / ${n}`, d.stream]);
    slowdownAlert(pending, top.sort((x, y) => y[1] - x[1]));
  }
  promise.finally(() => pending.splice(pending.indexOf(label), 1)).catch(() => {});
  promise.then((out) => logRenditions(id, tier, out.body), (e) => { // a failed lookup is remembered for 2 minutes so a player retrying a broken song can't hammer the accounts; then it is tried again
    console.log(`  -> id=${id} tier=${tier} FAILED ${e.status || ""} ${e.message}`);
    if (e.status === 429 || e.loginFailed) cache.delete(key); else setTimeout(() => { if (cache.get(key)?.promise === promise) cache.delete(key); }, 2 * 60 * 1000).unref();
  });
  if (cache.size > 3000) cache.delete(cache.keys().next().value);
  return { promise, cached: false };
}
function logRenditions(id, tier, out) { // logging only, off the response path
  fetch(out.url, { signal: AbortSignal.timeout(8000) })
    .then((r) => r.text())
    .then((x) => [...x.matchAll(/Representation id="([^"]*)"/g)].map((m) => m[1]).join(" | "))
    .catch(() => "?")
    .then((reps) => console.log(`  -> id=${id} tier=${tier} codec=${out.codec} reps: ${reps}`));
}

const cleanName = (n, ua) => String(n || ua || "unknown").replace(/[^\w .\/-]/g, "").trim().slice(0, 32) || "unknown";

async function addon(req, res, link, u, eclipse = false) {
  const owner = db.users[link.userId];
  const device = cleanName(u.searchParams.get("name") || u.searchParams.get("device"), req.headers["user-agent"]);
  const label = `${owner?.displayName || link.name} · ${device}`;
  const kind = u.pathname === "/search" || u.pathname === "/resolve" || u.pathname === "/resolve-isrc" ? "search" : u.pathname.startsWith("/stream/") ? "stream" : "manifest";
  if (eclipse) { // Eclipse's web player calls from the browser and has to read Retry-After
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Retry-After");
  }
  const ev = { t: Date.now(), kind, linkId: link.id, linkName: link.name, userId: link.userId, user: owner?.displayName || (link.guest ? "Guest" : "—"), device, client: eclipse ? "eclipse" : "bitchord", query: [...u.searchParams].filter(([k]) => k !== "q" && k !== "name" && k !== "device").map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join("&"), detail: "", status: 0, ms: 0, cached: false };
  let counted = false;
  res.on("close", () => {
    ev.status = res.statusCode;
    ev.ms = Date.now() - ev.t;
    if (ev.notFound) link.totals.notFound++;
    else if (ev.status >= 400) link.totals.errors++;
    if (kind !== "manifest" || ev.status >= 400) logEvent(ev);
    if (counted) { inflight.set(link.id, Math.max(0, (inflight.get(link.id) || 1) - 1)); }
    save();
  });
  console.log(new Date().toISOString(), label, req.method, u.pathname);
  try {
    if (!link.enabled) throw httpError(403, "This link is disabled");
    if (link.limits.expiresAt && link.limits.expiresAt < Date.now()) throw httpError(403, "This link has expired");
    link.lastSeen = Date.now();
    const d = (link.devices[device] ||= { search: 0, stream: 0, lastSeen: 0 });
    d.lastSeen = Date.now();
    if (kind === "search") { link.totals.search++; d.search++; }
    if (kind === "stream") { link.totals.stream++; d.stream++; }

    if (kind === "manifest") return json(res, eclipse ? await eclipseManifest(link) : await manifestFor(link));

    if (eclipse && (u.pathname === "/resolve-isrc" || u.pathname === "/resolve")) {
      const isrc = (u.searchParams.get("isrc") || "").trim().toUpperCase(), title = u.searchParams.get("title") || "", artist = u.searchParams.get("artist") || "";
      const ms = Number(u.searchParams.get("durationMs")) || 0;
      ev.detail = isrc || `${artist} - ${title}`;
      let item = null;
      if (isrc) { // exact only: never answer with a different recording
        const r = await withAccount(link, (a) => accounts.call(a, "/search/", { i: isrc, limit: 5 }));
        item = (r.data?.items || []).filter((t) => String(t.isrc || "").toUpperCase() === isrc && t.allowStreaming !== false && (link.limits.atmos || !isAtmosOnly(t.audioModes))).map(toRow)[0] || null;
      } else if (u.pathname === "/resolve" && title) {
        const r = await withAccount(link, (a) => accounts.call(a, "/search/", { s: `${artist} ${title}`.trim(), limit: 10 })).catch(() => null);
        const ta = nameKey(artist).split(" ")[0];
        item = (r?.data?.items || []).filter((t) => t.allowStreaming !== false && (link.limits.atmos || !isAtmosOnly(t.audioModes))).map(toRow)
          .find((t) => nameKey(t.title) === nameKey(title) && (!ta || nameKey(t.artist).includes(ta)) && (!ms || !t.duration || Math.abs(t.duration * 1000 - ms) <= 3000)) || null;
      }
      if (!item && u.pathname === "/resolve" && title) item = await subsonic.stand({ title, artist, duration: ms / 1000 }).catch(() => null); // your own library: TIDAL has nothing, and a Subsonic song has no ISRC to compare, so title, artist and length (within 4 s) must all match
      if (item && video.available()) video.forTrack({ title: item.title, artist: item.artist, duration: item.duration }).catch(() => {}); // warm the video lookup for when it plays
      if (item) known.set(item.id, `${item.artist} - ${item.title}`), knownMeta.set(item.id, { title: item.title, artist: item.artist, duration: item.duration });
      else ev.notFound = true;
      return json(res, u.pathname === "/resolve-isrc" ? { trackId: item ? item.id : null } : { item });
    }

    if (kind === "search") {
      const q = u.searchParams.get("q") || "";
      ev.detail = q;
      const result = await search(q, link);
      if (!result.tracks.length && q) { ev.notFound = true; missAlert("search", label, q); }
      return json(res, result);
    }

    const id = decodeURIComponent(u.pathname.slice(8));
    ev.detail = known.get(id) || `track ${id}`;
    const L = link.limits, us = usage(link.id);
    const limited = (msg, retry) => Object.assign(httpError(429, msg), { retryAfter: String(retry) });
    if (L.perHour && us.hour >= L.perHour) throw limited("Hourly stream limit reached", us.resetHourIn);
    if (L.perDay && us.day >= L.perDay) throw limited("Daily stream limit reached", 3600);
    if (L.maxConcurrent && us.inflight >= L.maxConcurrent) throw limited("Too many streams at once", 2);
    noteStream(link.id);
    inflight.set(link.id, us.inflight + 1);
    counted = true;

    const tier = tierFor(u.searchParams.get("quality"), L.maxQuality);
    const atmosParam = u.searchParams.get("atmos");
    ev.quality = tier;
    const base = `${originOf(req)}/${link.token}`;
    const sub = subsonic.parseId(id);
    let out;
    if (sub) { // a track that came from a Subsonic backup
      const t = await subsonic.song(sub.server, sub.song);
      out = { body: await subsonic.streamBody(t, tier, base, (what, q) => signed(link, "sub", what, q)), account: `Subsonic · ${t.server.label}` };
      ev.cached = false;
    } else {
      try {
        const { promise, cached } = cachedStream(link, id, tier, atmosParam === "auto" || atmosParam === "true", label);
        ev.cached = cached;
        [out] = await Promise.all([promise, L.delayMs ? sleep(L.delayMs) : null]);
      } catch (e) { // TIDAL couldn't play it: try the same song on a Subsonic server
        const alt = e.status !== 429 && knownMeta.has(id) && (await subsonic.stand(knownMeta.get(id)).catch(() => null));
        if (!alt) throw e;
        const t = await subsonic.song(subsonic.parseId(alt.id).server, subsonic.parseId(alt.id).song);
        out = { body: await subsonic.streamBody(t, tier, base, (what, q) => signed(link, "sub", what, q)), account: `Subsonic · ${t.server.label}` };
        ev.cached = false;
        ev.backup = true;
      }
    }
    const PLAIN = { flac: ["flac", "flac", "Lossless"], aac: ["aac", "mp4", tier === "LOW" ? "AAC 96" : "AAC 320"], "eac3-joc": ["eac3", "mp4", "Dolby Atmos"] };
    if (eclipse && !sub && out.body.manifest === "dash" && PLAIN[out.body.codec]) { // Eclipse can't play DASH: hand it a plain file (built while the player connects)
      const wantA = atmosParam === "auto" || atmosParam === "true", [format, container, quality] = PLAIN[out.body.codec];
      ensureAudio(link, id, tier, wantA).catch(() => {});
      out = { ...out, body: { url: `${base}/audio/${id}?q=${tier}${wantA ? "&a=1" : ""}&${signed(link, "audio", id, `${tier}|${wantA ? 1 : 0}`)}`, format, codec: out.body.codec, container, manifest: "none", encrypted: false, quality } };
    }
    if (eclipse && u.searchParams.get("video") !== "false" && knownMeta.has(id) && video.available()) {
      // The video is a background loop, so it never holds up the song: a song that hasn't been looked up yet gets a link that finds
      // its video while the player asks for it (nothing found = that request fails and Eclipse shows no video).
      const meta = knownMeta.get(id), k = video.known(meta);
      if (k !== null) {
        if (k === undefined) video.forTrack(meta).catch(() => {});
        out = { ...out, body: { ...out.body, video: {
          url: k ? `${base}/video/${k.id}?${signed(link, "video", k.id)}` : `${base}/video/by/${encodeURIComponent(id)}?${signed(link, "videoby", id)}`, mimeType: "video/mp4", muxed: true,
          ...(k?.width ? { width: k.width, height: k.height, renditions: [{ url: `${base}/video/${k.id}?${signed(link, "video", k.id)}`, height: k.height, mimeType: "video/mp4" }] } : {}),
          independent: !(k?.duration && meta.duration && Math.abs(k.duration - meta.duration) <= 1),
        } } };
        ev.video = k ? k.id : "looking";
      }
    }
    ev.codec = out.body.codec;
    ev.account = out.account;
    return json(res, out.body);
  } catch (e) {
    const status = e.status || 502;
    ev.error = e.message;
    if (status === 404 && kind === "stream") { ev.notFound = true; missAlert("stream", label, known.get(u.pathname.slice(8)) || `track id ${u.pathname.slice(8)}`); }
    json(res, { error: e.message }, status, e.retryAfter ? { "Retry-After": e.retryAfter } : {});
  }
}

// Eclipse wants plain audio files, so TIDAL's DASH audio is stitched into one and served from a small temp cache.
// ---- signed file URLs: /stream approves a play (and counts it against the link's limits); the file routes serve only what it approved ----
const FILE_TTL = 6 * 3600 * 1000; // long enough for a queue that a player prefetches ahead of time
const fileKey = () => { if (!db.settings.fileKey) { db.settings.fileKey = crypto.randomBytes(32).toString("hex"); save(); } return db.settings.fileKey; };
const sigOf = (link, kind, what, q, exp) => crypto.createHmac("sha256", fileKey()).update([link.id, kind, what, q, exp].join("|")).digest("base64url").slice(0, 32);
const signed = (link, kind, what, q = "") => { const exp = Date.now() + FILE_TTL; return `e=${exp}&s=${sigOf(link, kind, what, q, exp)}`; };
function needSigned(link, kind, what, u, q = "") { // throws unless the URL was issued by /stream for exactly this link, file and quality, and hasn't expired
  const exp = Number(u.searchParams.get("e")), s = String(u.searchParams.get("s") || "");
  if (!(exp > Date.now())) throw httpError(403, "This file link has expired. Play the song again.");
  const want = sigOf(link, kind, what, q, exp);
  if (s.length !== want.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) throw httpError(403, "Not allowed");
}
// Cover art for songs on Subsonic servers, for apps that can't send a key (Discord fetches an embed's picture itself). The URL is signed for exactly
// one server, picture and size, so it can't be used to ask for anything else.
const COVER_SIZES = [160, 320, 640, 800];
const coverSig = (sid, cid, size) => crypto.createHmac("sha256", fileKey()).update(["cover", sid, cid, size].join("|")).digest("base64url").slice(0, 32);
const coverUrls = (origin, id, cid) => { const sub = subsonic.parseId(id); return sub && cid ? Object.fromEntries([320, 640].map((n) => [String(n), `${origin}/v1/covers/sub/${sub.server}/${encodeURIComponent(cid)}?size=${n}&sig=${coverSig(sub.server, cid, n)}`])) : null; };
async function coverRoute(req, res, u, m) {
  const size = Number(u.searchParams.get("size")), sig = String(u.searchParams.get("sig") || ""), cid = decodeURIComponent(m[2]), want = COVER_SIZES.includes(size) ? coverSig(m[1], cid, size) : "";
  if (!want || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return void json(res, { error: "Not allowed" }, 403);
  try {
    const up = await subsonic.cover(m[1], cid, size);
    res.writeHead(200, { "Content-Type": up.headers.get("content-type"), "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" });
    if (req.method === "HEAD") return void res.end();
    Readable.fromWeb(up.body).on("error", () => res.destroy()).pipe(res);
  } catch (e) { if (!res.headersSent) json(res, { error: e.message }, e.status || 404); else res.destroy(); }
}
const denied = (res, fn) => { try { fn(); return false; } catch (e) { json(res, { error: e.message }, e.status || 403); return true; } };

const AUDIO_DIR = process.env.AUDIO_TMP_DIR || new URL("./audio-tmp", import.meta.url).pathname; // on disk, not in RAM
const AUDIO_MAX_FILES = 12, AUDIO_MAX_BYTES = 1.5e9, AUDIO_MAX_BUILDS = 3, AUDIO_BUILDS_PER_LINK = 2, AUDIO_MAX_AGE = 15 * 60 * 1000;
fs.rmSync(AUDIO_DIR, { recursive: true, force: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true, mode: 0o700 });
function trimAudio(room = 0) { // keep the newest files within the count and size limits, leaving room for `room` more
  const now = Date.now(), all = fs.readdirSync(AUDIO_DIR).map((f) => { try { const st = fs.statSync(`${AUDIO_DIR}/${f}`); return [f, st.mtimeMs, st.size]; } catch { return null; } }).filter(Boolean);
  for (const [f, t] of all) if (f.endsWith(".part") && now - t > AUDIO_MAX_AGE) fs.rmSync(`${AUDIO_DIR}/${f}`, { force: true }); // an unfinished build that died
  let n = 0, bytes = 0;
  for (const [f, t, size] of all.filter(([f]) => /\.(flac|m4a|mp3)$/.test(f)).sort((x, y) => y[1] - x[1])) {
    n++; bytes += size;
    if (n > AUDIO_MAX_FILES - room || bytes > AUDIO_MAX_BYTES || now - t > AUDIO_MAX_AGE) fs.rmSync(`${AUDIO_DIR}/${f}`, { force: true });
  }
}
setInterval(trimAudio, 5 * 60 * 1000).unref();
const audioBuilds = new Map(), buildOwner = new Map();
const MIME = { flac: "audio/flac", m4a: "audio/mp4" };
function ensureAudio(link, id, tier, atmos) {
  const key = `${id}-${tier}${atmos ? "-a" : ""}`, base = `${AUDIO_DIR}/${key}`;
  for (const ext of ["flac", "m4a"]) if (fs.existsSync(`${base}.${ext}`)) { fs.utimesSync(`${base}.${ext}`, new Date(), new Date()); return Promise.resolve(`${base}.${ext}`); }
  if (!audioBuilds.has(key)) {
    const mine = [...buildOwner.values()].filter((x) => x === link.id).length; // one link can't take every build slot
    if (audioBuilds.size >= AUDIO_MAX_BUILDS || mine >= (link.id === "player" ? AUDIO_MAX_BUILDS : AUDIO_BUILDS_PER_LINK)) return Promise.reject(Object.assign(httpError(429, "Busy making other songs. Try again in a moment."), { retryAfter: "3" }));
    trimAudio(1); // make room before the new file exists, so the limit holds at every moment
    const job = (async () => { const { promise } = cachedStream(link, id, tier, atmos, "Eclipse"); return `${base}.${await assemble((await promise).body.url, base)}`; })();
    audioBuilds.set(key, job);
    buildOwner.set(key, link.id);
    job.catch(() => {}).finally(() => { audioBuilds.delete(key); buildOwner.delete(key); });
  }
  return audioBuilds.get(key);
}
// A song in another format, made on the fly for a device that can't play the original: ALAC (lossless, Apple devices) or MP3 (V0, plays anywhere). Made once, then cached beside the original.
const RECODE = { alac: { ext: "m4a", mime: "audio/mp4", args: ["-c:a", "alac", "-movflags", "+faststart"] }, mp3: { ext: "mp3", mime: "audio/mpeg", args: ["-c:a", "libmp3lame", "-q:a", "0"] } };
const recodes = new Map();
const RECODE_MAX = Math.max(1, Number(process.env.RECODE_MAX) || 2); // conversions at once; the rest get "busy, try again". Set RECODE_MAX=1 on a small host.
function recode(file, fmt) {
  const f = RECODE[fmt], out = `${file.replace(/\.[a-z0-9]+$/, "")}~${fmt}.${f.ext}`;
  if (fs.existsSync(out)) { fs.utimesSync(out, new Date(), new Date()); return Promise.resolve(out); }
  if (recodes.size >= RECODE_MAX && !recodes.has(out)) return Promise.reject(Object.assign(httpError(429, "Busy converting. Try again in a moment."), { retryAfter: "3" }));
  if (!recodes.has(out)) {
    const job = new Promise((ok, bad) => {
      const tmp = `${out}.part`, c = spawn("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", file, "-threads", "1", "-vn", "-map_metadata", "-1", "-ac", "2", ...f.args, "-f", fmt === "alac" ? "ipod" : "mp3", tmp], { stdio: ["ignore", "ignore", "pipe"] });
      try { os.setPriority(c.pid, 19); } catch { /* lowest priority, so playback for everyone else is not starved; not fatal */ }
      let err = ""; c.stderr.on("data", (d) => { err = (err + d).slice(-400); });
      const t = setTimeout(() => c.kill("SIGKILL"), 240000);
      c.on("error", (e) => { clearTimeout(t); bad(e); });
      c.on("close", (code) => { clearTimeout(t); if (code === 0) { try { fs.renameSync(tmp, out); return ok(out); } catch (e) { return bad(e); } } fs.rmSync(tmp, { force: true }); bad(httpError(502, err.trim().split("\n").pop() || "Could not convert this song")); });
    });
    recodes.set(out, job);
    job.catch(() => {}).finally(() => recodes.delete(out));
  }
  return recodes.get(out);
}
// What is in an audio file, for the player to show (codec, sample rate, bit depth, channels, bit rate): ffprobe once per file, remembered.
const probed = new Map();
function probeAudio(file) {
  if (probed.has(file)) return probed.get(file);
  const job = new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,profile,sample_rate,channels,bits_per_raw_sample,bits_per_sample,bit_rate:format=bit_rate", "-of", "json", file], { timeout: 10000 }, (err, out) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(out), st = j.streams?.[0] || {}, bits = Number(st.bits_per_raw_sample) || Number(st.bits_per_sample) || 0, br = Number(st.bit_rate) || Number(j.format?.bit_rate) || 0;
        resolve({ codec: st.codec_name || "", profile: st.profile || "", sampleRate: Number(st.sample_rate) || 0, bitDepth: bits, channels: Number(st.channels) || 0, bitrateKbps: br ? Math.round(br / 1000) : 0 });
      } catch { resolve(null); }
    });
  });
  probed.set(file, job);
  if (probed.size > 400) probed.delete(probed.keys().next().value);
  return job;
}
function serveFile(req, res, file, mime, extra = {}) { // a file on disk, with seeking
  const size = fs.statSync(file).size, m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  let start = 0, end = size - 1, status = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); } else start = Math.max(0, size - Number(m[2]));
    if (start > end) return void res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
    status = 206;
  }
  res.writeHead(status, { "Content-Type": mime, "Content-Length": end - start + 1, "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges", "X-Content-Type-Options": "nosniff", ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) , ...extra});
  if (req.method === "HEAD") return void res.end();
  fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
}
async function audioProxy(req, res, link, id, u) {
  try {
    if (!link.enabled || (link.limits.expiresAt && link.limits.expiresAt < Date.now())) throw httpError(403, "This link is not active");
    let file = await ensureAudio(link, id, tierFor(u.searchParams.get("q"), link.limits.maxQuality), u.searchParams.get("a") === "1");
    const as = String(u.searchParams.get("format") || "").toLowerCase(); // "play as" ALAC or MP3, made from the same file
    if (RECODE[as]) file = await recode(file, as);
    serveFile(req, res, file, RECODE[as] ? RECODE[as].mime : MIME[file.split(".").pop()]);
  } catch (e) {
    if (res.headersSent) return void res.destroy();
    json(res, { error: e.message }, e.status || 502, e.retryAfter ? { "Retry-After": e.retryAfter } : {});
  }
}

const PFP_DIR = new URL("./pfp-cache", import.meta.url).pathname;
fs.mkdirSync(PFP_DIR, { recursive: true, mode: 0o700 });
function squareWebp(buf) { // centre crop, 96x96, WebP
  return new Promise((ok, bad) => {
    const c = spawn("ffmpeg", ["-v", "error", "-nostdin", "-i", "pipe:0", "-vf", "crop='min(iw,ih)':'min(iw,ih)',scale=96:96", "-frames:v", "1", "-c:v", "libwebp", "-quality", "85", "-f", "webp", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
    const out = [];
    c.stdout.on("data", (d) => out.push(d));
    c.stdin.on("error", () => {});
    c.on("error", bad);
    c.on("close", (code) => { const b = Buffer.concat(out); code === 0 && b.length > 100 ? ok(b) : bad(new Error("not an image")); });
    c.stdin.end(buf);
  });
}
// ---- lyrics: every provider is asked at once, and the best answer wins (word-synced first, plain text last) ----
// Unison searches by video id, ISRC, or song and artist. Its lyrics come as TTML/LRC text (word-synced when it can), parsed in the browser.
// Search results carry no lyrics text, so a hit is checked against the song and then fetched by its id. Every entry says who synced it.
const UNISON_HOSTS = ["https://unison.boidu.dev", "https://unison.betterlyrics.org"]; // the same service; the second is the fallback
async function unisonGet(path, params = {}) {
  for (const host of UNISON_HOSTS) {
    try {
      const u = new URL(host + path);
      for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
      const r = await fetch(u, { headers: { "User-Agent": "Undertow" }, signal: AbortSignal.timeout(9000) });
      if (r.status >= 500) continue;
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      return j?.success ? j.data : null;
    } catch { /* unreachable: try the other host */ }
  }
  return null;
}
// Profile pictures are links to somewhere else, so only known image hosts count (host === d or ends with "." + d, never a bare endsWith).
const PFP_HOSTS = ["googleusercontent.com", "ggpht.com", "ytimg.com", "discordapp.com", "discordapp.net", "betterlyrics.org"];
const pfpOk = (x) => { try { const u = new URL(x); return u.protocol === "https:" && PFP_HOSTS.some((d) => u.hostname === d || u.hostname.endsWith("." + d)); } catch { return false; } };
const words = (x) => nameKey(x).split(" ").filter((w) => w.length > 1);
async function unisonProvider({ song, artist, album, duration, videoId, isrc }) {
  const dur = duration ? String(Math.round(duration)) : "";
  const t = nameKey(song), aw = words(artist);
  // the same song: the title is contained one way or the other, and at least one artist word is shared (search is fuzzy)
  const same = (d) => d?.song && (nameKey(d.song).includes(t) || t.includes(nameKey(d.song))) && (!aw.length || words(d.artist).some((w) => aw.includes(w)));
  let d = await unisonGet("/lyrics", { v: videoId, isrc, song, artist, album, duration: dur });
  if (!d?.lyrics || !same(d)) {
    d = null;
    for (const q of [{ song, artist, duration: dur }, { q: `${song} ${artist}`.trim() }]) { // the structured search is strict about artist spelling; the plain one isn't
      const hits = (await unisonGet("/lyrics/search", q)) || [];
      const hit = (Array.isArray(hits) ? hits : []).filter(same).sort((x, y) => Math.abs((x.duration || 0) - duration) - Math.abs((y.duration || 0) - duration))[0];
      if (hit?.id) { d = await unisonGet(`/lyrics/${hit.id}`); if (d?.lyrics && same(d)) break; d = null; }
    }
  }
  if (!d?.lyrics || !["ttml", "lrc", "plain"].includes(d.format)) return null;
  const sb = d.submitter, who = sb?.displayName ? { name: String(sb.displayName).slice(0, 40), avatar: pfpOk(sb.avatarUrl) ? sb.avatarUrl : null, ...(Number.isFinite(sb.level) ? { level: Math.round(sb.level) } : {}), ...(sb.topBadge?.name ? { badge: String(sb.topBadge.name).slice(0, 40) } : {}) } : null;
  const page = /^[\w-]{11}$/.test(d.videoId || "") ? `${UNISON_HOSTS[0]}/song/${d.videoId}` : UNISON_HOSTS[0] + "/"; // the entry's own page, not the API address
  return { submitter: who, text: d.lyrics, format: d.format, sync: d.syncType === "richsync" ? "word" : d.syncType === "linesync" ? "line" : d.format === "plain" ? "plain" : "line", source: "Unison", sourceHref: page, songwriters: undefined };
}
const LYRIC_PROVIDERS = [ // key, name, and the order they win ties in
  ["blyrics", "Better Lyrics", createBLyricsProvider()], ["unison", "Unison", unisonProvider], ["portato", "Better Lyrics Portato", createPortatoProvider()],
  ["lrclib", "LRCLIB", createLRCLibSyncedProvider()], ["legato", "Kugou", createLegatoProvider()], ["binimum", "lrc.red", createBinimumProvider()], ["lrclib-plain", "LRCLIB plain", createLRCLibPlainProvider()],
];
const SYNC_RANK = { word: 3, line: 2, plain: 1 }; // karaoke (word by word) first, then line by line, then plain text
const syncOf = (x) => { // how a provider's answer is timed
  if (x.sync) return x.sync;
  const l = x.lyrics || [];
  if (l.some((r) => r.parts?.length)) return "word";
  return new Set(l.map((r) => r.startTimeMs)).size > 3 ? "line" : "plain";
};
const lyricCache = new Map(); // "artist|title|duration" -> { at, list }
async function lyricsList({ title, artist, album, duration, isrc }) {
  const key = `${nameKey(artist)}|${nameKey(title)}|${Math.round(duration / 5)}`, hit = lyricCache.get(key);
  if (hit && Date.now() - hit.at < 3600 * 1000) return hit.list;
  const k = video.known({ title, artist }), videoId = k?.id && /^[\w-]{11}$/.test(k.id) && !k.id.startsWith("x") ? k.id : undefined; // Unison matches on a YouTube video id
  const ask = await Promise.allSettled(LYRIC_PROVIDERS.map(([, , fn]) => fn({ song: title, artist, album: album || null, duration, videoId, isrc: isrc || undefined, signal: AbortSignal.timeout(12000) })));
  const list = [];
  ask.forEach((r, i) => {
    const x = r.status === "fulfilled" ? r.value : null;
    if (!x || !(x.lyrics?.length || x.text)) return;
    const [pk, name] = LYRIC_PROVIDERS[i];
    list.push({ key: pk, name, sync: syncOf(x), order: i, payload: { ...(x.text ? { text: x.text, format: x.format } : { lyrics: x.lyrics }), source: x.source, sourceHref: x.sourceHref, songwriters: x.songwriters, ...(x.submitter ? { submitter: x.submitter } : {}) } });
  });
  list.sort((p, q) => SYNC_RANK[q.sync] - SYNC_RANK[p.sync] || p.order - q.order);
  lyricCache.set(key, { at: Date.now(), list });
  if (lyricCache.size > 500) lyricCache.delete(lyricCache.keys().next().value);
  return list;
}

// ---- the web player: the same sources as the addon, for anyone signed in to the web UI ----
const sidOf = (req) => (/(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || "") || [])[1];
const playLink = { id: "player", name: "Web player", enabled: true, accountId: null, userId: null, guest: false, devices: {}, totals: { search: 0, stream: 0, notFound: 0, errors: 0 }, limits: { maxQuality: "HI_RES", atmos: false, expiresAt: null, delayMs: 0, perHour: 0, perDay: 0, maxConcurrent: 0 } };
// Each signed-in person gets a fair share: quick actions are rate-limited, and only a few heavy jobs run for one person at a time.
const hits = new Map(); // "user|kind" -> recent times
function rate(me, kind, max, ms) {
  const key = `${me.id}|${kind}`, now = Date.now(), list = (hits.get(key) || []).filter((t) => now - t < ms);
  if (list.length >= max) { hits.set(key, list); throw Object.assign(httpError(429, "Slow down a little."), { retryAfter: String(Math.max(1, Math.ceil((list[0] + ms - now) / 1000))) }); }
  list.push(now); hits.set(key, list);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
}
const heavy = new Map(); // user id -> heavy requests in flight
const atmosLink = { ...playLink, limits: { ...playLink.limits, atmos: true } }; // the second player asks for Dolby Atmos files by name; it is the one place the web player allows them
const apiLink = { ...playLink, id: "api", name: "Public API" }; // the public metadata API draws on the same TIDAL accounts as the player
const webRow = (t) => { // a song as the web player sees it: pictures come through this server
  const sub = subsonic.parseId(t.id);
  const tc = /\/images\/([0-9a-f]{8}\/[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{12})\//.exec(t.artworkURL || "");
  return { ...t, coverArt: undefined, artworkURL: tc ? `/api/play/tcover/${tc[1].replace(/\//g, "-")}` : (sub && t.coverArt ? `/api/play/art/${sub.server}/${encodeURIComponent(t.coverArt)}` : undefined) };
};
const canSubmitVideo = (me) => video.available() && (me.role === "admin" || db.settings.membersSubmitVideos !== false);
const validTrackId = (id) => /^\d+$/.test(id) || !!subsonic.parseId(id);
const songKey = (t) => `${nameKey(t.title)}|${nameKey(t.artist).split(" ")[0]}`;
// Autoplay: TIDAL's own "radio" for the song that's playing, with a seed from the person's favorites mixed in, so it follows their taste.
// Nothing already played or queued comes back, and no artist takes over (two songs each at most).
const radioCache = new Map(); // seed -> { at, items }
async function recsFor(seed) {
  const hit = radioCache.get(seed);
  if (hit && Date.now() - hit.at < 600000) return hit.items;
  const r = await withAccount(playLink, (a) => accounts.call(a, "/recommendations/", { id: seed }));
  const items = (r.data?.items || []).map((x) => x.track).filter((t) => t && t.allowStreaming !== false).map(toRow).filter((t) => !t.atmos);
  radioCache.set(seed, { at: Date.now(), items });
  if (radioCache.size > 300) radioCache.delete(radioCache.keys().next().value);
  return items;
}
async function seedFor(id) { // a TIDAL id for the song, even when it came from a Subsonic backup
  if (/^\d+$/.test(id)) return id;
  const m = knownMeta.get(id);
  if (!m) return null;
  const r = await withAccount(playLink, (a) => accounts.call(a, "/search/", { s: `${m.artist} ${m.title}`.trim(), limit: 3 })).catch(() => null);
  return r?.data?.items?.[0]?.id ? String(r.data.items[0].id) : null;
}
async function radio(me, id, exclude) {
  const seed = await seedFor(id);
  if (!seed) return [];
  const favs = (me.library?.favorites || []).filter((t) => /^\d+$/.test(t.id));
  const taste = favs.length ? favs[Math.floor(Math.random() * favs.length)].id : null; // one favorite, a different one each time
  const [main, extra] = await Promise.all([recsFor(seed).catch(() => []), taste && taste !== seed ? recsFor(taste).catch(() => []) : []]);
  const seen = new Set(exclude), keys = new Set(exclude.map((x) => knownMeta.get(x)).filter(Boolean).map(songKey));
  const favArtists = new Set(favs.map((t) => nameKey(t.artist).split(" ")[0]));
  const out = [], perArtist = new Map();
  const take = (t) => {
    if (!t || seen.has(t.id) || keys.has(songKey(t))) return false;
    const a = nameKey(t.artist).split(" ")[0];
    if ((perArtist.get(a) || 0) >= 2) return false;
    seen.add(t.id); keys.add(songKey(t)); perArtist.set(a, (perArtist.get(a) || 0) + 1); out.push(t);
    return true;
  };
  // the song's own radio leads; every fourth pick comes from the favorite's radio; songs by artists they already like float up a little
  const lead = [...main].sort((x, y) => favArtists.has(nameKey(y.artist).split(" ")[0]) - favArtists.has(nameKey(x.artist).split(" ")[0]) || 0);
  let a = 0, b = 0;
  while (out.length < 10 && (a < lead.length || b < extra.length)) {
    if ((out.length + 1) % 4 === 0 && b < extra.length) take(extra[b++]);
    else if (a < lead.length) take(lead[a++]);
    else take(extra[b++]);
  }
  for (const t of out) { known.set(t.id, `${t.artist} - ${t.title}`); knownMeta.set(t.id, { title: t.title, artist: t.artist, duration: t.duration }); }
  return out.map(webRow);
}
// The server's speakers, for both players (the first one's /api/play/speaker and Monochrome's /__off/speaker): who may use them, and what a request does.
const speakerAllowed = (me) => me.role === "admin" || me.speaker === true;
async function speakerAct(me, b) {
  const num = (v, max) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(Number(v), max)) : 0);
  if (b.action === "play") {
    const id = String(b.id || ""), tier = tierFor(b.q, "HI_RES"), sub = subsonic.parseId(id);
    if (!sub && !/^\d+$/.test(id)) throw httpError(400, "bad id");
    const open = async () => {
      if (sub) { const up = await subsonic.open(sub.server, sub.song, tier, null); return up.file ? { file: up.file } : { stream: Readable.fromWeb(up.body) }; }
      return { file: await ensureAudio(playLink, id, tier, false) };
    };
    logEvent({ t: Date.now(), kind: "stream", client: "web", linkId: "player", linkName: "Web player", userId: me.id, user: me.displayName, device: "Server speakers", detail: known.get(id) || `track ${id}`, quality: tier, status: 200, ms: 0, cached: false });
    await speaker.play({ id, title: String(b.title || "").slice(0, 120), dur: num(b.dur, 7200), at: num(b.pos, 7200), open });
  } else if (b.action === "pause") await speaker.pause();
  else if (b.action === "resume") await speaker.resume();
  else if (b.action === "seek") await speaker.seek(num(b.pos, 7200));
  else if (b.action === "volume") await speaker.volume(num(b.vol, 100));
  else if (b.action === "stop") await speaker.stop();
  else throw httpError(400, "Unknown action");
  return speaker.status();
}

async function playApi(req, res, u) {
  const me = sessionUser(sidOf(req));
  if (!me || me.disabled) return json(res, { error: "Sign in first" }, 401);
  const route = u.pathname.slice("/api/play/".length);
  if (req.method !== "GET" && req.method !== "HEAD" && !(req.method === "POST" && (route === "speaker" || route === "library" || route === "video-submit" || route === "scrobble"))) return json(res, { error: "Not found" }, 404);
  try {
    if (me.role !== "admin" && db.settings.membersUsePlayer === false) throw httpError(403, "The player is turned off for members");
    const kind = (route.match(/^(search|lyrics|audio|video|videosync|pfp|tcover|art)\b/) || [])[1], starts = !req.headers.range || /^bytes=0-/.test(req.headers.range);
    if (kind === "search") rate(me, "search", 40, 60000);
    else if (kind === "lyrics") rate(me, "lyrics", 60, 60000);
    else if (kind === "pfp" || kind === "tcover" || kind === "art") rate(me, "images", 300, 60000);
    else if (kind === "audio" && starts) rate(me, "audio", 40, 600000);
    else if ((kind === "video" || kind === "videosync") && starts) rate(me, "video", 30, 600000);
    if ((kind === "audio" || kind === "video" || kind === "videosync") && starts) {
      const n = heavy.get(me.id) || 0;
      if (n >= 4) throw Object.assign(httpError(429, "A few things are already loading. Try again in a moment."), { retryAfter: "3" });
      heavy.set(me.id, n + 1);
      res.on("close", () => heavy.set(me.id, Math.max(0, (heavy.get(me.id) || 1) - 1)));
    }
    if (route === "speaker") { // the server's own speakers (its AUX out); admins choose who may use them
      if (!speakerAllowed(me)) throw httpError(403, "You can't use the server speakers");
      if (req.method === "GET") return json(res, await speaker.status());
      if (req.headers["x-requested-with"] !== "ui") throw httpError(403, "Not allowed");
      rate(me, "speaker", 240, 60000);
      const b = await new Promise((ok, no) => { let s = ""; req.on("data", (c) => { s += c; if (s.length > 4096) req.destroy(); }); req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch { no(httpError(400, "Bad request")); } }); req.on("error", no); });
      return json(res, await speakerAct(me, b));
    }
    if (route === "scrobble") { // what the player is playing, to the person's own Last.fm
      if (req.headers["x-requested-with"] !== "ui") throw httpError(403, "Not allowed");
      if (!me.lastfm) return json(res, { ok: false, off: true });
      rate(me, "scrobble", 120, 60000);
      const b = await new Promise((ok, no) => { let s = ""; req.on("data", (c) => { s += c; if (s.length > 4096) req.destroy(); }); req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch { no(httpError(400, "Bad request")); } }); req.on("error", no); });
      if (b.kind !== "now" && b.kind !== "scrobble") throw httpError(400, "Unknown action");
      return json(res, await lastfmSend(me, b.kind, b, Number(b.ts)));
    }
    if (route === "library") { // favorites and playlists, one library per person
      if (req.method === "GET") return json(res, { ...library.view(me), can: { submit: canSubmitVideo(me), video: video.available() } }); // "video" tells the player videos exist, even if nothing was searched yet
      if (req.headers["x-requested-with"] !== "ui") throw httpError(403, "Not allowed");
      rate(me, "library", 120, 60000);
      const b = await new Promise((ok, no) => { let s = ""; req.on("data", (c) => { s += c; if (s.length > 8192) req.destroy(); }); req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch { no(httpError(400, "Bad request")); } }); req.on("error", no); });
      return json(res, library.mutate(me, b, validTrackId));
    }
    if (route === "video-submit") { // someone says which video belongs to a song
      if (!canSubmitVideo(me)) throw httpError(me.role === "admin" || !video.available() ? 503 : 403, video.available() ? "Video submissions are turned off" : "Music videos aren't set up on this server");
      if (req.headers["x-requested-with"] !== "ui") throw httpError(403, "Not allowed");
      rate(me, "vsubmit", 10, 3600000);
      const b = await new Promise((ok, no) => { let s = ""; req.on("data", (c) => { s += c; if (s.length > 4096) req.destroy(); }); req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch { no(httpError(400, "Bad request")); } }); req.on("error", no); });
      const id = String(b.id || ""), meta = knownMeta.get(id) || { title: String(b.title || "").slice(0, 120), artist: String(b.artist || "").slice(0, 80) };
      if (!validTrackId(id) || !meta.title.trim()) throw httpError(400, "Pick a song first");
      const yt = video.youtubeId(b.link);
      if (!yt) throw httpError(400, "Paste a YouTube link");
      const have = video.overrideFor(meta);
      if (have && !have.by && me.role !== "admin") throw httpError(403, "An admin already chose the video for this song");
      const info = await video.probe(yt);
      video.setOverride(meta.artist, meta.title, `https://www.youtube.com/watch?v=${yt}`, { by: { id: me.id, name: me.displayName } });
      logEvent({ t: Date.now(), kind: "stream", client: "web", linkId: "player", linkName: "Web player", userId: me.id, user: me.displayName, device: "Web player", detail: `video for ${meta.artist} - ${meta.title}`, quality: "", status: 200, ms: 0, cached: false });
      return json(res, { ok: true, title: info.title, duration: info.duration });
    }
    if (route === "radio") { // what to play next when the queue runs out
      rate(me, "radio", 30, 60000);
      const id = u.searchParams.get("id") || "", ex = (u.searchParams.get("exclude") || "").split(",").filter(Boolean).slice(0, 120);
      if (!validTrackId(id)) throw httpError(400, "bad id");
      return json(res, { tracks: await radio(me, id, [id, ...ex]) });
    }
    if (route === "search") {
      const q = (u.searchParams.get("q") || "").trim().slice(0, 200);
      if (!q) return json(res, { tracks: [], videos: video.available() });
      const { tracks } = await search(q, playLink);
      return json(res, { videos: video.available(), tracks: tracks.filter((t) => !t.atmos).map(webRow) }); // browsers can't play Atmos
    }
    let m;
    if ((m = route.match(/^audio\/(.+)$/))) {
      const id = decodeURIComponent(m[1]), tier = tierFor(u.searchParams.get("q"), "HI_RES");
      if (!req.headers.range || /^bytes=0-/.test(req.headers.range)) { // the start of a play, not a seek
        logEvent({ t: Date.now(), kind: "stream", client: "web", linkId: "player", linkName: "Web player", userId: me.id, user: me.displayName, device: "Web player", detail: known.get(id) || `track ${id}`, quality: tier, status: 200, ms: 0, cached: false });
      }
      const sub = subsonic.parseId(id);
      if (sub) return await subsonicProxy(req, res, playLink, sub.server, sub.song, tier);
      if (!/^\d+$/.test(id)) throw httpError(404, "bad id");
      u.searchParams.set("q", tier);
      if (!/^(alac|mp3)$/i.test(u.searchParams.get("format") || "")) u.searchParams.delete("format");
      return await audioProxy(req, res, playLink, id, u);
    }
    if (route === "lyrics") {
      const g = (k) => (u.searchParams.get(k) || "").slice(0, 200), title = g("title"), duration = Number(g("duration")) || 0;
      if (!title) return json(res, { lyrics: null, options: [] });
      const list = await lyricsList({ title, artist: g("artist"), album: g("album"), duration, isrc: g("isrc").replace(/[^A-Za-z0-9]/g, "").slice(0, 12) });
      const pick = list.find((x) => x.key === g("provider")) || list[0]; // the one chosen if it has lyrics, else the best synced
      return json(res, { ...(pick ? { ...pick.payload, key: pick.key, sync: pick.sync } : { lyrics: null }), options: list.map(({ key, name, sync }) => ({ key, name, sync })) });
    }
    if (route === "pfp") { // a lyric contributor's profile picture
      const src = u.searchParams.get("u") || "";
      if (!pfpOk(src)) throw httpError(400, "Not a profile picture");
      const name = crypto.createHash("sha256").update(src).digest("hex").slice(0, 24), file = `${PFP_DIR}/${name}.webp`;
      if (!fs.existsSync(file)) {
        const up = await fetch(src, { redirect: "manual", signal: AbortSignal.timeout(5000) }); // no redirects: a link can't send us somewhere else
        if (!up.ok) throw httpError(404, "No picture");
        const chunks = []; let size = 0;
        for await (const c of up.body) { size += c.length; if (size > 2e6) throw httpError(404, "Picture too large"); chunks.push(c); }
        const out = await squareWebp(Buffer.concat(chunks)).catch(() => null); // a real decoder: anything that isn't an image is thrown away
        if (!out) throw httpError(404, "Not an image");
        fs.writeFileSync(file, out);
        const old = fs.readdirSync(PFP_DIR).map((f) => [f, fs.statSync(`${PFP_DIR}/${f}`).mtimeMs]).sort((x, y) => y[1] - x[1]).slice(500);
        for (const [f] of old) fs.rmSync(`${PFP_DIR}/${f}`, { force: true });
      }
      res.writeHead(200, { "Content-Type": "image/webp", "Cache-Control": "private, max-age=604800", "X-Content-Type-Options": "nosniff" });
      return void fs.createReadStream(file).pipe(res);
    }
    if ((m = route.match(/^tcover\/([0-9a-f-]{36})$/))) { // TIDAL cover art, served from here so the page (and its animated background) can use it
      const up = await fetch(`https://resources.tidal.com/images/${m[1].replace(/-/g, "/")}/640x640.jpg`, { signal: AbortSignal.timeout(8000) });
      if (!up.ok) throw httpError(404, "No cover");
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=604800", "X-Content-Type-Options": "nosniff" });
      return void Readable.fromWeb(up.body).on("error", () => res.destroy()).pipe(res);
    }
    if (route === "motion") { // an album's animated cover, for the web player only (never the addon routes)
      if (!motion.available()) throw httpError(404, "No animated cover");
      rate(me, "motion", 90, 60000);
      const r = await motion.forAlbum(u.searchParams.get("artist"), u.searchParams.get("album"), u.searchParams.get("shape") === "tall" ? "tall" : "square");
      if (!r) throw httpError(404, "No animated cover");
      return serveFile(req, res, r.file, "video/mp4");
    }
    if ((m = route.match(/^video-status\/(.+)$/))) { // how far a song's video download has come, for the progress bar
      rate(me, "vstatus", 400, 60000);
      return json(res, video.statusFor(knownMeta.get(decodeURIComponent(m[1]))));
    }
    if ((m = route.match(/^videosync\/(.+)$/))) { // how far the music video is from the song: videoTime = songTime + offset
      const id = decodeURIComponent(m[1]);
      return json(res, await videoSyncFor(id, knownMeta.get(id)));
    }
    if ((m = route.match(/^video\/(.+)$/))) return await videoProxy(req, res, playLink, null, decodeURIComponent(m[1]));
    if ((m = route.match(/^art\/([a-f0-9]+)\/([^/]+)$/))) {
      const up = await subsonic.cover(m[1], decodeURIComponent(m[2]));
      res.writeHead(200, { "Content-Type": up.headers.get("content-type"), "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
      return void Readable.fromWeb(up.body).on("error", () => res.destroy()).pipe(res);
    }
    json(res, { error: "Not found" }, 404);
  } catch (e) {
    if (res.headersSent) return void res.destroy();
    json(res, { error: e.message }, e.status || 502, e.retryAfter ? { "Retry-After": e.retryAfter } : {});
  }
}

// How far a song's music video is from the song (videoTime = songTime + offset), shared by the first player (which knows the song from its search) and the second (which says what the song is).
async function videoSyncFor(id, meta) {
      const v = meta && (await video.forTrack(meta).catch(() => null));
      if (!v) return ({ offset: 0, ok: false, video: false });
      const ov = video.overrideFor(meta); // numbers set by hand in Accounts win over everything automatic
      if (ov && Number.isFinite(ov.offset)) return ({ offset: ov.offset, ok: true, via: "manual", ...(ov.end ? { end: ov.end } : {}), video: true });
      const key = `${id}|${v.id}`, cached = video.syncGet(key);
      if (cached) { // an answer from before: SponsorBlock's end and interruptions still apply (they're cheap, and cached for a day)
        const csb = await sponsorblock.range(v.id, meta.duration).catch(() => null);
        return ({ ...cached, ...(csb?.match ? { ...(csb.end ? { end: csb.end } : {}), ...(csb.skips.length ? { skips: csb.skips } : {}) } : {}), ...(ov?.end ? { end: ov.end } : {}), video: true });
      }
      // SponsorBlock says where the music is inside the video (past a spoken intro, and where it stops before an outro). The audio match is
      // exact when it's sure; when it isn't, that estimate stands in, and it always tells the player where the music ends.
      const sb = await sponsorblock.range(v.id, meta.duration).catch(() => null);
      const sub = subsonic.parseId(id);
      let audio;
      if (sub) { const up = await subsonic.open(sub.server, sub.song, "HI_RES", null); audio = up.file ? { file: up.file } : { stream: Readable.fromWeb(up.body) }; }
      else audio = { file: await ensureAudio(playLink, id, "HIGH", false) };
      let r = null, aligned = false;
      try { r = await video.align(await video.fileFor(v.id), audio, key); aligned = !!r?.ok; }
      catch (e) { if (e?.still || video.isStill(v.id)) return ({ offset: 0, ok: false, video: false }); /* only a picture: there's no music video for this song */ /* otherwise decode failed: fall through to the estimate */ }
      let via = "audio";
      if (!aligned && sb?.match) { r = { offset: sb.start, ok: true, confidence: 0 }; via = "sponsorblock"; }
      else if (!r) return ({ offset: 0, ok: false, video: true, ...(ov?.end ? { end: ov.end } : {}) });
      const out = { ...r, via, ...(sb?.end && sb.match ? { end: sb.end } : {}), ...(sb?.match && sb.skips.length ? { skips: sb.skips } : {}) }; // the end only counts when the music's length fits the song, so a wrong mark can't cut a video short
      video.syncSet(key, out);
      return ({ ...out, ...(ov?.end ? { end: ov.end } : {}), video: true });
}

// A music video found by video.mjs goes through here (YouTube's links only work for the address that asked for them).
async function videoProxy(req, res, link, id, trackId = null, metaOverride = null) {
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  try {
    if (!link.enabled || (link.limits.expiresAt && link.limits.expiresAt < Date.now())) throw httpError(403, "This link is not active");
    if (trackId || metaOverride) { // found only now: look it up for the song, then it's the same as any other video
      const meta = metaOverride || knownMeta.get(trackId), v = meta && (await video.forTrack(meta).catch(() => null));
      if (!v) throw httpError(404, "No video for this song");
      id = v.id;
    }
    if (!video.allowed(id)) throw httpError(404, "Unknown video");
    const t0 = Date.now(), file = await video.fileFor(id);
    if (!req.headers.range || /^bytes=0-/.test(req.headers.range)) { // the start of a video: show it in Activity
      const owner = db.users[link.userId];
      logEvent({ t: Date.now(), kind: "video", client: "eclipse", linkId: link.id, linkName: link.name, userId: link.userId, user: owner?.displayName || (link.guest ? "Guest" : "—"), device: cleanName(req.headers["user-agent"]), detail: `video ${id}`, status: 200, ms: Date.now() - t0, cached: false });
    }
    return serveFile(req, res, file, "video/mp4");
  } catch (e) {
    if (res.headersSent) return void res.destroy();
    json(res, { error: e.message }, e.status || 502);
  }
}

// Audio from a Subsonic backup goes through here, so the listener never sees that server's login.
async function subsonicProxy(req, res, link, sid, songId, q) {
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  try {
    if (!link.enabled || (link.limits.expiresAt && link.limits.expiresAt < Date.now())) throw httpError(403, "This link is not active");
    const up = await subsonic.open(sid, songId, tierFor(q, link.limits.maxQuality), req.headers.range, ac.signal);
    if (up.file) return serveFile(req, res, up.file, up.mime); // converted here
    const h = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) if (up.headers.get(k)) h[k] = up.headers.get(k);
    res.writeHead(up.status, h);
    if (req.method === "HEAD") { ac.abort(); return void res.end(); }
    Readable.fromWeb(up.body).on("error", () => res.destroy()).pipe(res);
  } catch (e) {
    if (res.headersSent) return void res.destroy();
    json(res, { error: e.message }, e.status || 502);
  }
}

// ---- link previews (Discord, Slack, iMessage…): Open Graph tags, injected per page ----
const BOT = /Discordbot|Twitterbot|facebookexternalhit|Slackbot|Slack-ImgProxy|TelegramBot|WhatsApp|LinkedInBot|Mastodon|Bluesky/i;
const h = (x) => String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const originOf = (req) => `${req.headers["x-forwarded-proto"] === "https" || req.headers["cf-visitor"]?.includes("https") ? "https" : "http"}://${req.headers["x-forwarded-host"] || req.headers.host}`;
function ogTags(req, title, desc, image) {
  const o = originOf(req);
  image ||= `${o}/og.png`;
  return [
    ["name", "description", desc], ["property", "og:site_name", APP_NAME], ["property", "og:type", "website"], ["property", "og:title", title], ["property", "og:description", desc],
    ["property", "og:image", image], ["property", "og:image:width", "1200"], ["property", "og:image:height", "630"], ["property", "og:image:alt", `${APP_NAME}: lossless music for BitChord`],
    ["name", "twitter:card", "summary_large_image"], ["name", "twitter:title", title], ["name", "twitter:description", desc], ["name", "twitter:image", image],
  ].map(([k, n, c]) => `<meta ${k}="${n}" content="${h(c)}">`).join("\n");
}
// The app shell, with a preview that depends on the link: invites get a personal one.
// Cloudflare gives static files a 4h browser cache, so the URL itself has to change when a file does.
const assetV = (f) => { try { return Math.floor(fs.statSync(WEB + f).mtimeMs / 1000).toString(36); } catch { return "0"; } };
function shell(req, html, query) {
  html = html.replace('href="/style.css"', `href="/style.css?v=${assetV("style.css")}"`).replace('src="/app.js"', `src="/app.js?v=${assetV("app.js")}"`);
  let title = APP_NAME, desc = "Lossless and hi-res music for BitChord from your own TIDAL account. Sign in to manage your links.", image;
  const code = query.get("invite"), inv = code && db.invites[code];
  if (code && inv && !BOT.test(req.headers["user-agent"] || "")) {
    const ua = req.headers["user-agent"] || "", state = inviteState(inv);
    const device = `${/Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Unknown device"}${/Firefox/.test(ua) ? " · Firefox" : /Edg\//.test(ua) ? " · Edge" : /Chrome/.test(ua) ? " · Chrome" : /Safari/.test(ua) ? " · Safari" : ""}`;
    inviteOpenedAlert(code, state, db.users[inv.by]?.displayName, device, req.headers["cf-ipcountry"]);
  }
  if (inv && inviteState(inv) === "valid") {
    const by = db.users[inv.by];
    title = by ? `${by.displayName} invited you to ${APP_NAME}` : `You're invited to ${APP_NAME}`;
    desc = inv.message ? `“${inv.message}”` : "Create your account to stream lossless and hi-res music in BitChord.";
    // The version changes with the inviter's name and photo, so chat apps don't keep an old picture.
    if (by) image = `${originOf(req)}/og/invite/${code}.png?v=${crypto.createHash("md5").update(`${by.displayName}|${by.avatar || 0}|${inv.message || ""}`).digest("hex").slice(0, 8)}`;
  }
  const by0 = inv && db.users[inv.by];
  if (by0?.avatar) html = html.replace('<link rel="icon" href="/icon.svg?v=3" type="image/svg+xml">', `<link rel="icon" href="/api/invite/${code}/avatar?v=${by0.avatar}" type="image/jpeg">`);
  html = html.replace("<title>Undertow</title>", `<title>${h(title)}</title>\n${ogTags(req, title, desc, image)}`);
  // Chat apps take the first theme-color as the embed accent; browsers keep the light/dark pair.
  return BOT.test(req.headers["user-agent"] || "") ? html.replace(/<meta name="theme-color"[^>]*>\n?/g, "").replace("</head>", '<meta name="theme-color" content="#5b5cf0">\n</head>') : html;
}
// What someone sees when they open an addon URL in a browser (or a chat app unfurls it).
// The browser tab shows the manager's photo when they have one.
const faviconFor = (link, maker) => (maker?.avatar ? `<link rel="icon" href="/${link.token}/maker.jpg?v=${maker.avatar}" type="image/jpeg">` : `<link rel="icon" href="/icon.svg?v=3" type="image/svg+xml">`);
const makerFace = (link, maker, px) => {
  if (!maker) return "";
  const hue = (x) => { let n = 0; for (const c of String(x)) n = (n * 31 + c.charCodeAt(0)) % 360; return n; };
  return `<span class="avatar" style="--c:hsl(${hue(maker.username)} 62% 50%);width:${px}px;height:${px}px">${maker.avatar ? `<img src="/${link.token}/maker.jpg?v=${maker.avatar}" alt="" draggable="false">` : h([...maker.displayName][0]?.toUpperCase() || "?")}</span>`;
};
function addonPage(req, link) {
  const ua = req.headers["user-agent"] || "", bot = BOT.test(ua), phone = !bot && /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const name = link.addonName || APP_NAME, origin = originOf(req), url = `${origin}/${link.token}`, maker = makerOf(link);
  const by = maker ? maker.displayName : "the admins";
  const title = `${name} for BitChord`, desc = `${addonKind(link)} · managed by ${by}. Add the link in BitChord as a source.`;
  const image = `${url}/og.png?v=${crypto.createHash("md5").update(`${link.addonName}|${link.guest}|${maker?.displayName}|${maker?.avatar || 0}`).digest("hex").slice(0, 8)}`;
  const hue = (x) => { let n = 0; for (const c of String(x)) n = (n * 31 + c.charCodeAt(0)) % 360; return n; };
  const steps = phone
    ? ["Tap Copy link", "Open BitChord, then Sources", "Choose Add an addon and paste the link"]
    : ["Copy the link", "On your phone, open BitChord and go to Sources", "Choose Add an addon and paste it (send the link to your phone first)"];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${h(title)}</title>
<meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#0f1114">${faviconFor(link, maker)}<link rel="stylesheet" href="/style.css?v=${assetV("style.css")}">
${ogTags(req, title, desc, image)}</head><body class="${phone ? "phone" : "pc"}"><div class="ambient" aria-hidden="true"></div>
<main class="auth"><section class="card glass" style="${phone ? "" : "width:min(480px,100%)"}"><img class="logo" src="/icon.svg?v=3" alt=""><div><h1>${h(name)}</h1><p class="muted" style="margin-top:6px">${h(addonKind(link))}</p></div>
<div class="row">${makerFace(link, maker, 36)}<div class="small"><span class="muted">Managed by</span><div><b>${h(by)}</b></div></div></div>
${phone ? `<button class="btn primary" id="copy" style="min-height:52px">Copy link</button><div class="urlbox"><code id="url">${h(url)}</code></div>` : `<div class="urlbox"><code id="url">${h(url)}</code><button class="btn sm" id="copy">Copy</button></div>`}
<ol class="muted small" style="margin:0;padding-left:20px;display:grid;gap:4px">${steps.map((t) => `<li>${h(t)}</li>`).join("")}</ol>
<a class="btn" href="${h(url)}/status">Status</a></section></main><script src="/addon.js"></script></body></html>`;
}

// /<token>/status: how this addon is doing and who runs it. Shows nothing about other links or accounts.
function statusPage(req, link) {
  const name = link.addonName || APP_NAME, L = link.limits, now = Date.now(), us = usage(link.id);
  const ev = activity.filter((e) => e.linkId === link.id && e.t > now - 86400000 && e.kind !== "manifest");
  const streams = ev.filter((e) => e.kind === "stream" && e.status < 400), searches = ev.filter((e) => e.kind === "search");
  const avg = streams.length ? Math.round(streams.reduce((a, e) => a + e.ms, 0) / streams.length) : null;
  const issues = ev.filter((e) => e.status >= 400).length;
  const owner = db.users[link.userId], maker = db.users[link.createdBy] || owner;
  const hue = (s) => { let x = 0; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) % 360; return x; };
  const who = (u) => `${makerFace(link, u, 40)}<div><b>${h(u.displayName)}</b><div class="small muted">@${h(u.username)}${u.role === "admin" ? " · Admin" : ""}</div></div>`;
  const state = !link.enabled ? ["Disabled", "bad"] : L.expiresAt && L.expiresAt < now ? ["Expired", "bad"] : ["Active", "ok"];
  const Q = { HI_RES: "Hi-res", CD: "CD quality", HIGH: "High (AAC)", LOW: "Low (AAC)" };
  const cap = (n, max) => (max ? `${n} / ${max}` : String(n));
  const ms = (x) => (x == null ? "—" : x < 1000 ? `${x} ms` : `${(x / 1000).toFixed(1)} s`);
  const ago = (t) => { if (!t) return "never"; const s = Math.max(0, Math.round((now - t) / 1000)); return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
  const devs = Object.entries(link.devices).sort((a, b) => b[1].stream + b[1].search - (a[1].stream + a[1].search)).slice(0, 5);
  const title = `${name} status`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${h(title)}</title>
<meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#0f1114"><meta http-equiv="refresh" content="60">${faviconFor(link, maker)}<link rel="stylesheet" href="/style.css?v=${assetV("style.css")}"></head><body><div class="ambient" aria-hidden="true"></div>
<main class="shell" style="display:block;max-width:560px"><div class="view still" style="padding-top:16px">
<div class="row between"><div class="brand"><img src="/icon.svg?v=3" alt="">${h(name)}</div><span class="chip ${state[1]}">${state[0]}</span></div>
<section class="card glass"><div class="small muted" style="margin-bottom:10px">Managed by</div><div class="row">${maker ? who(maker) : "<div><b>The admins</b></div>"}</div>
  <div class="small muted" style="margin-top:12px">${link.guest ? "Guest addon. It has no account, and only admins can change it." : owner ? `Used by ${h(owner.displayName)}.` : ""}</div></section>
<div class="tiles"><div class="tile glass"><span>Streams · 24h</span><b>${streams.length}</b></div><div class="tile glass"><span>Searches · 24h</span><b>${searches.length}</b></div>
  <div class="tile glass"><span>Avg stream time</span><b>${ms(avg)}</b></div><div class="tile glass"><span>Errors · 24h</span><b>${issues}</b></div></div>
<section class="card glass"><h2>This link</h2><dl class="kv" style="margin-top:12px">
  <dt>Quality</dt><dd>${Q[L.maxQuality] || L.maxQuality}</dd><dt>Dolby Atmos</dt><dd>${L.atmos ? "Allowed" : "Blocked"}</dd><dt>Downloads</dt><dd>${L.downloads ? "Allowed" : "Blocked"}</dd>
  <dt>Lossless check</dt><dd>${L.losslessCheck ? "On" : "Off"}</dd><dt>Delay</dt><dd>${L.delayMs ? `${L.delayMs / 1000}s` : "None"}</dd>
  <dt>Streams this hour</dt><dd>${cap(us.hour, L.perHour)}</dd><dt>Streams today</dt><dd>${cap(us.day, L.perDay)}</dd>
  <dt>Expires</dt><dd>${L.expiresAt ? new Date(L.expiresAt).toLocaleDateString("en-GB") : "Never"}</dd><dt>Last used</dt><dd>${ago(link.lastSeen)}</dd></dl></section>
${devs.length ? `<section class="card glass"><h2>Devices</h2><dl class="kv" style="margin-top:12px">${devs.map(([n, d]) => `<dt>${h(n)}</dt><dd>${d.stream} streams · ${ago(d.lastSeen)}</dd>`).join("")}</dl></section>` : ""}
<p class="small muted center">Updates every minute</p></div></main></body></html>`;
}

// ---- personal invite banner: the inviter's photo and name, rendered to PNG with rsvg-convert ----
const rgb = (hue) => { // hsl(hue, 62%, 50%) as hex, matching the avatars in the UI
  const a = 0.62 * 0.5, f = (n) => { const k = (n + hue / 30) % 12; return Math.round(255 * (0.5 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return `#${[f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
};
const hueOf = (str) => { let x = 0; for (const c of String(str)) x = (x * 31 + c.charCodeAt(0)) % 360; return x; };
const inviteSvg = (user, photo, message) => {
  const name = [...user.displayName].slice(0, 28).join("") + ([...user.displayName].length > 28 ? "…" : "");
  const size = name.length <= 10 ? 104 : name.length <= 16 ? 84 : name.length <= 22 ? 66 : 52;
  const initial = h([...user.displayName][0]?.toUpperCase() || "?");
  const face = photo
    ? `<image href="data:image/jpeg;base64,${photo.toString("base64")}" x="0" y="0" width="320" height="320" preserveAspectRatio="xMidYMid slice" clip-path="url(#face)"/>`
    : `<circle cx="160" cy="160" r="160" fill="${rgb(hueOf(user.username))}"/><text x="160" y="205" text-anchor="middle" font-family="Inter, 'Noto Sans', 'DejaVu Sans', sans-serif" font-weight="700" font-size="150" fill="#fff">${initial}</text>`;
  const font = `font-family="Inter, 'Noto Sans', 'Noto Color Emoji', 'DejaVu Sans', sans-serif"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1200 630" width="1200" height="630"><defs>
<linearGradient id="bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0b1020"/><stop offset="1" stop-color="#07090f"/></linearGradient>
<linearGradient id="ibg" x1="6" y1="0" x2="58" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#52a0ff"/><stop offset=".55" stop-color="#5b5cf0"/><stop offset="1" stop-color="#8a3ffc"/></linearGradient>
<linearGradient id="u" x1="0" y1="14" x2="0" y2="52" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#d9e4ff"/></linearGradient>
<clipPath id="face"><circle cx="160" cy="160" r="160"/></clipPath><clipPath id="r"><rect width="64" height="64" rx="15"/></clipPath>
<filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="90"/></filter><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="26"/></filter></defs>
<rect width="1200" height="630" fill="url(#bg)"/>
<circle cx="160" cy="80" r="330" fill="#2f5fd0" opacity=".55" filter="url(#blur)"/><circle cx="1090" cy="210" r="300" fill="#7a3fd0" opacity=".5" filter="url(#blur)"/><circle cx="560" cy="720" r="290" fill="#138f86" opacity=".45" filter="url(#blur)"/>
<rect x="64" y="64" width="1072" height="502" rx="48" fill="#fff" opacity=".055" stroke="#fff" stroke-opacity=".16" stroke-width="2"/><path d="M112 66h976" stroke="#fff" stroke-opacity=".28" stroke-width="2" stroke-linecap="round"/>
<g transform="translate(130 155)"><circle cx="160" cy="160" r="176" fill="#5b5cf0" opacity=".55" filter="url(#glow)"/><circle cx="160" cy="160" r="172" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="4"/>${face}</g>
<text x="520" y="215" ${font} font-weight="700" font-size="28" letter-spacing="5" fill="#9db4ff">YOU'RE INVITED</text>
<text x="518" y="${215 + size * 0.95}" ${font} font-weight="800" font-size="${size}" letter-spacing="-2" fill="#fff">${h(name)}</text>
<text x="522" y="${215 + size * 0.95 + 62}" ${font} font-weight="500" font-size="42" fill="#fff" fill-opacity=".75">invited you to ${h(APP_NAME)}</text>
<g transform="translate(522 440)"><rect width="84" height="84" rx="20" fill="#5b5cf0" opacity=".5" filter="url(#glow)"/><g transform="scale(1.3125)"><rect width="64" height="64" rx="15" fill="url(#ibg)"/><path d="M20 14v20a12 12 0 0 0 24 0V14" fill="none" stroke="url(#u)" stroke-width="6.5" stroke-linecap="round"/><path d="M24.5 35c2.6-2.8 5.2 2.8 7.5 0s4.9 2.8 7.5 0" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".6"/><path d="M26.5 41c2-2.2 4-.1 5.5-.1s3.5-2.1 5.5.1" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity=".35"/></g></g>
<text x="630" y="476" ${font} font-weight="650" font-size="30" fill="#fff" fill-opacity=".9">Lossless music for BitChord</text><text x="630" y="512" ${font} font-weight="500" font-size="24" fill="#fff" fill-opacity=".55">${h(message ? `“${clip(message, 52)}”` : "Tap the link to create your account")}</text></svg>`;
};
const rendered = new Map(); // "code|name|avatar" -> Promise<Buffer|null>
let rendering = 0;
function renderPng(svg) {
  return new Promise((ok) => {
    const p = spawn("rsvg-convert", ["-w", "1200", "-h", "630", "-f", "png"], { stdio: ["pipe", "pipe", "ignore"] });
    const out = [];
    const timer = setTimeout(() => p.kill(), 10000);
    p.stdout.on("data", (c) => out.push(c));
    p.on("error", () => ok(null)); // rsvg-convert isn't installed: callers fall back to the standard banner
    p.on("close", (code) => { clearTimeout(timer); ok(code === 0 ? Buffer.concat(out) : null); });
    p.stdin.on("error", () => {});
    p.stdin.end(svg);
  });
}
async function inviteBanner(code) {
  const inv = db.invites[code], user = inv && db.users[inv.by];
  if (inviteState(inv) !== "valid" || !user) return null;
  const key = `${code}|${user.displayName}|${user.avatar || 0}|${inv.message || ""}`;
  if (!rendered.has(key)) {
    if (rendering >= 3) return null; // never let a burst of requests pile up renderers
    rendering++;
    const photo = user.avatar ? await fs.promises.readFile(`${AVATAR_DIR}/${user.id}.jpg`).catch(() => null) : null;
    const p = renderPng(inviteSvg(user, photo, inv.message)).finally(() => rendering--);
    rendered.set(key, p);
    p.then((b) => { if (!b) rendered.delete(key); });
    if (rendered.size > 60) rendered.delete(rendered.keys().next().value);
  }
  return rendered.get(key);
}

// ---- addon banner for the token root: addon name, guest or owner, and who manages it ----
const makerOf = (link) => db.users[link.createdBy] || db.users[link.userId] || null;
const addonKind = (link) => (link.guest ? "Guest addon" : db.users[link.userId] ? `${db.users[link.userId].displayName}'s addon` : "Addon");
const clip = (t, n) => ([...t].length > n ? [...t].slice(0, n - 1).join("") + "…" : t);
const addonSvg = (link, maker, photo) => {
  const name = clip(link.addonName || APP_NAME, 26), size = name.length <= 12 ? 96 : name.length <= 18 ? 78 : 62;
  const font = `font-family="Inter, 'Noto Sans', 'Noto Color Emoji', 'DejaVu Sans', sans-serif"`;
  const face = !maker ? `<rect width="320" height="320" rx="64" fill="#1f6feb"/><path d="M96 72v96a64 64 0 0 0 128 0V72" fill="none" stroke="#fff" stroke-width="34" stroke-linecap="round"/>`
    : photo ? `<image href="data:image/jpeg;base64,${photo.toString("base64")}" width="320" height="320" preserveAspectRatio="xMidYMid slice" clip-path="url(#face)"/>`
    : `<circle cx="160" cy="160" r="160" fill="${rgb(hueOf(maker.username))}"/><text x="160" y="205" text-anchor="middle" ${font} font-weight="700" font-size="150" fill="#fff">${h([...maker.displayName][0]?.toUpperCase() || "?")}</text>`;
  const by = maker ? `Managed by ${clip(maker.displayName, 24)}` : "Managed by the admins";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630"><defs><clipPath id="face"><circle cx="160" cy="160" r="160"/></clipPath></defs>
<rect width="1200" height="630" fill="#0f1114"/><rect x="64" y="64" width="1072" height="502" rx="28" fill="#181b20"/>
<g transform="translate(120 155)">${face}</g>
<text x="520" y="${230 + size * 0.2}" ${font} font-weight="700" font-size="${size}" fill="#eceef2">${h(name)}</text>
<text x="522" y="${230 + size * 0.2 + 66}" ${font} font-weight="500" font-size="42" fill="#8e95a3">${h(addonKind(link))}</text>
<text x="522" y="${230 + size * 0.2 + 126}" ${font} font-weight="600" font-size="42" fill="#4c9aff">${h(by)}</text>
<text x="522" y="508" ${font} font-weight="500" font-size="28" fill="#8e95a3">Lossless music for BitChord</text></svg>`;
};
async function addonBanner(link) {
  const maker = makerOf(link), key = `a|${link.id}|${link.addonName}|${link.guest}|${link.userId}|${maker?.displayName}|${maker?.avatar || 0}`;
  if (!rendered.has(key)) {
    if (rendering >= 3) return null;
    rendering++;
    const photo = maker?.avatar ? await fs.promises.readFile(`${AVATAR_DIR}/${maker.id}.jpg`).catch(() => null) : null;
    const p = renderPng(addonSvg(link, maker, photo)).finally(() => rendering--);
    rendered.set(key, p);
    p.then((b) => { if (!b) rendered.delete(key); });
    if (rendered.size > 60) rendered.delete(rendered.keys().next().value);
  }
  return rendered.get(key);
}

const STATIC = {
  "/og.png": ["og.png", "image/png"],
  "/addon.js": ["addon.js", "text/javascript; charset=utf-8"],
  "/join.js": ["join.js", "text/javascript; charset=utf-8"],
  "/chat.js": ["chat.js", "text/javascript; charset=utf-8"],
  "/chat-crypto.js": ["chat-crypto.js", "text/javascript; charset=utf-8"],
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
  "/app.webmanifest": ["app.webmanifest", "application/manifest+json"],
  "/player.js": ["player.js", "text/javascript; charset=utf-8"],
  "/rpc.js": ["rpc.js", "text/javascript; charset=utf-8"],
  "/seasonal.js": ["seasonal.js", "text/javascript; charset=utf-8"],
  "/party.js": ["party.js", "text/javascript; charset=utf-8"],
  "/interlude.gif": ["interlude.gif", "image/gif"],
  "/vendor/braccato.js": ["vendor/braccato.js", "text/javascript; charset=utf-8"],
  "/vendor/braccato.css": ["vendor/braccato.css", "text/css; charset=utf-8"],
  "/vendor/kawarp.js": ["vendor/kawarp.js", "text/javascript; charset=utf-8"],
  "/vendor/monocraft.woff2": ["vendor/monocraft.woff2", "font/woff2"],
  "/vendor/LICENSES.txt": ["vendor/LICENSES.txt", "text/plain; charset=utf-8"],
};
const CSP = `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss://${new URL(process.env.MAIN_URL || process.env.PUBLIC_URL || "https://quiet-otter.outsideitrains.com").host} http://127.0.0.1:8892; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;

http
  .createServer(async (req, res) => {
    try {
      // Some clients append the route after the query ("<base>?name=Phone/manifest.json"): move it back to the path.
      const m = req.url.match(/^\/([A-Za-z0-9_-]{16,64})\/?\?((?:name|device)=[^/&?]*)\/(manifest\.json|search|stream\/[^?]*)(?:\?(.*))?$/);
      const u = m && linkIndex.has(m[1])
        ? new URL(`/${m[1]}/${m[3]}?${m[2]}${m[4] ? "&" + m[4] : ""}`, "http://x")
        : new URL(req.url, "http://x");
      u.pathname = u.pathname.replace(/\/{2,}/g, "/"); // tolerate "//" from base URLs ending in "/"

      if (playerHost.isPlayerHost(req)) { // the second player's own address: its app, its gateway and its sign-in, and nothing else of this server
        return await playerHost.handle(req, res, u, { ip: ipOf(req), appName: APP_NAME, speaker: { allowed: speakerAllowed, status: speaker.status, act: speakerAct }, hifi: (path, params, kind) => withAccount({}, (a) => accounts.call(a, path, params, { poll: true, soft403: true }), kind),
          mv: { // music videos in the second player: it says which song, Undertow finds the video, saves it and measures how it lines up
            available: () => video.available(),
            sync: (id, meta) => videoSyncFor(id, meta),
            file: (rq, rs, meta) => videoProxy(rq, rs, playLink, null, null, meta),
          },
          rpc: { info: rpcInfo, file: rpcFile },
          lastfm: { status: lastfmStatus, start: lastfmPlayerStart, complete: lastfmPlayerComplete, disconnect: lastfmDisconnect, send: lastfmSend },
          lyrics: async (sp) => { // the same answer the first player's /api/play/lyrics gives
            const g = (k) => (sp.get(k) || "").slice(0, 200), title = g("title"), duration = Number(g("duration")) || 0;
            if (!title) return { lyrics: null, options: [] };
            const list = await lyricsList({ title, artist: g("artist"), album: g("album"), duration, isrc: g("isrc").replace(/[^A-Za-z0-9]/g, "").slice(0, 12) });
            const pick = list.find((x) => x.key === g("provider")) || list[0];
            return { ...(pick ? { ...pick.payload, key: pick.key, sync: pick.sync } : { lyrics: null }), options: list.map(({ key, name, sync }) => ({ key, name, sync })) };
          },
          avatar: (id) => (db.users[id]?.avatar ? `${AVATAR_DIR}/${id}.jpg` : null),
          subSearch: (q, n) => (subsonic.any() ? subsonic.search(q, { count: n }) : Promise.resolve([])),
          subSong: (sid, song) => subsonic.song(sid, song),
          subCover: (sid, cid, size) => subsonic.cover(sid, cid, size),
          subAudio: (rq, rs, sid, song, q) => subsonicProxy(rq, rs, apiLink, sid, song, { HI_RES_LOSSLESS: "HI_RES", HI_RES: "HI_RES", LOSSLESS: "CD", CD: "CD", HIGH: "HIGH", LOW: "LOW" }[String(q || "").toUpperCase()] || "HI_RES"),
          audio: async (rq, rs, id, q, fallback, fmt) => { // a song for the second player: Hi-Res or CD, from the same cache the main player uses
            try {
              const TIERS = { HI_RES_LOSSLESS: "HI_RES", HI_RES: "HI_RES", LOSSLESS: "CD", CD: "CD", HIGH: "HIGH", LOW: "LOW" };
              const wantQ = String(q || "").toUpperCase(), atmos = /^DOLBY_ATMOS|^ATMOS$/.test(wantQ); // Dolby Atmos: the E-AC-3 file, like the Eclipse addon's "auto"
              let file;
              if (atmos) { // the Atmos twin of this song when it really has an Atmos stream; anything else is the stereo master at the quality asked for as the fallback
                const back = TIERS[String(fallback || "").toUpperCase()] || "HI_RES";
                let twin = await atmosTwin(atmosLink, id).catch(() => "");
                if (twin) { // an Atmos row with no E-AC-3 stream would only give a lossy AAC file: never trade a lossless song for that
                  const real = await cachedStream(atmosLink, twin, "HI_RES", true, "Player").promise.then((r) => r.body.codec === "eac3-joc").catch(() => false);
                  if (!real) { twins.set(id, { id: "", at: Date.now() }); twin = ""; }
                }
                file = twin ? await ensureAudio(atmosLink, twin, "HI_RES", true) : await ensureAudio(apiLink, id, back, false);
              } else file = await ensureAudio(apiLink, id, TIERS[wantQ] || "CD", false);
              const as = RECODE[String(fmt || "").toLowerCase()] ? String(fmt).toLowerCase() : "";
              if (as) file = await recode(file, as); // "play as": ALAC or MP3 made from the same file
              const info = await probeAudio(file);
              serveFile(rq, rs, file, as ? RECODE[as].mime : MIME[file.split(".").pop()], info ? { "X-Audio-Info": JSON.stringify(info) } : {});
            } catch (e) { if (rs.headersSent) return void rs.destroy(); json(rs, { error: e.message }, e.status || 502, e.retryAfter ? { "Retry-After": e.retryAfter } : {}); }
          } });
      }

      const seg = u.pathname.split("/")[1];
      const link = linkIndex.get(seg);
      if (link) {
        u.pathname = u.pathname.slice(seg.length + 1) || "/";
        if (u.pathname === "/eclipse" || u.pathname.startsWith("/eclipse/")) {
          u.pathname = u.pathname.slice(8) || "/";
          if (req.method === "OPTIONS") return void res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*", "Access-Control-Max-Age": "86400" }).end();
          if (u.pathname === "/" || u.pathname === "") u.pathname = "/manifest.json";
          const sub = u.pathname.match(/^\/sub\/([a-f0-9]+)\/([^/]+)$/);
          if (["/manifest.json", "/search", "/resolve", "/resolve-isrc"].includes(u.pathname) || u.pathname.startsWith("/stream/")) return await addon(req, res, link, u, true);
          if (sub) u.pathname = `/sub/${sub[1]}/${sub[2]}`; // falls through to the audio proxy below
          else return void res.writeHead(404).end();
        }
        if (u.pathname === "/manifest.json" || u.pathname === "/search" || u.pathname.startsWith("/stream/")) return await addon(req, res, link, u);
        if (/^\/(video|audio|sub)\//.test(u.pathname)) { // media paths: log what asks for them, and answer a browser's CORS pre-check
          console.log(new Date().toISOString(), req.method, u.pathname.replace(/^(\/\w+\/(?:by\/)?).*/, "$1…"), req.headers.range ? `range=${req.headers.range}` : "", `· ${String(req.headers["user-agent"] || "").slice(0, 40)}`);
          if (req.method === "OPTIONS") return void res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "*", "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges", "Access-Control-Max-Age": "86400" }).end();
        }
        const vb = u.pathname.match(/^\/video\/by\/(.+)$/);
        if (vb && (req.method === "GET" || req.method === "HEAD")) { const t = decodeURIComponent(vb[1]); if (denied(res, () => needSigned(link, "videoby", t, u))) return; return await videoProxy(req, res, link, null, t); }
        const vm = u.pathname.match(/^\/video\/([\w-]{11})$/);
        if (vm && (req.method === "GET" || req.method === "HEAD")) { if (denied(res, () => needSigned(link, "video", vm[1], u))) return; return await videoProxy(req, res, link, vm[1]); }
        const fm = u.pathname.match(/^\/audio\/(\d+)$/);
        if (fm && (req.method === "GET" || req.method === "HEAD")) { if (denied(res, () => needSigned(link, "audio", fm[1], u, `${u.searchParams.get("q") ?? ""}|${u.searchParams.get("a") === "1" ? 1 : 0}`))) return; return await audioProxy(req, res, link, fm[1], u); }
        const pm = u.pathname.match(/^\/sub\/([a-f0-9]+)\/([^/]+)$/);
        if (pm && (req.method === "GET" || req.method === "HEAD")) { const song = decodeURIComponent(pm[2]); if (denied(res, () => needSigned(link, "sub", `${pm[1]}/${song}`, u, u.searchParams.get("q") ?? ""))) return; return await subsonicProxy(req, res, link, pm[1], song, u.searchParams.get("q")); }
        if (u.pathname === "/og.png" && (req.method === "GET" || req.method === "HEAD")) {
          const png = (await addonBanner(link)) || (await fs.promises.readFile(WEB + "og.png"));
          res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" });
          return void res.end(req.method === "HEAD" ? undefined : png);
        }
        if (u.pathname === "/maker.jpg" && (req.method === "GET" || req.method === "HEAD")) { // only the photo of whoever manages this link
          const m = makerOf(link), body = m?.avatar ? await fs.promises.readFile(`${AVATAR_DIR}/${m.id}.jpg`).catch(() => null) : null;
          if (!body) return void res.writeHead(404).end();
          res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": body.length, "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" });
          return void res.end(req.method === "HEAD" ? undefined : body);
        }
        // BitChord itself asking for the root gets the manifest; people and chat apps get the page.
        if (u.pathname === "/" && /BitChord/i.test(req.headers["user-agent"] || "") && link.enabled) { u.pathname = "/manifest.json"; return await addon(req, res, link, u); }
        if (u.pathname === "/status" && (req.method === "GET" || req.method === "HEAD")) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
          return void res.end(req.method === "HEAD" ? undefined : statusPage(req, link));
        }
        if (u.pathname === "/" && (req.method === "GET" || req.method === "HEAD") && link.enabled) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Vary: "User-Agent", "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
          return void res.end(req.method === "HEAD" ? undefined : addonPage(req, link));
        }
        return void res.writeHead(404).end();
      }
      const cv = u.pathname.match(/^\/v1\/covers\/sub\/([a-f0-9]+)\/([^/]+)$/);
      if (cv && (req.method === "GET" || req.method === "HEAD")) return await coverRoute(req, res, u, cv);
      if (u.pathname === "/player-signin" && (req.method === "GET" || req.method === "HEAD")) { // the second player asking this site who someone is (see lib/playerhost.mjs)
        const id = u.searchParams.get("id") || "";
        const page = (status, html) => { res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }); res.end(html); };
        if (!playerHost.handoffKnown(id)) return page(404, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title><body style="font:16px system-ui;padding:2rem;max-width:30rem;margin:auto"><p>That sign-in has expired. Go back to the player and press Sign in again.</p>`);
        const me = sessionUser(sidOf(req));
        if (me && !me.disabled) {
          const r = playerHost.handoffApprove(id, me);
          if (r?.url) { res.writeHead(302, { Location: r.url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); return void res.end(); }
          return page(403, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title><body style="font:16px system-ui;padding:2rem;max-width:30rem;margin:auto"><p>${r?.error || "That didn't work."}</p>`);
        }
        return page(200, playerHost.mainSigninPage(id, discordOn(), APP_NAME));
      }
      if (u.pathname === "/v1" || u.pathname.startsWith("/v1/")) return await publicApi.handle(req, res, u, { ip: ipOf(req), call: (path, params) => withAccount(apiLink, (a) => accounts.call(a, path, params)), spec: publicApi.openapi, botToken: () => db.settings.discordBot?.token || "",
      subCover: coverUrls,
      lyrics: (meta) => lyricsList({ title: meta.title, artist: meta.artist, album: meta.album, duration: meta.duration, isrc: meta.isrc || "" }),
      subsonicSearch: (q, n) => (subsonic.any() ? subsonic.search(q, { count: n }) : Promise.resolve([])),
      subsonicSong: (id) => { const sub = subsonic.parseId(id); if (!sub) throw httpError(404, "No such track"); return subsonic.song(sub.server, sub.song); },
      stream: async (rq, rs, id, q) => { // a bot asking for a song's audio: CD quality unless it says otherwise
        const sub = subsonic.parseId(id);
        if (sub) return subsonicProxy(rq, rs, apiLink, sub.server, sub.song, Object.hasOwn(RANK, String(q || "").toUpperCase()) ? String(q).toUpperCase() : "HI_RES"); // the file as it is, unless a lower tier is asked for
        try {
          const tier = Object.hasOwn(RANK, String(q || "").toUpperCase()) ? String(q).toUpperCase() : "CD";
          const file = await ensureAudio(apiLink, id, tier, false);
          serveFile(rq, rs, file, MIME[file.split(".").pop()]);
        } catch (e) { if (rs.headersSent) return void rs.destroy(); json(rs, { error: { status: e.status || 502, message: e.message } }, e.status || 502, e.retryAfter ? { "Retry-After": e.retryAfter } : {}); }
      } });
      if (/^\/join\/[a-f0-9]{4,32}$/.test(u.pathname) && (req.method === "GET" || req.method === "HEAD")) { // a friend opening a shared link's invite
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
        return void res.end(req.method === "HEAD" ? undefined : await fs.promises.readFile(WEB + "join.html"));
      }
      if (u.pathname.startsWith("/api/play/")) return await playApi(req, res, u);
      if (u.pathname.startsWith("/api/")) return await handleApi(req, res, u.pathname.slice(4));
      const ib = u.pathname.match(/^\/og\/invite\/([a-f0-9]+)\.png$/);
      if (ib && (req.method === "GET" || req.method === "HEAD")) {
        const inv = db.invites[ib[1]];
        if (inviteState(inv) !== "valid") return void res.writeHead(404).end();
        const png = (await inviteBanner(ib[1])) || (await fs.promises.readFile(WEB + "og.png")); // standard banner if rendering fails
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" });
        return void res.end(req.method === "HEAD" ? undefined : png);
      }
      const file = STATIC[u.pathname];
      if (file && (req.method === "GET" || req.method === "HEAD")) {
        let body = await fs.promises.readFile(WEB + file[0]);
        if (u.pathname === "/") body = shell(req, body.toString(), u.searchParams);
        res.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-cache", "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
        return void res.end(req.method === "HEAD" ? undefined : body);
      }
      console.log(new Date().toISOString(), "REJECTED", req.method, req.url.replace(/^\/[^/?]+/, "/<x>").slice(0, 120));
      res.writeHead(404).end();
    } catch (e) {
      console.log("server error", e);
      if (!res.headersSent) res.writeHead(500).end();
    }
  })
  .on("upgrade", (req, socket, head) => { // the second player's listening parties talk over a WebSocket
    if (new URL(req.url, "http://x").pathname === "/api/parties/ws") return partyHost.upgrade(req, socket, head, { auth: playerHost.userOf, originOk: playerHost.originOk });
    socket.destroy();
  })
  .listen(PORT, () => console.log(`BitChord addon + web UI on :${PORT}`));

// The pre-existing secret URL keeps working as the first link; its device stats are carried over once.
if (SECRET && linkIndex.has(SECRET)) linkIndex.get(SECRET).primary = true; // keeps the original addon id even if its URL is rotated
// Only on a fresh install: once any link carries the original addon id, a rotated or deleted secret URL stays gone.
if (SECRET && !linkIndex.has(SECRET) && !Object.values(db.links).some((x) => x.primary)) {
  const admin = Object.values(db.users).find((x) => x.role === "admin");
  const l = createLink({ userId: admin?.id || null, name: "Original link", token: SECRET });
  l.primary = true;
  try {
    const old = JSON.parse(fs.readFileSync(new URL("./stats.json", import.meta.url), "utf8"));
    for (const [n, d] of Object.entries(old)) {
      l.devices[n] = { search: d.search || 0, stream: d.stream || 0, lastSeen: d.lastSeen ? Date.parse(d.lastSeen) : 0 };
      l.totals.search += d.search || 0; l.totals.stream += d.stream || 0; l.totals.notFound += d.notFound || 0;
    }
  } catch { /* nothing to import */ }
}
accounts.boot();
subsonic.boot();
