// Listening parties for the second player: a small WebSocket server (no dependencies) speaking the protocol Monochrome's party page expects.
// A person must be signed in to Undertow to connect; the host's browser tells everyone else what is playing and where, and guests follow it.
// Parties live in memory only: a restart ends them.
import crypto from "node:crypto";
import { rid } from "./store.mjs";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME = 1_000_000, MAX_MEMBERS = 50, MAX_PARTIES_PER_USER = 3, MAX_REQUESTS = 50, MAX_QUEUE = 300, MAX_TRACK_JSON = 20_000;
const parties = new Map(); // id -> party
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const clip = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

// ---- WebSocket framing ----
function frame(opcode, payload = Buffer.alloc(0)) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, payload]);
}

class Conn {
  constructor(socket, onMessage, onClose) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.parts = []; this.open = true; this.sent = []; // recent message times, for a rate limit
    socket.on("data", (d) => this.read(d));
    socket.on("close", () => this.end());
    socket.on("error", () => this.end());
    this.onMessage = onMessage; this.onClose = onClose;
  }
  send(obj) { if (this.open) try { this.socket.write(frame(0x1, Buffer.from(JSON.stringify(obj)))); } catch { this.end(); } }
  close(code = 1000) { if (!this.open) return; try { this.socket.write(frame(0x8, Buffer.from([code >> 8, code & 255]))); this.socket.end(); } catch { /* gone */ } this.end(); }
  end() { if (!this.open) return; this.open = false; try { this.socket.destroy(); } catch { /* gone */ } this.onClose?.(); }
  read(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1], fin = !!(b0 & 0x80), op = b0 & 15, masked = !!(b1 & 0x80);
      let len = b1 & 127, off = 2;
      if (!masked) return this.close(1002); // browsers always mask
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; const big = this.buf.readBigUInt64BE(2); if (big > BigInt(MAX_FRAME)) return this.close(1009); len = Number(big); off = 10; }
      if (len > MAX_FRAME) return this.close(1009);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4), data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (op === 0x8) return this.close();
      if (op === 0x9) { this.socket.write(frame(0xa, data)); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x0) {
        this.parts.push(data);
        if (this.parts.reduce((a, p) => a + p.length, 0) > MAX_FRAME) return this.close(1009);
        if (fin) { const text = Buffer.concat(this.parts).toString("utf8"); this.parts = []; this.message(text); }
      }
    }
  }
  message(text) {
    const now = Date.now();
    this.sent = this.sent.filter((t) => now - t < 5000); this.sent.push(now);
    if (this.sent.length > 60) return this.close(1008); // more than a dozen a second for five seconds: not a person
    let m; try { m = JSON.parse(text); } catch { return; }
    if (m && typeof m.type === "string") this.onMessage(m);
  }
}

// ---- parties ----
const avatarFor = (user, name) => {
  if (user?.avatar) return `/avatar/${user.id}.jpg?v=${user.avatar}`;
  const initial = [...(name || "?")][0]?.toUpperCase() || "?";
  const hue = parseInt(sha(name).slice(0, 4), 16) % 360;
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 45% 35%)"/><text x="32" y="43" font-size="30" font-family="sans-serif" text-anchor="middle" fill="#fff">${initial.replace(/[<>&]/g, "")}</text></svg>`)}`;
};
const trackOk = (t) => t && typeof t === "object" && !Array.isArray(t) && JSON.stringify(t).length <= MAX_TRACK_JSON;
const memberView = (m) => ({ id: m.id, name: m.name, avatar_url: m.avatar_url, is_host: m.isHost, typing_until: m.typing_until || 0 });
const partyView = (p) => ({ id: p.id, name: p.name, current_track: p.current_track, is_playing: p.is_playing, playback_time: p.playback_time, playback_timestamp: p.playback_timestamp, queue: p.queue, created: p.created });
const snapshot = (p, m, requestId) => ({ type: "snapshot", ...(requestId ? { requestId } : {}), party: partyView(p), members: [...p.members.values()].map(memberView), messages: p.messages, requests: p.requests, memberId: m.id, isHost: m.isHost });
function broadcast(p, msg, except = null) { for (const m of p.members.values()) for (const c of m.conns) if (c !== except) c.send(msg); }
const membersMsg = (p) => ({ type: "members", members: [...p.members.values()].map(memberView) });

function dropMember(p, m) {
  p.members.delete(m.id);
  broadcast(p, membersMsg(p));
  if (!p.members.size) setTimeout(() => { if (parties.get(p.id) === p && !p.members.size) parties.delete(p.id); }, 10 * 60 * 1000).unref();
}
function endParty(p) {
  broadcast(p, { type: "ended" });
  for (const m of p.members.values()) for (const c of [...m.conns]) c.close();
  parties.delete(p.id);
}

function handle(conn, state, user, m) {
  const reply = (obj) => conn.send(m.requestId ? { ...obj, requestId: m.requestId } : obj);
  const fail = (error) => reply({ type: "error", error });
  const pl = m.payload && typeof m.payload === "object" ? m.payload : {};
  const profileName = () => user.displayName; // people appear under their Undertow name, whatever the page sends
  const attach = (p, mem) => { mem.conns.add(conn); clearTimeout(mem.gone); state.party = p; state.member = mem; mem.lastSeen = Date.now(); };

  if (m.type === "create") {
    if ([...parties.values()].filter((p) => p.ownerUserId === user.id).length >= MAX_PARTIES_PER_USER) return fail("You already have the most parties allowed. End one first.");
    const name = clip(pl.name, 60) || `${user.displayName}'s Party`;
    if (!pl.hostToken || String(pl.hostToken).length < 16) return fail("Missing host token");
    const p = { id: rid(5), name, ownerUserId: user.id, hostHash: sha(pl.hostToken), members: new Map(), messages: [], requests: [], created: Date.now(), current_track: null, is_playing: false, playback_time: 0, playback_timestamp: Date.now(), queue: [] };
    const pb = pl.playback || {};
    if (trackOk(pb.current_track)) p.current_track = pb.current_track;
    p.is_playing = pb.is_playing === true; p.playback_time = num(pb.playback_time, 0, 0, 86400); p.playback_timestamp = num(pb.playback_timestamp, Date.now(), 0, 4e12);
    p.queue = (Array.isArray(pb.queue) ? pb.queue : []).filter(trackOk).slice(0, MAX_QUEUE);
    const nm = profileName(pl.profile), mem = { id: `m_${rid(6)}`, userId: user.id, name: nm, avatar_url: avatarFor(user, nm), isHost: true, conns: new Set(), typing_until: 0 };
    p.members.set(mem.id, mem); parties.set(p.id, p); attach(p, mem);
    return reply(snapshot(p, mem));
  }

  if (m.type === "join") {
    const p = parties.get(String(pl.partyId || ""));
    if (!p) return fail("That party has ended");
    let mem = pl.memberId ? p.members.get(String(pl.memberId)) : null;
    if (mem && mem.userId !== user.id) mem = null; // someone else's seat
    if (!mem) {
      if (p.members.size >= MAX_MEMBERS) return fail("That party is full");
      const nm = profileName(pl.profile);
      mem = { id: `m_${rid(6)}`, userId: user.id, name: nm, avatar_url: avatarFor(user, nm), isHost: false, conns: new Set(), typing_until: 0 };
      p.members.set(mem.id, mem);
    }
    if (pl.hostToken && sha(pl.hostToken) === p.hostHash) { for (const x of p.members.values()) x.isHost = false; mem.isHost = true; }
    attach(p, mem);
    reply(snapshot(p, mem));
    return broadcast(p, membersMsg(p), conn);
  }

  const p = state.party, mem = state.member;
  if (!p || !mem || !parties.has(p.id)) return m.requestId ? fail("Join a party first") : undefined;
  mem.lastSeen = Date.now();

  switch (m.type) {
    case "heartbeat": return;
    case "typing": mem.typing_until = num(pl.typing_until, 0, 0, Date.now() + 5000); return broadcast(p, membersMsg(p));
    case "chat": {
      const content = clip(pl.content, 500);
      if (!content) return;
      const msg = { id: rid(4), sender_id: mem.id, sender_name: mem.name, content, created: Date.now() };
      p.messages = [...p.messages, msg].slice(-100);
      mem.typing_until = 0;
      return broadcast(p, { type: "message", message: msg });
    }
    case "request": {
      if (!trackOk(pl.track) || p.requests.length >= MAX_REQUESTS) return;
      p.requests.push({ id: rid(4), track: pl.track, requested_by: mem.name, member_id: mem.id });
      return broadcast(p, { type: "requests", requests: p.requests });
    }
    case "request:remove": {
      if (!mem.isHost) return;
      p.requests = p.requests.filter((r) => r.id !== String(pl.requestId));
      return broadcast(p, { type: "requests", requests: p.requests });
    }
    case "playback": {
      if (!mem.isHost) return;
      p.current_track = trackOk(pl.current_track) ? pl.current_track : null;
      p.is_playing = pl.is_playing === true; p.playback_time = num(pl.playback_time, 0, 0, 86400); p.playback_timestamp = num(pl.playback_timestamp, Date.now(), 0, 4e12);
      if (Array.isArray(pl.queue)) p.queue = pl.queue.filter(trackOk).slice(0, MAX_QUEUE);
      return broadcast(p, { type: "party", party: partyView(p) }, conn);
    }
    case "leave": {
      if (pl.end === true && mem.isHost) return endParty(p);
      mem.conns.delete(conn); dropMember(p, mem); state.party = state.member = null;
      return;
    }
  }
}

// `auth(req)` gives the signed-in person who may use the player (or null); `originOk(req)` checks the page that opened the socket is the player's own.
export function upgrade(req, socket, head, { auth, originOk }) {
  const refuse = (code, text) => { try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ } socket.destroy(); };
  const key = req.headers["sec-websocket-key"];
  if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket" || req.headers["sec-websocket-version"] !== "13") return refuse(400, "Bad Request");
  if (!originOk(req)) return refuse(403, "Forbidden");
  const user = auth(req);
  if (!user) return refuse(401, "Unauthorized");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${crypto.createHash("sha1").update(key + GUID).digest("base64")}\r\n\r\n`);
  socket.setNoDelay(true);
  const state = { party: null, member: null };
  const conn = new Conn(socket, (m) => { try { handle(conn, state, user, m); } catch (e) { console.error("party:", e); } }, () => {
    const { party: p, member: mem } = state;
    if (!p || !mem) return;
    mem.conns.delete(conn);
    if (!mem.conns.size) mem.gone = setTimeout(() => { if (!mem.conns.size && parties.get(p.id) === p && p.members.get(mem.id) === mem) dropMember(p, mem); }, 45000); // a short drop (a phone changing network) keeps the seat
  });
  if (head?.length) conn.read(head);
}

export const partyCount = () => parties.size;
setInterval(() => { for (const [id, p] of parties) if (Date.now() - p.created > 12 * 3600 * 1000) endParty(p); }, 600000).unref(); // nothing lives past twelve hours
