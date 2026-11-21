// Discord alerts: login failures, slowdowns and batched "track not found" posts.
import { APP_NAME } from "./store.mjs";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || ""; // never logged
const PING_USER = process.env.LOGIN_PING_USER_ID || "";
const SLOW_COOLDOWN = Number(process.env.WEBHOOK_COOLDOWN_MS || 5 * 60 * 1000);
const LOGIN_COOLDOWN = Number(process.env.LOGIN_ALERT_COOLDOWN_MS || 30 * 60 * 1000);

function post(body) {
  if (!WEBHOOK) return;
  fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {}); // alerting must never affect playback
}

const lastLogin = new Map(); // account id -> time
export function loginAlert(account, status, detail) {
  if (Date.now() - (lastLogin.get(account.id) || 0) < LOGIN_COOLDOWN) return;
  lastLogin.set(account.id, Date.now());
  let why = "";
  try { why = String(JSON.parse(detail).detail || ""); } catch { /* not JSON */ }
  post({
    content: PING_USER ? `<@${PING_USER}>` : undefined,
    embeds: [{
      title: "Login went bye bye",
      description: `TIDAL account **${account.label}** can't log in, so it was taken out of rotation. Reconnect it from the Accounts tab, or check whether it was banned.`,
      color: 0xd9534f,
      fields: [{ name: "hifi-api said", value: `HTTP ${status}${why ? `: ${why}` : ""}`.slice(0, 1000) }],
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: PING_USER ? { users: [PING_USER] } : { parse: [] },
  });
}

// Someone opened an invite link. One post per invite every 10 minutes, so reloads don't spam the channel.
const INVITE_COOLDOWN = 10 * 60 * 1000, lastInvite = new Map();
export function inviteOpenedAlert(code, state, by, device, country) {
  if (Date.now() - (lastInvite.get(code) || 0) < INVITE_COOLDOWN) return;
  lastInvite.set(code, Date.now());
  const ok = state === "valid";
  post({
    embeds: [{
      title: ok ? "📨 An invite was opened" : "🚫 A used or expired invite was opened",
      description: ok ? "Someone is looking at an open invite and may be about to sign up." : `Someone opened an invite that doesn't work anymore (${state}).`,
      color: ok ? 0x5b5cf0 : 0x8a8f98,
      fields: [
        { name: "Invited by", value: by || "unknown", inline: true },
        { name: "Invite", value: `\`${code.slice(0, 4)}…\``, inline: true },
        { name: "Device", value: [device, country].filter(Boolean).join(" · ").slice(0, 200) || "unknown" },
      ],
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  });
}

export function memberLinksAlert(on, by) {
  post({
    embeds: [{
      title: on ? "🔓 Link creation is open to everyone" : "🔒 Link creation is admins-only again",
      description: on ? "Members can now make their own links (up to 3 each, default limits)." : "Members can no longer make new links. Their existing links keep working.",
      color: on ? 0x34c759 : 0x8a8f98,
      fields: [{ name: "Changed by", value: by || "unknown", inline: true }],
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  });
}

let lastSlow = 0;
export function slowdownAlert(pending, top) {
  if (Date.now() - lastSlow < SLOW_COOLDOWN) return;
  lastSlow = Date.now();
  const counts = {};
  for (const n of pending) counts[n] = (counts[n] || 0) + 1;
  post({
    embeds: [{
      title: `⚠️ ${APP_NAME} is slowed down`,
      description: `${pending.length} stream requests are queued behind the playback accounts. Expect a few extra seconds per track until the queue clears.`,
      color: 0xf0a020,
      fields: [
        { name: "Queued by", value: Object.entries(counts).map(([n, c]) => `**${n}**: ${c}`).join("\n").slice(0, 1000) },
        { name: "Requests so far", value: top.slice(0, 5).map(([n, c]) => `${n}: ${c} streams`).join("\n").slice(0, 1000) || "none", inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  });
}

// BitChord auto-searches the whole queue, so misses are batched into one post per 30s.
const seen = new Map();
let buffer = [];
let timer = null;
export function missAlert(kind, name, what) {
  const key = `${kind}|${name}|${what}`;
  if (Date.now() - (seen.get(key) || 0) < 10 * 60 * 1000) return false;
  seen.set(key, Date.now());
  if (seen.size > 2000) seen.delete(seen.keys().next().value);
  buffer.push({ kind, name, what });
  if (!timer && WEBHOOK) timer = setTimeout(flush, 30000).unref();
  return true;
}
function flush() {
  timer = null;
  const batch = buffer;
  buffer = [];
  if (!batch.length) return;
  const line = (m) => `${m.kind === "search" ? "🔎" : "⛔"} **${m.name}**: ${m.what}`.slice(0, 200);
  post({
    embeds: [{
      title: `Track not found${batch.length > 1 ? ` (${batch.length})` : ""}`,
      description: (batch.slice(0, 10).map(line).join("\n") + (batch.length > 10 ? `\n…and ${batch.length - 10} more` : "")).slice(0, 4000),
      color: 0xd9534f,
      footer: { text: "🔎 search returned nothing · ⛔ stream unavailable" },
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  });
}
