// Encrypted chats between friends, and sending songs in them. Loaded the first time a chat is opened.
// Everything is locked and unlocked in this browser (see chat-crypto.js); the server only ever sees ciphertext.
import * as C from "/chat-crypto.js";

let ctx, root;
const S = { ident: null, friend: null, aes: null, theirPub: null, safety: "", msgs: [], seen: new Set(), after: "", theirRead: "", timer: null, state: "", pending: null, lastReadSent: "", plain: new Map() };
const $ = (s, r = root) => r.querySelector(s);
const esc = (x) => ctx.esc(x);
const same = (a, b) => a && b && a.x === b.x && a.y === b.y;
const t12 = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (t) => { const d = new Date(t), n = new Date(); return d.toDateString() === n.toDateString() ? "Today" : d.toDateString() === new Date(n - 864e5).toDateString() ? "Yesterday" : d.toLocaleDateString([], { month: "short", day: "numeric" }); };

// ---- this browser's keys (IndexedDB; if it can't be used, they last only until the page is closed) ----
const mem = new Map();
const idb = () => new Promise((ok, no) => { const r = indexedDB.open("undertow-chat", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const kv = {
  async get(k) { try { const d = await idb(); return await new Promise((ok, no) => { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error); }); } catch { return mem.get(k); } },
  async set(k, v) { mem.set(k, v); try { const d = await idb(); await new Promise((ok, no) => { const tx = d.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = ok; tx.onerror = () => no(tx.error); }); } catch { /* memory only */ } },
};
async function loadIdentity() { const s = await kv.get(`identity:${ctx.myId}`); return s ? { pair: await C.importPair(s.priv), pub: s.pub, priv: s.priv } : null; }
async function newIdentity(passphrase) {
  const pair = await C.newIdentity(), priv = await C.privateJwk(pair), pub = await C.publicJwk(pair);
  await ctx.api("PUT", "/chat/key", { pub, ...(passphrase ? { backup: await C.wrapPrivate(priv, passphrase) } : {}) });
  await kv.set(`identity:${ctx.myId}`, { priv, pub });
  S.ident = { pair, pub, priv };
}

// ---- the panel ----
function build() {
  if (root) return;
  root = document.createElement("div");
  root.className = "chat";
  root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "Chat"); root.setAttribute("inert", "");
  root.innerHTML = `<header class="cm-top"><button class="cm-ib" data-c="back" aria-label="Back">${ctx.icon("back")}</button><span class="cm-av"></span><div class="cm-who"><b></b><span>${ctx.icon("accounts")}<i>End-to-end encrypted</i></span></div><button class="cm-ib" data-c="safety" aria-label="Safety number and key backup">${ctx.icon("accounts")}</button></header>
    <div class="cm-body"></div>
    <form class="cm-compose" hidden><button type="button" class="cm-ib cm-song-btn" data-c="song" aria-label="Send a song">${ctx.icon("note")}</button><textarea rows="1" maxlength="2000" placeholder="Message" enterkeyhint="send" aria-label="Message"></textarea><button class="cm-send" aria-label="Send" disabled>${ctx.icon("up")}</button></form>
    <div class="cm-sheetbg" hidden><div class="cm-sheet glass chrome" role="dialog"></div></div>`;
  document.body.append(root);
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-c]");
    if (b) return ({ back: closeChat, safety: showSafety, song: pickSong, sheetx: closeSheet, play: () => playSong(b), save: () => saveSong(b), del: () => delMsg(b.dataset.id), toggle: () => b.closest(".cm-m")?.classList.toggle("sel"), unlock: unlock, start: setup, startover: startOver, trust: trust, send: () => sendSongRow(b) })[b.dataset.c]?.();
    if (e.target.classList.contains("cm-sheetbg")) closeSheet();
    const m = e.target.closest(".cm-b"); if (m && !e.target.closest("button")) m.closest(".cm-m")?.classList.toggle("sel");
  });
  const ta = $("textarea"), form = $(".cm-compose");
  const fit = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 130)}px`; $(".cm-send").disabled = !ta.value.trim(); };
  ta.addEventListener("input", fit);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = ta.value.trim(); if (!text) return;
    ta.value = ""; fit();
    if (!(await send({ type: "text", text }))) { ta.value = text; fit(); }
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && root.classList.contains("open")) { if (!$(".cm-sheetbg").hidden) closeSheet(); else closeChat(); } });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && S.state === "ready") poll(); });
}
const body = (html) => { $(".cm-body").innerHTML = html; };
const screen = (state, html) => { S.state = state; $(".cm-compose").hidden = state !== "ready"; body(html); };

export function init(c) { ctx = c; }
export async function openChat(c, friend) {
  ctx = c; build();
  root.dataset.mode = ""; S.friend = friend; S.aes = null; S.msgs = []; S.seen = new Set(); S.after = ""; S.theirRead = ""; S.plain = new Map(); S.lastReadSent = "";
  $(".cm-av").innerHTML = ctx.avatar(friend, 40); $(".cm-who b").textContent = friend.displayName;
  root.removeAttribute("inert"); requestAnimationFrame(() => root.classList.add("open"));
  document.documentElement.classList.add("chat-open");
  await enter();
}
export function closeChat() {
  clearInterval(S.timer); S.timer = null; S.state = "";
  root?.classList.remove("open"); root?.setAttribute("inert", ""); closeSheet();
  document.documentElement.classList.remove("chat-open");
  ctx?.refreshBadge?.();
}

async function enter() {
  screen("loading", `<div class="cm-note">Opening…</div>`);
  try {
    const [{ key }, ident] = await Promise.all([ctx.api("GET", "/chat/me"), loadIdentity().catch(() => null)]);
    S.myKey = key;
    if (ident && key && same(key.pub, ident.pub)) { S.ident = ident; return await thread(); }
    if (ident && !key) { await ctx.api("PUT", "/chat/key", { pub: ident.pub }); S.ident = ident; S.myKey = (await ctx.api("GET", "/chat/me")).key; return await thread(); } // the server forgot it: tell it again
    if (!key) return screen("setup", setupHtml());
    if (key.backup) return screen("restore", restoreHtml());
    return screen("reset", resetHtml());
  } catch (e) { screen("error", `<div class="cm-note">${esc(e.message)}</div>`); }
}
const lockBadge = `<div class="cm-hero">${"<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='M7 11V8a5 5 0 0 1 10 0v3M6 11h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z'/></svg>"}</div>`;
const setupHtml = () => `<div class="cm-card">${lockBadge}<h2>Private chats</h2><p>Messages are locked on your device before they're sent, so nobody but you and ${esc(S.friend.displayName)} can read them. Not the server, and not its owner.</p>
  <label class="field"><span>Back up your key (optional)</span><input class="input" id="cm-pass" type="password" autocomplete="new-password" placeholder="A passphrase, 8+ characters"><span class="hint" style="padding:0">It lets you read your chats on another phone or computer. If you lose this device and forget it, old messages can't be recovered.</span></label>
  <div class="err" id="cm-err" role="alert"></div><button class="btn primary" data-c="start">Turn on private chats</button></div>`;
const restoreHtml = () => `<div class="cm-card">${lockBadge}<h2>Unlock your chats</h2><p>Your chats are set up on another device. Enter your backup passphrase to read them here.</p>
  <label class="field"><span>Passphrase</span><input class="input" id="cm-pass" type="password" autocomplete="current-password"></label>
  <div class="err" id="cm-err" role="alert"></div><button class="btn primary" data-c="unlock">Unlock</button><button class="btn" data-c="startover">Forgot it? Start over</button></div>`;
const resetHtml = () => `<div class="cm-card">${lockBadge}<h2>Chats are set up elsewhere</h2><p>Your chats were turned on from another device, without a backup, so this one can't read them. You can start over here with a new key. Older messages won't be readable.</p>
  <div class="err" id="cm-err" role="alert"></div><button class="btn danger" data-c="startover">Start over with a new key</button></div>`;
const fail = (m) => { const e = $("#cm-err"); if (e) e.textContent = m; };
async function setup() {
  const p = $("#cm-pass")?.value || "";
  if (p && p.length < 8) return fail("The passphrase needs at least 8 characters.");
  const b = $('[data-c="start"]'); b.disabled = true;
  try { await newIdentity(p); S.myKey = (await ctx.api("GET", "/chat/me")).key; await thread(); } catch (e) { fail(e.message); b.disabled = false; }
}
async function unlock() {
  const p = $("#cm-pass")?.value || ""; if (!p) return fail("Enter your passphrase.");
  const b = $('[data-c="unlock"]'); b.disabled = true;
  try {
    const priv = await C.unwrapPrivate(S.myKey.backup, p);
    const pair = await C.importPair(priv), pub = await C.publicJwk(pair);
    if (!same(pub, S.myKey.pub)) throw new Error("mismatch");
    await kv.set(`identity:${ctx.myId}`, { priv, pub }); S.ident = { pair, pub, priv };
    await thread();
  } catch { fail("That passphrase didn't work."); b.disabled = false; }
}
async function startOver() {
  if (!confirm("Start over with a new key? Messages sent to you before now won't be readable.")) return;
  try { await newIdentity(""); S.myKey = (await ctx.api("GET", "/chat/me")).key; await thread(); } catch (e) { fail(e.message); }
}

// ---- a conversation ----
async function thread() {
  let theirs;
  try { theirs = await ctx.api("GET", `/chat/key/${S.friend.id}`); }
  catch { if (S.pending) { S.pending = null; ctx.toast(`${S.friend.displayName} hasn't turned on private chats yet`, true); } return screen("waiting", `<div class="cm-card">${lockBadge}<h2>Waiting for ${esc(S.friend.displayName)}</h2><p>${esc(S.friend.displayName)} hasn't turned on private chats yet. As soon as they do, you can message each other here.</p></div>`); }
  // the first key seen from a friend is remembered; if it ever changes, nothing is sent or read until you've looked at it
  const fp = await C.fingerprint(theirs.pub), pinKey = `pin:${ctx.myId}:${S.friend.id}`, pinned = await kv.get(pinKey);
  S.theirPub = theirs.pub; S.safety = await C.safetyNumber(S.ident.pub, theirs.pub);
  if (pinned && pinned !== fp) { S.newFp = fp; return screen("changed", `<div class="cm-card warn">${lockBadge}<h2>${esc(S.friend.displayName)}'s key changed</h2><p>This can happen when they get a new phone or start over. It can also mean someone is in the way. Compare the safety number with ${esc(S.friend.displayName)} in person or on a call before you carry on.</p><div class="cm-sn">${esc(S.safety)}</div><button class="btn primary" data-c="trust">It matches: continue</button></div>`); }
  if (!pinned) await kv.set(pinKey, fp);
  await ready();
}
async function trust() { await kv.set(`pin:${ctx.myId}:${S.friend.id}`, S.newFp); await ready(); }
async function ready() {
  S.aes = await C.sharedKey(S.ident.pair.privateKey, S.ident.pub, S.theirPub);
  screen("ready", `<div class="cm-list" aria-live="polite"></div>`);
  await poll(true);
  clearInterval(S.timer); S.timer = setInterval(() => { if (!document.hidden && S.state === "ready") poll(); }, 2500);
  if (S.pending) { const t = S.pending; S.pending = null; await send({ type: "song", track: t }); }
  else if (!matchMedia("(pointer: coarse)").matches) $("textarea").focus({ preventScroll: true });
}
async function poll(first = false) {
  if (S.polling) return; S.polling = true;
  try {
    const r = await ctx.api("GET", `/chat/with/${S.friend.id}${S.after ? `?after=${S.after}` : ""}`);
    S.theirRead = r.theirRead || "";
    const fresh = [];
    for (const m of r.messages) { if (S.seen.has(m.id)) continue; S.seen.add(m.id); fresh.push(await decode(m)); }
    if (fresh.length) { S.after = r.messages[r.messages.length - 1].id; S.msgs.push(...fresh); }
    if (first) draw(); else if (fresh.length) add(fresh); status();
    const last = [...S.msgs].reverse().find((m) => !m.mine);
    if (last && last.id > S.lastReadSent && !document.hidden) { S.lastReadSent = last.id; ctx.api("POST", `/chat/with/${S.friend.id}/read`, { id: last.id }).catch(() => {}); }
  } catch (e) { if (first) $(".cm-list").innerHTML = `<div class="cm-note">${esc(e.message)}</div>`; }
  finally { S.polling = false; }
}
async function decode(m) {
  const mine = m.from === ctx.myId;
  try { return { id: m.id, t: m.t, mine, body: await C.open(S.aes, m.from, mine ? S.friend.id : ctx.myId, m) }; }
  catch { return { id: m.id, t: m.t, mine, bad: true }; }
}
async function send(b) {
  try {
    const sealed = await C.seal(S.aes, ctx.myId, S.friend.id, b), r = await ctx.api("POST", `/chat/with/${S.friend.id}`, sealed);
    S.seen.add(r.message.id); S.after = r.message.id > S.after ? r.message.id : S.after;
    const m = { id: r.message.id, t: r.message.t, mine: true, body: b }; S.msgs.push(m); add([m], true); status();
    return true;
  } catch (e) { ctx.toast(e.message, true); return false; }
}

// ---- drawing ----
function node(m) {
  const w = document.createElement("div"); w.className = `cm-m ${m.mine ? "me" : "they"}`; w.dataset.id = m.id;
  const b = document.createElement("div"); b.className = "cm-b";
  if (m.bad) { b.classList.add("bad"); b.textContent = "Can't be read on this device"; }
  else if (m.body?.type === "song" && m.body.track) {
    const t = m.body.track; b.classList.add("song");
    const art = typeof t.artworkURL === "string" && t.artworkURL.startsWith("/api/play/") ? `<img src="${esc(t.artworkURL)}" alt="" draggable="false" loading="lazy">` : "";
    b.innerHTML = `<span class="cm-th">${art}</span><span class="cm-st"><b>${esc(t.title)}</b><span>${esc(t.artist || "")}</span></span><span class="cm-sb"><button type="button" class="cm-pl" data-c="play" aria-label="Play">${ctx.icon("play")}</button><button type="button" class="cm-pl alt" data-c="save" aria-label="Add to favorites">${ctx.icon("heart")}</button></span>`;
    S.plain.set(m.id, t);
    b.dataset.sid = m.id;
  } else b.textContent = String(m.body?.text ?? "");
  w.append(b);
  const tools = document.createElement("div"); tools.className = "cm-tools";
  tools.innerHTML = `<span>${t12(m.t)}</span>${m.mine ? `<button type="button" data-c="del" data-id="${esc(m.id)}">Delete</button>` : ""}`;
  w.append(tools);
  return w;
}
function stamp(list, m, prev) { // a time label when there's been a pause
  if (prev && m.t - prev.t < 10 * 60000 && new Date(m.t).toDateString() === new Date(prev.t).toDateString()) return;
  const s = document.createElement("div"); s.className = "cm-day"; s.textContent = `${day(m.t)} ${t12(m.t)}`; list.append(s);
}
function draw() {
  const list = $(".cm-list"); list.innerHTML = "";
  if (!S.msgs.length) { list.innerHTML = `<div class="cm-empty">${ctx.icon("accounts")}<b>Say hi to ${esc(S.friend.displayName)}</b><span>Messages and songs here are end-to-end encrypted.</span></div>`; return; }
  let lost = 0; // a run of messages that can't be opened (an old key) shows as one notice, not a pile of grey bubbles
  const flush = () => { if (!lost) return; const n = document.createElement("div"); n.className = "cm-lost"; n.textContent = `${lost} earlier message${lost === 1 ? "" : "s"} can't be read on this device`; list.append(n); lost = 0; };
  S.msgs.forEach((m, i) => { if (m.bad) { lost++; return; } flush(); stamp(list, m, S.msgs[i - 1]); list.append(node(m)); });
  flush();
  list.scrollTop = list.scrollHeight;
}
function add(fresh, mine = false) {
  const list = $(".cm-list"), near = list.scrollHeight - list.scrollTop - list.clientHeight < 140;
  list.querySelector(".cm-empty")?.remove();
  for (const m of fresh) { const prev = S.msgs[S.msgs.indexOf(m) - 1]; stamp(list, m, prev); const n = node(m); n.classList.add("in"); list.append(n); }
  if (near || mine) list.scrollTo({ top: list.scrollHeight, behavior: ctx.reduce ? "auto" : "smooth" });
}
function status() { // "Read" under the last message of mine that they've seen
  for (const e of root.querySelectorAll(".cm-rd")) e.remove();
  const mineMsgs = S.msgs.filter((m) => m.mine); const last = mineMsgs[mineMsgs.length - 1]; if (!last) return;
  const el = root.querySelector(`.cm-m[data-id="${CSS.escape(last.id)}"]`); if (!el) return;
  const s = document.createElement("div"); s.className = "cm-rd"; s.textContent = S.theirRead && S.theirRead >= last.id ? "Read" : "Sent"; el.after(s);
}
async function delMsg(id) {
  try { await ctx.api("DELETE", `/chat/with/${S.friend.id}/${id}`); S.msgs = S.msgs.filter((m) => m.id !== id); draw(); status(); } catch (e) { ctx.toast(e.message, true); }
}

// ---- songs ----
const pickTrack = (t) => ({ id: String(t.id), title: String(t.title || "").slice(0, 200), artist: String(t.artist || "").slice(0, 200), album: String(t.album || "").slice(0, 200), duration: Number(t.duration) || 0, ...(typeof t.artworkURL === "string" && t.artworkURL.startsWith("/api/play/") ? { artworkURL: t.artworkURL } : {}) });
const trackOf = (b) => S.plain.get(b.closest(".cm-b")?.dataset.sid);
function playSong(b) { const t = trackOf(b); if (t) { ctx.playTrack?.(t); ctx.toast(`Playing ${t.title}`); } }
async function saveSong(b) {
  const t = trackOf(b); if (!t) return;
  try { await ctx.api("POST", "/play/library", { action: "fav", track: t }); ctx.toast("Added to your favorites"); } catch (e) { ctx.toast(e.message, true); }
}
function sheet(html) { const bg = $(".cm-sheetbg"); $(".cm-sheet").innerHTML = html; bg.hidden = false; requestAnimationFrame(() => bg.classList.add("on")); }
function closeSheet() { const bg = $(".cm-sheetbg"); if (!bg || bg.hidden) return; bg.classList.remove("on"); setTimeout(() => { bg.hidden = true; }, 220); }
function pickSong() {
  const now = ctx.nowPlaying?.();
  sheet(`<div class="cm-sh"><b>Send a song</b><button class="cm-ib" data-c="sheetx" aria-label="Close">${ctx.icon("close")}</button></div>
    ${now ? `<button class="cm-row" data-c="send" data-i="now"><span class="cm-th">${now.artworkURL ? `<img src="${esc(now.artworkURL)}" alt="">` : ""}</span><span class="cm-st"><b>${esc(now.title)}</b><span>Now playing · ${esc(now.artist || "")}</span></span></button>` : ""}
    <input class="input" id="cm-q" type="search" placeholder="Search for a song" enterkeyhint="search" autocomplete="off" autocapitalize="none" spellcheck="false"><div class="cm-res" id="cm-res"></div>`);
  S.results = now ? [now] : [];
  const q = $("#cm-q"); let timer;
  q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 350); });
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(timer); search(); q.blur(); } });
}
async function search() {
  const v = $("#cm-q").value.trim(), out = $("#cm-res"); if (!v) { out.innerHTML = ""; return; }
  out.innerHTML = `<div class="cm-note">Searching…</div>`;
  try {
    const r = await ctx.api("GET", `/play/search?q=${encodeURIComponent(v)}`);
    const now = ctx.nowPlaying?.(); S.results = now ? [now, ...r.tracks] : r.tracks; // "now playing" keeps its place at the top
    out.innerHTML = r.tracks.length ? r.tracks.map((t, i) => `<button class="cm-row" data-c="send" data-i="${i + (now ? 1 : 0)}"><span class="cm-th">${t.artworkURL ? `<img src="${esc(t.artworkURL)}" alt="" loading="lazy">` : ""}</span><span class="cm-st"><b>${esc(t.title)}</b><span>${esc(t.artist || "")}</span></span></button>`).join("") : `<div class="cm-note">Nothing found.</div>`;
  } catch (e) { out.innerHTML = `<div class="cm-note">${esc(e.message)}</div>`; }
}
async function sendSongRow(b) {
  const t = b.dataset.i === "now" ? ctx.nowPlaying?.() : S.results[Number(b.dataset.i)]; if (!t) return;
  closeSheet(); if (await send({ type: "song", track: pickTrack(t) })) ctx.toast(`Sent ${t.title}`);
}

// ---- the safety number, and a key backup ----
function showSafety() {
  if (S.state !== "ready" && S.state !== "changed") return;
  const groups = S.safety.split(" "), rows = [0, 4, 8].map((i) => groups.slice(i, i + 4).join("  "));
  sheet(`<div class="cm-sh"><b>Safety number</b><button class="cm-ib" data-c="sheetx" aria-label="Close">${ctx.icon("close")}</button></div>
    <p class="cm-p">If this number is the same on ${esc(S.friend.displayName)}'s screen, nobody has got in between you. Compare it in person or on a call.</p>
    <div class="cm-sn">${rows.map(esc).join("<br>")}</div>
    <div class="cm-sh2">${S.myKey?.backup ? "Your key has a passphrase backup, so you can read your chats on another device." : "Your key is only on this device. Add a passphrase backup to read your chats elsewhere."}</div>
    <label class="field"><span>${S.myKey?.backup ? "Change the backup passphrase" : "Back up your key"}</span><input class="input" id="cm-bp" type="password" autocomplete="new-password" placeholder="8+ characters"></label>
    <div class="err" id="cm-berr" role="alert"></div><button class="btn" id="cm-bsave">${S.myKey?.backup ? "Change passphrase" : "Save backup"}</button>`);
  $("#cm-bsave").addEventListener("click", async () => {
    const p = $("#cm-bp").value; if (p.length < 8) { $("#cm-berr").textContent = "At least 8 characters."; return; }
    try { await ctx.api("PUT", "/chat/key", { pub: S.ident.pub, backup: await C.wrapPrivate(S.ident.priv, p) }); S.myKey = (await ctx.api("GET", "/chat/me")).key; closeSheet(); ctx.toast("Backup saved"); } catch (e) { $("#cm-berr").textContent = e.message; }
  });
}

// ---- sending a song from the player: pick a friend, it goes ----
export async function share(c, track) {
  ctx = c; build();
  let friends = [];
  try { friends = (await ctx.api("GET", "/friends")).friends; } catch (e) { return ctx.toast(e.message, true); }
  if (!friends.length) return ctx.toast("Add a friend first, then you can send them songs", true);
  const t = pickTrack(track);
  root.removeAttribute("inert"); requestAnimationFrame(() => root.classList.add("open")); document.documentElement.classList.add("chat-open");
  root.dataset.mode = "pick"; S.state = "pick"; $(".cm-compose").hidden = true; $(".cm-av").innerHTML = ""; $(".cm-who b").textContent = "Send a song";
  body(`<div class="cm-pick"><div class="cm-row static"><span class="cm-th">${t.artworkURL ? `<img src="${esc(t.artworkURL)}" alt="">` : ""}</span><span class="cm-st"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></span></div><p class="cm-p">Send it to…</p>${friends.map((f, i) => `<button class="cm-row" data-pick="${i}">${ctx.avatar(f.user, 44)}<span class="cm-st"><b>${esc(f.user.displayName)}</b><span>@${esc(f.user.username)}</span></span></button>`).join("")}</div>`);
  $(".cm-body").onclick = async (e) => {
    const r = e.target.closest("[data-pick]"); if (!r) return;
    const f = friends[Number(r.dataset.pick)].user; $(".cm-body").onclick = null;
    S.pending = t; await openChat(ctx, f); // opens their chat, sets chats up if they aren't yet, and sends it
  };
}
