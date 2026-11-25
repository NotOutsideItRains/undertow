// OAuth 2.0 for other apps: a person says "this app may see what I am listening to", and the app gets a token for it (like "Log in with Spotify").
// Authorization code flow with PKCE (S256, required for every app). Apps are registered by an admin; each person approves each app on a consent page.
// Tokens and app secrets are kept as SHA-256 hashes and shown once. What an app can see is limited by scopes:
//   user-read-profile            the person's id and display name
//   user-read-currently-playing  the song they are playing now (only while a player is sharing it, see lib/rpcrelay.mjs)
import crypto from "node:crypto";
import { db, save, rid, httpError } from "./store.mjs";
import * as relay from "./rpcrelay.mjs";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const apps = () => (db.oauthApps ||= {});
const grants = () => (db.oauthGrants ||= {});
export const SCOPES = {
  "user-read-profile": "See your name and account id",
  "user-read-currently-playing": "See the song you are playing right now",
};
export const LIMITS = { apps: 30, accessMs: 60 * 60 * 1000, refreshMs: 60 * 24 * 3600 * 1000, codeMs: 10 * 60 * 1000, requestMs: 15 * 60 * 1000, redirects: 5, grantsPerUser: 50 };

const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, n);
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hits = new Map();
export function rate(id, max, ms = 60000) { // throws 429 when `id` asks more than `max` times in `ms`
  const t = Date.now(), r = hits.get(id);
  if (!r || t - r[0] > ms) { hits.set(id, [t, 1]); if (hits.size > 5000) hits.delete(hits.keys().next().value); return; }
  if (++r[1] > max) throw httpError(429, "Slow down a little");
}

// ---- redirect addresses: https, a loopback address for apps on the same computer, or an app's own scheme (myapp://callback) ----
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
export function cleanRedirect(v) {
  const s = String(v || "").trim();
  if (!s || s.length > 300 || /[\u0000-\u001f\u007f\s]/.test(s) || s.includes("#")) return "";
  let u; try { u = new URL(s); } catch { return ""; }
  if (u.username || u.password) return "";
  if (u.protocol === "https:") return u.hostname ? s : "";
  if (u.protocol === "http:") return LOOPBACK.test(u.hostname) ? s : "";
  if (/^(javascript|data|file|vbscript|blob|about|ws|wss|ftp):$/i.test(u.protocol)) return "";
  return /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) ? s : "";
}
function redirectMatches(registered, given) {
  if (registered.includes(given)) return true;
  let g; try { g = new URL(given); } catch { return false; }
  if (g.protocol !== "http:" || !LOOPBACK.test(g.hostname)) return false; // an app on this computer may pick a free port each time
  return registered.some((r) => { try { const x = new URL(r); return x.protocol === "http:" && x.hostname === g.hostname && x.pathname === g.pathname && x.search === g.search; } catch { return false; } });
}
const appView = (a) => ({ id: a.id, name: a.name, redirectUris: a.redirectUris, confidential: !!a.secretHash, createdAt: a.createdAt, createdBy: a.createdBy, lastUsed: a.lastUsed || null, people: Object.values(grants()).filter((g) => g.appId === a.id).length });

// ---- apps (admin) ----
export function createApp(name, redirectUris, confidential, by) {
  if (Object.keys(apps()).length >= LIMITS.apps) throw httpError(400, `That's the most apps allowed (${LIMITS.apps}). Remove one first.`);
  const label = clean(name, 40);
  if (!label) throw httpError(400, "Give the app a name; people see it when they approve it");
  const list = [...new Set((Array.isArray(redirectUris) ? redirectUris : String(redirectUris || "").split(/\s+/)).map(cleanRedirect).filter(Boolean))].slice(0, LIMITS.redirects);
  if (!list.length) throw httpError(400, "Add at least one redirect address: https://…, http://localhost…, or the app's own scheme like myapp://callback");
  const a = { id: "uc_" + crypto.randomBytes(12).toString("base64url"), name: label, redirectUris: list, secretHash: null, createdAt: Date.now(), createdBy: clean(by, 40), lastUsed: null };
  let secret = null;
  if (confidential) { secret = "us_" + crypto.randomBytes(24).toString("base64url"); a.secretHash = sha(secret); }
  apps()[a.id] = a;
  save();
  return { app: appView(a), secret }; // the secret exists outside the owner's copy only now
}
export const listApps = () => Object.values(apps()).sort((a, b) => b.createdAt - a.createdAt).map(appView);
export function updateApp(id, body) {
  const a = apps()[id]; if (!a) throw httpError(404, "No such app");
  if (body.name !== undefined) { const n = clean(body.name, 40); if (!n) throw httpError(400, "Give the app a name"); a.name = n; }
  if (body.redirectUris !== undefined) {
    const list = [...new Set((Array.isArray(body.redirectUris) ? body.redirectUris : String(body.redirectUris).split(/\s+/)).map(cleanRedirect).filter(Boolean))].slice(0, LIMITS.redirects);
    if (!list.length) throw httpError(400, "Add at least one valid redirect address");
    a.redirectUris = list;
  }
  save();
  return appView(a);
}
export function resetSecret(id) {
  const a = apps()[id]; if (!a) throw httpError(404, "No such app");
  if (!a.secretHash) throw httpError(400, "This app has no secret (it is a public app)");
  const secret = "us_" + crypto.randomBytes(24).toString("base64url");
  a.secretHash = sha(secret); save();
  return { app: appView(a), secret };
}
export function removeApp(id) {
  if (!apps()[id]) throw httpError(404, "No such app");
  delete apps()[id];
  for (const [gid, g] of Object.entries(grants())) if (g.appId === id) delete grants()[gid];
  for (const [k, v] of codes) if (v.appId === id) codes.delete(k);
  save();
}

// ---- the authorization request: validated first, then kept on the server while the person decides ----
const requests = new Map(); // id -> request
const codes = new Map(); // sha(code) -> { ... }
const sweep = () => { const t = Date.now(); for (const [k, v] of requests) if (v.exp < t) requests.delete(k); for (const [k, v] of codes) if (v.exp < t) codes.delete(k); };
const withParams = (uri, params) => { const u = new URL(uri); for (const [k, v] of Object.entries(params)) if (v != null && v !== "") u.searchParams.set(k, v); return u.toString(); };

/** Checks what the app asked for. Returns {fatal} (show the person an error, never redirect: the address cannot be trusted) or {redirect} (send the app back with an error) or {id}. */
export function begin(q) {
  rate("begin", 600);
  const a = apps()[String(q.client_id || "")];
  if (!a) return { fatal: "This app is not registered here (unknown client_id)." };
  const redirect = String(q.redirect_uri || (a.redirectUris.length === 1 ? a.redirectUris[0] : ""));
  if (!redirect || !redirectMatches(a.redirectUris, redirect)) return { fatal: "The app asked to send you to an address that was not registered for it." };
  const state = q.state == null ? "" : String(q.state).slice(0, 500);
  const back = (error, description) => ({ redirect: withParams(redirect, { error, error_description: description, state }) });
  if (q.response_type !== "code") return back("unsupported_response_type", "Only response_type=code is supported");
  const challenge = String(q.code_challenge || "");
  if (q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back("invalid_request", "PKCE is required: send code_challenge (S256 of your code_verifier, base64url) and code_challenge_method=S256");
  const asked = String(q.scope || "user-read-profile").split(/[\s+,]+/).filter(Boolean);
  const bad = asked.find((s) => !SCOPES[s]);
  if (bad) return back("invalid_scope", `Unknown scope: ${bad.slice(0, 60)}`);
  sweep();
  if (requests.size > 2000) return back("temporarily_unavailable", "Try again in a few minutes");
  const id = rid(24);
  requests.set(id, { id, appId: a.id, redirect, state, challenge, scopes: [...new Set(asked)], exp: Date.now() + LIMITS.requestMs });
  return { id };
}
const formToken = (sid, id) => crypto.createHmac("sha256", fileKey()).update(`oauth-consent|${sid}|${id}`).digest("base64url").slice(0, 32);
const fileKey = () => { db.settings ||= {}; if (!db.settings.fileKey) { db.settings.fileKey = crypto.randomBytes(32).toString("hex"); save(); } return db.settings.fileKey; };

/** What the consent page shows, plus the one-time form token that only this browser session can use. */
export function consentInfo(id, sid) {
  const r = requests.get(String(id || "")); if (!r || r.exp < Date.now()) return null;
  const a = apps()[r.appId]; if (!a) return null;
  let host = ""; try { const u = new URL(r.redirect); host = u.protocol.startsWith("http") ? u.host : u.protocol; } catch { /* shown without it */ }
  return { app: a.name, host, scopes: r.scopes.map((s) => ({ id: s, text: SCOPES[s] })), token: formToken(sid, r.id) };
}

/** The person pressed Allow or Deny. Returns the address to send them to (the app's, with a code or an error). */
export function decide(me, sid, id, token, allow) {
  if (!me) throw httpError(401, "Sign in first");
  rate("decide|" + me.id, 30);
  const r = requests.get(String(id || ""));
  if (!r || r.exp < Date.now()) throw httpError(410, "This request has expired. Go back to the app and try again.");
  if (!eq(String(token || ""), formToken(sid, r.id))) throw httpError(403, "Bad request");
  requests.delete(r.id); // answered once
  const a = apps()[r.appId]; if (!a) throw httpError(410, "This app was removed.");
  if (!allow) return withParams(r.redirect, { error: "access_denied", error_description: "The person said no", state: r.state });
  const code = "uc_" + crypto.randomBytes(24).toString("base64url");
  codes.set(sha(code), { appId: a.id, userId: me.id, redirect: r.redirect, challenge: r.challenge, scopes: r.scopes, exp: Date.now() + LIMITS.codeMs });
  return withParams(r.redirect, { code, state: r.state });
}

// ---- tokens ----
const tokenErr = (status, error, description) => Object.assign(httpError(status, description || error), { oauth: error });
function appAuth(body, header) {
  let id = String(body.client_id || ""), secret = body.client_secret == null ? "" : String(body.client_secret);
  const b = /^Basic\s+(\S+)$/i.exec(header || "");
  if (b) { try { const [i, ...s] = Buffer.from(b[1], "base64").toString().split(":"); id = decodeURIComponent(i); secret = decodeURIComponent(s.join(":")); } catch { throw tokenErr(401, "invalid_client", "Bad Basic credentials"); } }
  const a = apps()[id];
  if (!a) throw tokenErr(401, "invalid_client", "Unknown client_id");
  if (a.secretHash && !(secret && eq(sha(secret), a.secretHash))) throw tokenErr(401, "invalid_client", "Wrong client_secret");
  return a;
}
function issue(g) {
  const access = "uo_a_" + crypto.randomBytes(32).toString("base64url"), refresh = "uo_r_" + crypto.randomBytes(32).toString("base64url");
  g.accessHash = sha(access); g.accessExp = Date.now() + LIMITS.accessMs; g.refreshHash = sha(refresh); g.refreshExp = Date.now() + LIMITS.refreshMs;
  return { access_token: access, token_type: "Bearer", expires_in: Math.floor(LIMITS.accessMs / 1000), refresh_token: refresh, scope: g.scopes.join(" ") };
}
const b64 = (buf) => buf.toString("base64url");

/** POST /oauth/token (form fields as an object). Throws errors that carry `.oauth` (the OAuth error name). */
export function token(body, authHeader, ip) {
  rate("token|" + ip, 60);
  const a = appAuth(body, authHeader);
  a.lastUsed = Date.now();
  if (body.grant_type === "authorization_code") {
    const key = sha(String(body.code || "")), c = codes.get(key);
    codes.delete(key); // single use
    if (!c || c.exp < Date.now() || c.appId !== a.id) throw tokenErr(400, "invalid_grant", "That code is wrong, used or expired");
    if (String(body.redirect_uri || "") !== c.redirect) throw tokenErr(400, "invalid_grant", "redirect_uri does not match the one in the request");
    const verifier = String(body.code_verifier || "");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !eq(b64(crypto.createHash("sha256").update(verifier).digest()), c.challenge)) throw tokenErr(400, "invalid_grant", "code_verifier does not match");
    let g = Object.values(grants()).find((x) => x.userId === c.userId && x.appId === a.id); // approving again replaces the earlier approval
    if (!g) {
      if (Object.values(grants()).filter((x) => x.userId === c.userId).length >= LIMITS.grantsPerUser) throw tokenErr(400, "invalid_grant", "This account has approved too many apps");
      g = { id: rid(8), userId: c.userId, appId: a.id, createdAt: Date.now(), lastUsed: null };
      grants()[g.id] = g;
    }
    g.scopes = c.scopes;
    const out = issue(g); save();
    return out;
  }
  if (body.grant_type === "refresh_token") {
    const h = sha(String(body.refresh_token || ""));
    const g = Object.values(grants()).find((x) => x.appId === a.id && x.refreshHash && eq(x.refreshHash, h));
    if (!g || g.refreshExp < Date.now()) throw tokenErr(400, "invalid_grant", "That refresh token is wrong or expired");
    const out = issue(g); save(); // the old pair stops working: a refresh token is used once
    return out;
  }
  throw tokenErr(400, "unsupported_grant_type", "Use authorization_code or refresh_token");
}

/** POST /oauth/revoke: forget an access or refresh token (and the approval behind it). Always "succeeds" (RFC 7009). */
export function revoke(body, authHeader, ip) {
  rate("revoke|" + ip, 60);
  const a = appAuth(body, authHeader), h = sha(String(body.token || ""));
  const g = Object.values(grants()).find((x) => x.appId === a.id && (x.accessHash === h || x.refreshHash === h));
  if (g) { delete grants()[g.id]; save(); }
}

/** Who a bearer token (an access token) belongs to, or null. */
let lastSave = 0;
export function authenticate(bearer) {
  const t = String(bearer || "");
  if (!/^uo_a_[A-Za-z0-9_-]{30,60}$/.test(t)) return null;
  const h = sha(t), g = Object.values(grants()).find((x) => x.accessHash && eq(x.accessHash, h));
  if (!g || g.accessExp < Date.now()) return null;
  const user = db.users[g.userId];
  if (!user || user.disabled) return null;
  g.lastUsed = Date.now();
  if (g.lastUsed - lastSave > 60000) { lastSave = g.lastUsed; save(); }
  return { user, grant: g, scopes: g.scopes };
}

// ---- what an app can read ----
export const profile = (user) => ({ id: user.id, display_name: user.displayName || user.username });
/** Shaped like Spotify's "currently playing", so apps written for it need little change. */
export function currentlyPlaying(user) {
  const c = relay.current(user.id);
  if (!c.playing) return { is_playing: false, progress_ms: 0, item: null };
  return {
    is_playing: true, progress_ms: c.positionMs, timestamp: Date.now(),
    item: { id: c.tidalId || null, name: c.title, artists: c.artist ? [{ name: c.artist }] : [], album: { name: c.album || "", images: c.coverUrl ? [{ url: c.coverUrl }] : [] }, duration_ms: c.durationMs, source: c.source },
  };
}

// ---- each person's approvals ----
export const grantsOf = (userId) => Object.values(grants()).filter((g) => g.userId === userId && apps()[g.appId]).sort((a, b) => b.createdAt - a.createdAt)
  .map((g) => ({ id: g.id, app: apps()[g.appId].name, scopes: g.scopes, createdAt: g.createdAt, lastUsed: g.lastUsed }));
export function revokeGrant(userId, id) {
  const g = grants()[id];
  if (!g || g.userId !== userId) throw httpError(404, "No such approval");
  delete grants()[id]; save();
}
/** An account that is removed takes its approvals with it. */
export function forgetUser(userId) { let n = 0; for (const [id, g] of Object.entries(grants())) if (g.userId === userId) { delete grants()[id]; n++; } if (n) save(); }

export const metadata = (origin) => ({
  issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, revocation_endpoint: `${origin}/oauth/revoke`,
  response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"], scopes_supported: Object.keys(SCOPES),
});

// ---- the consent page ----
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shell = (name, body, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="dark light">
<title>${esc(name)}</title><link rel="icon" href="/icon.svg?v=3">
<style>
:root{--bg:#061820;--s:#0c2530;--t:#e4f3ee;--t2:rgba(228,243,238,.72);--h:rgba(160,225,210,.18);--a:#ffb02e;--ink:#1a1203;--bad:#ff5a5f}
@media(prefers-color-scheme:light){:root{--bg:#dce9e5;--s:#f2f8f5;--t:#0b2229;--t2:rgba(11,34,41,.72);--h:rgba(11,34,41,.16);--a:#b25a00;--ink:#fff;--bad:#c62828}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--t);font:400 .9375rem/1.45 "Avenir Next","Segoe UI",system-ui,sans-serif}
main{width:min(420px,100%);background:var(--s);box-shadow:0 0 0 1px var(--h);border-radius:12px;padding:24px;display:grid;gap:14px}
h1{margin:0;font-size:1.25rem;line-height:1.25}p{margin:0;color:var(--t2)}ul{margin:0;padding-left:1.2em;display:grid;gap:4px}
label{display:grid;gap:6px;font-size:.8rem;font-weight:600;color:var(--t2)}
input{font:inherit;font-size:16px;color:var(--t);min-height:44px;padding:0 14px;border:0;border-radius:8px;background:transparent;box-shadow:inset 0 0 0 1px var(--h);outline:none}
button{font:inherit;font-weight:700;min-height:44px;border:0;border-radius:8px;padding:0 16px;cursor:pointer;background:var(--a);color:var(--ink)}
button.q{background:transparent;color:var(--t);box-shadow:inset 0 0 0 1px var(--h)}.row{display:flex;gap:10px}.row button{flex:1}
#msg{color:var(--bad);min-height:1.2em;font-size:.85rem}small{color:var(--t2)}a{color:var(--a)}
</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;

export const errorPage = (appName, message) => shell(appName, `<h1>Can't connect this app</h1><p>${esc(message)}</p><p><small>Nothing was shared. You can close this page.</small></p>`);
export const hopPage = (appName, to) => shell(appName, `<h1>One moment…</h1><p><a href="${esc(to)}">Continue</a></p>`).replace("</head>", `<meta http-equiv="refresh" content="0;url=${esc(to)}"></head>`); // a page of ours makes the last hop, so the session cookie (SameSite=Strict) is sent

export function consentPage(appName, reqId, info, me) {
  const body = `<h1>${esc(info.app)} wants to connect to your ${esc(appName)} account</h1>
<p>You are signed in as <b>${esc(me.displayName || me.username)}</b>.</p>
<p>It will be able to:</p><ul>${info.scopes.map((s) => `<li>${esc(s.text)}</li>`).join("")}</ul>
<p><small>${info.scopes.some((s) => s.id === "user-read-currently-playing") ? "It only sees a song while a player is sharing it (the “share what I’m playing” switch in the player). " : ""}It can't change anything, play music or see your library. You can remove it any time at <a href="/developers">/developers</a>. After you allow, you go to <b>${esc(info.host || "the app")}</b>.</small></p>
<div id="msg" role="alert"></div>
<div class="row"><button class="q" id="no" type="button">Cancel</button><button id="yes" type="button">Allow</button></div>`;
  const script = `const R=${JSON.stringify(reqId)},T=${JSON.stringify(info.token)},m=document.getElementById("msg");
async function go(allow){document.getElementById("yes").disabled=document.getElementById("no").disabled=true;
try{const r=await fetch("/api/oauth/consent",{method:"POST",headers:{"content-type":"application/json","x-requested-with":"ui"},body:JSON.stringify({req:R,token:T,allow})});const j=await r.json();
if(!r.ok)throw new Error(j.error||"Something went wrong");location.href=j.redirect}catch(e){m.textContent=e.message;document.getElementById("yes").disabled=document.getElementById("no").disabled=false}}
document.getElementById("yes").onclick=()=>go(true);document.getElementById("no").onclick=()=>go(false);`;
  return shell(appName, body, script);
}
export function signinPage(appName, appLabel) {
  const body = `<h1>Sign in to connect ${esc(appLabel)}</h1><p>Sign in to your ${esc(appName)} account to see what this app is asking for.</p>
<label>Username<input id="u" autocomplete="username" autocapitalize="none"></label><label>Password<input id="p" type="password" autocomplete="current-password"></label>
<div id="msg" role="alert"></div><button id="go" type="button">Sign in</button>
<p><small>Signed in another way (Discord)? <a href="/" target="_blank" rel="noopener">Sign in on the main page</a>, then <a href="" onclick="location.reload();return false">reload this page</a>.</small></p>`;
  const script = `const m=document.getElementById("msg");async function go(){m.textContent="";try{const r=await fetch("/api/login",{method:"POST",headers:{"content-type":"application/json","x-requested-with":"ui"},body:JSON.stringify({username:document.getElementById("u").value,password:document.getElementById("p").value})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||"Could not sign in");location.reload()}catch(e){m.textContent=e.message}}
document.getElementById("go").onclick=go;document.getElementById("p").addEventListener("keydown",(e)=>{if(e.key==="Enter")go()});`;
  return shell(appName, body, script);
}
export const appLabel = (reqId) => { const r = requests.get(String(reqId || "")); return r && apps()[r.appId] ? apps()[r.appId].name : "this app"; };
