// The "Connected apps" page: people remove apps they approved; admins register apps. Everything shown from the server goes in as text, never as HTML.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id), msg = $("msg");
  const api = async (method, path, body) => {
    const r = await fetch("/api" + path, { method, headers: { "content-type": "application/json", "x-requested-with": "ui" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `Error ${r.status}`), { status: r.status });
    return j;
  };
  const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(props)) k === "text" ? (e.textContent = v) : k === "class" ? (e.className = v) : e.addEventListener ? (k.startsWith("on") ? e.addEventListener(k.slice(2), v) : e.setAttribute(k, v)) : 0; for (const c of kids) e.append(c); return e; };
  const when = (t) => (t ? new Date(t).toLocaleString() : "never");
  const fail = (e) => { msg.textContent = e.message; };
  const origin = location.origin;

  $("doc").textContent = `1. Send the person to:
${origin}/oauth/authorize?response_type=code&client_id=<client id>&redirect_uri=<your redirect>
    &scope=user-read-profile%20user-read-currently-playing&state=<random>
    &code_challenge=<base64url(sha256(code_verifier))>&code_challenge_method=S256

2. They sign in and press Allow; we send them to your redirect with ?code=...&state=...

3. Swap the code for tokens (add client_secret, or HTTP Basic, if your app has a secret):
curl -X POST ${origin}/oauth/token -d grant_type=authorization_code -d code=<code> \\
  -d redirect_uri=<your redirect> -d client_id=<client id> -d code_verifier=<code_verifier>

4. Ask what they are playing (access tokens last 1 hour):
curl ${origin}/v1/me/player/currently-playing -H "Authorization: Bearer <access_token>"

5. Renew: POST ${origin}/oauth/token with grant_type=refresh_token&refresh_token=...&client_id=...
   (every refresh gives a new refresh token; the old one stops working)
   Revoke: POST ${origin}/oauth/revoke with token=...

Scopes: user-read-profile (GET /v1/me), user-read-currently-playing (GET /v1/me/player/currently-playing),
user-stream-audio (GET /v1/tracks/<id>/stream?quality=LOSSLESS, plus search, tracks, albums, artists, playlists and mixes).
Audio is only for apps an admin marked "may ask for audio"; the consent page shows that to people in red.
Songs show up only while one of the person's players is sharing what it plays (the "share what I'm playing" switch in the player).`;

  async function loadGrants() {
    const { grants } = await api("GET", "/oauth/grants"), box = $("grants");
    box.replaceChildren(...(grants.length ? grants.map((g) => el("div", { class: "item" },
      el("b", { text: g.app }), el("small", { text: `${g.scopes.join(", ")} · approved ${when(g.createdAt)} · last used ${when(g.lastUsed)}` }),
      el("div", { class: "row" }, el("button", { class: "d", text: "Remove", onclick: async () => { try { await api("DELETE", `/oauth/grants/${g.id}`); loadGrants(); } catch (e) { fail(e); } } }))))
      : [el("p", { text: "No apps yet." })]));
  }
  function showSecret(title, r) {
    const f = $("fresh"); f.hidden = false;
    f.replaceChildren(el("b", { text: title }), el("small", { text: "Copy these now. The secret is shown only once." }), el("pre", { text: `client_id:     ${r.app.id}${r.secret ? `\nclient_secret: ${r.secret}` : "\n(no secret: a public app)"}` }));
  }
  async function loadApps() {
    const { apps } = await api("GET", "/oauth/apps"), box = $("apps");
    box.replaceChildren(...(apps.length ? apps.map((a) => el("div", { class: "item" },
      el("b", { text: a.name }), el("small", { text: `client_id ${a.id} · ${a.confidential ? "has a secret" : "public app"} · ${a.audio ? "MAY ASK FOR AUDIO" : "no audio"} · ${a.people} ${a.people === 1 ? "person" : "people"} · last used ${when(a.lastUsed)}` }),
      el("small", { text: a.redirectUris.join("  ") }),
      el("div", { class: "row" },
        el("button", { class: "q", text: a.audio ? "Stop allowing audio" : "Allow audio", onclick: async () => { if (!a.audio && !confirm(`Let “${a.name}” ask people for audio? It would play music from this server's TIDAL account.`)) return; try { await api("PATCH", `/oauth/apps/${a.id}`, { audio: !a.audio }); loadApps(); } catch (e) { fail(e); } } }),
        a.confidential ? el("button", { class: "q", text: "New secret", onclick: async () => { if (!confirm("The old secret stops working. Continue?")) return; try { showSecret(`New secret for ${a.name}`, await api("POST", `/oauth/apps/${a.id}/secret`)); } catch (e) { fail(e); } } }) : "",
        el("button", { class: "d", text: "Delete", onclick: async () => { if (!confirm(`Delete “${a.name}”? Everyone who approved it is disconnected.`)) return; try { await api("DELETE", `/oauth/apps/${a.id}`); loadApps(); loadGrants(); } catch (e) { fail(e); } } }))))
      : [el("p", { text: "No apps registered." })]));
  }
  $("create").addEventListener("click", async () => {
    msg.textContent = "";
    try {
      const r = await api("POST", "/oauth/apps", { name: $("name").value, redirectUris: $("uris").value.split(/\s+/).filter(Boolean), confidential: $("conf").checked, audio: $("audio").checked });
      showSecret(`Registered “${r.app.name}”`, r); $("name").value = ""; $("uris").value = ""; $("audio").checked = false; loadApps();
    } catch (e) { fail(e); }
  });
  (async () => {
    try {
      const boot = await (await fetch("/api/boot")).json();
      if (!boot.user) { $("signin").hidden = false; return; }
      $("mine").hidden = false; await loadGrants();
      if (boot.user.role === "admin") { $("admin").hidden = false; await loadApps(); }
    } catch (e) { fail(e); }
  })();
})();
