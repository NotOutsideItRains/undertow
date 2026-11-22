// Monochrome Connect: send what is playing in Monochrome to another device of your own, like Spotify Connect.
//
// A device is a receiver that plays what it is told: a small program on a Raspberry Pi (connect/agent.py) with a Bluetooth speaker, or a web page
// (/connect) opened on a phone, laptop or TV. Devices belong to one person: only the owner sees and controls them.
//
//  - Pairing (programs): the receiver asks for a short code, the owner types it into Monochrome, and the receiver is handed its own token. Nothing secret
//    is ever typed into a shell.
//  - A receiver is not called, it calls: it holds a long request open ("poll") and the server answers it with the next command, so it works from behind any
//    router and any tunnel. It reports what it is doing about once a second.
//  - What a receiver may be told is a short fixed list (play, pause, resume, seek, volume, stop). The server never sends it anything to run.
import crypto from "node:crypto";
import { db, save, httpError, rid } from "./store.mjs";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
export const LIMITS = { devices: 10, pollMs: 25000, onlineMs: Number(process.env.CONNECT_ONLINE_MS) || 45000, pairMs: 10 * 60 * 1000, pairing: 200, queue: 40 };
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0 or 1: a code read aloud or off a screen is not mistaken
const devs = () => (db.devices ||= {});
const live = new Map(); // device id -> { seq, queue, waiter, state, seen }
const L = (id) => { let l = live.get(id); if (!l) live.set(id, (l = { seq: 0, queue: [], waiter: null, state: null, seen: 0 })); return l; };

const cleanText = (n, max) => String(n ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export const cleanName = (n, fallback = "Device") => cleanText(n, 40) || fallback;
const num = (v, max, dflt = 0) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(Number(v), max)) : dflt);
const online = (l) => !!l && Date.now() - l.seen < LIMITS.onlineMs;

// ---- what the owner sees ----
function view(d) {
  const l = live.get(d.id), s = l?.state;
  const pos = s ? (s.playing ? Math.min(s.dur || 1e9, s.pos + (Date.now() - s.at) / 1000) : s.pos) : 0; // where the song is now, not when it last reported
  return {
    id: d.id, name: d.name, kind: d.kind, online: online(l),
    state: s ? { id: s.id, playing: s.playing, pos: Math.round(pos * 10) / 10, dur: s.dur, ended: s.ended, volume: s.volume, error: s.error } : null,
  };
}
export const list = (userId) => Object.values(devs()).filter((d) => d.owner === userId).sort((a, b) => a.created - b.created).map(view);
export const ownedBy = (userId, id) => { const d = devs()[id]; return d && d.owner === userId ? d : null; };

// ---- pairing a program (the Raspberry Pi) ----
const pairings = new Map(); // code -> { poll, exp, claim }
const byPoll = new Map(); // poll token -> code
const sweep = () => { const now = Date.now(); for (const [c, p] of pairings) if (p.exp < now) { pairings.delete(c); byPoll.delete(p.poll); } };
const normCode = (c) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export function startPairing() {
  sweep();
  if (pairings.size >= LIMITS.pairing) throw httpError(429, "Too many devices are pairing right now. Try again in a few minutes.");
  let code = "";
  for (let i = 0; i < 8; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  const p = { poll: rid(16), exp: Date.now() + LIMITS.pairMs, claim: null };
  pairings.set(code, p); byPoll.set(p.poll, code);
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, poll: p.poll, expiresIn: LIMITS.pairMs / 1000 };
}
// the owner typed the code into Monochrome
export function claimPairing(userId, rawCode, name) {
  sweep();
  const code = normCode(rawCode), p = pairings.get(code);
  if (!p || p.claim) throw httpError(404, "That code isn't valid, or it has expired. Start the receiver again to get a new one.");
  const d = addDevice(userId, "agent", cleanName(name, "Raspberry Pi"));
  p.claim = d; // the receiver collects its token with its poll token
  return view(d.device);
}
// the receiver asks whether its code was used; it is told once, then forgets the code
export function pollPairing(poll) {
  sweep();
  const code = byPoll.get(String(poll)), p = code && pairings.get(code);
  if (!p) throw httpError(404, "That pairing has expired. Start the receiver again.");
  if (!p.claim) return { status: "waiting" };
  pairings.delete(code); byPoll.delete(p.poll);
  return { status: "paired", id: p.claim.device.id, name: p.claim.device.name, token: p.claim.token, owner: db.users[p.claim.device.owner]?.displayName || "" };
}

function addDevice(userId, kind, name) {
  if (Object.values(devs()).filter((d) => d.owner === userId).length >= LIMITS.devices) throw httpError(409, `You can have up to ${LIMITS.devices} devices. Remove one first.`);
  const token = rid(32), device = { id: rid(8), owner: userId, name, kind, hash: sha(token), created: Date.now() };
  devs()[device.id] = device; save();
  return { device, token };
}

// a web page that wants to be a device: it keeps its id and token in the browser, and gets a new pair if the old one is gone
export function registerWeb(userId, name, id, token) {
  const d = id && ownedBy(userId, id);
  if (d && d.kind === "web" && d.hash === sha(token || "")) { d.name = cleanName(name, d.name); save(); return { id: d.id, name: d.name, token }; }
  const made = addDevice(userId, "web", cleanName(name, "Web player"));
  return { id: made.device.id, name: made.device.name, token: made.token };
}

// who is this receiver (by its token)?
export function byToken(token) {
  if (!token) return null;
  const h = sha(token);
  return Object.values(devs()).find((d) => d.hash === h) || null;
}
export function rename(userId, id, name) { const d = ownedBy(userId, id); if (!d) throw httpError(404, "No such device"); d.name = cleanName(name, d.name); save(); return view(d); }
export function remove(userId, id) {
  const d = ownedBy(userId, id);
  if (!d) throw httpError(404, "No such device");
  delete devs()[id]; save();
  const l = live.get(id);
  if (l?.waiter) { clearTimeout(l.waiter.timer); l.waiter.done({ revoked: true }); }
  live.delete(id);
}

// ---- commands to a receiver ----
const ACTIONS = new Set(["play", "pause", "resume", "seek", "volume", "stop"]);
export function command(userId, id, body, { urlFor } = {}) {
  const d = ownedBy(userId, id);
  if (!d) throw httpError(404, "No such device");
  const l = L(id);
  if (!online(l)) throw httpError(409, `${d.name} is offline`);
  const action = String(body.action || "");
  if (!ACTIONS.has(action)) throw httpError(400, "Unknown action");
  const cmd = { action };
  if (action === "play") {
    const track = String(body.id || "");
    if (!/^(\d{1,12}|sub_[a-f0-9]+_[A-Za-z0-9_-]+)$/.test(track)) throw httpError(400, "bad id");
    cmd.id = track; cmd.pos = num(body.pos, 7200); cmd.dur = num(body.dur, 7200); cmd.title = cleanText(body.title, 120);
    cmd.url = urlFor(track, String(body.q || "").toUpperCase().replace(/[^A-Z_]/g, "").slice(0, 24) || "HI_RES");
    if (body.vol != null) cmd.vol = num(body.vol, 100, 60);
  } else if (action === "seek") cmd.pos = num(body.pos, 7200);
  else if (action === "volume") cmd.vol = num(body.vol, 100, 60);
  cmd.seq = ++l.seq;
  l.queue.push(cmd); if (l.queue.length > LIMITS.queue) l.queue.shift();
  wake(l);
  return { ok: true, seq: cmd.seq };
}
function wake(l) {
  if (!l.waiter) return;
  const w = l.waiter, cmds = l.queue.filter((c) => c.seq > w.since);
  if (cmds.length) { clearTimeout(w.timer); w.done({ seq: l.seq, commands: cmds }); }
}
// the receiver's long request: answered with what it has not seen yet, or with nothing after a while (it asks again at once)
export function poll(id, since, abort) {
  const l = L(id);
  l.seen = Date.now();
  if (since == null) return Promise.resolve({ seq: l.seq, commands: [] }); // a receiver that has just started: where are we? Nothing old is replayed to it
  if (since > l.seq) since = 0; // the server was restarted since the receiver last asked
  const cmds = l.queue.filter((c) => c.seq > since);
  if (cmds.length) return Promise.resolve({ seq: l.seq, commands: cmds });
  return new Promise((resolve) => {
    if (l.waiter) { clearTimeout(l.waiter.timer); l.waiter.done({ seq: l.seq, commands: [] }); } // a newer request replaces an older one
    const w = (l.waiter = { since, timer: 0, done: (v) => { if (l.waiter === w) l.waiter = null; l.seen = Date.now(); resolve(v); } });
    w.timer = setTimeout(() => w.done({ seq: l.seq, commands: [] }), LIMITS.pollMs);
    abort?.addEventListener?.("abort", () => { clearTimeout(w.timer); if (l.waiter === w) l.waiter = null; });
  });
}
// what the receiver says it is doing
export function report(id, s) {
  const l = L(id);
  l.seen = Date.now();
  l.state = {
    id: typeof s.id === "string" ? s.id.slice(0, 80) : null, playing: !!s.playing, pos: num(s.pos, 1e5), dur: num(s.dur, 1e5), ended: Math.floor(num(s.ended, 1e9)),
    volume: s.volume == null ? null : num(s.volume, 100), error: s.error ? String(s.error).slice(0, 200) : null, at: Date.now(),
  };
}

// ---- the song, as a link only this device can use for a few hours: the receiver's player (mpv, a web page) sends no cookie and no header ----
const fileKey = () => { db.settings ||= {}; if (!db.settings.fileKey) { db.settings.fileKey = crypto.randomBytes(32).toString("hex"); save(); } return db.settings.fileKey; };
const audioSig = (deviceId, track, q, exp) => crypto.createHmac("sha256", fileKey()).update(["connect-audio", deviceId, track, q, exp].join("|")).digest("base64url").slice(0, 32);
export const AUDIO_TTL = 6 * 3600 * 1000;
export const audioQuery = (deviceId, track, q) => { const exp = Date.now() + AUDIO_TTL; return `d=${deviceId}&q=${q}&e=${exp}&s=${audioSig(deviceId, track, q, exp)}`; };
// the device the link was made for, or an error: the link names the device, the song and the quality, and only that
export function checkAudio(track, params) {
  const d = devs()[String(params.get("d") || "")], q = String(params.get("q") || ""), exp = Number(params.get("e")), sig = String(params.get("s") || "");
  if (!d || !(exp > Date.now())) throw httpError(403, "This link has expired. Play the song again.");
  const want = audioSig(d.id, track, q, exp);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) throw httpError(403, "Not allowed");
  return { device: d, quality: q };
}
