// "Sign in with Discord" and "connect Discord" via OAuth2 (identify scope only). No tokens are kept.
const ID = process.env.DISCORD_CLIENT_ID || "";
const API = process.env.DISCORD_API || "https://discord.com/api"; // overridable so the flow can be tested against a stub
const SECRET = process.env.DISCORD_CLIENT_SECRET || ""; // never logged or sent to the browser
export const discordOn = () => !!(ID && SECRET);

export const authorizeUrl = (redirect, state) =>
  `https://discord.com/oauth2/authorize?${new URLSearchParams({ client_id: ID, response_type: "code", scope: "identify", redirect_uri: redirect, state })}`;

export async function discordUser(code, redirect) {
  const t = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: ID, client_secret: SECRET, grant_type: "authorization_code", code, redirect_uri: redirect }),
    signal: AbortSignal.timeout(8000),
  });
  if (!t.ok) throw new Error(`token ${t.status}`);
  const { access_token } = await t.json();
  const r = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`user ${r.status}`);
  const u = await r.json();
  if (!/^\d{5,25}$/.test(String(u.id))) throw new Error("bad id");
  return { id: String(u.id), username: String(u.username || "").slice(0, 40), name: String(u.global_name || u.username || "").slice(0, 40) };
}
