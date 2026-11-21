// TIDAL accounts: device-code login (the same flow as hifi-api's tidal_auth.py) and one hifi-api
// process per account. Separate processes mean accounts can be added or dropped without restarting
// the others, and each request can be routed to (or pinned to) a specific account.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { db, save, rid, httpError } from "./store.mjs";
import { loginAlert } from "./notify.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const HIFI_DIR = process.env.HIFI_DIR || ROOT + "hifi-api";
const ACC_DIR = process.env.ACCOUNTS_DIR || ROOT + "accounts";
fs.mkdirSync(ACC_DIR, { recursive: true, mode: 0o700 });
const AUTH_BASE = process.env.TIDAL_AUTH_BASE || "https://auth.tidal.com/v1/oauth2";
const API_BASE = process.env.TIDAL_API_BASE || "https://api.tidal.com/v1";
const UA = "okhttp/5.3.2";
const b64 = (s) => Buffer.from(s, "base64").toString("latin1");
// App constants from hifi-api's own tidal_auth.py (public in that repo).
const AUTH_ID = b64("ZlgySnhkbW50WldLMGl4VA==");
const AUTH_SECRET = b64("MU5tNUFmREFqeHJnSkZKYktOV0xlQXlLR1ZHbUlOdVhQUExIVlhBdnhBZz0=");
const REQ_ID = b64("bHczdlI2R0UxdnROQnNqdg==");
const REQ_SECRET = b64("WTh0SXBxS0p4czlCRUl3WXIwSTliU2JNV0Rzb2dYSng5TGFOM21DSHdENCUzRA==");
const HEADERS = { "User-Agent": UA, Accept: "application/json", "Accept-Language": "en-US,en;q=0.9", "X-Platform": "android" };

const MAIN_URL = (process.env.HIFI_API_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const rt = new Map(); // account id -> runtime stats (memory only)
const R = (id) => { let r = rt.get(id); if (!r) rt.set(id, (r = { inflight: 0, leases: 0, picks: {}, requests: 0, errors: 0, avgMs: 0, authFailures: 0, lastOkAt: null, fails: 0 })); return r; };

// ---- device login ----------------------------------------------------------------------------
const logins = new Map(); // login id -> state

export async function startLogin(ownerId) {
  const r = await fetch(`${AUTH_BASE}/device_authorization`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: AUTH_ID, scope: "r_usr+w_usr+w_sub" }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw httpError(502, `TIDAL refused the login request (HTTP ${r.status})`);
  const d = await r.json();
  const url = String(d.verificationUriComplete || "").replace(/^(?!https?:)/, "https://");
  const l = {
    id: rid(6), ownerId, deviceCode: d.deviceCode, url, display: String(d.verificationUriComplete || "").replace(/^https?:\/\//, ""),
    userCode: d.userCode, expiresAt: Date.now() + (d.expiresIn || 300) * 1000, status: "pending", error: null, accountId: null,
  };
  logins.set(l.id, l);
  poll(l, (d.interval || 5) * 1000);
  return l;
}
async function poll(l, every) {
  while (l.status === "pending") {
    await new Promise((ok) => setTimeout(ok, every));
    if (Date.now() > l.expiresAt) { l.status = "expired"; break; }
    try {
      const r = await fetch(`${AUTH_BASE}/token`, {
        method: "POST",
        headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${AUTH_ID}:${AUTH_SECRET}`).toString("base64") },
        body: new URLSearchParams({ client_id: AUTH_ID, scope: "r_usr+w_usr+w_sub", device_code: l.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const acc = await addAccount(await r.json());
        l.accountId = acc.id;
        l.status = "done";
      } else {
        const e = await r.json().catch(() => ({}));
        if (e.error === "expired_token") l.status = "expired";
        else if (e.error && e.error !== "authorization_pending" && e.error !== "slow_down") { l.status = "error"; l.error = e.error_description || e.error; }
      }
    } catch (e) {
      if (!/timeout|fetch failed/i.test(String(e.message))) { l.status = "error"; l.error = e.message; }
    }
  }
  setTimeout(() => logins.delete(l.id), 10 * 60 * 1000).unref();
}
export const getLogin = (id) => logins.get(id);
export const loginView = (l) => ({ id: l.id, url: l.url, display: l.display, userCode: l.userCode, expiresAt: l.expiresAt, status: l.status, error: l.error, account: l.accountId ? view(db.accounts[l.accountId]) : null });

// ---- instances -------------------------------------------------------------------------------
const base = (a) => `http://127.0.0.1:${a.port}`;
export async function probe(a) {
  try { return (await fetch(base(a) + "/", { signal: AbortSignal.timeout(2500) })).ok; } catch { return false; }
}
async function waitReady(a, tries = 40) {
  for (let i = 0; i < tries; i++) { if (await probe(a)) return true; await new Promise((ok) => setTimeout(ok, 500)); }
  return false;
}
function spawnInstance(a) {
  const log = fs.openSync(`${ACC_DIR}/${a.id}.log`, "a", 0o600);
  const cmd = (process.env.HIFI_CMD || `${HIFI_DIR}/.venv/bin/hypercorn main:app --bind 127.0.0.1:${a.port}`).split(" ");
  const child = spawn(cmd[0], cmd.slice(1), { cwd: HIFI_DIR, env: { ...process.env, TOKEN_FILE: a.tokenFile, PORT: String(a.port) }, detached: true, stdio: ["ignore", log, log] });
  child.unref();
  a.pid = child.pid;
}
const takenPorts = () => new Set(Object.values(db.accounts).map((a) => a.port));
function freePort() { const t = takenPorts(); let p = 8100; while (t.has(p)) p++; return p; }

async function start(a) {
  a.status = "starting";
  if (await probe(a)) { a.status = "ok"; return; } // adopt a process that survived a restart
  spawnInstance(a);
  save();
  a.status = (await waitReady(a)) ? "ok" : "down";
  if (a.status === "down") a.lastError = "hifi-api did not start; see accounts/" + a.id + ".log";
}

async function fetchPlan(a, accessToken, userId) {
  try {
    const r = await fetch(`${API_BASE}/users/${userId}/subscription`, { headers: { ...HEADERS, Authorization: `Bearer ${accessToken}`, "X-Tidal-Platform": "android" }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return;
    const d = await r.json();
    a.plan = d.subscription?.type || d.type || a.plan;
    a.quality = d.highestSoundQuality || d.subscription?.highestSoundQuality || a.quality;
  } catch { /* best effort */ }
}

async function addAccount(tok) {
  const userId = String(tok.user?.userId ?? "");
  const entry = { access_token: tok.access_token, refresh_token: tok.refresh_token, userID: tok.user?.userId, client_ID: REQ_ID, client_secret: REQ_SECRET };
  let a = Object.values(db.accounts).find((x) => x.tidalUserId === userId && x.kind === "managed");
  if (a) { // reconnecting a known account: swap in fresh tokens and restart its process
    fs.writeFileSync(a.tokenFile, JSON.stringify([entry], null, 2), { mode: 0o600 });
    killInstance(a);
    a.enabled = true;
    a.lastError = null;
    R(a.id).authFailures = 0;
  } else {
    const id = rid(4);
    a = { id, label: tok.user?.username || tok.user?.email?.split("@")[0] || `Account ${Object.keys(db.accounts).length + 1}`, kind: "managed", port: freePort(), tokenFile: `${ACC_DIR}/${id}.json`, tidalUserId: userId, enabled: true, status: "starting", addedAt: Date.now() };
    fs.writeFileSync(a.tokenFile, JSON.stringify([entry], null, 2), { mode: 0o600 });
    db.accounts[id] = a;
    const old = Object.values(db.accounts).find((x) => x.kind === "external" && x.tidalUserId === userId);
    if (old) { old.enabled = false; old.lastError = "Replaced by a freshly connected copy"; }
  }
  await start(a);
  await fetchPlan(a, tok.access_token, userId);
  save();
  return a;
}

export function killInstance(a) {
  if (a.pid) { try { process.kill(-a.pid, "SIGTERM"); } catch { /* already gone */ } a.pid = null; }
}
export function removeAccount(id) {
  const a = db.accounts[id];
  if (!a) throw httpError(404, "No such account");
  if (a.kind === "external") throw httpError(400, "The built-in account can only be disabled");
  killInstance(a);
  for (const f of [a.tokenFile, `${ACC_DIR}/${a.id}.log`]) fs.rm(f, () => {});
  delete db.accounts[id];
  for (const l of Object.values(db.links)) if (l.accountId === id) l.accountId = null;
  save();
}
export async function restartAccount(id) {
  const a = db.accounts[id];
  if (!a) throw httpError(404, "No such account");
  if (a.kind === "managed") { killInstance(a); await new Promise((ok) => setTimeout(ok, 600)); await start(a); a.lastError = null; R(a.id).authFailures = 0; save(); }
  else { a.status = (await probe(a)) ? "ok" : "down"; }
  return a;
}

export async function boot() {
  const url = new URL(MAIN_URL);
  let main = db.accounts.main;
  if (!main) {
    main = db.accounts.main = { id: "main", label: "Main account", kind: "external", port: Number(url.port || 80), tokenFile: HIFI_DIR + "/token.json", enabled: true, status: "starting", addedAt: Date.now() };
    try { main.tidalUserId = String(JSON.parse(fs.readFileSync(main.tokenFile, "utf8"))[0].userID); } catch { /* optional */ }
  }
  main.port = Number(url.port || 80);
  for (const a of Object.values(db.accounts)) {
    a.status = "starting";
    (a.kind === "managed" && a.enabled ? start(a) : probe(a).then((ok) => (a.status = ok ? "ok" : "down"))).catch(() => {});
  }
  save();
  setInterval(recover, 5 * 60 * 1000).unref();
}

// Dead or down accounts get a cheap re-check every 5 minutes so a transient failure heals itself.
async function recover() {
  for (const a of Object.values(db.accounts)) {
    if (!a.enabled || a.status === "ok") continue;
    if (a.status === "down" && a.kind === "managed") { await start(a); continue; }
    if (!(await probe(a))) { a.status = "down"; continue; }
    try {
      await call(a, "/trackManifests/", { id: "493546859", formats: ["FLAC"], manifestType: "MPEG_DASH", uriScheme: "HTTPS" }, { poll: true, probing: true });
      a.status = "ok";
      a.lastError = null;
      save();
    } catch { /* still dead */ }
  }
}

// ---- routing ---------------------------------------------------------------------------------
const usable = (a) => a.enabled && a.status === "ok";
// Which account does the next piece of work go to? The one that is least busy right now (a stream counts as busy for its whole run, so two
// plays at once land on different accounts), and then the one that has had the fewest jobs OF THIS KIND. Searches and streams are counted
// separately: counting every call together made a steady rhythm of calls (say two searches and a stream per play) send every stream to one
// account and every search to the other.
export function pick({ pinned = null, exclude = [], kind = "other" } = {}) {
  let pool = Object.values(db.accounts).filter((a) => usable(a) && !exclude.includes(a.id));
  if (pinned) pool = pool.filter((a) => a.id === pinned);
  if (!pool.length) throw httpError(503, pinned ? "The account for this link is unavailable" : "No TIDAL account is available");
  const load = (a) => R(a.id).inflight + R(a.id).leases;
  pool.sort((x, y) => load(x) - load(y) || (R(x.id).picks[kind] || 0) - (R(y.id).picks[kind] || 0) || R(x.id).requests - R(y.id).requests);
  const r = R(pool[0].id);
  r.picks[kind] = (r.picks[kind] || 0) + 1;
  return pool[0];
}
export const lease = (a, n) => { R(a.id).leases = Math.max(0, R(a.id).leases + n); }; // hold an account busy across a whole job
export const anyUsable = () => Object.values(db.accounts).some(usable);

let authBurst = 0;
function loginDead(a, status, detail) {
  const r = R(a.id);
  const dead = status === 401 || (status === 500 && /credential/i.test(detail)) || (status === 403 && ++r.authFailures >= 3);
  if (!dead) return false;
  a.status = "dead";
  let why = "";
  try { why = String(JSON.parse(detail).detail || ""); } catch { /* not JSON */ }
  a.lastError = `HTTP ${status}${why ? `: ${why}` : ""}`;
  save();
  loginAlert(a, status, detail);
  return true;
}

// One call to a specific account's hifi-api. Playback endpoints queue (202) and are polled.
export async function call(a, path, params = {}, { poll = false, probing = false, soft403 = false } = {}) {
  const r = R(a.id);
  const url = new URL(base(a) + path);
  for (const [k, v] of Object.entries(params)) for (const item of [].concat(v)) url.searchParams.append(k, item);
  const t0 = Date.now();
  r.requests++;
  r.inflight++;
  try {
    for (let i = 0; i < 80; i++) {
      let res;
      try { res = await fetch(url, { signal: AbortSignal.timeout(15000) }); }
      catch (e) { if (++r.fails >= 3 && !probing) { a.status = "down"; a.lastError = "hifi-api is not responding"; } throw Object.assign(new Error("hifi-api unreachable"), { status: 502 }); }
      r.fails = 0;
      if (res.status === 202 && poll) {
        const body = await res.json();
        await new Promise((ok) => setTimeout(ok, 250));
        url.href = base(a) + body.statusUrl;
        url.search = "";
        continue;
      }
      if (res.status === 202) throw Object.assign(new Error("queued"), { status: 429, retryAfter: res.headers.get("retry-after") || "2" });
      if (res.status === 404) throw Object.assign(new Error("not found"), { status: 404 });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const loginFailed = soft403 && res.status === 403 ? false : loginDead(a, res.status, detail); // soft403: a caller that asks for qualities a track may not have must not get a working account written off
        r.errors++;
        throw Object.assign(new Error(loginFailed ? "tidal login failed" : `hifi-api ${res.status}`), { status: 502, loginFailed, account: a.id });
      }
      if (/^\/(track|trackManifests)\//.test(path)) { r.authFailures = 0; r.lastOkAt = Date.now(); }
      const ms = Date.now() - t0;
      r.avgMs = r.avgMs ? r.avgMs * 0.8 + ms * 0.2 : ms;
      return await res.json();
    }
    throw Object.assign(new Error("queue timeout"), { status: 429, retryAfter: "5" });
  } finally { r.inflight--; }
}

export function view(a) {
  if (!a) return null;
  const r = R(a.id);
  return { id: a.id, label: a.label, kind: a.kind, enabled: a.enabled, status: a.enabled ? a.status : "disabled", lastError: a.lastError || null, tidalUserId: a.tidalUserId || null, plan: a.plan || null, quality: a.quality || null, port: a.port, addedAt: a.addedAt, inflight: r.inflight, requests: r.requests, errors: r.errors, avgMs: Math.round(r.avgMs), lastOkAt: r.lastOkAt };
}
export const allViews = () => Object.values(db.accounts).map(view);
