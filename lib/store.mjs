// Persistent state for the web UI: users, sessions, invites, links, accounts, plus the activity log.
// Everything lives in data.json (chmod 600); the activity log is flushed separately because it churns.
import fs from "node:fs";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";

const ROOT = new URL("..", import.meta.url).pathname;
const FILE = process.env.DATA_FILE || ROOT + "data.json";
const ACT_FILE = process.env.ACTIVITY_FILE || ROOT + "activity.json";

export const APP_NAME = process.env.APP_NAME || "Undertow";
export const bus = new EventEmitter();
bus.setMaxListeners(500);
export const rid = (bytes = 16) => crypto.randomBytes(bytes).toString("hex");
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; }
};
export const db = Object.assign({ users: {}, links: {}, accounts: {}, subsonic: {}, videos: {}, invites: {}, sessions: {}, friends: {}, settings: {} }, readJson(FILE, {}));

function writeAtomic(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
let timer = null;
export function save() {
  if (timer) return;
  timer = setTimeout(flush, 400);
}
export function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  writeAtomic(FILE, JSON.stringify(db));
  if (actDirty) { actDirty = false; writeAtomic(ACT_FILE, JSON.stringify(activity)); }
}
setInterval(() => { if (actDirty) flush(); }, 30000).unref();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { flush(); process.exit(0); });
process.on("exit", () => { try { flush(); } catch { /* shutting down */ } });

// ---- passwords -------------------------------------------------------------------------------
const scrypt = promisify(crypto.scrypt);
export async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64);
  return `s1$${salt.toString("hex")}$${h.toString("hex")}`;
}
const DUMMY = hashPw("not a real password");
export async function checkPw(pw, stored) {
  const [v, s, h] = String(stored || await DUMMY).split("$");
  if (v !== "s1") return false;
  const x = await scrypt(pw, Buffer.from(s, "hex"), 64);
  return crypto.timingSafeEqual(x, Buffer.from(h, "hex")) && stored !== undefined;
}

// ---- users & sessions ------------------------------------------------------------------------
export const USERNAME_RE = /^[a-z0-9_.-]{3,24}$/;
export const findUser = (username) => Object.values(db.users).find((u) => u.username === String(username).toLowerCase());
// The owner is whoever set the server up: the earliest admin account.
export const ownerId = () => Object.values(db.users).filter((x) => x.role === "admin").sort((a, b) => a.createdAt - b.createdAt)[0]?.id;
export const publicUser = (u) => u && { owner: u.id === ownerId(), id: u.id, username: u.username, displayName: u.displayName, role: u.role, player: u.role === "admin" || db.settings.membersUsePlayer !== false, speaker: u.role === "admin" || u.speaker === true, selfLinks: u.selfLinks === true, avatar: u.avatar || null, shareListening: u.shareListening !== false, disabled: !!u.disabled, discord: u.discord ? { username: u.discord.username, name: u.discord.name } : null, lastfm: u.lastfm ? { name: u.lastfm.name } : null, createdAt: u.createdAt, lastLogin: u.lastLogin || null };

export async function createUser({ username, displayName, password, role = "user" }) {
  username = String(username || "").trim().toLowerCase();
  displayName = String(displayName || "").trim().slice(0, 40) || username;
  if (!USERNAME_RE.test(username)) throw httpError(400, "Username must be 3–24 characters: letters, numbers, . _ -");
  if (String(password || "").length < 8) throw httpError(400, "Password must be at least 8 characters");
  if (findUser(username)) throw httpError(409, "That username is taken");
  const u = { id: rid(6), username, displayName, passHash: await hashPw(password), role: role === "admin" ? "admin" : "user", createdAt: Date.now() };
  db.users[u.id] = u;
  save();
  return u;
}

const DAY = 86400000;
export function createSession(userId, ua = "", ip = "") {
  const token = rid(32);
  db.sessions[sha(token)] = { userId, exp: Date.now() + 30 * DAY, created: Date.now(), ua: String(ua).slice(0, 120), ip };
  for (const [k, s] of Object.entries(db.sessions)) if (s.exp < Date.now()) delete db.sessions[k];
  save();
  return token;
}
export function sessionUser(token) {
  if (!token) return null;
  const k = sha(token), s = db.sessions[k];
  if (!s) return null;
  if (s.exp < Date.now()) { delete db.sessions[k]; return null; }
  const u = db.users[s.userId];
  if (!u || u.disabled) return null;
  if (s.exp - Date.now() < 25 * DAY) { s.exp = Date.now() + 30 * DAY; save(); }
  return u;
}
export function destroySession(token) { if (token) { delete db.sessions[sha(token)]; save(); } }
export function destroyUserSessions(userId, except) {
  for (const [k, s] of Object.entries(db.sessions)) if (s.userId === userId && k !== except) delete db.sessions[k];
  save();
}
export const sessionKey = sha;

export function httpError(status, message) { return Object.assign(new Error(message), { status }); }

// ---- links -----------------------------------------------------------------------------------
export const QUALITIES = ["HI_RES", "CD", "HIGH", "LOW"]; // best first
export const DEFAULT_LIMITS = { atmos: true, downloads: false, losslessCheck: false, maxQuality: "HI_RES", delayMs: 0, perHour: 0, perDay: 0, maxConcurrent: 0, expiresAt: null };

const num = (v, min, max, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d; };
export function sanitizeLimits(inp = {}, base = DEFAULT_LIMITS) {
  return {
    atmos: inp.atmos === undefined ? base.atmos : !!inp.atmos,
    downloads: inp.downloads === undefined ? !!base.downloads : !!inp.downloads,
    losslessCheck: inp.losslessCheck === undefined ? !!base.losslessCheck : !!inp.losslessCheck,
    maxQuality: QUALITIES.includes(inp.maxQuality) ? inp.maxQuality : base.maxQuality,
    delayMs: num(inp.delayMs, 0, 30000, base.delayMs),
    perHour: num(inp.perHour, 0, 100000, base.perHour),
    perDay: num(inp.perDay, 0, 1000000, base.perDay),
    maxConcurrent: num(inp.maxConcurrent, 0, 20, base.maxConcurrent),
    expiresAt: inp.expiresAt === undefined ? base.expiresAt : inp.expiresAt ? num(inp.expiresAt, 0, 4e12, null) : null,
  };
}

// Invites can be used more than once (uses), and carry an optional message from whoever made them.
export const inviteLeft = (i) => Math.max(0, (i.uses || 1) - (i.usedList?.length ?? (i.usedBy ? 1 : 0)));
export const inviteState = (i) => (!i ? "unknown" : i.exp <= Date.now() ? "expired" : inviteLeft(i) <= 0 ? "used" : "valid");
export const cleanInviteMessage = (m) => String(m ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

export const linkIndex = new Map(); // token -> link
export function reindexLinks() {
  linkIndex.clear();
  for (const l of Object.values(db.links)) linkIndex.set(l.token, l);
}
reindexLinks();

export function createLink({ userId, name, limits, accountId = null, token = rid(16), guest = false, createdBy = null }) {
  const l = {
    id: rid(5), token, userId: guest ? null : userId, guest: !!guest, createdBy, name: String(name || "Untitled link").trim().slice(0, 40) || "Untitled link",
    enabled: true, accountId: accountId || null, limits: sanitizeLimits(limits), createdAt: Date.now(), lastSeen: null,
    totals: { search: 0, stream: 0, notFound: 0, errors: 0 }, devices: {},
  };
  db.links[l.id] = l;
  linkIndex.set(l.token, l);
  save();
  return l;
}
export function deleteLink(id) {
  const l = db.links[id];
  if (!l) return;
  linkIndex.delete(l.token);
  delete db.links[id];
  save();
}

// Sliding-window stream counters (memory only; they reset on restart, which only ever loosens a limit).
const streamTimes = new Map(); // linkId -> number[]
export const inflight = new Map(); // linkId -> number
export function noteStream(linkId) {
  const a = streamTimes.get(linkId) || [];
  a.push(Date.now());
  streamTimes.set(linkId, a);
}
export function usage(linkId) {
  const a = streamTimes.get(linkId) || [];
  const now = Date.now();
  while (a.length && a[0] < now - DAY) a.shift();
  let hour = 0;
  for (let i = a.length - 1; i >= 0 && a[i] > now - 3600000; i--) hour++;
  return { hour, day: a.length, inflight: inflight.get(linkId) || 0, resetHourIn: hour ? Math.max(1, Math.ceil((a[a.length - hour] + 3600000 - now) / 1000)) : 0 };
}

// ---- activity log ----------------------------------------------------------------------------
export const activity = readJson(ACT_FILE, []);
let actDirty = false;
let seq = activity.length ? activity[activity.length - 1].id + 1 : 1;
export function logEvent(ev) {
  ev.id = seq++;
  activity.push(ev);
  if (activity.length > 2000) activity.splice(0, activity.length - 2000);
  actDirty = true;
  bus.emit("event", ev);
  return ev;
}
