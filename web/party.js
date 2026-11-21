// Listening parties in the first player: the same rooms the second player uses (lib/partyhost.mjs), so people can mix the two.
// The host's player says what is playing and where; guests follow it. Songs travel in the second player's shape, with ours tucked inside (_u).
let env, ws, st = null, tries = 0, beat, pushT, lastPush = 0, applying = 0, left = false, sheetEl = null;
const hostKey = (id) => `party.host.${id}`, seatKey = (id) => `party.seat.${id}`;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } } };
const UUID = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i;

export const init = (e) => { env = e; };
export const active = () => !!st;
export const following = () => !!st && !st.isHost;
export const partyId = (text) => (String(text || "").match(/\/party\/([a-f0-9]{6,16})\b/i) || String(text || "").trim().match(/^([a-f0-9]{6,16})$/i) || [])[1] || "";

const toWire = (t) => ({ id: t.id, title: t.title, duration: t.duration || 0, artist: { name: t.artist || "" }, artists: String(t.artist || "").split(/,\s*/).filter(Boolean).map((name) => ({ name })),
  album: { title: t.album || "", cover: (String(t.artworkURL || "").match(UUID) || [])[1] || "" }, source: t.source || "", _u: t });
const fromWire = (w) => w?._u ? { ...w._u } : { id: String(w.id), title: w.title || "?", artist: (w.artists || []).map((a) => a.name).filter(Boolean).join(", ") || w.artist?.name || "", album: w.album?.title || "", duration: w.duration || 0,
  artworkURL: w.album?.cover && UUID.test(w.album.cover) ? `/api/play/tcover/${w.album.cover}` : undefined };

function connect(first) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/parties/ws`);
    const pending = new Map();
    ws.request = (type, payload) => new Promise((res, rej) => { const requestId = Math.random().toString(36).slice(2); pending.set(requestId, [res, rej]); ws.send(JSON.stringify({ type, requestId, payload })); setTimeout(() => { if (pending.delete(requestId)) rej(new Error("No answer")); }, 10000); });
    ws.onopen = () => { tries = 0; clearInterval(beat); beat = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: "heartbeat" })), 20000); resolve(ws); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      const p = m.requestId && pending.get(m.requestId);
      if (p) { pending.delete(m.requestId); return m.type === "error" ? p[1](new Error(m.error)) : p[0](m); }
      onMessage(m);
    };
    ws.onerror = () => { if (first) reject(new Error("Couldn't reach the party server")); };
    ws.onclose = () => {
      clearInterval(beat);
      for (const [, [, rej]] of pending) rej(new Error("Disconnected"));
      if (!st || left) return;
      if (tries++ > 6) { env.toast("Lost the party", true); end(); return; }
      setTimeout(() => rejoin(), Math.min(8000, 800 * tries));
    };
  });
}
async function rejoin() {
  if (!st || left) return;
  try { await connect(false); const m = await ws.request("join", { partyId: st.id, memberId: st.memberId, hostToken: st.isHost ? store.get(hostKey(st.id)) : undefined, profile: {} }); take(m); }
  catch (e) { if (/ended/i.test(e.message)) { env.toast("The party ended"); end(); } else if (st && !left) setTimeout(rejoin, 2500); }
}
function take(m) {
  st = { id: m.party.id, name: m.party.name, memberId: m.memberId, isHost: m.isHost, members: m.members, messages: m.messages || [], party: m.party };
  store.set(seatKey(st.id), st.memberId);
  render(); env.state();
  if (!st.isHost) follow(m.party);
}
function end() { clearInterval(beat); try { ws?.close(); } catch { /* gone */ } st = null; ws = null; render(); env.state(); }

function onMessage(m) {
  if (!st) return;
  if (m.type === "party") { st.party = m.party; if (!st.isHost) follow(m.party); }
  else if (m.type === "members") { st.members = m.members; const me = m.members.find((x) => x.id === st.memberId); if (me) st.isHost = me.is_host; render("members"); env.state(); }
  else if (m.type === "message") { st.messages = [...st.messages, m.message].slice(-100); render("chat"); }
  else if (m.type === "ended") { env.toast("The host ended the party"); st = null; env.state(); render(); }
}

// ---- guests follow the host ----
function follow(p) {
  const cur = p.current_track;
  if (!cur) { env.audio.pause(); return; }
  const q = (p.queue?.length ? p.queue : [cur]).map(fromWire), want = String(cur.id);
  const i = Math.max(0, q.findIndex((t) => String(t.id) === want));
  const pos = p.is_playing ? p.playback_time + Math.max(0, (Date.now() - p.playback_timestamp) / 1000) : p.playback_time;
  const have = env.tracks(), same = have[env.index()] && String(have[env.index()].id) === want;
  applying = Date.now() + 1500;
  if (!same) { env.load(q, i, pos, p.is_playing); return; }
  if (have.length !== q.length || have.some((t, k) => String(t.id) !== String(q[k].id))) env.setQueue(q, i); // the rest of the queue changed
  const a = env.audio;
  if (Number.isFinite(a.duration) && Math.abs(a.currentTime - pos) > 2) a.currentTime = Math.min(pos, a.duration - 0.2);
  if (p.is_playing && a.paused) a.play().catch(() => {}); else if (!p.is_playing && !a.paused) a.pause();
}

// ---- the host tells everyone (the player calls this on play, pause, seek, a new song or queue change) ----
export function changed() {
  if (!st?.isHost || ws?.readyState !== 1 || Date.now() < applying) return;
  const now = Date.now();
  clearTimeout(pushT);
  pushT = setTimeout(push, Math.max(0, 250 - (now - lastPush)));
}
function push() {
  if (!st?.isHost || ws?.readyState !== 1) return;
  lastPush = Date.now();
  const t = env.tracks()[env.index()], a = env.audio;
  ws.send(JSON.stringify({ type: "playback", payload: { current_track: t ? toWire(t) : null, is_playing: !a.paused && !a.ended, playback_time: a.currentTime || 0, playback_timestamp: Date.now(), queue: env.tracks().slice(0, 300).map(toWire) } }));
}

export async function start(name) {
  left = false;
  const hostToken = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  await connect(true);
  const t = env.tracks()[env.index()], a = env.audio;
  const m = await ws.request("create", { name, hostToken, profile: {}, playback: { current_track: t ? toWire(t) : null, is_playing: !a.paused, playback_time: a.currentTime || 0, playback_timestamp: Date.now(), queue: env.tracks().slice(0, 300).map(toWire) } });
  store.set(hostKey(m.party.id), hostToken);
  take(m);
}
export async function join(id) {
  left = false;
  await connect(true);
  const m = await ws.request("join", { partyId: id, memberId: store.get(seatKey(id)) || undefined, hostToken: store.get(hostKey(id)) || undefined, profile: {} });
  take(m);
}
export function leave(endIt) {
  left = true;
  try { ws?.send(JSON.stringify({ type: "leave", payload: { end: !!endIt } })); } catch { /* gone */ }
  setTimeout(end, 120);
}
const link = () => `${location.origin}/#/party/${st.id}`;

// ---- the sheet ----
const avatar = (m) => (m.avatar_url?.startsWith("data:") ? `<img src="${env.esc(m.avatar_url)}" alt="">` : `<i>${env.esc([...m.name][0] || "?")}</i>`);
function body() {
  const { esc } = env;
  if (!st) return `<div class="p-sheeth"><b>Listening party</b><span>Listen together: everyone hears the same song at the same moment. Works with the second player too.</span></div>
    <button data-m="start">Start a party</button>
    <div class="p-partyjoin"><input class="input p-sheetin" data-pt="code" placeholder="Paste a party link or code" maxlength="200"><button data-m="join">Join</button></div>`;
  return `<div class="p-sheeth"><b>${esc(st.name)}</b><span>${st.isHost ? "You are the host. What you play, everyone hears." : "Following the host. Your controls come back into line on the host's next move."}</span></div>
    <button data-m="copy">Copy invite link</button>
    <div class="p-members">${membersHtml()}</div>
    <div class="p-chat">${chatHtml()}</div>
    <input class="input p-sheetin" data-pt="chat" placeholder="Say something" maxlength="500">
    <button data-m="leave" class="danger">${st.isHost ? "End party" : "Leave party"}</button>`;
}
const chatHtml = () => st.messages.map((c) => `<p><b>${env.esc(c.sender_name)}</b> ${env.esc(c.content)}</p>`).join("") || `<p class="p-note">No messages yet.</p>`;
const membersHtml = () => st.members.map((m) => `<span class="p-member${m.is_host ? " host" : ""}" title="${env.esc(m.name)}">${avatar(m)}<b>${env.esc(m.name)}</b></span>`).join("");
let shownFor = null;
// Only what changed is redrawn, so a box you are typing in keeps its text and focus.
function render(what) {
  if (!sheetEl?.isConnected) { sheetEl = null; return; }
  const box = sheetEl.firstElementChild, key = st ? `${st.id}|${st.isHost}|${st.name}` : "";
  if (what === undefined || key !== shownFor) { shownFor = key; box.innerHTML = body(); wire(); const c = box.querySelector(".p-chat"); if (c) c.scrollTop = c.scrollHeight; return; }
  if (what === "chat") { const c = box.querySelector(".p-chat"), atEnd = c.scrollHeight - c.scrollTop - c.clientHeight < 40; c.innerHTML = chatHtml(); if (atEnd) c.scrollTop = c.scrollHeight; }
  else if (what === "members") box.querySelector(".p-members").innerHTML = membersHtml();
}
function wire() {
  const chat = sheetEl?.querySelector("[data-pt=chat]");
  if (chat) chat.onkeydown = (e) => { if (e.key === "Enter" && chat.value.trim() && ws?.readyState === 1) { ws.send(JSON.stringify({ type: "chat", payload: { content: chat.value.trim() } })); chat.value = ""; } };
  const code = sheetEl?.querySelector("[data-pt=code]");
  if (code) code.onkeydown = (e) => { if (e.key === "Enter") doJoin(code.value); };
}
async function doJoin(text) {
  const id = partyId(text);
  if (!id) return env.toast("That isn't a party link", true);
  try { await join(id); } catch (e) { env.toast(e.message, true); }
}
export function openSheet() {
  shownFor = st ? `${st.id}|${st.isHost}|${st.name}` : "";
  sheetEl = env.sheet(body(), async (b) => {
    const m = b.dataset.m;
    if (m === "start") { try { await start(`${env.name()}'s party`); } catch (e) { env.toast(e.message, true); } }
    else if (m === "join") doJoin(sheetEl.querySelector("[data-pt=code]").value);
    else if (m === "copy") { try { await navigator.clipboard.writeText(link()); env.toast("Invite link copied"); } catch { env.toast(link()); } }
    else if (m === "leave") { leave(st?.isHost); env.close(); }
  });
  wire();
}
