// Encrypted chats between friends. The server is only a mailbox: messages are encrypted in the browser, and what's kept here is the ciphertext,
// who sent it and when, each person's PUBLIC key, and (optionally) a copy of their private key that only their passphrase can open.
import fs from "node:fs";
import { httpError } from "./store.mjs";

const FILE = process.env.CHAT_FILE || new URL("../chats.json", import.meta.url).pathname;
let db = { keys: {}, msgs: {}, reads: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { /* none yet */ }
function writeNow() {
  try { fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(db), { mode: 0o600 }); fs.renameSync(`${FILE}.tmp`, FILE); } catch { /* best effort */ }
}
let timer = null;
const save = () => { clearTimeout(timer); timer = setTimeout(writeNow, 800); timer.unref?.(); };
process.on("exit", () => { if (timer) writeNow(); });

export const MAX_PER_CHAT = 2000, MAX_CT = 12000;
const B64 = /^[A-Za-z0-9_-]+$/;
const conv = (a, b) => [a, b].sort().join(":");
const newId = () => `${Date.now().toString(36).padStart(9, "0")}${Math.random().toString(36).slice(2, 5)}`; // sorts by time

// ---- keys ----
export function setKey(uid, b) {
  const p = b?.pub;
  if (!p || p.kty !== "EC" || p.crv !== "P-256" || typeof p.x !== "string" || typeof p.y !== "string" || !B64.test(p.x) || !B64.test(p.y) || p.x.length > 64 || p.y.length > 64) throw httpError(400, "That isn't a usable key");
  const k = { pub: { kty: "EC", crv: "P-256", x: p.x, y: p.y }, v: (db.keys[uid]?.v || 0) + (db.keys[uid] && (db.keys[uid].pub.x !== p.x || db.keys[uid].pub.y !== p.y) ? 1 : 0) || 1, at: Date.now() };
  const bk = b.backup;
  if (bk) {
    const ok = ["salt", "iv", "ct"].every((f) => typeof bk[f] === "string" && B64.test(bk[f]) && bk[f].length < 2000) && Number.isInteger(bk.iter) && bk.iter >= 100000 && bk.iter <= 2000000;
    if (!ok) throw httpError(400, "That backup isn't usable");
    k.backup = { salt: bk.salt, iv: bk.iv, ct: bk.ct, iter: bk.iter };
  } else if (db.keys[uid]?.backup && db.keys[uid].pub.x === p.x && db.keys[uid].pub.y === p.y) k.backup = db.keys[uid].backup; // same key: keep its backup
  db.keys[uid] = k;
  save();
  return { v: k.v };
}
export const getKey = (uid) => db.keys[uid] || null;
export const publicKey = (uid) => (db.keys[uid] ? { pub: db.keys[uid].pub, v: db.keys[uid].v } : null);

// ---- messages ----
export function post(from, to, b) {
  if (!db.keys[to]) throw httpError(409, "They haven't set up chats yet");
  if (!db.keys[from]) throw httpError(409, "Set up chats first");
  const iv = String(b?.iv || ""), ct = String(b?.ct || "");
  if (iv.length !== 16 || !B64.test(iv) || !ct || ct.length > MAX_CT || !B64.test(ct)) throw httpError(400, "That message can't be sent");
  const c = conv(from, to), list = (db.msgs[c] ||= []);
  const m = { id: newId(), from, t: Date.now(), iv, ct };
  list.push(m);
  if (list.length > MAX_PER_CHAT) list.splice(0, list.length - MAX_PER_CHAT);
  save();
  return m;
}
export function list(a, b, after = "") {
  return (db.msgs[conv(a, b)] || []).filter((m) => m.id > after).slice(-100);
}
export function markRead(uid, other, id) {
  const r = (db.reads[conv(uid, other)] ||= {});
  if (typeof id === "string" && id > (r[uid] || "")) { r[uid] = id; save(); }
}
export function remove(uid, other, id) {
  const l = db.msgs[conv(uid, other)] || [], i = l.findIndex((m) => m.id === id && m.from === uid);
  if (i < 0) throw httpError(404, "No such message");
  l.splice(i, 1);
  save();
}
// for each friend: the last message and how many from them are unread
export function threads(uid, friendIds) {
  return friendIds.map((f) => {
    const l = db.msgs[conv(uid, f)] || [], seen = db.reads[conv(uid, f)]?.[uid] || "";
    return { friend: f, last: l[l.length - 1] || null, unread: l.filter((m) => m.from === f && m.id > seen).length, hasKey: !!db.keys[f], theirRead: db.reads[conv(uid, f)]?.[f] || "" };
  });
}
export function forgetUser(uid) {
  delete db.keys[uid];
  for (const c of Object.keys(db.msgs)) if (c.split(":").includes(uid)) { delete db.msgs[c]; delete db.reads[c]; }
  save();
}
export function dropChat(a, b) { const c = conv(a, b); delete db.msgs[c]; delete db.reads[c]; save(); } // an unfriended chat is deleted, not kept
const hits = new Map();
export function limit(uid, kind, max, ms) { // per person, per kind of action
  const key = `${uid}|${kind}`, now = Date.now(), l = (hits.get(key) || []).filter((t) => now - t < ms);
  if (l.length >= max) { hits.set(key, l); throw Object.assign(httpError(429, "Slow down a little."), { retryAfter: String(Math.max(1, Math.ceil((l[0] + ms - now) / 1000))) }); }
  l.push(now); hits.set(key, l);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
}
