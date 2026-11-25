// End-to-end test of OAuth for other apps: starts the real server on a temporary data folder and walks through registering an app, a person approving it,
// getting tokens and reading what they are playing. Run:  node --test tests/
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-test-"));
const PORT = 7200 + Math.floor(Math.random() * 200), BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, PORT: String(PORT), DATA_FILE: path.join(tmp, "data.json"), ACTIVITY_FILE: path.join(tmp, "act.json"), ACCOUNTS_DIR: path.join(tmp, "accounts"), AVATARS_DIR: path.join(tmp, "av"), AUDIO_CACHE_DIR: path.join(tmp, "ac"), AUDIO_TMP_DIR: path.join(tmp, "at"), SETUP_FILE: path.join(tmp, "setup"), HIFI_DIR: path.join(tmp, "none"), PUBLIC_URL: BASE };
let server, admin, user, userId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (method, p, { sid, body, form, headers = {}, raw } = {}) => fetch(BASE + p, {
  method, redirect: "manual",
  headers: { ...(sid ? { cookie: `sid=${sid}` } : {}), ...(method !== "GET" && sid ? { "x-requested-with": "ui" } : {}), ...(body ? { "content-type": "application/json" } : {}), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...headers },
  body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
}).then(async (r) => { const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* html */ } return { status: r.status, text: t, json: j, headers: r.headers }; });
const pkce = () => { const verifier = crypto.randomBytes(48).toString("base64url"); return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") }; };
const REDIRECT = "https://app.example.com/callback";

async function authorize(sid, { client, scope, redirect = REDIRECT, state = "xyz", allow = true, challenge }) {
  const q = new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, scope, state, code_challenge: challenge, code_challenge_method: "S256" });
  const a = await call("GET", `/oauth/authorize?${q}`);
  assert.equal(a.status, 200, a.text.slice(0, 200));
  const req = /consent\?req=([a-f0-9]+)/.exec(a.text)[1];
  const page = await call("GET", `/oauth/consent?req=${req}`, { sid });
  assert.equal(page.status, 200);
  const token = /const R="[a-f0-9]+",T="([^"]+)"/.exec(page.text)[1];
  const d = await call("POST", "/api/oauth/consent", { sid, body: { req, token, allow } });
  assert.equal(d.status, 200, d.text);
  const u = new URL(d.json.redirect);
  return { url: u, code: u.searchParams.get("code"), req, token };
}
const tokenCall = (form, headers) => call("POST", "/oauth/token", { form, headers });

before(async () => {
  Object.assign(process.env, env);
  const s = await import(path.join(ROOT, "lib/store.mjs"));
  const a = await s.createUser({ username: "admin1", displayName: "Admin One", password: "pw-admin-12345", role: "admin" });
  const b = await s.createUser({ username: "user1", displayName: "User One", password: "pw-user-12345", role: "user" });
  admin = s.createSession(a.id, "t", "1.2.3.4"); user = s.createSession(b.id, "t", "1.2.3.4"); userId = b.id; s.flush();
  server = spawn("node", ["server.mjs"], { cwd: ROOT, env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/api/boot")).ok) return; } catch { /* starting */ } await sleep(200); }
  throw new Error("the server did not start");
});
after(() => { server?.kill("SIGTERM"); fs.rmSync(tmp, { recursive: true, force: true }); });

let app, appSecret, publicApp;

test("the settings are published", async () => {
  const r = await call("GET", "/.well-known/oauth-authorization-server");
  assert.equal(r.status, 200);
  assert.equal(r.json.token_endpoint, `${BASE}/oauth/token`);
  assert.deepEqual(r.json.code_challenge_methods_supported, ["S256"]);
});

test("only admins register apps, and bad redirect addresses are refused", async () => {
  assert.equal((await call("POST", "/api/oauth/apps", { sid: user, body: { name: "x", redirectUris: [REDIRECT] } })).status, 403);
  assert.equal((await call("POST", "/api/oauth/apps", { sid: admin, body: { name: "x", redirectUris: ["javascript:alert(1)", "http://evil.example.com/cb", "https://u:p@x.example.com/cb", "https://x.example.com/cb#frag"] } })).status, 400);
  const r = await call("POST", "/api/oauth/apps", { sid: admin, body: { name: "Now Playing Widget", redirectUris: [REDIRECT, "http://localhost:9000/cb", "myapp://callback"], confidential: true } });
  assert.equal(r.status, 200, r.text);
  app = r.json.app; appSecret = r.json.secret;
  assert.match(app.id, /^uc_/); assert.match(appSecret, /^us_/);
  assert.ok(!JSON.stringify((await call("GET", "/api/oauth/apps", { sid: admin })).json).includes(appSecret), "the secret is never shown again");
  const p = await call("POST", "/api/oauth/apps", { sid: admin, body: { name: "Profile Only", redirectUris: [REDIRECT], confidential: false } });
  publicApp = p.json.app; assert.equal(p.json.secret, null);
});

test("the authorize request is checked before anything is shown", async () => {
  const { challenge } = pkce();
  const base = { response_type: "code", client_id: app.id, redirect_uri: REDIRECT, state: "s1", code_challenge: challenge, code_challenge_method: "S256", scope: "user-read-profile" };
  const get = (o) => call("GET", `/oauth/authorize?${new URLSearchParams({ ...base, ...o })}`);
  assert.equal((await get({ client_id: "uc_nope" })).status, 400); // never redirected: the address cannot be trusted
  const evil = await get({ redirect_uri: "https://evil.example.com/cb" });
  assert.equal(evil.status, 400); assert.ok(!evil.headers.get("location"));
  const noPkce = await get({ code_challenge: "", code_challenge_method: "" });
  assert.equal(noPkce.status, 302); assert.match(noPkce.headers.get("location"), /error=invalid_request.*state=s1/);
  assert.match((await get({ code_challenge_method: "plain" })).headers.get("location"), /error=invalid_request/);
  assert.match((await get({ scope: "user-read-profile admin-everything" })).headers.get("location"), /error=invalid_scope/);
  assert.match((await get({ response_type: "token" })).headers.get("location"), /error=unsupported_response_type/);
  assert.equal((await get({})).status, 200);
});

test("the consent page needs a sign-in, and only that browser session can answer it", async () => {
  const { challenge } = pkce();
  const q = new URLSearchParams({ response_type: "code", client_id: app.id, redirect_uri: REDIRECT, state: "s", code_challenge: challenge, code_challenge_method: "S256", scope: "user-read-profile user-read-currently-playing" });
  const req = /consent\?req=([a-f0-9]+)/.exec((await call("GET", `/oauth/authorize?${q}`)).text)[1];
  const anon = await call("GET", `/oauth/consent?req=${req}`);
  assert.match(anon.text, /Sign in to connect Now Playing Widget/);
  const page = await call("GET", `/oauth/consent?req=${req}`, { sid: user });
  assert.match(page.text, /Now Playing Widget wants to connect/); assert.match(page.text, /User One/); assert.match(page.text, /the song you are playing right now/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  const token = /T="([^"]+)"/.exec(page.text)[1];
  assert.equal((await call("POST", "/api/oauth/consent", { sid: user, body: { req, token: "wrong", allow: true } })).status, 403);
  assert.equal((await call("POST", "/api/oauth/consent", { sid: admin, body: { req, token, allow: true } })).status, 403, "another session cannot use someone else's page");
  assert.equal((await call("POST", "/api/oauth/consent", { body: { req, token, allow: true } })).status, 403);
  const ok = await call("POST", "/api/oauth/consent", { sid: user, body: { req, token, allow: false } });
  assert.match(ok.json.redirect, /error=access_denied.*state=s/); // saying no is answered once
  assert.equal((await call("POST", "/api/oauth/consent", { sid: user, body: { req, token, allow: true } })).status, 410);
});

test("the whole flow: code, tokens, what the person is playing, refresh, revoke", async () => {
  const { verifier, challenge } = pkce();
  const a = await authorize(user, { client: app.id, scope: "user-read-profile user-read-currently-playing", challenge });
  assert.equal(a.url.origin + a.url.pathname, REDIRECT); assert.equal(a.url.searchParams.get("state"), "xyz");
  const form = { grant_type: "authorization_code", code: a.code, redirect_uri: REDIRECT, client_id: app.id, code_verifier: verifier };
  assert.equal((await tokenCall({ ...form, client_secret: appSecret, code_verifier: pkce().verifier })).json.error, "invalid_grant"); // wrong verifier (and that spent the code)
  const b = await authorize(user, { client: app.id, scope: "user-read-profile user-read-currently-playing", challenge });
  const noSecret = await tokenCall({ ...form, code: b.code }); assert.equal(noSecret.status, 401); assert.equal(noSecret.json.error, "invalid_client");
  const c = await authorize(user, { client: app.id, scope: "user-read-profile user-read-currently-playing", challenge });
  assert.equal((await tokenCall({ ...form, code: c.code, redirect_uri: "https://app.example.com/other", client_secret: appSecret })).json.error, "invalid_grant");
  const d = await authorize(user, { client: app.id, scope: "user-read-profile user-read-currently-playing", challenge });
  const basic = "Basic " + Buffer.from(`${app.id}:${appSecret}`).toString("base64");
  const t = await tokenCall({ ...form, code: d.code, client_id: undefined }, { authorization: basic });
  assert.equal(t.status, 200, t.text);
  assert.match(t.json.access_token, /^uo_a_/); assert.match(t.json.refresh_token, /^uo_r_/); assert.equal(t.json.token_type, "Bearer"); assert.equal(t.json.expires_in, 3600);
  assert.equal((await tokenCall({ ...form, code: d.code, client_secret: appSecret })).json.error, "invalid_grant", "a code works once");

  const get = (p, tok = t.json.access_token) => call("GET", p, { headers: { authorization: `Bearer ${tok}` } });
  assert.deepEqual((await get("/v1/me")).json, { id: userId, display_name: "User One" });
  assert.deepEqual((await get("/v1/me/player/currently-playing")).json, { is_playing: false, progress_ms: 0, item: null });
  assert.equal((await call("POST", "/api/rpc/now", { sid: user, body: { title: "Test Song", artist: "Test Artist", album: "Test Album", durationMs: 200000, positionMs: 5000, playing: true, tidalId: "123", coverUrl: "https://resources.tidal.com/x.jpg" } })).status, 200);
  const np = (await get("/v1/me/player/currently-playing")).json;
  assert.equal(np.is_playing, true); assert.equal(np.item.name, "Test Song"); assert.deepEqual(np.item.artists, [{ name: "Test Artist" }]);
  assert.equal(np.item.id, "123"); assert.equal(np.item.duration_ms, 200000); assert.ok(np.progress_ms >= 5000 && np.progress_ms < 8000);
  assert.equal((await get("/v1/tracks/1")).status, 403, "a person's token reads nothing else");
  assert.equal((await get("/v1/me", "uo_a_" + "x".repeat(40))).status, 401);

  const r1 = await tokenCall({ grant_type: "refresh_token", refresh_token: t.json.refresh_token, client_id: app.id, client_secret: appSecret });
  assert.equal(r1.status, 200); assert.notEqual(r1.json.access_token, t.json.access_token);
  assert.equal((await get("/v1/me")).status, 401, "the old access token stops working");
  assert.equal((await tokenCall({ grant_type: "refresh_token", refresh_token: t.json.refresh_token, client_id: app.id, client_secret: appSecret })).json.error, "invalid_grant", "a refresh token is used once");
  assert.equal((await get("/v1/me", r1.json.access_token)).status, 200);
  assert.equal((await tokenCall({ grant_type: "refresh_token", refresh_token: r1.json.refresh_token, client_id: publicApp.id })).json.error, "invalid_grant", "another app cannot use it");

  assert.equal((await call("GET", "/api/oauth/grants", { sid: user })).json.grants.length, 1);
  assert.equal((await call("GET", "/api/oauth/grants", { sid: admin })).json.grants.length, 0, "approvals are private to the person");
  const gid = (await call("GET", "/api/oauth/grants", { sid: user })).json.grants[0].id;
  assert.equal((await call("DELETE", `/api/oauth/grants/${gid}`, { sid: admin })).status, 404);
  assert.equal((await call("DELETE", `/api/oauth/grants/${gid}`, { sid: user })).status, 200);
  assert.equal((await get("/v1/me", r1.json.access_token)).status, 401, "removing the approval ends the token");
});

test("scopes limit what an app can read, and revoke works", async () => {
  const { verifier, challenge } = pkce();
  const a = await authorize(user, { client: publicApp.id, scope: "user-read-profile", challenge });
  const t = await tokenCall({ grant_type: "authorization_code", code: a.code, redirect_uri: REDIRECT, client_id: publicApp.id, code_verifier: verifier });
  assert.equal(t.status, 200, t.text); assert.equal(t.json.scope, "user-read-profile");
  const get = (p) => call("GET", p, { headers: { authorization: `Bearer ${t.json.access_token}` } });
  assert.equal((await get("/v1/me")).status, 200);
  assert.equal((await get("/v1/me/player/currently-playing")).status, 403);
  assert.equal((await call("POST", "/oauth/revoke", { form: { token: t.json.refresh_token, client_id: publicApp.id } })).status, 200);
  assert.equal((await get("/v1/me")).status, 401);
});

test("a loopback app may use any port, nobody else may", async () => {
  const { verifier, challenge } = pkce();
  const a = await authorize(user, { client: app.id, scope: "user-read-profile", challenge, redirect: "http://localhost:54321/cb" });
  assert.equal(a.url.host, "localhost:54321");
  const bad = await call("GET", `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: app.id, redirect_uri: "http://localhost:54321/other", code_challenge: challenge, code_challenge_method: "S256" })}`);
  assert.equal(bad.status, 400);
  void verifier;
});

test("audio: only for apps an admin allowed, shown in red, and only for people who may use the player", async () => {
  const mk = async (name, audio) => (await call("POST", "/api/oauth/apps", { sid: admin, body: { name, redirectUris: [REDIRECT], confidential: false, audio } })).json.app;
  const plain = await mk("Plain App", false), loud = await mk("Audio App", true);
  assert.equal(plain.audio, false); assert.equal(loud.audio, true);
  const { verifier, challenge } = pkce();
  const ask = (client, scope) => call("GET", `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: REDIRECT, scope, state: "a", code_challenge: challenge, code_challenge_method: "S256" })}`);
  const refused = await ask(plain.id, "user-read-profile user-stream-audio");
  assert.equal(refused.status, 302); assert.match(refused.headers.get("location"), /error=invalid_scope/);
  const req = /consent\?req=([a-f0-9]+)/.exec((await ask(loud.id, "user-read-profile user-stream-audio")).text)[1];
  const page = await call("GET", `/oauth/consent?req=${req}`, { sid: user });
  assert.match(page.text, /class="warn"/); assert.match(page.text, /asking for AUDIO/); assert.match(page.text, /<li class="red">Play music from this server/);
  const calm = /consent\?req=([a-f0-9]+)/.exec((await ask(plain.id, "user-read-profile")).text)[1];
  assert.doesNotMatch((await call("GET", `/oauth/consent?req=${calm}`, { sid: user })).text, /class="warn"/, "no warning when audio isn't asked for");

  // a person who may not use the player cannot hand out audio
  const off = await call("PATCH", "/api/settings", { sid: admin, body: { membersUsePlayer: false } }); assert.equal(off.status, 200, off.text);
  const token = /T="([^"]+)"/.exec(page.text)[1];
  assert.equal((await call("POST", "/api/oauth/consent", { sid: user, body: { req, token, allow: true } })).status, 403);
  await call("PATCH", "/api/settings", { sid: admin, body: { membersUsePlayer: true } });
  const ok = await call("POST", "/api/oauth/consent", { sid: user, body: { req, token, allow: true } });
  assert.equal(ok.status, 200, "the request was kept, so allowing works once they may");
  const t = await tokenCall({ grant_type: "authorization_code", code: new URL(ok.json.redirect).searchParams.get("code"), redirect_uri: REDIRECT, client_id: loud.id, code_verifier: verifier });
  assert.equal(t.status, 200, t.text); assert.match(t.json.scope, /user-stream-audio/);
  const get = (p) => call("GET", p, { headers: { authorization: `Bearer ${t.json.access_token}` } });
  const reach = async (p) => { const r = await get(p); assert.ok(![401, 403, 429].includes(r.status), `${p} -> ${r.status} ${r.text.slice(0, 120)}`); };
  await reach("/v1/tracks/123/stream?quality=LOSSLESS"); // (no TIDAL behind this test server, so it may fail, but it must get past the permission checks)
  await reach("/v1/search?q=hello");
  assert.equal((await get("/v1/tracks/123/lyrics")).status === 200, false, "lyrics are not part of audio");
  assert.equal((await get("/v1/bot/token")).status, 403);
  assert.equal((await get("/v1/me")).status, 200, "the profile scope it also asked for still works");

  // the same person turned off later: the token stops reaching audio
  await call("PATCH", "/api/settings", { sid: admin, body: { membersUsePlayer: false } });
  assert.equal((await get("/v1/tracks/123/stream")).status, 403);
  assert.equal((await get("/v1/search?q=hello")).status, 403);
  await call("PATCH", "/api/settings", { sid: admin, body: { membersUsePlayer: true } });

  // a token with no audio scope still can't
  const b = await authorize(user, { client: plain.id, scope: "user-read-profile", challenge });
  const t2 = await tokenCall({ grant_type: "authorization_code", code: b.code, redirect_uri: REDIRECT, client_id: plain.id, code_verifier: verifier });
  assert.equal((await call("GET", "/v1/tracks/123/stream", { headers: { authorization: `Bearer ${t2.json.access_token}` } })).status, 403);
  assert.equal((await call("PATCH", `/api/oauth/apps/${loud.id}`, { sid: admin, body: { audio: false } })).json.app.audio, false);
});

test("deleting an app disconnects everyone who approved it", async () => {
  const { verifier, challenge } = pkce();
  const a = await authorize(user, { client: app.id, scope: "user-read-profile", challenge });
  const t = await tokenCall({ grant_type: "authorization_code", code: a.code, redirect_uri: REDIRECT, client_id: app.id, client_secret: appSecret, code_verifier: verifier });
  assert.equal(t.status, 200);
  assert.equal((await call("DELETE", `/api/oauth/apps/${app.id}`, { sid: admin })).status, 200);
  assert.equal((await call("GET", "/v1/me", { headers: { authorization: `Bearer ${t.json.access_token}` } })).status, 401);
});

test("the developers page is served", async () => {
  const r = await call("GET", "/developers");
  assert.equal(r.status, 200); assert.match(r.text, /Connected apps/);
  assert.equal((await call("GET", "/developers.js")).status, 200);
  const md = await call("GET", "/developers/AGENTS.md");
  assert.equal(md.status, 200); assert.match(md.headers.get("content-type"), /text\/markdown/);
  assert.ok(md.text.includes(`${BASE}/oauth/authorize`) && !md.text.includes("{{ORIGIN}}"), "this server's own address is filled in");
});
