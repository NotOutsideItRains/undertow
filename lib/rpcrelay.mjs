// Discord presence relay: a player (phone or PC) tells Undertow what it is playing; the Undertow Presence app on the PC polls it with a per-account key.
// Presence lives in memory only (it is stale after a minute anyway). The key is kept as a SHA-256 hash and shown once, when it is made.
import crypto from "node:crypto";
import { db, save, httpError } from "./store.mjs";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const keys = () => (db.rpcKeys ||= {}); // user id -> { hash, prefix, at, lastUsed }
const now = new Map(); // user id -> { p: presence, at }
const STALE = 45000; // players report at least every 15 s while playing
const hits = new Map();
function rate(id, max, ms = 60000) {
  const t = Date.now(), r = hits.get(id);
  if (!r || t - r[0] > ms) { hits.set(id, [t, 1]); if (hits.size > 5000) hits.delete(hits.keys().next().value); return; }
  if (++r[1] > max) throw httpError(429, "Slow down a little");
}
const text = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const num = (v, max) => { v = Number(v); return Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : 0; };

/** What a player may say, cleaned up. Same shape the presence app's Presence struct reads. */
function clean(b) {
  const cover = String(b.coverUrl || "");
  return {
    title: text(b.title, 128), artist: text(b.artist, 128), album: text(b.album, 128),
    durationMs: num(b.durationMs, 24 * 3600 * 1000), positionMs: num(b.positionMs, 24 * 3600 * 1000), playing: b.playing === true,
    coverUrl: /^https:\/\/[^\s]{1,500}$/.test(cover) ? cover : "", tidalId: /^\d{1,12}$/.test(String(b.tidalId || "")) ? String(b.tidalId) : "", source: text(b.source, 20) || "Undertow",
  };
}

/** A signed-in player reports (or pauses / stops) what it is playing. */
export function push(me, body) {
  if (!me) throw httpError(401, "Sign in first");
  rate("push|" + me.id, 90);
  const p = clean(body || {});
  if (!p.title || !p.playing) now.delete(me.id); else now.set(me.id, { p, at: Date.now() });
  return { ok: true };
}

/** The account's current track, advanced to this moment; playing:false when paused, idle or silent for too long. */
export function current(userId) {
  const e = now.get(userId), t = Date.now();
  if (!e || t - e.at > STALE) return { playing: false };
  return { ...e.p, positionMs: Math.min(e.p.durationMs || Infinity, e.p.positionMs + (t - e.at)), playing: true };
}

export function keyStatus(me) { const k = keys()[me.id]; return k ? { has: true, prefix: k.prefix, at: k.at, lastUsed: k.lastUsed || null } : { has: false }; }
export function makeKey(me) { // replaces any earlier key
  const secret = "urp_" + crypto.randomBytes(24).toString("base64url");
  keys()[me.id] = { hash: sha(secret), prefix: secret.slice(0, 8), at: Date.now(), lastUsed: null };
  save();
  return { key: secret, ...keyStatus(me) };
}
export function revokeKey(me) { delete keys()[me.id]; now.delete(me.id); save(); }
function userOfKey(req) {
  const h = String(req.headers.authorization || "").match(/^Bearer\s+(urp_[A-Za-z0-9_-]{20,60})$/);
  if (!h) return null;
  const hash = sha(h[1]);
  for (const [uid, k] of Object.entries(keys())) {
    if (k.hash.length === hash.length && crypto.timingSafeEqual(Buffer.from(k.hash), Buffer.from(hash)) && db.users[uid]) return { uid, k };
  }
  return null;
}

/** Routes under /api/rpc/{now,key}. Returns true when it answered. */
export async function route(req, res, path, me, { json, readBody }) {
  const method = req.method;
  if (path === "/rpc/now") {
    if (method === "GET") {
      let uid = me?.id, k = null;
      if (!uid) {
        const f = userOfKey(req);
        if (!f) throw httpError(401, "Sign in, or send the presence key as a Bearer token");
        uid = f.uid; k = f.k;
      }
      rate("get|" + uid, 30);
      if (k && Date.now() - (k.lastUsed || 0) > 60000) { k.lastUsed = Date.now(); save(); }
      json(res, current(uid));
      return true;
    }
    if (method === "POST") { json(res, push(me, await readBody(req))); return true; }
  }
  if (path === "/rpc/key") {
    if (!me) throw httpError(401, "Sign in first");
    if (method === "GET") { json(res, keyStatus(me)); return true; }
    if (method === "POST") { rate("mk|" + me.id, 10); json(res, makeKey(me)); return true; }
    if (method === "DELETE") { revokeKey(me); json(res, { ok: true }); return true; }
  }
  return false;
}
