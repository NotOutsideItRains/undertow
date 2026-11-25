// JSON API behind the web UI: sessions, users, links, accounts, activity.
import { memberLinksAlert } from "./notify.mjs";
import { sendBody } from "./compress.mjs";
import { discordOn, authorizeUrl, discordUser } from "./discord.mjs";
import * as lastfm from "./lastfm.mjs";
import * as publicApi from "./publicapi.mjs";
import * as botLicense from "./botlicense.mjs";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  APP_NAME, db, save, rid, bus, activity, httpError, hashPw, checkPw, findUser, publicUser, ownerId, inviteLeft, inviteState, cleanInviteMessage, createUser, createSession, sessionUser,
  destroySession, destroyUserSessions, sessionKey, createLink, deleteLink, sanitizeLimits, reindexLinks, usage, DEFAULT_LIMITS,
} from "./store.mjs";
import * as accounts from "./accounts.mjs";
import * as subsonic from "./subsonic.mjs";
import * as video from "./video.mjs";
import * as chat from "./chat.mjs";
import { rpcInfo, rpcFile } from "./rpcdl.mjs";
import * as relay from "./rpcrelay.mjs";
import * as oauth from "./oauth.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
export const AVATAR_DIR = process.env.AVATARS_DIR || ROOT + "avatars";
fs.mkdirSync(AVATAR_DIR, { recursive: true, mode: 0o700 });
const SETUP_FILE = process.env.SETUP_FILE || ROOT + ".setup-code";

// The first admin is created with a one-time code from .setup-code, so nobody who finds the public
// hostname first can claim the instance.
let setupCode = null;
if (!Object.keys(db.users).length) {
  setupCode = rid(4);
  fs.writeFileSync(SETUP_FILE, setupCode + "\n", { mode: 0o600 });
  console.log(`No users yet. Open the site and use the setup code in ${SETUP_FILE}`);
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const json = (res, body, status = 200, headers = {}) => sendBody(res, status, JSON.stringify(body), { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
async function readBody(req) {
  let n = 0;
  const chunks = [];
  for await (const c of req) { if ((n += c.length) > 65536) throw httpError(413, "Body too large"); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks)); } catch { throw httpError(400, "Invalid JSON"); }
}
function reencodeJpeg(buf) { // decode with ffmpeg and write a fresh JPEG; null if it isn't a picture. Without ffmpeg the header check stands.
  return new Promise((ok) => {
    const c = spawn("ffmpeg", ["-v", "error", "-nostdin", "-i", "pipe:0", "-frames:v", "1", "-vf", "scale='min(768,iw)':-2", "-q:v", "3", "-f", "mjpeg", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
    const out = [];
    const t = setTimeout(() => { c.kill("SIGKILL"); ok(null); }, 15000);
    c.stdout.on("data", (d) => out.push(d));
    c.stdin.on("error", () => {});
    c.on("error", () => { clearTimeout(t); ok(buf); });
    c.on("close", (code) => { clearTimeout(t); const b = Buffer.concat(out); ok(code === 0 && b.length > 100 && b[0] === 0xff && b[1] === 0xd8 ? b : null); });
    c.stdin.end(buf);
  });
}
// An animated picture: the GIF is decoded and cropped by ffmpeg (never trusted as sent) and re-encoded as a small looping WebP,
// plus a still JPEG of the first frame for link previews. Short, small and square, so one can't be used to eat space or CPU.
function ffmpegOut(args, buf, ms = 20000) {
  return new Promise((ok) => {
    const c = spawn("ffmpeg", ["-v", "error", "-nostdin", "-i", "pipe:0", ...args, "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
    const out = []; let size = 0;
    const t = setTimeout(() => { c.kill("SIGKILL"); ok(null); }, ms);
    c.stdout.on("data", (d) => { size += d.length; if (size > 4e6) { c.kill("SIGKILL"); return; } out.push(d); });
    c.stdin.on("error", () => {});
    c.on("error", () => { clearTimeout(t); ok(null); });
    c.on("close", (code) => { clearTimeout(t); ok(code === 0 && size <= 4e6 ? Buffer.concat(out) : null); });
    c.stdin.end(buf);
  });
}
async function animatedAvatar(buf, crop) {
  const box = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`;
  const anim = async (px, fps, q) => ffmpegOut(["-t", "8", "-frames:v", "120", "-vf", `${box},scale=${px}:${px}:flags=lanczos,fps=${fps}`, "-c:v", "libwebp_anim", "-loop", "0", "-q:v", String(q), "-f", "webp"], buf);
  let webp = await anim(256, 15, 65);
  if (webp && webp.length > 1.2e6) webp = await anim(192, 10, 45); // a long or busy GIF is made lighter, not refused
  if (!webp || webp.length > 1.2e6 || webp.toString("latin1", 0, 4) !== "RIFF" || webp.toString("latin1", 8, 12) !== "WEBP") return null;
  const still = await ffmpegOut(["-frames:v", "1", "-vf", `${box},scale=320:320:flags=lanczos`, "-q:v", "3", "-f", "mjpeg"], buf);
  if (!still || still[0] !== 0xff || still[1] !== 0xd8) return null;
  return { webp, still };
}
const cropOf = (q, w, h) => { // the square the person framed, in the picture's own pixels
  const n = (k) => Math.round(Number(q.get(k)));
  const c = { x: n("x"), y: n("y"), w: n("w"), h: n("h") };
  if (![c.x, c.y, c.w, c.h].every(Number.isFinite) || c.w < 16 || c.h < 16 || c.x < 0 || c.y < 0 || c.x + c.w > w || c.y + c.h > h) return null;
  return c;
};
async function readRaw(req, max) {
  let n = 0;
  const chunks = [];
  for await (const c of req) { if ((n += c.length) > max) throw httpError(413, "That image is too large"); chunks.push(c); }
  return Buffer.concat(chunks);
}
const friendship = (a, b) => Object.values(db.friends).find((f) => (f.from === a && f.to === b) || (f.from === b && f.to === a));
const areFriends = (a, b) => friendship(a, b)?.status === "accepted";
const brief = (u) => u && { id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar || null };
function listeningOf(u) {
  if (u.shareListening === false) return null;
  for (let i = activity.length - 1; i >= 0 && activity[i].t > Date.now() - 20 * 60000; i--) {
    const e = activity[i];
    if (e.userId === u.id && e.kind === "stream" && e.status < 400 && e.detail && !e.detail.startsWith("track ")) return { track: e.detail, at: e.t };
  }
  return null;
}
function friendsView(me) {
  const out = { friends: [], incoming: [], outgoing: [] };
  for (const f of Object.values(db.friends)) {
    if (f.from !== me.id && f.to !== me.id) continue;
    const other = db.users[f.from === me.id ? f.to : f.from];
    if (!other) continue;
    if (f.status === "accepted") out.friends.push({ id: f.id, user: brief(other), since: f.at, listening: listeningOf(other) });
    else (f.to === me.id ? out.incoming : out.outgoing).push({ id: f.id, user: brief(other), at: f.at });
  }
  out.friends.sort((a, b) => (b.listening?.at || 0) - (a.listening?.at || 0) || a.user.displayName.localeCompare(b.user.displayName));
  return out;
}
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), c.slice(i + 1)]; }));
// The client's address. Cloudflare's header is only believed when the connection really comes from the tunnel (TRUSTED_PROXIES) or this machine:
// anyone else on the network could write that header themselves and dodge the login throttle.
const TRUSTED = new Set(["127.0.0.1", "::1", ...String(process.env.TRUSTED_PROXIES || "").split(",").map((x) => x.trim()).filter(Boolean)]);
const peerOf = (req) => String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
const ipOf = (req) => (TRUSTED.has(peerOf(req)) ? String(req.headers["cf-connecting-ip"] || peerOf(req)) : peerOf(req));
const secure = (req) => req.headers["x-forwarded-proto"] === "https" || req.headers["cf-visitor"]?.includes("https");
const setCookie = (req, token, maxAge) => `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure(req) ? "; Secure" : ""}`;

// Brute-force guard: 8 failures per IP per 10 minutes.
const fails = new Map();
function throttle(ip) {
  const f = fails.get(ip);
  if (f && f.until > Date.now() && f.n >= 8) throw httpError(429, "Too many attempts. Try again in a few minutes.");
}
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (v.until < now) fails.delete(k); }, 600000).unref(); // forget old failures
const failed = (ip) => { const f = fails.get(ip); fails.set(ip, f && f.until > Date.now() ? { n: f.n + 1, until: f.until } : { n: 1, until: Date.now() + 600000 }); };

const origin = (req) => `${secure(req) ? "https" : "http"}://${req.headers["x-forwarded-host"] || req.headers.host}`;
const isAdmin = (u) => u.role === "admin";
const need = (u, admin) => { if (!u) throw httpError(401, "Sign in first"); if (admin && !isAdmin(u)) throw httpError(403, "Admins only"); };

function linkView(l, req, viewer) {
  const owner = db.users[l.userId];
  const devices = Object.entries(l.devices).sort((a, b) => (b[1].stream + b[1].search) - (a[1].stream + a[1].search)).slice(0, 8).map(([name, d]) => ({ name, ...d }));
  return {
    id: l.id, name: l.name, addonName: l.addonName || null, enabled: l.enabled, accountId: l.accountId, limits: l.limits, createdAt: l.createdAt, lastSeen: l.lastSeen,
    totals: l.totals, devices, usage: usage(l.id), url: `${origin(req)}/${l.token}`,
    ...(l.shared ? { shared: true, joinOpen: l.joinOpen !== false, joinUrl: `${origin(req)}/join/${l.joinCode}` } : {}), ...(l.parent ? { parent: l.parent } : {}),
    owner: owner ? { id: owner.id, displayName: owner.displayName, username: owner.username } : null, guest: !!l.guest,
    expired: !!(l.limits.expiresAt && l.limits.expiresAt < Date.now()),
  };
}
// The name BitChord shows for the addon; blank falls back to the app name.
const cleanAddonName = (n) => String(n ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40) || null;
const dcStates = new Map(); // OAuth state -> { mode, userId, exp }, so a Discord callback can only finish a flow this server started
const dcCookie = (req, v, maxAge) => `dc_state=${v}; HttpOnly; SameSite=Lax; Path=/api/discord; Max-Age=${maxAge}${secure(req) ? "; Secure" : ""}`;

// ---- Last.fm: the owner's keys live in settings (never sent back out); each person's account is a name and a session key ----
const lfCfg = () => (db.settings.lastfm?.key && db.settings.lastfm?.secret ? db.settings.lastfm : null);
const lfStates = new Map(); // token -> { userId, exp }: a callback can only finish a connection this server started
const lfCookie = (req, v, maxAge) => `lf_tok=${v}; HttpOnly; SameSite=Lax; Path=/api/lastfm; Max-Age=${maxAge}${secure(req) ? "; Secure" : ""}`;
const lfQueue = new Map(); // userId -> scrobbles that couldn't be sent yet, tried again with the next one
export const lastfmOn = () => !!lfCfg();
// ---- the second player's side of Last.fm: it connects without Undertow's pages (it asks for a token, the person approves it on Last.fm, the player asks again) ----
const lfPlayer = new Map(); // token -> { userId, exp }
export const lastfmStatus = (me) => ({ configured: !!lfCfg(), connected: !!me.lastfm, name: me.lastfm?.name || null });
export async function lastfmPlayerStart(me, doneUrl) {
  const cfg = lfCfg(); if (!cfg) throw httpError(503, "Last.fm isn't set up on this server. The owner can add its keys in Undertow.");
  let a; try { a = await lastfm.startAuth(cfg, doneUrl); } catch { throw httpError(502, "Couldn't reach Last.fm"); }
  for (const [k, v] of lfPlayer) if (v.exp < Date.now() || v.userId === me.id) lfPlayer.delete(k); // one connection at a time per person
  lfPlayer.set(a.token, { userId: me.id, exp: Date.now() + 30 * 60000 });
  return a; // { token, url }
}
export async function lastfmPlayerComplete(me, token) {
  const cfg = lfCfg(), st = lfPlayer.get(String(token));
  if (!cfg || !st || st.userId !== me.id || st.exp < Date.now()) throw httpError(404, "That connection has expired. Start again.");
  try { me.lastfm = { ...(await lastfm.finishAuth(cfg, String(token))), at: Date.now() }; }
  catch (e) { if (Number(e.code) === 14 || Number(e.code) === 15) return { pending: true }; lfPlayer.delete(String(token)); throw httpError(502, "Last.fm didn't confirm the account"); } // 14: not approved yet
  lfPlayer.delete(String(token)); save();
  return { success: true, name: me.lastfm.name };
}
export function lastfmDisconnect(me) { delete me.lastfm; lfQueue.delete(me.id); save(); }

export async function lastfmSend(me, kind, t, ts) { // kind: "now" | "scrobble" | "love"; returns { ok, disconnected? }
  const cfg = lfCfg(), acct = me.lastfm;
  if (!cfg || !acct) return { ok: false, off: true };
  const q = lfQueue.get(me.id) || [];
  try {
    if (kind === "now") await lastfm.nowPlaying(cfg, acct.key, t);
    else if (kind === "love") await lastfm.love(cfg, acct.key, t);
    else {
      const age = Math.floor(Date.now() / 1000) - ts;
      if (!Number.isFinite(ts) || age < 0 || age > 14 * 86400) throw httpError(400, "Bad time");
      lastfm.trackParams(t); // a song that can never be accepted is refused now, not left at the front of the queue
      q.push({ t, ts });
      while (q.length > 40) q.shift();
      while (q.length) {
        try { await lastfm.scrobble(cfg, acct.key, q[0].t, q[0].ts); } catch (e) { if (e instanceof lastfm.LastfmError && Number(e.code) === 6) { q.shift(); continue; } throw e; } // 6: Last.fm won't take that one
        q.shift();
      }
    }
    lfQueue.set(me.id, q);
    return { ok: true };
  } catch (e) {
    lfQueue.set(me.id, q);
    if (lastfm.isAuthError(e)) { delete me.lastfm; lfQueue.delete(me.id); save(); return { ok: false, disconnected: true }; }
    if (e.status) throw e;
    return { ok: false, error: String(e.message || "Last.fm didn't answer").slice(0, 120) };
  }
}

// ---- the Discord bot's token: the owner's alone, kept on the server, handed only to keys the owner made for the bot ----
const DISCORD_API = process.env.DISCORD_API || "https://discord.com/api";
const botView = () => { const b = db.settings.discordBot; return b ? { configured: true, name: b.name, id: b.id, invite: `https://discord.com/oauth2/authorize?client_id=${b.id}&scope=bot+applications.commands&permissions=3172352` } : { configured: false }; };
const botKeyAllowed = (me, want) => { if (want && me.id !== ownerId()) throw httpError(403, "Only the owner can make a key that reads the bot token"); return want; };
const MEMBER_LINK_MAX = 3, MAX_PEOPLE = 100;
// A shared link is one entry for many friends. Each person gets a link of their own underneath it (so their plays and searches are
// counted and shown by name), with the shared link's limits; the admin sees one card, not one per friend.
const people = (id) => Object.values(db.links).filter((x) => x.parent === id);
function addPerson(parent, name, userId = null) {
  if (people(parent.id).length >= MAX_PEOPLE) throw httpError(400, "That's the most people on one shared link");
  const base = String(name || "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 32) || "Friend", used = new Set(people(parent.id).map((x) => x.name.toLowerCase()));
  let n = base, i = 2;
  while (used.has(n.toLowerCase())) n = `${base} (${i++})`.slice(0, 40);
  const c = createLink({ userId, guest: !userId, name: n, limits: parent.limits, accountId: parent.accountId, createdBy: parent.createdBy });
  c.parent = parent.id; c.enabled = parent.enabled;
  save();
  return c;
}
const joinHits = new Map(); // ip -> recent join times
function joinThrottle(ip) {
  const now = Date.now(), list = (joinHits.get(ip) || []).filter((t) => now - t < 3600000);
  if (list.length >= 8) throw httpError(429, "Too many tries. Try again later.");
  list.push(now); joinHits.set(ip, list);
  if (joinHits.size > 5000) joinHits.delete(joinHits.keys().next().value);
}
const sharedByCode = (code) => Object.values(db.links).find((x) => x.shared && x.joinCode === code);
const joinOpen = (p) => !!p && p.joinOpen !== false && p.enabled;
async function accountFromDiscord(du) { // joining with Discord makes an account the first time: no password, the person signs in with Discord
  let base = String(du.username || "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 18) || "friend";
  if (base.length < 3) base = `dc-${base}`;
  let name = base, i = 2;
  while (findUser(name)) name = `${base}${i++}`.slice(0, 24);
  const u = await createUser({ username: name, displayName: du.name || du.username || name, password: crypto.randomBytes(24).toString("base64url"), role: "user" });
  u.discord = du;
  save();
  return u;
}
const ownLinks = (u) => Object.values(db.links).filter((l) => l.userId === u.id);
const mayOwnLinks = (u) => !!db.settings.membersCreateLinks || u.selfLinks === true; // everyone when the switch is on, or just the people an admin picked
const canCreateLink = (u) => isAdmin(u) || (mayOwnLinks(u) && ownLinks(u).length < MEMBER_LINK_MAX);
const scopeLinks = (u) => Object.values(db.links).filter((l) => isAdmin(u) || l.userId === u.id);
const inScope = (u, e) => isAdmin(u) || e.userId === u.id;

function userStats(id) {
  const out = { links: 0, search: 0, stream: 0, notFound: 0, lastSeen: null };
  for (const l of Object.values(db.links)) {
    if (l.userId !== id) continue;
    out.links++;
    out.search += l.totals.search; out.stream += l.totals.stream; out.notFound += l.totals.notFound;
    if (l.lastSeen && l.lastSeen > (out.lastSeen || 0)) out.lastSeen = l.lastSeen;
  }
  return out;
}

function overview(u) {
  const now = Date.now(), day = now - 86400000;
  const ev = activity.filter((e) => e.t >= day && inScope(u, e));
  const series = Array.from({ length: 60 }, () => ({ stream: 0, search: 0 }));
  const devices = new Map();
  let ms = 0, msN = 0;
  const out = { streams: 0, searches: 0, notFound: 0, errors: 0 };
  for (const e of ev) {
    if (e.kind === "stream") { out.streams++; if (e.status < 400 && !e.cached) { ms += e.ms; msN++; } }
    else if (e.kind === "search") out.searches++;
    if (e.notFound) out.notFound++;
    if (e.status >= 400 && !e.notFound) out.errors++;
    const i = 59 - Math.floor((now - e.t) / 60000);
    if (i >= 0 && i < 60 && (e.kind === "stream" || e.kind === "search")) series[i][e.kind]++;
    if (e.kind !== "manifest") { const k = `${e.user}\u0000${e.device}`; devices.set(k, (devices.get(k) || 0) + 1); }
  }
  return {
    ...out, avgStreamMs: msN ? Math.round(ms / msN) : null, series,
    top: [...devices].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => { const [user, device] = k.split("\u0000"); return { user, device, n }; }),
    activeNow: new Set(ev.filter((e) => e.t > now - 5 * 60000).map((e) => `${e.userId}|${e.device}`)).size,
    links: scopeLinks(u).length, users: isAdmin(u) ? Object.keys(db.users).length : undefined,
    accounts: isAdmin(u) ? accounts.allViews() : undefined,
  };
}

let sseTotal = 0;
const sseBy = new Map();
export async function handleApi(req, res, path) {
  const method = req.method;
  const ip = ipOf(req);
  try {
    if (method !== "GET" && method !== "HEAD" && req.headers["x-requested-with"] !== "ui") throw httpError(403, "Bad request");
    const sid = cookies(req).sid;
    const me = sessionUser(sid);
    let m;
    if (path.startsWith("/rpc/") && await relay.route(req, res, path, me, { json, readBody })) return; // Discord presence relay (lib/rpcrelay.mjs)

    // ---- public ----
    if (method === "GET" && path === "/boot") return json(res, { name: APP_NAME, needsSetup: !Object.keys(db.users).length, user: publicUser(me), discord: discordOn(), lastfm: lastfmOn() });
    // ---- Discord: sign in, or connect it to the account you're signed in to ----
    if (method === "POST" && path === "/discord/start") {
      if (!discordOn()) throw httpError(503, "Discord sign-in isn't set up on this server");
      const b = await readBody(req), mode = b.mode === "link" ? "link" : b.mode === "join" ? "join" : "login";
      const next = mode === "login" && /^\/player-signin\?id=[a-f0-9]{32}$/.test(String(b.next || "")) ? String(b.next) : null; // the second player sending someone through here to sign in
      const jp = mode === "join" ? sharedByCode(String(b.code || "")) : null;
      if (mode === "join" && !jp) throw httpError(404, "That invite doesn't exist");
      if (mode === "link") need(me);
      const now = Date.now();
      for (const [k, v] of dcStates) if (v.exp < now) dcStates.delete(k);
      if (dcStates.size > 500) throw httpError(429, "Try again in a minute");
      const state = crypto.randomBytes(24).toString("hex");
      dcStates.set(state, { mode, userId: mode === "link" ? me.id : null, code: jp ? jp.joinCode : null, next, exp: now + 600000 });
      return json(res, { url: authorizeUrl(`${origin(req)}/api/discord/callback`, state) }, 200, { "Set-Cookie": dcCookie(req, state, 600) });
    }
    if (method === "GET" && path === "/discord/callback") {
      // The browser lands here from discord.com, so the SameSite=Strict session cookie isn't sent: the account comes from the state saved at the start.
      const q = new URL(req.url, "http://x").searchParams, state = q.get("state") || "", st = dcStates.get(state);
      dcStates.delete(state);
      const done = (flag, extra = {}) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Set-Cookie": [dcCookie(req, "", 0), ...(extra.cookie ? [extra.cookie] : [])] });
        const to = st?.code && /^[a-f0-9]+$/.test(st.code) ? `/join/${st.code}` : "/"; // an invite sends them back to its page
        const back = flag === "ok" && st?.next ? st.next : `${to}?discord=${flag}`; // signed in for the second player: straight back to its sign-in
        res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${back}"><title>${APP_NAME}</title><p><a href="${back}">Continue</a></p>`); // a page of ours does the final hop, so the session cookie is sent
      };
      if (!st || st.exp < Date.now() || !safeEq(cookies(req).dc_state || "", state)) return done("error");
      if (!q.get("code")) return done("denied");
      if (!discordOn()) return done("error");
      if (st.mode === "login" || st.mode === "join") throttle(ip);
      let du;
      try { du = await discordUser(q.get("code"), `${origin(req)}/api/discord/callback`); } catch { return done("error"); }
      if (st.mode === "link") {
        const u = db.users[st.userId];
        if (!u) return done("error");
        if (Object.values(db.users).some((x) => x.discord?.id === du.id && x.id !== u.id)) return done("taken");
        u.discord = du;
        save();
        return done("linked");
      }
      if (st.mode === "join") {
        let u = Object.values(db.users).find((x) => x.discord?.id === du.id);
        if (u?.disabled) { failed(ip); return done("nolink"); }
        if (!u) { // first time: an account is made for them
          if (!joinOpen(sharedByCode(st.code))) return done("closed");
          joinThrottle(ip);
          u = await accountFromDiscord(du);
        }
        u.lastLogin = Date.now(); save();
        return done("ok", { cookie: setCookie(req, createSession(u.id, req.headers["user-agent"], ip), 2592000) });
      }
      const u = Object.values(db.users).find((x) => x.discord?.id === du.id);
      if (!u || u.disabled) { failed(ip); return done("nolink"); }
      u.lastLogin = Date.now();
      save();
      return done("ok", { cookie: setCookie(req, createSession(u.id, req.headers["user-agent"], ip), 2592000) });
    }
    if (method === "POST" && path === "/discord/unlink") { need(me); delete me.discord; save(); return json(res, { user: publicUser(me) }); }
    // Last.fm. The keys are the owner's alone; everyone connects their own account.
    if (path === "/lastfm/config" && method === "GET") { need(me, true); const c = db.settings.lastfm; return json(res, { owner: me.id === ownerId(), configured: !!lfCfg(), key: c?.key ? `${c.key.slice(0, 4)}…${c.key.slice(-4)}` : null }); }
    if (path === "/lastfm/config" && method === "PUT") {
      if (me?.id !== ownerId()) throw httpError(403, "Only the owner can set the Last.fm keys");
      const b = await readBody(req), key = String(b.key || "").trim(), secret = String(b.secret || "").trim() || db.settings.lastfm?.secret || "";
      if (!/^[a-f0-9]{32}$/i.test(key) || !/^[a-f0-9]{32}$/i.test(secret)) throw httpError(400, "The API key and shared secret are 32 characters each (letters a–f and numbers)");
      try { await lastfm.checkKeys({ key, secret }); } catch (e) { throw httpError(400, [10, 13].includes(Number(e.code)) ? "Last.fm says that key or secret isn't right" : "Couldn't reach Last.fm to check the keys"); }
      if (db.settings.lastfm?.key !== key) for (const x of Object.values(db.users)) delete x.lastfm; // accounts connected through another key stop working
      db.settings.lastfm = { key, secret };
      save();
      return json(res, { configured: true, key: `${key.slice(0, 4)}…${key.slice(-4)}` });
    }
    if (path === "/lastfm/config" && method === "DELETE") {
      if (me?.id !== ownerId()) throw httpError(403, "Only the owner can remove the Last.fm keys");
      delete db.settings.lastfm; for (const x of Object.values(db.users)) delete x.lastfm; save();
      return json(res, { configured: false });
    }
    if (method === "POST" && path === "/lastfm/start") {
      need(me);
      const cfg = lfCfg(); if (!cfg) throw httpError(503, "Last.fm isn't set up on this server");
      let a; try { a = await lastfm.startAuth(cfg, `${origin(req)}/api/lastfm/callback`); } catch { throw httpError(502, "Couldn't reach Last.fm"); }
      for (const [k, v] of lfStates) if (v.exp < Date.now()) lfStates.delete(k);
      for (const [k, v] of lfStates) if (v.userId === me.id) lfStates.delete(k); // one connection at a time per person
      lfStates.set(a.token, { userId: me.id, exp: Date.now() + 30 * 60000 });
      return json(res, { url: a.url }, 200, { "Set-Cookie": lfCookie(req, a.token, 600) });
    }
    if (method === "GET" && path === "/lastfm/callback") {
      // The browser lands here from last.fm, so the SameSite=Strict session cookie isn't sent: the account comes from the token saved at the start.
      const q = new URL(req.url, "http://x").searchParams, token = q.get("token") || "", st = lfStates.get(token);
      lfStates.delete(token);
      const done = (flag) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Set-Cookie": lfCookie(req, "", 0) });
        res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/?lastfm=${flag}"><title>${APP_NAME}</title><p><a href="/?lastfm=${flag}">Continue</a></p>`);
      };
      const cfg = lfCfg(), user = st && st.exp > Date.now() && safeEq(cookies(req).lf_tok || "", token) ? db.users[st.userId] : null;
      if (!cfg || !user) return done("error");
      try { user.lastfm = { ...(await lastfm.finishAuth(cfg, token)), at: Date.now() }; save(); } catch (e) { return done(e.code === 14 ? "denied" : "error"); }
      return done("ok");
    }
    if (method === "POST" && path === "/lastfm/finish") { // Last.fm doesn't always send the browser back, so the app asks once the person returns
      need(me);
      const cfg = lfCfg(), hit = [...lfStates].find(([, v]) => v.userId === me.id && v.exp > Date.now());
      if (!cfg || !hit) return json(res, { state: "none", user: publicUser(me) });
      try { me.lastfm = { ...(await lastfm.finishAuth(cfg, hit[0])), at: Date.now() }; lfStates.delete(hit[0]); save(); return json(res, { state: "ok", user: publicUser(me) }); }
      catch (e) { if (Number(e.code) === 14 || Number(e.code) === 15) return json(res, { state: "waiting", user: publicUser(me) }); lfStates.delete(hit[0]); return json(res, { state: "error", user: publicUser(me) }); } // 14: not approved yet
    }
    if (method === "POST" && path === "/lastfm/unlink") { need(me); delete me.lastfm; lfQueue.delete(me.id); save(); return json(res, { user: publicUser(me) }); }
    // The inviter's photo, for the "invite no longer works" pop-up. Whoever holds the code already sees it in the link preview.
    if (method === "GET" && (m = path.match(/^\/invite\/([a-f0-9]+)\/avatar$/))) {
      const u = db.users[db.invites[m[1]]?.by];
      const body = u?.avatar ? await fs.promises.readFile(`${AVATAR_DIR}/${u.id}.jpg`).catch(() => null) : null;
      if (!body) throw httpError(404, "No picture");
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": body.length, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
      return void res.end(body);
    }
    if ((m = path.match(/^\/join\/([a-f0-9]+)(\/account)?$/))) { // the page a friend opens: an account first, so the link is always theirs to find again
      const p = sharedByCode(m[1]), mine = me && p ? people(p.id).find((x) => x.userId === me.id) : null;
      const urls = (c) => ({ name: c.name, url: `${origin(req)}/${c.token}`, eclipse: `${origin(req)}/${c.token}/eclipse` });
      if (method === "GET" && !m[2]) return json(res, { name: p ? p.name : null, open: joinOpen(p), discord: discordOn(), user: me ? { displayName: me.displayName } : null, link: mine ? urls(mine) : null });
      if (method === "POST") {
        if (!joinOpen(p) && !mine) throw httpError(403, "This invite isn't open anymore");
        let user = me, cookie;
        if (m[2]) { // make the account here
          if (me) throw httpError(400, "You're already signed in");
          throttle(ip); joinThrottle(ip);
          const b = await readBody(req);
          user = await createUser({ username: b.username, displayName: b.displayName, password: b.password, role: "user" });
          user.lastLogin = Date.now(); save();
          cookie = setCookie(req, createSession(user.id, req.headers["user-agent"], ip), 2592000);
        }
        if (!user) throw httpError(401, "Sign in first");
        const c = people(p.id).find((x) => x.userId === user.id) || addPerson(p, user.displayName, user.id);
        return json(res, urls(c), 200, cookie ? { "Set-Cookie": cookie } : {});
      }
    }
    if (method === "GET" && (m = path.match(/^\/invite\/([a-f0-9]+)$/))) {
      const inv = db.invites[m[1]];
      const st = inviteState(inv), valid = st === "valid";
      return json(res, { valid, role: inv?.role, reason: valid ? undefined : st, message: inv?.message || undefined, left: inv ? inviteLeft(inv) : undefined, by: inv && db.users[inv.by] ? { username: db.users[inv.by].username, displayName: db.users[inv.by].displayName, avatar: db.users[inv.by].avatar || null } : undefined });
    }
    if (method === "POST" && path === "/setup") {
      throttle(ip);
      const b = await readBody(req);
      if (Object.keys(db.users).length || !setupCode || !safeEq(b.code || "", setupCode)) { failed(ip); throw httpError(403, "That setup code isn't right"); }
      const u = await createUser({ ...b, role: "admin" });
      for (const l of Object.values(db.links)) if (!l.userId && !l.guest) l.userId = u.id;
      setupCode = null;
      fs.rm(SETUP_FILE, () => {});
      u.lastLogin = Date.now();
      return json(res, { user: publicUser(u) }, 200, { "Set-Cookie": setCookie(req, createSession(u.id, req.headers["user-agent"], ip), 2592000) });
    }
    if (method === "POST" && path === "/login") {
      throttle(ip);
      const b = await readBody(req);
      const u = findUser(b.username || "");
      const ok = await checkPw(String(b.password || ""), u?.passHash);
      if (!u || !ok || u.disabled) { failed(ip); throw httpError(401, u?.disabled && ok ? "This account is disabled" : "Wrong username or password"); }
      u.lastLogin = Date.now();
      save();
      return json(res, { user: publicUser(u) }, 200, { "Set-Cookie": setCookie(req, createSession(u.id, req.headers["user-agent"], ip), 2592000) });
    }
    if (method === "POST" && path === "/register") {
      throttle(ip);
      const b = await readBody(req);
      const inv = db.invites[String(b.invite || "")];
      if (inviteState(inv) !== "valid") { failed(ip); throw httpError(403, "This invite is invalid or already used"); }
      const u = await createUser({ ...b, role: inv.role });
      inv.usedBy = u.id; (inv.usedList ||= []).push(u.id);
      u.lastLogin = Date.now();
      save();
      return json(res, { user: publicUser(u) }, 200, { "Set-Cookie": setCookie(req, createSession(u.id, req.headers["user-agent"], ip), 2592000) });
    }
    if (method === "POST" && path === "/logout") {
      destroySession(sid);
      return json(res, { ok: true }, 200, { "Set-Cookie": setCookie(req, "", 0) });
    }

    // ---- signed in ----
    need(me);
    if (method === "GET" && path === "/me") return json(res, { user: publicUser(me), stats: userStats(me.id) });
    if (method === "PATCH" && path === "/me") {
      const b = await readBody(req);
      if (b.displayName !== undefined) {
        const name = String(b.displayName || "").trim().slice(0, 40);
        if (!name) throw httpError(400, "Display name can't be empty");
        me.displayName = name;
      }
      if (b.shareListening !== undefined) me.shareListening = !!b.shareListening;
      save();
      return json(res, { user: publicUser(me) });
    }
    if (method === "POST" && path === "/me/password") {
      throttle(ip);
      const b = await readBody(req);
      if (!(await checkPw(String(b.current || ""), me.passHash))) { failed(ip); throw httpError(403, "Current password is wrong"); }
      if (String(b.next || "").length < 8) throw httpError(400, "New password must be at least 8 characters");
      me.passHash = await hashPw(b.next);
      destroyUserSessions(me.id, sessionKey(sid));
      return json(res, { ok: true });
    }
    // ---- profile picture: the client sends a 320px JPEG; anything that isn't one is refused ----
    if (method === "POST" && path === "/me/avatar" && String(req.headers["content-type"] || "").startsWith("image/gif")) { // an animated picture
      const buf = await readRaw(req, 6 * 1024 * 1024);
      const gif = buf.length > 20 && /^GIF8[79]a/.test(buf.toString("latin1", 0, 6));
      const w = gif ? buf.readUInt16LE(6) : 0, h = gif ? buf.readUInt16LE(8) : 0;
      if (!gif || w < 16 || h < 16 || w > 4096 || h > 4096) throw httpError(400, "That doesn't look like a usable GIF");
      const crop = cropOf(new URL(req.url, "http://x").searchParams, w, h);
      if (!crop) throw httpError(400, "Couldn't read the crop");
      const r = await animatedAvatar(buf, crop);
      if (!r) throw httpError(400, "That GIF couldn't be used. Try a shorter or smaller one.");
      fs.writeFileSync(`${AVATAR_DIR}/${me.id}.jpg`, r.still, { mode: 0o600 });
      fs.writeFileSync(`${AVATAR_DIR}/${me.id}.webp`, r.webp, { mode: 0o600 });
      me.avatar = Date.now(); me.avatarAnim = true;
      save();
      return json(res, { user: publicUser(me) });
    }
    if (method === "POST" && path === "/me/avatar") {
      const buf = await readRaw(req, 400 * 1024);
      if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw httpError(400, "That doesn't look like a JPEG");
      const clean = await reencodeJpeg(buf);
      if (!clean) throw httpError(400, "That doesn't look like a valid picture");
      fs.writeFileSync(`${AVATAR_DIR}/${me.id}.jpg`, clean, { mode: 0o600 });
      fs.rm(`${AVATAR_DIR}/${me.id}.webp`, () => {}); me.avatarAnim = false;
      me.avatar = Date.now();
      save();
      return json(res, { user: publicUser(me) });
    }
    if (method === "DELETE" && path === "/me/avatar") {
      fs.rm(`${AVATAR_DIR}/${me.id}.jpg`, () => {}); fs.rm(`${AVATAR_DIR}/${me.id}.webp`, () => {});
      me.avatar = null; me.avatarAnim = false;
      save();
      return json(res, { user: publicUser(me) });
    }
    if (method === "GET" && (m = path.match(/^\/avatar\/([a-f0-9]+)$/))) {
      const u = db.users[m[1]];
      if (!u?.avatar || !(isAdmin(me) || me.id === u.id || areFriends(me.id, u.id))) throw httpError(404, "No picture");
      const anim = u.avatarAnim === true, body = await fs.promises.readFile(`${AVATAR_DIR}/${u.id}.${anim ? "webp" : "jpg"}`).catch(() => null);
      if (!body) throw httpError(404, "No picture");
      res.writeHead(200, { "Content-Type": anim ? "image/webp" : "image/jpeg", "Content-Length": body.length, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
      return void res.end(body);
    }

    // ---- Discord presence app: what to download, and the Discord application it uses ----
    if (method === "GET" && path === "/rpc") { need(me); return json(res, rpcInfo()); }
    if ((m = path.match(/^\/rpc\/file\/([\w.-]+)$/)) && (method === "GET" || method === "HEAD")) { need(me); if (!rpcFile(req, res, m[1])) throw httpError(404, "No such file"); return; }
    // ---- friends ----
    if (method === "GET" && path === "/friends") return json(res, friendsView(me));
    // ---- encrypted chats: the server only keeps ciphertext, public keys and timing; it can't read a message ----
    if (path.startsWith("/chat/")) {
      const theirs = (id) => { if (!/^[a-f0-9]+$/.test(id) || !areFriends(me.id, id) || !db.users[id] || db.users[id].disabled) throw httpError(404, "No such friend"); return db.users[id]; };
      if (method === "GET" && path === "/chat/me") return json(res, { key: chat.getKey(me.id) }); // my public key, and the backup only my passphrase opens
      if (method === "PUT" && path === "/chat/key") { chat.limit(me.id, "key", 20, 3600000); return json(res, chat.setKey(me.id, await readBody(req))); }
      if (method === "GET" && path === "/chat/threads") {
        const ids = Object.values(db.friends).filter((f) => f.status === "accepted" && (f.from === me.id || f.to === me.id)).map((f) => (f.from === me.id ? f.to : f.from)).filter((id) => db.users[id] && !db.users[id].disabled);
        return json(res, { threads: chat.threads(me.id, ids) });
      }
      if ((m = path.match(/^\/chat\/key\/([a-f0-9]+)$/)) && method === "GET") {
        theirs(m[1]);
        const k = chat.publicKey(m[1]);
        if (!k) throw httpError(404, "They haven't set up chats yet");
        return json(res, k);
      }
      if ((m = path.match(/^\/chat\/with\/([a-f0-9]+)(?:\/(read)|\/([a-z0-9]{6,20}))?$/))) {
        const other = theirs(m[1]);
        if (method === "GET" && !m[2] && !m[3]) { chat.limit(me.id, "poll", 120, 60000); return json(res, { messages: chat.list(me.id, other.id, String(new URL(req.url, "http://x").searchParams.get("after") || "")), theirRead: chat.threads(me.id, [other.id])[0].theirRead }); }
        if (method === "POST" && !m[2] && !m[3]) { chat.limit(me.id, "send", 60, 60000); return json(res, { message: chat.post(me.id, other.id, await readBody(req)) }); }
        if (method === "POST" && m[2]) { chat.markRead(me.id, other.id, (await readBody(req)).id); return json(res, { ok: true }); }
        if (method === "DELETE" && m[3]) { chat.remove(me.id, other.id, m[3]); return json(res, { ok: true }); }
      }
      throw httpError(404, "Not found");
    }
    if (method === "POST" && path === "/friends") {
      const b = await readBody(req);
      const other = findUser(String(b.username || "").trim().replace(/^@/, ""));
      if (!other || other.disabled) throw httpError(404, "No one has that username");
      if (other.id === me.id) throw httpError(400, "That's you");
      const ex = friendship(me.id, other.id);
      if (ex?.status === "accepted") throw httpError(409, `You're already friends with ${other.displayName}`);
      if (ex && ex.from === me.id) throw httpError(409, "You already sent a request");
      if (ex) ex.status = "accepted"; // they had already asked you
      else { const f = { id: rid(5), from: me.id, to: other.id, status: "pending", at: Date.now() }; db.friends[f.id] = f; }
      save();
      return json(res, { ...friendsView(me), accepted: !!ex });
    }
    if ((m = path.match(/^\/friends\/([a-f0-9]+)(\/accept)?$/))) {
      const f = db.friends[m[1]];
      if (!f || (f.from !== me.id && f.to !== me.id)) throw httpError(404, "No such request");
      if (method === "POST" && m[2]) {
        if (f.to !== me.id || f.status !== "pending") throw httpError(400, "Nothing to accept");
        f.status = "accepted"; f.at = Date.now();
      } else if (method === "DELETE") { if (f.status === "accepted") chat.dropChat(f.from, f.to); delete db.friends[f.id]; } // unfriending deletes the chat too
      else throw httpError(404, "Not found");
      save();
      return json(res, friendsView(me));
    }

    if (method === "GET" && path === "/overview") return json(res, overview(me));
    if (method === "GET" && path === "/links") return json(res, { canCreate: canCreateLink(me), membersCreate: !!db.settings.membersCreateLinks, links: scopeLinks(me).sort((a, b) => b.createdAt - a.createdAt).map((l) => linkView(l, req, me)) });
    // API keys for the public metadata API (/v1). Admins make and remove them; a key is shown once, when it's made.
    if (path === "/apikeys" && method === "GET") { need(me, true); return json(res, { keys: publicApi.listKeys(), perMin: publicApi.DEFAULT_PER_MIN }); }
    if (path === "/apikeys" && method === "POST") { need(me, true); const b = await readBody(req); return json(res, publicApi.createKey(b.name, me.displayName, b.perMin, b.stream === true, botKeyAllowed(me, b.bot === true), b.lyrics === true)); }
    if ((m = path.match(/^\/apikeys\/([a-f0-9]+)$/))) {
      need(me, true);
      if (method === "PATCH") return json(res, { key: publicApi.renameKey(m[1], await readBody(req)) });
      if (method === "DELETE") { publicApi.removeKey(m[1]); return json(res, { ok: true }); }
    }
    // OAuth apps (see lib/oauth.mjs): admins register them; everyone sees and removes the apps they have approved.
    if (path === "/oauth/apps" && method === "GET") { need(me, true); return json(res, { apps: oauth.listApps(), scopes: oauth.SCOPES }); }
    if (path === "/oauth/apps" && method === "POST") { need(me, true); const b = await readBody(req); return json(res, oauth.createApp(b.name, b.redirectUris, b.confidential !== false, me.displayName)); }
    if ((m = path.match(/^\/oauth\/apps\/(uc_[A-Za-z0-9_-]+)(\/secret)?$/))) {
      need(me, true);
      if (m[2] && method === "POST") return json(res, oauth.resetSecret(m[1]));
      if (!m[2] && method === "PATCH") return json(res, { app: oauth.updateApp(m[1], await readBody(req)) });
      if (!m[2] && method === "DELETE") { oauth.removeApp(m[1]); return json(res, { ok: true }); }
    }
    if (path === "/oauth/grants" && method === "GET") { need(me); return json(res, { grants: oauth.grantsOf(me.id) }); }
    if ((m = path.match(/^\/oauth\/grants\/([a-f0-9]+)$/)) && method === "DELETE") { need(me); oauth.revokeGrant(me.id, m[1]); return json(res, { ok: true }); }
    if (path === "/oauth/consent" && method === "POST") { const b = await readBody(req); return json(res, { redirect: oauth.decide(me, sid, b.req, b.token, b.allow === true) }); }
    if (path === "/discordbot" && method === "GET") { need(me, true); return json(res, { owner: me.id === ownerId(), ...botView() }); }
    if (path === "/discordbot" && method === "PUT") {
      if (me?.id !== ownerId()) throw httpError(403, "Only the owner can set the bot token");
      const token = String((await readBody(req)).token || "").trim();
      if (!/^[A-Za-z0-9_-]{20,40}\.[A-Za-z0-9_-]{5,10}\.[A-Za-z0-9_-]{25,80}$/.test(token)) throw httpError(400, "That doesn't look like a bot token. It's three parts joined by dots, from the Bot tab in the Discord Developer Portal.");
      let info;
      try {
        const r = await fetch(`${DISCORD_API}/v10/users/@me`, { headers: { Authorization: `Bot ${token}`, "User-Agent": "DiscordBot (https://github.com/NotOutsideItRains/undertow, 1.0)" }, signal: AbortSignal.timeout(8000) });
        if (r.status === 401) throw httpError(400, "Discord says that token isn't right");
        if (!r.ok) throw httpError(502, "Discord didn't accept the check. Try again in a moment.");
        info = await r.json();
      } catch (e) { if (e.status) throw e; throw httpError(502, "Couldn't reach Discord to check the token"); }
      if (!/^\d{5,25}$/.test(String(info.id))) throw httpError(502, "Discord gave an unexpected answer");
      db.settings.discordBot = { token, id: String(info.id), name: String(info.username || "").slice(0, 40) };
      save();
      return json(res, botView());
    }
    if (path === "/discordbot" && method === "DELETE") {
      if (me?.id !== ownerId()) throw httpError(403, "Only the owner can remove the bot token");
      delete db.settings.discordBot; save();
      return json(res, botView());
    }
    // Bot licenses: the owner makes them for users; a user sees their own, with the bot's invite link
    if (path === "/botlicenses" && method === "GET") { need(me); const owner = me.id === ownerId(); return json(res, { owner, invite: botView().invite || null, licenses: owner ? botLicense.listAll() : botLicense.listFor(me.id) }); }
    if (path === "/botlicenses" && method === "POST") { if (me?.id !== ownerId()) throw httpError(403, "Only the owner can make licenses"); const b = await readBody(req); return json(res, botLicense.view(botLicense.create(String(b.userId || ""), b.label, me.displayName))); }
    if ((m = path.match(/^\/botlicenses\/([a-f0-9]+)$/))) {
      if (me?.id !== ownerId()) throw httpError(403, "Only the owner can change licenses");
      if (method === "PATCH") return json(res, botLicense.change(m[1], String((await readBody(req)).action || "")));
      if (method === "DELETE") { botLicense.remove(m[1]); return json(res, { ok: true }); }
    }
    if (path === "/settings" && method === "GET") { need(me, true); return json(res, { membersCreateLinks: !!db.settings.membersCreateLinks, membersUsePlayer: db.settings.membersUsePlayer !== false, membersSubmitVideos: db.settings.membersSubmitVideos !== false, memberLinkMax: MEMBER_LINK_MAX }); }
    if (path === "/settings" && method === "PATCH") {
      need(me, true);
      const b = await readBody(req);
      if (b.membersCreateLinks !== undefined) {
        const was = !!db.settings.membersCreateLinks;
        db.settings.membersCreateLinks = !!b.membersCreateLinks;
        if (was !== db.settings.membersCreateLinks) memberLinksAlert(db.settings.membersCreateLinks, me.displayName);
      }
      if (b.membersUsePlayer !== undefined) db.settings.membersUsePlayer = !!b.membersUsePlayer;
      if (b.membersSubmitVideos !== undefined) db.settings.membersSubmitVideos = !!b.membersSubmitVideos;
      save();
      return json(res, { membersCreateLinks: !!db.settings.membersCreateLinks, membersUsePlayer: db.settings.membersUsePlayer !== false, membersSubmitVideos: db.settings.membersSubmitVideos !== false, memberLinkMax: MEMBER_LINK_MAX });
    }
    if (method === "GET" && path === "/activity") {
      const url = new URL(req.url, "http://x");
      const limit = Math.min(500, Number(url.searchParams.get("limit")) || 150);
      return json(res, { events: activity.filter((e) => inScope(me, e)).slice(-limit).reverse() });
    }
    if (method === "GET" && path === "/events") {
      if (sseTotal >= 150 || (sseBy.get(me.id) || 0) >= 4) throw httpError(429, "Too many live views open");
      sseTotal++; sseBy.set(me.id, (sseBy.get(me.id) || 0) + 1);
      res.on("close", () => { sseTotal--; sseBy.set(me.id, Math.max(0, (sseBy.get(me.id) || 1) - 1)); });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(": hi\n\n");
      const on = (e) => { if (inScope(me, e)) res.write(`data: ${JSON.stringify(e)}\n\n`); };
      bus.on("event", on);
      const beat = setInterval(() => res.write(": beat\n\n"), 20000);
      req.on("close", () => { bus.off("event", on); clearInterval(beat); });
      return;
    }

    // ---- admin ----
    if (path === "/users" && method === "GET") {
      need(me, true);
      return json(res, { users: Object.values(db.users).map((u) => ({ ...publicUser(u), stats: userStats(u.id) })) });
    }
    if (path === "/users" && method === "POST") {
      need(me, true);
      const u = await createUser(await readBody(req));
      return json(res, { user: publicUser(u) });
    }
    if ((m = path.match(/^\/users\/([a-f0-9]+)$/))) {
      need(me, true);
      const u = db.users[m[1]];
      if (!u) throw httpError(404, "No such user");
      const admins = Object.values(db.users).filter((x) => x.role === "admin" && !x.disabled);
      const lastAdmin = u.role === "admin" && !u.disabled && admins.length === 1;
      if (u.id === ownerId()) { // the owner can't be demoted, disabled, removed or have their password reset
        const b = method === "PATCH" ? await readBody(req) : {};
        req.parsedBody = b;
        const touches = method === "DELETE" || (b.role !== undefined && b.role !== "admin") || b.disabled === true || b.password !== undefined;
        if (touches && me.id !== u.id) throw httpError(403, "You are not the owner lil bro 😭🙏");
        if (touches && (method === "DELETE" || b.role !== undefined || b.disabled === true)) throw httpError(400, "The owner can't be demoted, disabled or removed");
      }
      if (method === "DELETE") {
        if (u.id === me.id || lastAdmin) throw httpError(400, "You can't remove the last admin or yourself");
        for (const l of Object.values(db.links)) if (l.userId === u.id) deleteLink(l.id);
        destroyUserSessions(u.id);
        for (const f of Object.values(db.friends)) if (f.from === u.id || f.to === u.id) delete db.friends[f.id];
        fs.rm(`${AVATAR_DIR}/${u.id}.jpg`, () => {}); fs.rm(`${AVATAR_DIR}/${u.id}.webp`, () => {});
        chat.forgetUser(u.id);
        botLicense.dropUser(u.id); oauth.forgetUser(u.id); delete db.users[u.id];
        save();
        return json(res, { ok: true });
      }
      if (method === "PATCH") {
        const b = req.parsedBody || await readBody(req);
        if (b.displayName !== undefined) u.displayName = String(b.displayName).trim().slice(0, 40) || u.displayName;
        if (b.role !== undefined) { if (lastAdmin && b.role !== "admin") throw httpError(400, "There must be at least one admin"); u.role = b.role === "admin" ? "admin" : "user"; }
        if (b.disabled !== undefined) { if (lastAdmin && b.disabled) throw httpError(400, "You can't disable the last admin"); u.disabled = !!b.disabled; if (u.disabled) destroyUserSessions(u.id); }
        if (b.speaker !== undefined) u.speaker = b.speaker === true; // who may play through the server's speakers (admins always can)
        if (b.selfLinks !== undefined) { // let this person use their own link; one is made for them so it's ready
          u.selfLinks = b.selfLinks === true;
          if (u.selfLinks && !ownLinks(u).length) createLink({ userId: u.id, name: `${u.displayName}'s link`.slice(0, 40), createdBy: me.id });
        }
        if (b.password) { if (String(b.password).length < 8) throw httpError(400, "Password must be at least 8 characters"); u.passHash = await hashPw(b.password); destroyUserSessions(u.id); }
        save();
        return json(res, { user: { ...publicUser(u), stats: userStats(u.id) } });
      }
    }
    if (path === "/invites" && method === "GET") {
      need(me, true);
      return json(res, { invites: Object.entries(db.invites).filter(([, i]) => inviteState(i) === "valid").map(([code, i]) => ({ code, role: i.role, exp: i.exp, uses: i.uses || 1, left: inviteLeft(i), message: i.message || "", url: `${origin(req)}/?invite=${code}` })) });
    }
    if (path === "/invites" && method === "POST") {
      need(me, true);
      const b = await readBody(req);
      const code = rid(8);
      const uses = Math.min(100, Math.max(1, Math.round(Number(b.uses)) || 1)), days = Math.min(30, Math.max(1, Math.round(Number(b.days)) || 7));
      db.invites[code] = { role: b.role === "admin" ? "admin" : "user", exp: Date.now() + days * 86400000, by: me.id, uses, usedList: [], message: cleanInviteMessage(b.message) };
      save();
      return json(res, { code, uses, days, url: `${origin(req)}/?invite=${code}` });
    }
    if ((m = path.match(/^\/invites\/([a-f0-9]+)$/)) && method === "DELETE") {
      need(me, true);
      delete db.invites[m[1]];
      save();
      return json(res, { ok: true });
    }

    if (path === "/links" && method === "POST") {
      const b = await readBody(req);
      if (!isAdmin(me)) { // members get a plain link of their own, with default limits
        need(me);
        if (!mayOwnLinks(me)) throw httpError(403, "Admins only");
        if (ownLinks(me).length >= MEMBER_LINK_MAX) throw httpError(403, `You can have up to ${MEMBER_LINK_MAX} links`);
        return json(res, { link: linkView(createLink({ userId: me.id, name: b.name, createdBy: me.id }), req, me) });
      }
      if (b.userId === "guest" || b.shared === true) {
        const g = createLink({ guest: true, name: b.name, limits: b.limits, accountId: b.accountId, createdBy: me.id });
        if (b.shared === true) { g.shared = true; g.joinCode = rid(8); g.joinOpen = true; save(); }
        return json(res, { link: linkView(g, req, me) });
      }
      const owner = db.users[b.userId] || me;
      if (b.accountId && !db.accounts[b.accountId]) throw httpError(400, "Unknown account");
      const l = createLink({ userId: owner.id, name: b.name, limits: b.limits, accountId: b.accountId, createdBy: me.id });
      return json(res, { link: linkView(l, req, me) });
    }
    if (method === "POST" && (m = path.match(/^\/links\/([a-f0-9]+)\/people$/))) { // add a friend to a shared link by hand
      need(me, true);
      const p = db.links[m[1]];
      if (!p?.shared) throw httpError(404, "No such shared link");
      return json(res, { link: linkView(addPerson(p, (await readBody(req)).name), req, me) });
    }
    if ((m = path.match(/^\/links\/([a-f0-9]+)(\/rotate)?$/))) {
      const l = db.links[m[1]];
      if (!l) throw httpError(404, "No such link");
      if (method === "PATCH" && !isAdmin(me)) { // owners may only rename their own addon
        if (l.userId !== me.id) throw httpError(404, "No such link");
        const b = await readBody(req);
        if (Object.keys(b).some((k) => k !== "addonName")) throw httpError(403, "Admins only");
        l.addonName = cleanAddonName(b.addonName);
        save();
        return json(res, { link: linkView(l, req, me) });
      }
      if (method === "DELETE" && l.userId === me.id && mayOwnLinks(me)) { deleteLink(l.id); return json(res, { ok: true }); }
      need(me, true);
      if (method === "DELETE") { for (const c of people(l.id)) deleteLink(c.id); deleteLink(l.id); return json(res, { ok: true }); }
      if (method === "POST" && m[2]) { l.token = rid(16); reindexLinks(); save(); return json(res, { link: linkView(l, req, me) }); }
      if (method === "PATCH") {
        const b = await readBody(req);
        if (b.addonName !== undefined) l.addonName = cleanAddonName(b.addonName);
        if (b.name !== undefined) l.name = String(b.name).trim().slice(0, 40) || l.name;
        if (b.enabled !== undefined) l.enabled = !!b.enabled;
        if (b.userId === "guest") { l.userId = null; l.guest = true; }
        else if (b.userId !== undefined && db.users[b.userId]) { l.userId = b.userId; l.guest = false; }
        if (b.accountId !== undefined) { if (b.accountId && !db.accounts[b.accountId]) throw httpError(400, "Unknown account"); l.accountId = b.accountId || null; }
        if (b.limits) l.limits = sanitizeLimits(b.limits, l.limits);
        if (b.shared !== undefined && !l.parent) { // turn a link into one shared by many, or back
          l.shared = b.shared === true;
          if (l.shared) { l.joinCode ||= rid(8); l.joinOpen ??= true; l.userId = null; l.guest = true; }
          else for (const c of people(l.id)) delete c.parent; // no longer shared: its people become ordinary links
        }
        if (l.shared && b.joinOpen !== undefined) l.joinOpen = !!b.joinOpen;
        if (l.shared && b.rotateJoin) l.joinCode = rid(8);
        if (l.shared) for (const c of people(l.id)) { c.enabled = l.enabled; c.accountId = l.accountId; c.limits = sanitizeLimits(l.limits, c.limits); } // everyone under it follows its settings
        save();
        return json(res, { link: linkView(l, req, me) });
      }
    }

    if (path === "/accounts" && method === "GET") { need(me, true); return json(res, { accounts: accounts.allViews(), subsonic: subsonic.allViews(), videos: Object.entries(video.overrides()).map(([key, v]) => ({ key, ...v })), videosOn: video.available() }); }
    if (path === "/videos" && method === "POST") {
      need(me, true);
      const b = await readBody(req), old = b.key ? video.overrides()[b.key] : null;
      const link = String(b.link || "").trim() || old?.url || old?.id; // editing: a blank link keeps the one it has
      const key = video.setOverride(b.artist, b.title, link, { offset: b.offset, end: b.end, hidden: b.hidden === true, by: old?.by });
      if (old && b.key !== key) video.removeOverride(b.key); // the song or artist was renamed
      return json(res, { key });
    }
    if ((m = path.match(/^\/videos\/(.+)$/)) && method === "DELETE") { need(me, true); video.removeOverride(decodeURIComponent(m[1])); return json(res, { ok: true }); }
    if (path === "/subsonic" && method === "POST") {
      need(me, true);
      const b = await readBody(req);
      return json(res, { server: subsonic.view(await subsonic.addServer(b)) });
    }
    if ((m = path.match(/^\/subsonic\/([a-f0-9]+)(\/test)?$/))) {
      need(me, true);
      const s = subsonic.get(m[1]);
      if (!s) throw httpError(404, "No such server");
      if (method === "DELETE") { subsonic.removeServer(s.id); return json(res, { ok: true }); }
      if (method === "POST" && m[2]) { await subsonic.test(s); return json(res, { server: subsonic.view(s) }); }
      if (method === "PATCH") {
        const b = await readBody(req);
        if (b.password) await subsonic.setPassword(s, b.password);
        if (b.label !== undefined) s.label = String(b.label).trim().slice(0, 30) || s.label;
        if (b.enabled !== undefined) s.enabled = !!b.enabled;
        if (b.direct !== undefined) subsonic.setDirect(s, b.direct);
        if (b.normalize !== undefined) s.normalize = !!b.normalize;
        save();
        return json(res, { server: subsonic.view(s) });
      }
    }
    if (path === "/accounts/login" && method === "POST") {
      need(me, true);
      return json(res, accounts.loginView(await accounts.startLogin(me.id)));
    }
    if ((m = path.match(/^\/accounts\/login\/([a-f0-9]+)$/)) && method === "GET") {
      need(me, true);
      const l = accounts.getLogin(m[1]);
      if (!l) throw httpError(404, "That login expired");
      return json(res, accounts.loginView(l));
    }
    if ((m = path.match(/^\/accounts\/([a-z0-9]+)(\/restart)?$/))) {
      need(me, true);
      const a = db.accounts[m[1]];
      if (!a) throw httpError(404, "No such account");
      if (method === "DELETE") { accounts.removeAccount(a.id); return json(res, { ok: true }); }
      if (method === "POST" && m[2]) { await accounts.restartAccount(a.id); return json(res, { account: accounts.view(a) }); }
      if (method === "PATCH") {
        const b = await readBody(req);
        if (b.label !== undefined) a.label = String(b.label).trim().slice(0, 30) || a.label;
        if (b.enabled !== undefined) a.enabled = !!b.enabled;
        save();
        return json(res, { account: accounts.view(a) });
      }
    }
    throw httpError(404, "Not found");
  } catch (e) {
    json(res, { error: e.message }, e.status || 500, e.status === 429 ? { "Retry-After": "60" } : {});
    if (!e.status) console.log("API error", e);
  }
}
export { DEFAULT_LIMITS, ipOf };

// ---- OAuth for other apps, on the main address (the consent pages and the token endpoint; the admin side is under /api/oauth) ----
const CSP_PAGE = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'";
const htmlPage = (res, status, html) => { res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": CSP_PAGE, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" }); res.end(html); };
const TOKEN_CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400" };
async function readForm(req) { // a token request: the usual form encoding, or JSON
  let n = 0; const chunks = [];
  for await (const c of req) { if ((n += c.length) > 16384) throw httpError(413, "Body too large"); chunks.push(c); }
  const text = Buffer.concat(chunks).toString("utf8");
  if (String(req.headers["content-type"] || "").includes("json")) { try { const j = JSON.parse(text || "{}"); return j && typeof j === "object" ? j : {}; } catch { throw httpError(400, "Invalid JSON"); } }
  return Object.fromEntries(new URLSearchParams(text));
}
/** Returns true when the path was one of OAuth's. `origin` is this server's public address. */
export async function handleOAuth(req, res, u, origin) {
  const p = u.pathname, method = req.method, ip = ipOf(req);
  if (p === "/.well-known/oauth-authorization-server" && (method === "GET" || method === "HEAD")) { json(res, oauth.metadata(origin), 200, { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" }); return true; }
  if (!p.startsWith("/oauth/")) return false;
  const oauthError = (e) => { // OAuth's own error shape on the token endpoints
    const status = e.status || 500;
    json(res, { error: e.oauth || (status === 429 ? "slow_down" : "invalid_request"), error_description: status >= 500 ? "Something went wrong" : e.message }, status, { ...TOKEN_CORS, ...(status === 401 ? { "WWW-Authenticate": 'Basic realm="Undertow"' } : {}) });
  };
  try {
    if (p === "/oauth/token" || p === "/oauth/revoke") {
      if (method === "OPTIONS") { res.writeHead(204, TOKEN_CORS).end(); return true; }
      if (method !== "POST") throw httpError(405, "POST only");
      const body = await readForm(req), hdr = req.headers.authorization;
      if (p === "/oauth/token") json(res, oauth.token(body, hdr, ip), 200, { ...TOKEN_CORS, Pragma: "no-cache" });
      else { oauth.revoke(body, hdr, ip); json(res, {}, 200, TOKEN_CORS); }
      return true;
    }
    if (method !== "GET" && method !== "HEAD") throw httpError(405, "Not allowed");
    if (p === "/oauth/authorize") {
      oauth.rate("authorize|" + ip, 60);
      const q = Object.fromEntries(u.searchParams), r = oauth.begin(q);
      if (r.fatal) return htmlPage(res, 400, oauth.errorPage(APP_NAME, r.fatal)), true;
      if (r.redirect) { res.writeHead(302, { Location: r.redirect, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); res.end(); return true; }
      htmlPage(res, 200, oauth.hopPage(APP_NAME, `/oauth/consent?req=${r.id}`)); // the session cookie is SameSite=Strict, so this hop is made by a page of ours
      return true;
    }
    if (p === "/oauth/consent") {
      const sid = cookies(req).sid, me = sessionUser(sid), id = u.searchParams.get("req") || "";
      if (!me) return htmlPage(res, 200, oauth.signinPage(APP_NAME, oauth.appLabel(id))), true;
      const info = oauth.consentInfo(id, sid);
      if (!info) return htmlPage(res, 410, oauth.errorPage(APP_NAME, "This request has expired. Go back to the app and try connecting again.")), true;
      htmlPage(res, 200, oauth.consentPage(APP_NAME, id, info, me));
      return true;
    }
    throw httpError(404, "Not found");
  } catch (e) {
    if (p === "/oauth/token" || p === "/oauth/revoke") { oauthError(e); return true; }
    if (!e.status || e.status >= 500) console.error("oauth:", e.message);
    htmlPage(res, e.status || 500, oauth.errorPage(APP_NAME, e.status && e.status < 500 ? e.message : "Something went wrong"));
    return true;
  }
}
