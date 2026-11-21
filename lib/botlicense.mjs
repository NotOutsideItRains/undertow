// Licenses for the Discord bot. The owner makes one for an Undertow user; the user redeems it in their Discord server with /license, and the bot
// only works in servers that hold one. A license covers one server at a time; the owner can free it (to move it), turn it off, or delete it.
import crypto from "node:crypto";
import { db, save, rid, httpError } from "./store.mjs";

const all = () => (db.botLicenses ||= {});
export const MAX_LICENSES = 200;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I, so a code read out loud or from a screenshot isn't misread
const group = () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
const norm = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^UT/, "");
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const tidy = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, n);
const GUILD = /^\d{5,25}$/;

export function create(userId, label, by) {
  if (!db.users[userId]) throw httpError(404, "No such user");
  if (Object.keys(all()).length >= MAX_LICENSES) throw httpError(400, `That's the most licenses allowed (${MAX_LICENSES})`);
  const l = { id: rid(6), code: `UT-${group()}-${group()}-${group()}`, userId, label: tidy(label, 40), createdAt: Date.now(), createdBy: by, guildId: null, guildName: null, redeemedAt: null, revoked: false };
  all()[l.id] = l;
  save();
  return l;
}

export function view(l) {
  const u = db.users[l.userId];
  return { id: l.id, code: l.code, label: l.label, userId: l.userId, user: u ? { displayName: u.displayName, username: u.username } : null, createdAt: l.createdAt, guild: l.guildId ? { id: l.guildId, name: l.guildName } : null, redeemedAt: l.redeemedAt, revoked: l.revoked === true };
}
export const listAll = () => Object.values(all()).sort((a, b) => b.createdAt - a.createdAt).map(view);
export const listFor = (userId) => listAll().filter((l) => l.userId === userId);

export function change(id, action) {
  const l = all()[id]; if (!l) throw httpError(404, "No such license");
  if (action === "release") { l.guildId = null; l.guildName = null; l.redeemedAt = null; }
  else if (action === "revoke") l.revoked = true;
  else if (action === "restore") l.revoked = false;
  else throw httpError(400, "Unknown change");
  save();
  return view(l);
}
export function remove(id) { if (!all()[id]) throw httpError(404, "No such license"); delete all()[id]; save(); }
// a person's licenses go with them
export function dropUser(userId) { let n = 0; for (const l of Object.values(all())) if (l.userId === userId) { delete all()[l.id]; n++; } if (n) save(); }

// What the bot asks before it does anything in a server
export function status(guildId) {
  if (!GUILD.test(String(guildId))) throw httpError(400, "That isn't a server id");
  const l = Object.values(all()).find((x) => x.guildId === String(guildId) && !x.revoked && db.users[x.userId] && !db.users[x.userId].disabled);
  return l ? { licensed: true, label: l.label || null, holder: db.users[l.userId].displayName, since: l.redeemedAt || null } : { licensed: false };
}

const tries = new Map(); // bad codes per server: slows down guessing
export function redeem(code, guildId, guildName) {
  guildId = String(guildId || "");
  if (!GUILD.test(guildId)) throw httpError(400, "That isn't a server id");
  const t = tries.get(guildId) || { n: 0, at: Date.now() };
  if (Date.now() - t.at > 600000) { t.n = 0; t.at = Date.now(); }
  if (t.n >= 8) throw httpError(429, "Too many wrong codes. Wait a few minutes.");
  const want = norm(code);
  const l = want.length === 12 ? Object.values(all()).find((x) => eq(norm(x.code), want)) : null;
  if (!l) { t.n++; tries.set(guildId, t); throw httpError(404, "That license code isn't right"); }
  if (l.revoked) throw httpError(403, "That license has been turned off");
  if (!db.users[l.userId] || db.users[l.userId].disabled) throw httpError(403, "That license's owner can't use it right now");
  if (l.guildId && l.guildId !== guildId) throw httpError(409, "That license is already used by another server. Ask the owner to free it first.");
  const other = Object.values(all()).find((x) => x.guildId === guildId && x.id !== l.id && !x.revoked);
  if (other) throw httpError(409, "This server already has a license");
  l.guildId = guildId; l.guildName = tidy(guildName, 100); l.redeemedAt = l.redeemedAt || Date.now();
  save();
  return { ok: true, label: l.label || null, holder: db.users[l.userId].displayName };
}
