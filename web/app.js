"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const app = $("#app");
const state = { appName: "Undertow", user: null, tab: "overview", events: [], paused: false, filter: "all", links: [], users: [], accounts: [], subsonic: [], videos: [], timers: [] };

const IC = {
  overview: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  links: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  accounts: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z",
  users: "M16 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M20 20v-1a4 4 0 0 0-3-3.9M16 4.2a3.5 3.5 0 0 1 0 6.6",
  copy: "M9 9h10v11H9zM5 15V4h10",
  plus: "M12 5v14M5 12h14",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.5-4.5",
  play: "M8 5v14l11-7z",
  doc: "M7 3h7l5 5v13H7zM14 3v5h5",
  chev: "M9 6l6 6-6 6",
  friends: "M15 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M19 8v6M16 11h6",
  pause: "M8 5v14M16 5v14",
  next: "M6 5l9 7-9 7zM18 5v14",
  prev: "M18 5l-9 7 9 7zM6 5v14",
  video: "M3 7h12v10H3zM15 11l6-3v8l-6-3",
  close: "M6 6l12 12M18 6L6 18",
  pip: "M3 5h18v14H3zM12 12h6v4h-6z",
  chat: "M4 5h16v11H9l-5 4z",
  up: "M12 19V6M6 12l6-6 6 6",
  note: "M9 18V6l11-2v12M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zM20 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z",
  lyrics: "M4 6h16M4 11h16M4 16h9",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  queue: "M4 6h12M4 11h12M4 16h6M15 14v6l5-3z",
  down: "M6 9l6 6 6-6",
  speaker: "M11 5L6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13",
  heart: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  radio: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8",
  back: "M15 6l-6 6 6 6",
  shuffle: "M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5",
  headphones: "M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H4zM17 15h3v5h-3z",
  party: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM21 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8",
  download: "M12 4v11M7 11l5 5 5-5M5 20h14",
};
const icon = (n, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra} aria-hidden="true"><path d="${IC[n]}"/></svg>`;

async function api(method, path, body) {
  const r = await fetch("/api" + path, { method, headers: { "x-requested-with": "ui", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && state.user && !path.startsWith("/login")) { state.user = null; boot(); }
    throw Object.assign(new Error(d.error || `Something went wrong (${r.status})`), { status: r.status });
  }
  return d;
}

// ---- formatting ------------------------------------------------------------------------------
const nf = new Intl.NumberFormat();
const fmtMs = (ms) => (ms == null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
function ago(t) {
  if (!t) return "never";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const roleName = (u) => u.owner ? "Owner" : u.role === "admin" ? "Admin" : "Member";
const roleChip = (u) => u.owner ? `<span class="chip owner">Owner</span>` : u.role === "admin" ? `<span class="chip acc">Admin</span>` : "";
const avatar = (u, size) => `<span class="avatar" style="--c:hsl(${hue(u.username)} 62% 50%);${size ? `width:${size}px;height:${size}px;font-size:${size * 0.4}px` : ""}">${u.avatar ? `<img src="/api/avatar/${esc(u.id)}?v=${u.avatar}" alt="" draggable="false">` : esc((u.displayName || u.username)[0].toUpperCase())}</span>`;
const QNAME = { HI_RES: "Hi-res", CD: "CD quality", HIGH: "High (AAC)", LOW: "Low (AAC)" };

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
// Is the browser drawing on the CPU (graphics acceleration off)? Then WebGL and blur are slow and parts of the page can flash black.
let swGl;
const softwareGl = () => (swGl ??= (() => {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return true;
    const x = gl.getExtension("WEBGL_debug_renderer_info");
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(x ? String(gl.getParameter(x.UNMASKED_RENDERER_WEBGL)) : "");
  } catch { return true; }
})());
{ // reduced effects: chosen in the player's menu, asked for by the device, or switched on by itself when there's no graphics acceleration (your own choice always wins)
  const sync = () => { const v = store.get("p.fx"); document.documentElement.classList.toggle("fx-low", v === "1" || (v === null && softwareGl()) || matchMedia("(prefers-reduced-motion: reduce)").matches); };
  sync(); matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.("change", sync);
}

// Greeting: time of day, a few special days, and "welcome back" after an absence. Seeded by the hour so it
// doesn't change on every refresh.
function greetingPre(away) {
  const d = new Date(), h = d.getHours(), dow = d.getDay(), md = `${d.getMonth() + 1}/${d.getDate()}`;
  const pick = (a) => a[Math.floor(Date.now() / 3600000) % a.length];
  if (md === "12/25") return "Merry Christmas,";
  if (md === "1/1") return "Happy New Year,";
  if (md === "10/31") return "Happy Halloween,";
  if (away) return "Welcome back,";
  if (h < 5) return pick(["Still up,", "Burning the midnight oil,", "Late night,"]);
  if (h < 12) return dow === 1 ? "Happy Monday," : pick(["Good morning,", "Rise and shine,", "Morning,"]);
  if (h < 17) return dow === 0 || dow === 6 ? pick(["Lazy afternoon,", "Good afternoon,"]) : pick(["Good afternoon,", "Hey there,"]);
  if (h < 22) return dow === 5 ? "Friday night," : pick(["Good evening,", "Evening,"]);
  return pick(["Winding down,", "Good night,"]);
}
function subline(o, fr) {
  setHealth(o);
  const now = Date.now(), h = new Date().getHours(), pick = (a) => a[Math.floor(now / 3600000) % a.length];
  const bad = (o.accounts || []).find((a) => a.enabled && (a.status === "dead" || a.status === "down"));
  if (bad) return { tone: "bad", text: `${bad.label} needs attention`, go: "accounts" };
  const live = (fr?.friends || []).filter((f) => f.listening && now - f.listening.at < 5 * 60000);
  if (live.length) { const f = live[Math.floor(now / 60000) % live.length]; return { tone: "ok", text: `${f.user.displayName} is listening to ${f.listening.track}`, go: "friends" }; }
  if (fr?.incoming.length) return { tone: "acc", text: `${fr.incoming.length} friend request${fr.incoming.length > 1 ? "s" : ""} waiting`, go: "friends" };
  if (o.streams) return { tone: "ok", text: `${nf.format(o.streams)} track${o.streams === 1 ? "" : "s"} streamed in the last 24 hours` };
  return { tone: "", text: h < 5 ? "Quiet hours. Perfect for headphones." : h < 12 ? "Coffee and a record?" : h < 18 ? "Nothing playing yet. Press play." : "Nothing playing yet. Pick something good." };
}
let typeTok = 0;
const NEAR = { q: "wa", w: "qes", e: "wrd", r: "etf", t: "ryg", y: "tuh", u: "yij", i: "uok", o: "ipl", p: "ol", a: "qsz", s: "adw", d: "sfe", f: "dgr", g: "fht", h: "gjy", j: "hku", k: "jli", l: "kop", z: "asx", x: "zcs", c: "xvd", v: "cbf", b: "vng", n: "bmh", m: "nk" };
// Types the whole greeting ("Evening, Adm") one key at a time. Each letter has a 5% chance of a slip:
// a wrong key (sometimes one more after it), a beat of "oh no", backspacing, then the right letter.
// Capped at a handful of slips so a long name doesn't take forever.
function typeName(el, instant) {
  const tok = ++typeTok, pre = el.previousElementSibling?.matches("[data-pre]") ? el.previousElementSibling : null, caret = el.nextElementSibling, head = pre?.dataset.pre || "", name = el.dataset.name, full = head + name;
  const draw = (t) => { if (pre) pre.textContent = t.slice(0, head.length); el.textContent = t.slice(head.length); };
  if (instant || reduce) { draw(full); caret?.classList.add("done"); return; }
  draw("");
  let buf = "", i = 0, queue = [], slips = 0;
  const rnd = (a, b) => a + Math.random() * (b - a), keep = () => tok === typeTok && el.isConnected;
  const plan = () => {
    const c = full[i], lower = c.toLowerCase();
    if (NEAR[lower] && slips < 6 && Math.random() < 0.05) {
      slips++;
      const near = NEAR[lower], wrong = near[Math.floor(Math.random() * near.length)], wrongs = [c === lower ? wrong : wrong.toUpperCase()];
      if (i + 1 < full.length && Math.random() < 0.4) wrongs.push(full[i + 1]); // kept typing before noticing
      wrongs.forEach((w) => queue.push([w, rnd(70, 130)]));
      queue.push(["pause", rnd(320, 520)]);
      wrongs.forEach(() => queue.push(["back", rnd(55, 85)]));
      queue.push(["pause", rnd(120, 220)]);
    }
    queue.push([c, rnd(55, 130) + (c === " " || c === "," ? 70 : 0)]);
    i++;
  };
  const step = () => {
    if (!keep()) return;
    if (!queue.length) { if (i >= full.length) return void setTimeout(() => keep() && caret?.classList.add("done"), 1400); plan(); }
    const [op, wait] = queue.shift();
    if (op === "back") buf = buf.slice(0, -1); else if (op !== "pause") buf += op;
    draw(buf);
    setTimeout(step, wait);
  };
  setTimeout(step, 450);
}
function countUp(el, animate) {
  const n = +el.dataset.count;
  if (!animate || reduce || n < 2) return void (el.textContent = nf.format(n));
  const t0 = performance.now();
  const f = (t) => { const p = Math.min(1, (t - t0) / 850); el.textContent = nf.format(Math.round(n * (1 - (1 - p) ** 4))); if (p < 1) requestAnimationFrame(f); };
  requestAnimationFrame(f);
}

let toastTimer;
function toast(msg, bad) {
  $(".toast")?.remove();
  const t = Object.assign(document.createElement("div"), { className: `toast glass chrome${bad ? " bad" : ""}`, textContent: msg });
  t.setAttribute("role", "status");
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add("in"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 500); }, 2600);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); }
  catch { const ta = Object.assign(document.createElement("textarea"), { value: text }); document.body.append(ta); ta.select(); try { document.execCommand("copy"); toast("Copied"); } catch { toast("Press and hold to copy", true); } ta.remove(); }
}

// ---- sheets ----------------------------------------------------------------------------------
let sheetEl = null, scrimEl = null, sheetCleanup = null;
const wide = () => matchMedia("(min-width: 700px)").matches;
function openSheet(html, cleanup) {
  closeSheet(true);
  scrimEl = Object.assign(document.createElement("div"), { className: "scrim" });
  sheetEl = Object.assign(document.createElement("div"), { className: "sheet glass chrome" });
  sheetEl.setAttribute("role", "dialog");
  sheetEl.setAttribute("aria-modal", "true");
  sheetEl.innerHTML = `<div class="sheet-head"><div class="grab"></div></div><div class="body">${html}</div>`;
  sheetCleanup = cleanup || null;
  document.body.append(scrimEl, sheetEl);
  requestAnimationFrame(() => { scrimEl?.classList.add("in"); sheetEl?.classList.add("in"); initControls(sheetEl); });
  scrimEl.addEventListener("click", () => closeSheet());
  attachDrag(sheetEl, sheetEl, scrimEl);
  if (!matchMedia("(pointer: coarse)").matches) setTimeout(() => $("input:not([type=range]), select", sheetEl)?.focus({ preventScroll: true }), 120);
  return sheetEl;
}
const setSheet = (html) => { if (!sheetEl) return; $(".body", sheetEl).innerHTML = html; initControls(sheetEl); };
function closeSheet(instant) {
  const s = sheetEl, sc = scrimEl;
  if (!s) return;
  sheetEl = scrimEl = null;
  sheetCleanup?.(); sheetCleanup = null;
  if (instant) { s.remove(); sc.remove(); return; }
  s.classList.remove("in", "drag"); s.classList.add("out");
  if (!wide()) s.style.transform = "translateY(100%)";
  sc.classList.remove("in");
  setTimeout(() => { s.remove(); sc.remove(); }, 330);
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

// Drag-to-dismiss: tracks the finger 1:1, then projects the release velocity to pick a side.
function attachDrag(sheet, sheetNode, scrim) {
  const head = $(".sheet-head", sheet);
  let y0 = 0, hist = [], on = false;
  head.addEventListener("pointerdown", (e) => { if (wide()) return; on = true; y0 = e.clientY; hist = [[e.timeStamp, e.clientY]]; head.setPointerCapture(e.pointerId); sheetNode.classList.add("drag"); });
  head.addEventListener("pointermove", (e) => {
    if (!on) return;
    const dy = e.clientY - y0;
    hist.push([e.timeStamp, e.clientY]); if (hist.length > 6) hist.shift();
    const shown = dy > 0 ? dy : -Math.sqrt(-dy) * 3; // rubber-band upwards
    sheetNode.style.transform = `translateY(${shown}px)`;
    scrim.style.opacity = String(Math.max(0, 1 - dy / sheetNode.offsetHeight));
  });
  const end = (e) => {
    if (!on) return;
    on = false;
    const dy = e.clientY - y0, [t0, yA] = hist[0], v = hist.length > 1 ? (e.clientY - yA) / Math.max(1, e.timeStamp - t0) : 0; // px/ms
    const projected = dy + (v * 0.998) / (1 - 0.998) * 0.18; // momentum projection, damped for a sheet
    scrim.style.opacity = "";
    sheetNode.classList.remove("drag");
    if (projected > sheetNode.offsetHeight * 0.45 || v > 0.9) closeSheet();
    else sheetNode.style.transform = "";
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
}

function confirmSheet(title, text, label = "Delete") {
  return new Promise((ok) => {
    let result = false;
    openSheet(`<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p><div class="row"><button class="btn grow" data-act="sheet-no">Cancel</button><button class="btn grow danger" data-act="sheet-yes">${esc(label)}</button></div>`, () => ok(result));
    sheetEl.addEventListener("click", (e) => { const a = e.target.closest("[data-act]")?.dataset.act; if (a === "sheet-yes") { result = true; closeSheet(); } else if (a === "sheet-no") closeSheet(); });
  });
}

// ---- controls (segmented, switch) ------------------------------------------------------------
function initControls(root) {
  $$(".seg", root).forEach(placeThumb);
}
function placeThumb(seg) {
  const btns = $$("button", seg), i = Math.max(0, btns.findIndex((b) => b.classList.contains("on")));
  let th = $(".thumb", seg);
  if (!th) { th = document.createElement("i"); th.className = "thumb"; seg.prepend(th); th.style.transition = "none"; requestAnimationFrame(() => (th.style.transition = "")); }
  const w = (seg.clientWidth - 6) / btns.length;
  th.style.width = `${w}px`;
  th.style.transform = `translateX(${i * w}px)`;
}
const seg = (name, opts, value) => `<div class="seg" data-seg="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${esc(v)}" class="${v === value ? "on" : ""}">${esc(l)}</button>`).join("")}</div>`;
const sw = (name, on) => `<button type="button" class="switch" role="switch" aria-checked="${!!on}" data-sw="${name}"></button>`;
const segVal = (root, name) => $(`[data-seg="${name}"] .on`, root)?.dataset.v;
const swVal = (root, name) => $(`[data-sw="${name}"]`, root).getAttribute("aria-checked") === "true";
addEventListener("resize", () => { $$(".seg").forEach(placeThumb); moveInd(); });

// ---- auth ------------------------------------------------------------------------------------
function authScreen(mode, invite, info) {
  const titles = { login: ["Welcome back", "Sign in to continue."], setup: ["Set up your server", "Create the first admin. The setup code is in the .setup-code file next to server.mjs."], register: ["You're invited", "Choose a username and password."] };
  const [h, p] = titles[mode];
  app.innerHTML = `<main class="auth"><form class="card glass chrome rise" data-form="${mode}" novalidate>
    <img class="logo" src="/icon.svg?v=3" alt=""><div class="brandline"><span class="typed" data-name="${esc(state.appName)}"></span><i class="caret"></i></div><div><h1>${h}</h1><p class="muted" style="margin-top:6px">${p}</p></div>
    ${mode === "register" && info?.by ? `<div class="invite-msg"><div class="row">${avatar({ ...info.by, id: "" }, 44).replace(/src="[^"]*"/, `src="/api/invite/${encodeURIComponent(invite)}/avatar?v=${info.by.avatar}"`)}<div class="grow"><b>${esc(info.by.displayName)}</b><div class="small muted">@${esc(info.by.username)} invited you</div></div></div>${info.message ? `<p>${esc(info.message)}</p>` : ""}</div>` : ""}
    ${mode === "setup" ? `<label class="field"><span>Setup code</span><input class="input mono" name="code" autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false" required></label>` : ""}
    ${mode !== "login" ? `<label class="field"><span>Display name</span><input class="input" name="displayName" autocomplete="nickname" maxlength="40" required></label>` : ""}
    <label class="field"><span>Username</span><input class="input" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next" required></label>
    <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" enterkeyhint="go" required></label>
    <div class="err" role="alert"></div>
    <button class="btn primary" type="submit">${mode === "login" ? "Sign in" : mode === "setup" ? "Create admin" : "Create account"}</button>
    ${mode === "login" && state.discord ? `<button class="btn discord" type="button" data-act="discord-login"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>Continue with Discord</button>` : ""}
  </form></main>`;
  $$(".typed", app).forEach((el) => typeName(el));
}
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-form]");
  if (!f) return;
  e.preventDefault();
  const mode = f.dataset.form, d = Object.fromEntries(new FormData(f));
  const err = $(".err", f), btn = $("button[type=submit]", f);
  err.textContent = "";
  btn.disabled = true;
  try {
    if (mode === "register") d.invite = new URLSearchParams(location.search).get("invite");
    const r = await api("POST", `/${mode}`, d);
    state.user = r.user;
    if (mode === "register") history.replaceState(null, "", "/");
    boot();
  } catch (x) { err.textContent = x.message; btn.disabled = false; }
});

// ---- shell -----------------------------------------------------------------------------------
const tabsFor = () => [["overview", "Overview"], ["links", "Links"], ["activity", "Activity"], ["friends", "Friends"], ["discord", "Discord"], ...(state.user.role === "admin" ? [["accounts", "Accounts"], ["users", "Users"]] : [])];
function renderShell() {
  const u = state.user, tabs = tabsFor();
  app.innerHTML = `<div class="edge"></div>
    <header class="topbar glass chrome">
      <div class="brand"><img class="brand-mark" src="/icon.svg?v=3" alt="" width="32" height="32">Undertow</div>
      <span class="chip status ok" id="health"><i class="dot"></i><span>All good</span></span>
      <div class="spacer"></div>
      <span class="clock mono" id="clock"></span>
      <div class="top-actions">
        ${u.player === false ? "" : `<button class="btn primary player-cta" data-act="player" aria-label="Open the player"><i class="dot"></i>${icon("play")}<span class="hide-s">Player</span></button>`}
        <button class="avatar-btn" data-act="profile" aria-label="Profile">${avatar(u)}</button>
      </div>
    </header>
    <div class="shell"><main id="view" class="view"></main></div>
    <nav class="nav glass chrome" aria-label="Sections" style="--n:${tabs.length}"><i class="ind"></i>
      ${tabs.map(([k, l]) => `<button data-act="tab" data-tab="${k}" aria-label="${l}">${icon(k)}<span>${l}</span></button>`).join("")}
    </nav>`;
  const tick = () => { const c = $("#clock"); if (c) c.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
  tick();
  clearInterval(state.clockTimer);
  state.clockTimer = setInterval(tick, 20000);
}
// The top bar says whether anything needs attention.
function setHealth(o) {
  const el = $("#health");
  if (!el) return;
  const bad = (o.accounts || []).find((a) => a.enabled && (a.status === "dead" || a.status === "down"));
  el.className = `chip status ${bad ? "bad" : "ok"}`;
  el.lastElementChild.textContent = bad ? "Needs attention" : "All good";
}
function moveInd() { // the dock's lens slides to the open tab
  const nav = $(".nav");
  if (!nav) return;
  const i = $$("button[data-tab]", nav).findIndex((b) => b.classList.contains("on"));
  if (i >= 0) nav.style.setProperty("--i", i);
}
// The glass catches light where the finger is.
document.addEventListener("pointermove", (e) => {
  const g = e.target.closest?.(".nav, .toast, .topbar");
  if (!g) return;
  const r = g.getBoundingClientRect();
  g.style.setProperty("--mx", `${e.clientX - r.left}px`); g.style.setProperty("--my", `${e.clientY - r.top}px`);
});
document.addEventListener("pointerdown", (e) => e.target.closest?.(".nav")?.classList.add("touch"));
addEventListener("pointerup", () => $(".nav")?.classList.remove("touch"));
addEventListener("pointercancel", () => $(".nav")?.classList.remove("touch"));
function stopTimers() { state.timers.forEach(clearInterval); state.timers = []; }
const every = (ms, fn) => state.timers.push(setInterval(fn, ms));

async function show(tab, { anim = true } = {}) {
  if (!tabsFor().some(([k]) => k === tab)) tab = "overview";
  const changed = state.tab !== tab || anim;
  const order = tabsFor().map(([k]) => k), dir = Math.sign(order.indexOf(tab) - order.indexOf(state.tab)) || 1;
  state.tab = tab;
  $$(".nav [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  moveInd();
  requestAnimationFrame(moveInd); // again once layout and fonts have settled
  if (changed) { stopTimers(); window.scrollTo(0, 0); }
  const v = $("#view");
  if (!v) return;
  // The old page slides out the way you're heading while the next one loads, then the new one slides in.
  const leaving = changed && anim && !reduce && v.children.length ? v.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${-dir * 18}px)` }], { duration: 150, easing: "cubic-bezier(.23,1,.32,1)", fill: "forwards" }).finished.catch(() => {}) : null;
  let html;
  try { [html] = await Promise.all([views[tab](), leaving]); }
  catch (e) { html = `<div class="empty card glass">${esc(e.message)}<br><br><button class="btn" data-act="tab" data-tab="${tab}">Try again</button></div>`; }
  if (state.tab !== tab) return;
  v.getAnimations().forEach((a) => a.cancel());
  v.className = `view${anim ? "" : " still"}`;
  v.style.setProperty("--dx", `${dir * 26}px`);
  v.innerHTML = html;
  $$(".rise", v).forEach((el, i) => el.style.setProperty("--i", Math.min(i, 9)));
  $$("[data-count]", v).forEach((el) => countUp(el, anim));
  $$(".typed", v).forEach((el) => typeName(el, !anim));
  initControls(v);
  if (changed) hooks[tab]?.();
}
const partyLink = () => { // an invite (#/party/<id>): open the player and join
  const id = (location.hash.match(/^#\/party\/([a-f0-9]{6,16})$/i) || [])[1];
  if (!id || !state.user) return false;
  history.replaceState(null, "", location.pathname + "#/overview");
  actions.player().then(() => state.playerMod?.joinParty(id));
  return true;
};
addEventListener("hashchange", () => { if (state.user && !partyLink()) show(location.hash.slice(2) || "overview"); });
const go = (t) => (location.hash === `#/${t}` ? show(t) : (location.hash = `#/${t}`));

// ---- overview: chart, live ticker, live counters ---------------------------------------------
const CLIENTS = { bitchord: ["BitChord", "cl-bitchord"], eclipse: ["Eclipse", "cl-eclipse"] }; // events from before Eclipse existed are all BitChord
const clientChip = (e) => { const [n, c] = CLIENTS[e.client] || CLIENTS.bitchord; return `<span class="chip ${c}">${n}</span>`; };
const tickerRow = (e, isNew) => `<div class="tk${isNew ? " new" : ""}"><span class="kind ${e.kind}">${icon(e.kind === "stream" ? "play" : e.kind === "search" ? "search" : "doc")}</span><div class="grow"><div class="t">${esc(e.detail || e.kind)}</div><div class="s">${e.kind === "manifest" ? "" : clientChip(e) + " "}${esc([e.user, e.device, fmtMs(e.ms)].filter(Boolean).join(" · "))}</div></div><span class="small muted">${clock(e.t).slice(0, 5)}</span></div>`;
const tickerHtml = (list) => list.length ? list.map((e) => tickerRow(e)).join("") : `<p class="muted tk-empty">Nothing playing.</p>`;
// Smooth curve through the points (monotone-ish Catmull-Rom), so the line reads as one stroke.
function curve(pts) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1] || pts[i], [x1, y1] = pts[i], [x2, y2] = pts[i + 1], [x3, y3] = pts[i + 2] || pts[i + 1];
    const c1y = Math.min(Math.max(y1 + (y2 - y0) / 6, Math.min(y1, y2)), Math.max(y1, y2)), c2y = Math.min(Math.max(y2 - (y3 - y1) / 6, Math.min(y1, y2)), Math.max(y1, y2));
    d += `C${x1 + (x2 - x0) / 6},${c1y} ${x2 - (x3 - x1) / 6},${c2y} ${x2},${y2}`;
  }
  return d;
}
function drawChart(animate) {
  const box = $("#chart"), ov = state.ov;
  if (!box || !ov) return;
  const W = Math.max(220, box.clientWidth), H = 124, padT = 10, padB = 6, n = ov.series.length, step = (W - 12) / (n - 1);
  const peak = Math.max(3, ...ov.series.map((x) => Math.max(x.stream, x.search)));
  const X = (i) => 6 + i * step, Y = (v) => H - padB - (v / peak) * (H - padT - padB);
  const line = (key) => ov.series.map((x, i) => [X(i), Y(x[key])]);
  const ps = line("stream"), pq = line("search"), ds = curve(ps), dq = curve(pq), last = ps[n - 1];
  box.classList.toggle("still", !animate);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
    <path class="ln q" pathLength="1" d="${dq}"/><path class="ln s" pathLength="1" d="${ds}"/>
    <g class="scrub" opacity="0"><line y1="0" y2="${H}"/><circle class="cs" r="4"/><circle class="cq" r="3"/></g>
    <g class="nowdot" style="transform:translate(${last[0]}px,${last[1]}px)"><circle class="core" r="4"/></g></svg><div class="tip" hidden></div>`;
  const svg = $("svg", box), sc = $(".scrub", svg), tip = $(".tip", box), read = $("#chart-read");
  const base = read?.textContent;
  const at = (clientX) => {
    const r = svg.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.round(((clientX - r.left) / r.width * W - 6) / step))), x = ov.series[i], px = X(i);
    sc.setAttribute("opacity", "1");
    $("line", sc).setAttribute("x1", px); $("line", sc).setAttribute("x2", px);
    $(".cs", sc).setAttribute("cx", px); $(".cs", sc).setAttribute("cy", Y(x.stream)); $(".cq", sc).setAttribute("cx", px); $(".cq", sc).setAttribute("cy", Y(x.search));
    const ago = n - 1 - i;
    tip.hidden = false; tip.textContent = `${ago ? `${ago} min ago` : "Now"} · ${x.stream} stream${x.stream === 1 ? "" : "s"} · ${x.search} search${x.search === 1 ? "" : "es"}`;
    tip.style.transform = `translateX(${Math.max(0, Math.min(box.clientWidth - tip.offsetWidth, px / W * box.clientWidth - tip.offsetWidth / 2))}px)`;
  };
  const off = () => { sc.setAttribute("opacity", "0"); tip.hidden = true; if (read && base) read.textContent = base; };
  svg.addEventListener("pointerdown", (e) => at(e.clientX));
  svg.addEventListener("pointermove", (e) => (e.buttons || e.pointerType === "mouse") && at(e.clientX));
  svg.addEventListener("pointerleave", off); svg.addEventListener("pointerup", off); svg.addEventListener("pointercancel", off);
}
function bump(el) { if (!el || reduce) return; el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
// A request just came in over the live feed: move the numbers, the chart and the ticker with it.
function liveEvent(e) {
  const ov = state.ov;
  if (!ov || state.tab !== "overview" || e.kind === "manifest") return;
  const set = (key, text) => { const el = $(`[data-live="${key}"]`); if (el) { el.textContent = text; bump(el); } };
  if (e.kind === "stream") { ov.streams++; ov.series[ov.series.length - 1].stream++; set("streams", nf.format(ov.streams)); }
  else if (e.kind === "search") { ov.searches++; ov.series[ov.series.length - 1].search++; set("searches", nf.format(ov.searches)); }
  if (e.notFound) ov.notFound++; else if (e.status >= 400) ov.errors++;
  if (e.notFound || e.status >= 400) set("issues", `${ov.notFound} · ${ov.errors}`);
  drawChart(false);
  const tk = $("#ticker");
  if (tk) { $(".tk-empty", tk)?.remove(); tk.insertAdjacentHTML("afterbegin", tickerRow(e, true)); while (tk.children.length > 4) tk.lastChild.remove(); }
}

// ---- views -----------------------------------------------------------------------------------
const views = {
  async overview() {
    const o = await api("GET", "/overview");
    const recent = (await api("GET", "/activity?limit=5").catch(() => ({ events: [] }))).events.filter((e) => e.kind !== "manifest").slice(0, 4);
    state.ov = { ...o, series: o.series.map((x) => ({ ...x })), recent };
    const admin = state.user.role === "admin";
    const fr = await api("GET", "/friends").catch(() => null);
    const u = state.user, last = Number(store.get("ut.last") || 0), away = last && Date.now() - last > 3 * 86400000;
    store.set("ut.last", Date.now());
    const sub = subline(o, fr);
    return `<section class="hero glass rise">
        <button class="hero-av" data-act="profile" aria-label="Your profile">${avatar(u, 76)}</button>
        <div class="hero-t">
          <h1 class="greet"><span class="pre" data-pre="${esc(greetingPre(away))} ">${esc(greetingPre(away))} </span><span class="typed" data-name="${esc(u.displayName)}">${esc(u.displayName)}</span><i class="caret"></i></h1>
          ${sub.go ? `<button class="sub link" data-act="tab" data-tab="${sub.go}">` : `<p class="sub">`}<span class="dot ${sub.tone}"></span><span>${esc(sub.text)}</span>${sub.go ? "</button>" : "</p>"}</div></section>
      <div class="tiles">
        <div class="tile glass rise"><span>Streams · 24h</span><b data-count="${o.streams}" data-live="streams">${nf.format(o.streams)}</b></div>
        <div class="tile glass rise"><span>Searches · 24h</span><b data-count="${o.searches}" data-live="searches">${nf.format(o.searches)}</b></div>
        <div class="tile glass rise"><span>Avg stream time</span><b>${o.avgStreamMs == null ? "—" : fmtMs(o.avgStreamMs)}</b></div>
        <div class="tile glass rise"><span>Not found · errors</span><b data-live="issues">${o.notFound} · ${o.errors}</b></div>
      </div>
      <section class="card glass rise chart-card"><div class="row between"><h2>Last hour</h2><span class="small muted"><span style="color:var(--ok)">●</span> streams &nbsp;<span style="color:var(--accent)">●</span> searches</span></div>
        <div class="chart" id="chart" role="img" aria-label="Streams and searches per minute for the last hour"></div>
        <div class="row between small muted"><span>60 min ago</span><span id="chart-read">${o.activeNow} active device${o.activeNow === 1 ? "" : "s"} now</span><span>now</span></div></section>
      <section class="card glass rise"><div class="row between"><h2>Live</h2></div><div class="ticker" id="ticker">${tickerHtml(state.ov.recent)}</div></section>
      ${admin ? `<section class="card glass rise"><div class="row between"><h2>Accounts</h2><button class="btn sm" data-act="tab" data-tab="accounts">Manage</button></div><div class="list" style="margin-top:12px">${o.accounts.map((a) => `<div class="row"><span class="dot ${accDot(a)}"></span><div class="grow"><div class="t" style="font-weight:620">${esc(a.label)}</div><div class="small muted">${accText(a)} · ${a.requests} calls</div></div>${a.plan ? `<span class="chip">${esc(a.plan)}</span>` : ""}</div>`).join("")}</div></section>` : ""}
      <section class="card glass rise"><h2>Top devices</h2><div class="list" style="margin-top:12px">${o.top.length ? o.top.map((d) => `<div class="row"><div class="grow"><div style="font-weight:620">${esc(d.device)}</div><div class="small muted">${esc(d.user)}</div></div><span class="chip acc">${nf.format(d.n)}</span></div>`).join("") : `<p class="muted">No requests yet.</p>`}</div></section>`;
  },

  async links() {
    const [l, u, a] = await Promise.all([api("GET", "/links"), state.user.role === "admin" ? api("GET", "/users") : { users: [] }, state.user.role === "admin" ? api("GET", "/accounts") : { accounts: [] }]);
    state.links = l.links; state.users = u.users; state.accounts = a.accounts;
    const admin = state.user.role === "admin";
    state.canCreate = l.canCreate; state.membersCreate = l.membersCreate;
    const others = admin ? state.links.filter((x) => !x.parent && x.userId && x.userId !== state.user.id).length : 0; // links that belong to other people
    state.scope = store.get("links.scope") === "all" ? "all" : "mine";
    return `<div class="row between rise"><h1>Links</h1>${l.canCreate ? `<button class="btn primary" data-act="new-link">${icon("plus")}New link</button>` : ""}</div>
      ${others ? `<div class="rise">${seg("linkscope", [["mine", "Mine"], ["all", `Everyone (${state.links.filter((x) => !x.parent).length})`]], state.scope)}</div>` : ""}
      <div id="linklist">${linkListHtml()}</div>`;
  },

  async activity() {
    const r = await api("GET", "/activity?limit=150");
    state.events = r.events;
    return `<div class="row between rise"><h1>Activity</h1><button class="live" data-act="pause" aria-pressed="${state.paused}"><span class="dot ${state.paused ? "" : "ok"}"></span><span id="livetxt">${state.paused ? "Paused" : "Live"}</span></button></div>
      <div class="rise">${seg("filter", [["all", "All"], ["stream", "Streams"], ["search", "Searches"], ["bad", "Issues"]], state.filter)}</div>
      <div class="feed" id="feed">${feedHtml()}</div>`;
  },

  async accounts() {
    const r = await api("GET", "/accounts");
    state.accounts = r.accounts;
    state.subsonic = r.subsonic || [];
    state.videos = r.videos || [];
    state.videosOn = !!r.videosOn;
    return `<div class="row between rise"><h1>Accounts</h1><button class="btn primary" data-act="connect">${icon("plus")}Connect</button></div>
      <p class="muted rise" style="margin:-4px 2px 0">Requests go to the least busy account. A link can be pinned to one.</p>
      <div class="list">${r.accounts.map((a) => `<button class="item glass rise" data-act="account" data-id="${a.id}"><span class="dot ${accDot(a)}"></span><div class="grow"><div class="t">${esc(a.label)}</div><div class="s">${accText(a)}${a.avgMs ? ` · avg ${fmtMs(a.avgMs)}` : ""} · ${nf.format(a.requests)} calls${a.inflight ? ` · ${a.inflight} busy` : ""}</div></div>${a.plan ? `<span class="chip">${esc(a.plan)}</span>` : ""}${icon("chev", 'width="18" height="18" style="opacity:.4"')}</button>`).join("")}</div>
      <div class="row between rise" style="margin-top:8px"><h2>Backup servers</h2><button class="btn sm" data-act="new-subsonic">${icon("plus")}Add</button></div>
      <p class="muted rise" style="margin:-4px 2px 0">Subsonic servers like gonic or Navidrome. They're used when TIDAL doesn't have a song or can't play it.</p>
      <div class="list">${state.subsonic.map((x) => `<button class="item glass rise" data-act="subsonic" data-id="${x.id}"><span class="dot ${accDot(x)}"></span><div class="grow"><div class="t">${esc(x.label)}</div><div class="s">${x.status === "ok" ? "Ready" : x.status === "dead" ? "Login failed" : x.status === "down" ? "Offline" : x.status === "disabled" ? "Disabled" : "Checking…"} · ${esc(new URL(x.url).host)}${x.requests ? ` · ${nf.format(x.requests)} calls` : ""}</div></div>${icon("chev", 'width="18" height="18" style="opacity:.4"')}</button>`).join("") || `<div class="empty muted rise">No backup servers yet.</div>`}</div>
      <div class="row between rise" style="margin-top:8px"><h2>Music videos</h2><button class="btn sm" data-act="new-video">${icon("plus")}Add</button></div>
      <p class="muted rise" style="margin:-4px 2px 0">Eclipse plays a song's video, found on YouTube. Pick one by hand for songs search can't find, like unlisted videos or other sites.${state.videosOn ? "" : " yt-dlp isn't installed on this server yet, so nothing plays."}</p>
      <div class="list">${state.videos.map((v) => `<button class="item glass rise" data-act="video" data-key="${esc(v.key)}"><div class="grow"><div class="t">${esc(v.title)}</div><div class="s">${esc(v.artist || "No artist")} · ${esc(new URL(v.url || `https://youtu.be/${v.id}`).host)}${v.by ? ` · from ${esc(v.by.name)}` : ""}${v.hidden ? " · hidden" : Number.isFinite(v.offset) || v.end ? " · timing set" : ""}</div></div>${icon("chev", 'width="18" height="18" style="opacity:.4"')}</button>`).join("") || `<div class="empty muted rise">None set by hand.</div>`}</div>`;
  },

  async discord() {
    const R = window.UndertowRPC, [info, st, rk] = await Promise.all([api("GET", "/rpc"), R.status(), api("GET", "/rpc/key").catch(() => ({ has: false }))]);
    const on = R.enabled(), isWin = /Windows/i.test(navigator.userAgent), kb = (n) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
    const files = [...info.files].sort((a, b) => (b.os === (isWin ? "windows" : "linux")) - (a.os === (isWin ? "windows" : "linux")));
    const state1 = !st ? `<span class="chip bad">App not found</span>` : st.discord?.connected ? `<span class="chip ok">Connected${st.discord.user ? ` as ${esc(st.discord.user)}` : ""}</span>` : `<span class="chip warn">App running, Discord not found</span>`;
    return `<div class="row between rise"><h1>Discord</h1><button class="btn" data-act="rpc-recheck">Check again</button></div>
      <div class="card glass rise" style="border-radius:22px;padding:16px 18px">
        <div class="row between"><div><b>Show what you're listening to</b><div class="hint" style="padding:0">Puts "Listening to" on your Discord profile with the cover, a progress bar and a button that opens the song on TIDAL. Works in both players.</div></div>${state1}</div>
        <div class="row" style="margin-top:14px;gap:10px;flex-wrap:wrap">
          <button class="btn ${on ? "" : "primary"}" data-act="rpc-toggle" ${st ? "" : "disabled"}>${on ? "Turn off in this browser" : "Turn on in this browser"}</button>
          <button class="btn" data-act="rpc-test" ${st?.discord?.connected ? "" : "disabled"}>Send a test card</button>
        </div>
        <div class="hint" style="padding:10px 0 0">${st ? (on ? "On. Play something and it shows up on Discord." : "Off. Nothing is sent until you turn it on.") : "Install and start the app below. Your browser will ask to let this site reach devices on your network: allow it, then press Check again."}</div>
      </div>
      <div class="section-h rise"><h2>Show phone playback on your computer</h2></div>
      <div class="card glass rise" style="border-radius:22px;padding:16px 18px">
        <div class="hint" style="padding:0">Your phone can't reach the app on your computer, so it tells Undertow what you play, and the app on your computer asks Undertow every 10 seconds. Nothing shows while you're paused. A card from a browser on the computer itself wins while it's playing.</div>
        <div class="row between" style="margin-top:14px"><div><b>Tell Undertow what this browser plays</b><div class="hint" style="padding:0">Turn it on in each browser you listen in. The second player has the same switch in Settings.</div></div><button class="btn ${R.relayEnabled?.() ? "" : "primary"}" data-act="rpc-relay">${R.relayEnabled?.() ? "Turn off" : "Turn on"}</button></div>
        <div class="row between" style="margin-top:14px;gap:10px;flex-wrap:wrap"><div><b>Key for the app</b><div class="hint" style="padding:0">${rk.has ? `Made ${esc(new Date(rk.at).toLocaleDateString())} (${esc(rk.prefix)}…)${rk.lastUsed ? `, last used ${esc(new Date(rk.lastUsed).toLocaleString())}` : ", not used yet"}.` : "No key yet. Make one, then give it to the app on your computer."} The key only lets the app see your current song.</div></div>
          <div class="row" style="gap:8px"><button class="btn ${rk.has ? "" : "primary"}" data-act="rpc-key">${rk.has ? "Make a new key" : "Make a key"}</button>${rk.has ? `<button class="btn" data-act="rpc-key-revoke">Revoke</button>` : ""}</div></div>
        ${state.rpcKey ? `<div class="hint" style="padding:12px 0 0">Shown once. Run this on your computer (it's remembered after that):<br><code style="user-select:all;word-break:break-all">UndertowRPC --server ${esc(location.origin)} --relay-key ${esc(state.rpcKey)}</code><div style="margin-top:8px"><button class="btn sm" data-act="rpc-key-copy">Copy the command</button></div></div>` : ""}
        <div class="hint" style="padding:10px 0 0">With the AppImage use <code>./UndertowRPC-x86_64.AppImage --server …</code>; on Windows, <code>UndertowRPC-windows-amd64.exe --server …</code> from a terminal. Stop the relay with <code>--no-relay</code>. Needs app v1.1 or newer.</div>
      </div>
      <div class="section-h rise"><h2>Get the app</h2></div>
      <div class="row rise" style="gap:10px;flex-wrap:wrap">${files.map((f, i) => `<a class="btn sm ${i ? "" : "primary"}" href="${esc(f.url)}" download title="${esc(f.name)} · SHA-256 ${esc(f.sha256 || "n/a")}">${icon("download")}${esc(f.label)} · ${kb(f.size)}</a>`).join("") || `<div class="empty card glass">The app isn't uploaded yet.</div>`}</div>
      <div class="hint rise" style="padding:6px 2px">v${esc(info.version)}. Hover a button for the file name and checksum.</div>
      <div class="card glass rise" style="border-radius:22px;padding:14px 18px;margin-top:12px"><div class="hint" style="padding:0">
        <b>Linux:</b> make it runnable once (<code>chmod +x UndertowRPC-x86_64.AppImage</code>), then start it. It stays in a terminal window while it runs.<br>
        <b>Windows:</b> it isn't code-signed, so SmartScreen may say "unknown publisher": More info, then Run anyway.<br>
        Discord's desktop app has to be open. The app only listens on 127.0.0.1:${info.port} (this computer) and only answers ${esc(location.host)} and the second player.</div></div>`;
  },
  async friends() {
    const [r, th] = await Promise.all([api("GET", "/friends"), api("GET", "/chat/threads").catch(() => ({ threads: [] }))]);
    state.friends = r;
    const unread = new Map(th.threads.map((t) => [t.friend, t.unread]));
    setBadge(r.incoming.length + [...unread.values()].reduce((a, b) => a + b, 0));
    const now = Date.now();
    const person = (x, right, sub, below = "") => `<div class="item glass rise">${avatar(x.user, 44)}<div class="grow"><div class="t">${esc(x.user.displayName)}</div><div class="s">${sub}</div>${below ? `<div class="row" style="margin-top:10px">${below}</div>` : ""}</div>${right}</div>`;
    return `<div class="row between rise"><h1>Friends</h1><button class="btn primary" data-act="add-friend">${icon("plus")}Add friend</button></div>
      ${r.incoming.length ? `<div class="section-h rise"><h2>Requests</h2></div><div class="list">${r.incoming.map((x) => person(x, "", `@${esc(x.user.username)} wants to be friends`, `<button class="btn sm primary" data-act="accept-friend" data-id="${x.id}">Accept</button><button class="btn sm" data-act="remove-friend" data-id="${x.id}" data-quiet="1">Decline</button>`)).join("")}</div>` : ""}
      ${r.friends.length ? `<div class="list">${r.friends.map((x) => { const l = x.listening, live = l && now - l.at < 5 * 60000;
        return `<button class="item glass rise" data-act="friend" data-id="${x.id}">${avatar(x.user, 44)}<div class="grow"><div class="t">${esc(x.user.displayName)} ${live ? `<span class="chip ok">Listening</span>` : ""}${unread.get(x.user.id) ? ` <span class="chip bad">${unread.get(x.user.id)} new</span>` : ""}</div><div class="s">${l ? `${live ? "" : "Last played "}${esc(l.track)} · ${ago(l.at)}` : `@${esc(x.user.username)}`}</div></div><span class="chat-pill" role="button" tabindex="0" data-act="chat" data-uid="${x.user.id}" aria-label="Message ${esc(x.user.displayName)}">${icon("chat")}</span></button>`; }).join("")}</div>`
      : `<div class="empty card glass rise">${r.incoming.length ? "" : "No friends yet. Add someone by their username."}</div>`}
      ${r.outgoing.length ? `<div class="section-h rise"><h2>Sent</h2></div><div class="list">${r.outgoing.map((x) => person(x, `<button class="btn sm" data-act="remove-friend" data-id="${x.id}" data-quiet="1">Cancel</button>`, `@${esc(x.user.username)} · waiting`)).join("")}</div>` : ""}`;
  },

  async users() {
    const [r, inv] = await Promise.all([api("GET", "/users"), api("GET", "/invites")]);
    state.users = r.users;
    const [set, ak, bot, lic] = await Promise.all([api("GET", "/settings"), api("GET", "/apikeys"), api("GET", "/discordbot"), api("GET", "/botlicenses")]);
    return `<div class="row between rise"><h1>Users</h1><div class="row"><button class="btn" data-act="invite">Invite</button><button class="btn primary" data-act="new-user">${icon("plus")}Add</button></div></div>
      <div class="card glass rise" style="border-radius:22px;padding:14px 16px"><div class="row between"><div><b>Members can create links</b><div class="hint" style="padding:0">Up to ${set.memberLinkMax} each, with default limits.</div></div>${sw("membersCreateLinks", set.membersCreateLinks)}</div></div>
      <div class="card glass rise" style="border-radius:22px;padding:14px 16px"><div class="row between"><div><b>Members can use the player</b><div class="hint" style="padding:0">Search and play from this site. Admins always can.</div></div>${sw("membersUsePlayer", set.membersUsePlayer)}</div></div>
      <div class="card glass rise" style="border-radius:22px;padding:14px 16px"><div class="row between"><div><b>Members can submit music videos</b><div class="hint" style="padding:0">A button in the player lets them pick a YouTube video for a song. Admins always can, and can change or remove any of them in Accounts.</div></div>${sw("membersSubmitVideos", set.membersSubmitVideos)}</div></div>
      <div class="section-h rise"><h2>API keys</h2><button class="btn sm" data-act="apikey-new">${icon("plus")}New key</button></div>
      ${bot.owner ? `<div class="card glass rise" style="border-radius:22px;padding:14px 16px"><div class="row between"><div><b>Discord bot</b><div class="hint" style="padding:0">${bot.configured ? `Token saved for <b>${esc(bot.name)}</b>. It stays on this server and is never shown again. The bot fetches it with an API key that has the Discord bot switch on.` : "Save the bot's token here, so it never has to be written in a file on the bot's machine."}</div></div><div class="row">${bot.configured ? `<button class="btn sm" data-act="copy" data-text="${esc(bot.invite)}">${icon("copy")}Invite link</button>` : ""}<button class="btn sm" data-act="bot-token">${bot.configured ? "Change" : "Set token"}</button></div></div></div>` : ""}
      ${lic.owner ? `<div class="section-h rise"><h2>Bot licenses</h2><button class="btn sm" data-act="license-new">${icon("plus")}New license</button></div>
      <div class="card glass rise" style="border-radius:22px;padding:14px 16px"><div class="hint" style="padding:0">The bot only works in Discord servers that hold a license. Make one for a user; they redeem it in their server with <b>/license</b>, and see it (with the bot's invite link) in their profile.</div>
        ${lic.licenses.length ? `<div class="list" style="margin-top:10px">${lic.licenses.map((l) => `<div class="item glass"><div class="grow"><div class="t">${esc(l.user?.displayName || "Removed user")} ${l.revoked ? `<span class="chip bad">Off</span>` : l.guild ? `<span class="chip ok">In use</span>` : `<span class="chip">Unused</span>`}</div><div class="s">${esc(l.code)}${l.label ? ` · ${esc(l.label)}` : ""}${l.guild ? ` · ${esc(l.guild.name || l.guild.id)}` : ""}</div></div><button class="btn sm" data-act="copy" data-text="${esc(l.code)}">${icon("copy")}Code</button><button class="btn sm" data-act="license-edit" data-id="${l.id}">Manage</button></div>`).join("")}</div>` : ""}</div>` : ""}
      <div class="card glass rise" style="border-radius:22px;padding:14px 16px"><div class="hint" style="padding:0">Lets other apps read song, album and artist details from this server. Details only unless a key is given audio streaming. Never video or lyrics. Docs: <a href="/v1/openapi.json" target="_blank" rel="noopener">/v1/openapi.json</a></div>
        ${ak.keys.length ? `<div class="list" style="margin-top:10px">${ak.keys.map((k) => `<div class="item glass"><div class="grow"><div class="t">${esc(k.name)} <span class="chip">${esc(k.prefix)}…</span>${k.stream ? ` <span class="chip">Audio</span>` : ""}${k.lyrics ? ` <span class="chip">Lyrics</span>` : ""}${k.bot ? ` <span class="chip">Bot</span>` : ""}</div><div class="s">${k.perMin}/min · ${nf.format(k.uses)} requests · ${k.lastUsed ? `used ${ago(k.lastUsed)}` : "never used"} · by ${esc(k.createdBy)}</div></div><div class="row"><button class="btn sm" data-act="apikey-edit" data-id="${k.id}">Edit</button><button class="btn sm danger" data-act="apikey-del" data-id="${k.id}" data-name="${esc(k.name)}">Remove</button></div></div>`).join("")}</div>` : ""}</div>
      <div class="list">${r.users.map((u) => `<button class="item glass rise" data-act="user" data-id="${u.id}">${avatar(u, 42)}<div class="grow"><div class="t">${esc(u.displayName)} ${roleChip(u)}${u.disabled ? ` <span class="chip bad">Disabled</span>` : ""}</div><div class="s">@${esc(u.username)} · ${u.stats.links} link${u.stats.links === 1 ? "" : "s"} · ${nf.format(u.stats.stream)} streams · seen ${ago(u.stats.lastSeen)}</div></div>${icon("chev", 'width="18" height="18" style="opacity:.4"')}</button>`).join("")}</div>
      ${inv.invites.length ? `<div class="section-h rise"><h2>Pending invites</h2></div><div class="list">${inv.invites.map((i) => `<div class="item inv glass rise"><div class="grow"><div class="t small">${esc(i.url)}</div><div class="s">${i.role === "admin" ? "Admin" : "Member"} · ${i.uses > 1 ? `${i.left} of ${i.uses} left` : "1 use"} · expires ${new Date(i.exp).toLocaleDateString()}</div>${i.message ? `<div class="s">“${esc(i.message)}”</div>` : ""}</div><button class="btn sm" data-act="copy" data-text="${esc(i.url)}">Copy</button><button class="btn sm danger" data-act="revoke-invite" data-code="${i.code}">Revoke</button></div>`).join("")}</div>` : ""}`;
  },
};
const hooks = {
  overview() {
    drawChart(!$("#view").classList.contains("still"));
    every(60000, () => { const ov = state.ov; if (ov) { ov.series.push({ stream: 0, search: 0 }); ov.series.shift(); drawChart(false); } });
    every(45000, () => show("overview", { anim: false }));
  },
  links() { every(15000, () => !sheetEl && show("links", { anim: false })); },
  accounts() { every(4000, () => !sheetEl && show("accounts", { anim: false })); },
  discord() { every(10000, () => !sheetEl && show("discord", { anim: false })); },
  friends() { every(15000, () => !sheetEl && show("friends", { anim: false })); },
  users() { every(30000, () => !sheetEl && show("users", { anim: false })); },
};
const accDot = (a) => ({ ok: "ok", starting: "warn", dead: "bad", down: "bad", disabled: "" }[a.status] || "");
const accText = (a) => ({ ok: "Ready", starting: "Starting…", dead: "Login failed", down: "Offline", disabled: "Disabled" }[a.status] || a.status);

function linkCard(l) {
  const L = l.limits, status = !l.enabled ? ["Disabled", ""] : l.expired ? ["Expired", "bad"] : ["Active", "ok"];
  const pills = [QNAME[L.maxQuality], L.atmos ? "Atmos" : "No Atmos", L.delayMs ? `+${L.delayMs / 1000}s delay` : "", L.perHour ? `${L.perHour}/hour` : "", L.perDay ? `${L.perDay}/day` : "", L.maxConcurrent ? `${L.maxConcurrent} at once` : ""].filter(Boolean);
  const kids = l.shared ? state.links.filter((x) => x.parent === l.id) : [], streams = l.totals.stream + kids.reduce((n, k) => n + k.totals.stream, 0), seen = Math.max(l.lastSeen || 0, ...kids.map((k) => k.lastSeen || 0)) || null;
  return `<button class="item glass rise" data-act="link" data-id="${l.id}" style="align-items:flex-start"><div class="grow">
    <div class="row between"><div class="t">${esc(l.name)}</div><span class="chip ${status[1]}">${status[0]}</span></div>
    <div class="s">${l.shared ? `Shared · ${kids.length} ${kids.length === 1 ? "person" : "people"} · ` : state.user.role === "admin" ? (l.guest ? "Guest · " : l.owner ? esc(l.owner.displayName) + " · " : "") : ""}${nf.format(streams)} streams · seen ${ago(seen)}</div>
    <div class="pills">${pills.map((p) => `<span class="chip">${esc(p)}</span>`).join("")}</div></div></button>`;
}

// ---- activity feed ---------------------------------------------------------------------------
const linkListHtml = () => {
  const admin = state.user.role === "admin", all = state.scope === "all" || !admin;
  const top = state.links.filter((x) => !x.parent); // the people under a shared link live inside its card
  const shown = all ? top : top.filter((x) => !x.userId || x.userId === state.user.id); // your own and guest links; other people's stay out of sight until asked for
  if (shown.length) return `<div class="list">${shown.map(linkCard).join("")}</div>`;
  const hidden = top.length - shown.length;
  return `<div class="empty card glass rise">${admin ? (hidden ? `You have no links of your own. ${hidden} belong${hidden === 1 ? "s" : ""} to other people (see Everyone).` : "No links yet. Create one for yourself or a friend.") : state.canCreate ? "You don't have a link yet. Tap New link to make one." : "You don't have a link yet. Ask the admin to turn on your own link."}</div>`;
};
const evMatch = (e) => state.filter === "all" || (state.filter === "bad" ? e.status >= 400 || e.notFound : e.kind === state.filter);
function evRow(e, isNew) {
  const nfound = e.notFound, bad = e.status >= 400 && !nfound;
  const chip = nfound ? `<span class="chip warn">Not found</span>` : bad ? `<span class="chip bad">${e.status}</span>` : e.cached ? `<span class="chip acc">Cached</span>` : "";
  const sp = e.ms < 800 ? "" : e.ms < 2500 ? "mid" : "slow";
  const meta = [e.user, e.device, e.quality && e.kind === "stream" ? (e.codec === "eac3-joc" ? "Atmos" : `${QNAME[e.quality] || e.quality}`) : "", fmtMs(e.ms)].filter(Boolean).join(" · ");
  return `<button class="ev glass${isNew ? " new" : ""}" data-act="event" data-id="${e.id}"><div class="l1"><span class="kind ${e.kind}">${icon(e.kind === "stream" ? "play" : e.kind === "search" ? "search" : "doc")}</span><span class="t">${esc(e.detail || (e.kind === "manifest" ? "Manifest" : e.kind))}</span>${clientChip(e)}${chip}</div>
    <div class="l2">${clock(e.t)} · ${esc(meta)}</div><div class="wf"><i class="${sp}" style="width:${Math.max(3, Math.min(100, e.ms / 40))}%"></i></div></button>`;
}
const feedHtml = () => { const rows = state.events.filter(evMatch); return rows.length ? rows.map((e) => evRow(e)).join("") : `<div class="empty card glass">No requests yet.</div>`; };

let es;
function startEvents() {
  es?.close();
  es = new EventSource("/api/events");
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (state.paused) return;
    state.events.unshift(e);
    if (state.events.length > 300) state.events.length = 300;
    liveEvent(e);
    const feed = $("#feed");
    if (state.tab === "activity" && feed && evMatch(e)) {
      $(".empty", feed)?.remove();
      feed.insertAdjacentHTML("afterbegin", evRow(e, true));
      while (feed.children.length > 150) feed.lastChild.remove();
    }
  };
}

// ---- link forms ------------------------------------------------------------------------------
const EXPIRY = [["never", "Never"], ["1", "In 1 day"], ["7", "In 7 days"], ["30", "In 30 days"]];
function linkForm(l) {
  const L = l?.limits || { atmos: true, downloads: false, losslessCheck: false, maxQuality: "HI_RES", delayMs: 0, perHour: 0, perDay: 0, maxConcurrent: 0, expiresAt: null };
  const users = state.users, accts = state.accounts;
  return `<h2>${l ? "Edit link" : "New link"}</h2>
    <label class="field"><span>Name</span><input class="input" data-f="name" value="${esc(l?.name || "")}" maxlength="40" placeholder="Alex's phone"></label>
    <label class="field"><span>Belongs to</span><select class="input" data-f="userId">${users.map((u) => `<option value="${u.id}" ${!l?.guest && (l?.owner?.id || state.user.id) === u.id ? "selected" : ""}>${esc(u.displayName)} (@${esc(u.username)})</option>`).join("")}<option value="guest" ${l?.guest ? "selected" : ""}>Guest (no account, admins manage it)</option></select></label>
    ${l?.parent ? "" : `<div class="row between"><div><b>Shared link</b><div class="hint" style="padding:0">One link for many friends. Each gets their own link from an invite page, so you still see everyone's streams and searches.</div></div>${sw("shared", l?.shared)}</div>`}
    <label class="field"><span>TIDAL account</span><select class="input" data-f="accountId"><option value="">Any (least busy)</option>${accts.map((a) => `<option value="${a.id}" ${l?.accountId === a.id ? "selected" : ""}>${esc(a.label)}</option>`).join("")}</select></label>
    <div class="field"><span>Best quality allowed</span>${seg("maxQuality", [["HI_RES", "Hi-res"], ["CD", "CD"], ["HIGH", "High"], ["LOW", "Low"]], L.maxQuality)}</div>
    <div class="row between"><div><b>Dolby Atmos</b><div class="hint" style="padding:0">Off hides Atmos-only releases.</div></div>${sw("atmos", L.atmos)}</div>
    <div class="row between"><div><b>Downloads</b><div class="hint" style="padding:0">Lets BitChord save tracks.</div></div>${sw("downloads", L.downloads)}</div>
    <div class="row between"><div><b>Lossless check</b><div class="hint" style="padding:0">Only used on wired, USB, HDMI, LDAC or LHDC output.</div></div>${sw("losslessCheck", L.losslessCheck)}</div>
    <div class="field"><span>Delay per stream · <b id="delayv">${L.delayMs / 1000}s</b></span><input type="range" data-f="delayMs" min="0" max="10000" step="500" value="${L.delayMs}"><div class="hint">Wait added before each track.</div></div>
    <div class="row"><label class="field grow"><span>Streams / hour</span><input class="input" data-f="perHour" type="number" inputmode="numeric" min="0" value="${L.perHour}"></label><label class="field grow"><span>Streams / day</span><input class="input" data-f="perDay" type="number" inputmode="numeric" min="0" value="${L.perDay}"></label><label class="field grow"><span>At once</span><input class="input" data-f="maxConcurrent" type="number" inputmode="numeric" min="0" value="${L.maxConcurrent}"></label></div>
    <div class="hint" style="margin-top:-6px">0 means no limit. Prefetched tracks count as streams.</div>
    <label class="field"><span>Expires</span><select class="input" data-f="expiry">${l?.limits.expiresAt ? `<option value="keep">${new Date(l.limits.expiresAt).toLocaleDateString()} (current)</option>` : ""}${EXPIRY.map(([v, t]) => `<option value="${v}" ${!l?.limits.expiresAt && v === "never" ? "selected" : ""}>${t}</option>`).join("")}</select></label>
    <div class="err" role="alert"></div>
    <button class="btn primary" data-act="save-link" ${l ? `data-id="${l.id}"` : ""}>${l ? "Save changes" : "Create link"}</button>`;
}
function readLinkForm(root) {
  const f = (k) => $(`[data-f="${k}"]`, root).value, exp = f("expiry");
  const limits = { maxQuality: segVal(root, "maxQuality"), atmos: swVal(root, "atmos"), downloads: swVal(root, "downloads"), losslessCheck: swVal(root, "losslessCheck"), delayMs: +f("delayMs"), perHour: +f("perHour") || 0, perDay: +f("perDay") || 0, maxConcurrent: +f("maxConcurrent") || 0 };
  if (exp !== "keep") limits.expiresAt = exp === "never" ? null : Date.now() + +exp * 86400000;
  return { name: f("name"), userId: f("userId"), accountId: f("accountId") || null, limits, ...($('[data-sw="shared"]', root) ? { shared: swVal(root, "shared") } : {}) };
}

function sharedBlock(l) { // who is on a shared link, their stats, and the invite they join from
  const kids = state.links.filter((x) => x.parent === l.id).sort((a, b) => (b.totals.stream + b.totals.search) - (a.totals.stream + a.totals.search));
  return `<div><div class="row between" style="margin-bottom:6px"><span class="hint" style="padding:0">People (${kids.length})</span><button class="btn sm" data-act="add-person" data-id="${l.id}">${icon("plus")}Add</button></div>
    ${kids.length ? `<div class="list">${kids.map((k) => `<button class="item glass" data-act="link" data-id="${k.id}"><div class="grow"><div class="t">${esc(k.name)}${k.enabled ? "" : " · off"}</div><div class="s">${nf.format(k.totals.stream)} streams · ${nf.format(k.totals.search)} searches · seen ${ago(k.lastSeen)}</div></div></button>`).join("")}</div>` : `<div class="hint" style="padding:0">Nobody yet. Share the invite below, or add someone yourself.</div>`}</div>
    <div><div class="hint" style="margin-bottom:6px">Invite link: friends open it and get their own link</div><div class="urlbox"><code>${esc(l.joinUrl)}</code><button class="btn sm" data-act="copy" data-text="${esc(l.joinUrl)}">${icon("copy")}Copy</button></div>
      <div class="row between" style="margin-top:10px"><b>Open to new people</b><button type="button" class="switch" role="switch" aria-checked="${l.joinOpen}" data-sw="joinOpen" data-id="${l.id}"></button></div>
      <button class="btn sm" data-act="rotate-join" data-id="${l.id}" style="margin-top:8px">New invite URL</button></div>`;
}
function videoTiming(v = {}) { // by-hand timing for a video; blank means the server works it out itself
  return `<div class="row"><label class="field grow"><span>Starts at (s)</span><input class="input" data-f="offset" type="number" inputmode="decimal" step="0.1" min="-120" max="120" value="${Number.isFinite(v.offset) ? v.offset : ""}" placeholder="Auto"></label>
    <label class="field grow"><span>Music ends (s)</span><input class="input" data-f="end" type="number" inputmode="decimal" step="0.1" min="0" value="${v.end || ""}" placeholder="Auto"></label></div>
    <div class="hint" style="margin-top:-6px">Starts at: how far into the video the song begins (12 for a 12-second intro, negative if the video starts late). Music ends: where the music stops in the video, so an outro never shows. Blank means automatic.</div>`;
}
function linkDetail(l) {
  const L = l.limits, admin = state.user.role === "admin", u = l.usage;
  const meter = (n, max) => (max ? `<div class="bar" style="margin-top:6px"><i style="width:${Math.min(100, (n / max) * 100)}%"></i></div>` : "");
  return `<div class="row between"><h2>${esc(l.name)}</h2><span class="chip ${!l.enabled ? "" : l.expired ? "bad" : "ok"}">${!l.enabled ? "Disabled" : l.expired ? "Expired" : "Active"}</span></div>
    ${l.parent ? `<div class="muted small" style="margin-top:-8px">Part of ${esc(state.links.find((x) => x.id === l.parent)?.name || "a shared link")}</div>` : ""}
    <div><div class="hint" style="margin-bottom:6px">Source URL for BitChord</div><div class="urlbox"><code id="linkurl">${esc(l.url)}</code><button class="btn sm" data-act="copy-link" data-url="${esc(l.url)}">${icon("copy")}Copy</button></div></div>
    <div class="field"><span>Name in BitChord</span><div class="row"><input class="input grow" id="addonname" value="${esc(l.addonName || "")}" placeholder="${esc(state.appName)}" maxlength="40"><button class="btn" data-act="save-addon-name" data-id="${l.id}">Save</button></div><span class="hint" style="padding:0">Name shown in BitChord. Refresh the source to update it.</span></div>
    <div><div class="hint" style="margin-bottom:6px">Source URL for Eclipse</div><div class="urlbox"><code>${esc(l.url)}/eclipse</code><button class="btn sm" data-act="copy" data-text="${esc(l.url)}/eclipse">${icon("copy")}Copy</button></div></div>
    <label class="field"><span>Device name (optional)</span><input class="input" id="devname" placeholder="Phone" maxlength="32" autocapitalize="none" autocorrect="off" data-url="${esc(l.url)}"><span class="hint" style="padding:0">Shown in Activity.</span></label>
    <dl class="kv card glass" style="margin:0;border-radius:20px;padding:14px 16px">
      <dt>Quality</dt><dd>${QNAME[L.maxQuality]}</dd><dt>Dolby Atmos</dt><dd>${L.atmos ? "Allowed" : "Blocked"}</dd><dt>Delay</dt><dd>${L.delayMs ? `${L.delayMs / 1000}s` : "None"}</dd><dt>Downloads</dt><dd>${L.downloads ? "Allowed" : "Blocked"}</dd><dt>Lossless check</dt><dd>${L.losslessCheck ? "On" : "Off"}</dd>
      <dt>Account</dt><dd>${l.accountId ? esc(state.accounts.find((a) => a.id === l.accountId)?.label || "Pinned") : "Any"}</dd><dt>Expires</dt><dd>${L.expiresAt ? new Date(L.expiresAt).toLocaleString() : "Never"}</dd></dl>
    <div class="card glass" style="border-radius:20px;padding:14px 16px"><div class="row between"><span>This hour</span><b>${u.hour}${L.perHour ? ` / ${L.perHour}` : ""}</b></div>${meter(u.hour, L.perHour)}
      <div class="row between" style="margin-top:12px"><span>Last 24 h</span><b>${u.day}${L.perDay ? ` / ${L.perDay}` : ""}</b></div>${meter(u.day, L.perDay)}
      <div class="row between small muted" style="margin-top:12px"><span>${nf.format(l.totals.stream)} streams · ${nf.format(l.totals.search)} searches</span><span>${l.totals.notFound} not found</span></div></div>
    ${l.shared && admin ? sharedBlock(l) : ""}
    ${l.devices.length ? `<div><div class="hint" style="margin-bottom:6px">Devices</div><div class="list">${l.devices.map((d) => `<div class="row small"><span class="grow" style="font-weight:620">${esc(d.name)}</span><span class="muted">${d.stream} streams · ${ago(d.lastSeen)}</span></div>`).join("")}</div></div>` : ""}
    ${admin ? `<div class="row wrap"><button class="btn grow" data-act="edit-link" data-id="${l.id}">Edit</button><button class="btn grow" data-act="toggle-link" data-id="${l.id}">${l.enabled ? "Disable" : "Enable"}</button></div>
    <div class="row wrap"><button class="btn grow" data-act="rotate-link" data-id="${l.id}">New URL</button><button class="btn grow danger" data-act="delete-link" data-id="${l.id}">Delete</button></div>` : state.membersCreate ? `<button class="btn danger" data-act="delete-link" data-id="${l.id}">Delete</button>` : ""}`;
}

// ---- TIDAL connect flow ----------------------------------------------------------------------
async function connectFlow() {
  let timer, dead = false;
  const sh = openSheet(`<div class="ring">${icon("links")}</div><p class="muted center">Asking TIDAL for a login link…</p>`, () => { dead = true; clearInterval(timer); });
  try {
    const login = await api("POST", "/accounts/login");
    if (dead) return;
    const draw = (secs) => setSheet(`<div class="ring">${icon("links")}</div><div class="center"><h2>Connect a TIDAL account</h2><p class="muted" style="margin-top:6px">Open the link and approve it with the TIDAL account to add.</p></div>
      <a class="btn primary" href="${esc(login.url)}" target="_blank" rel="noopener noreferrer">Open ${esc(login.display)}</a>
      <div class="big-code mono">${esc(login.display)}</div>
      <p class="small muted center">Waiting for approval · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}</p>`);
    draw(Math.max(0, Math.round((login.expiresAt - Date.now()) / 1000)));
    let tick = 0;
    timer = setInterval(async () => {
      if (dead) return;
      const left = Math.max(0, Math.round((login.expiresAt - Date.now()) / 1000));
      tick++;
      if (tick % 2 === 0) {
        const s = await api("GET", `/accounts/login/${login.id}`).catch(() => null);
        if (s?.status === "done") { clearInterval(timer); return finish(s.account); }
        if (s && s.status !== "pending") { clearInterval(timer); return fail(s.status === "expired" ? "That link expired." : s.error || "TIDAL said no."); }
      }
      if (!dead && !$(".tick", sheetEl)) { const p = $(".small.muted.center", sheetEl); if (p) p.textContent = `Waiting for approval · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`; }
    }, 1000);
  } catch (e) { fail(e.message); }
  function finish(a) {
    setSheet(`<svg class="tick" viewBox="0 0 76 76"><circle cx="38" cy="38" r="30"/><path d="M26 39l9 9 16-18"/></svg><div class="center"><h2>${esc(a.label)} is connected</h2><p class="muted" style="margin-top:6px">${a.plan ? `Plan: ${esc(a.plan)}${a.quality ? ` · up to ${esc(a.quality)}` : ""}. ` : ""}It's already in rotation.</p></div>
      <div class="row"><button class="btn grow" data-act="connect">Add another</button><button class="btn primary grow" data-act="sheet-no">Done</button></div>`);
    if (state.tab === "accounts") show("accounts", { anim: false });
  }
  function fail(msg) { setSheet(`<div class="center"><h2>Couldn't connect</h2><p class="muted" style="margin-top:6px">${esc(msg)}</p></div><button class="btn primary" data-act="connect">Try again</button>`); }
}

// Direct streaming puts the server's login in the stream links, so asking twice is on purpose.
async function confirmDirect() {
  const save = $('[data-act="update-subsonic"]', sheetEl), id = save.dataset.id;
  const draft = { label: $('[data-f="label"]', sheetEl).value, enabled: swVal(sheetEl, "enabled"), normalize: swVal(sheetEl, "normalize"), password: $('[data-f="password"]', sheetEl).value, direct: false };
  const ok = (await confirmSheet("Send audio straight from this server?", "Listeners will connect to your Subsonic server themselves, not through Undertow. Link limits and the activity log won't see those plays.", "Continue"))
    && (await confirmSheet("The stream link includes the login", "Anyone who gets a stream link can use this server's login. Only turn this on for an account you're fine sharing, like a read-only one.", "Turn on"));
  actions.subsonic({ dataset: { id } }, null, { ...draft, direct: !!ok });
}

// ---- chats: the module loads the first time a chat is opened ----
const assetV = () => new URL($('script[src*="/app.js"]').src).search;
const chatMod = async () => (state.chatMod ||= await import(`/chat.js${assetV()}`));
const playerCtx = () => ({ name: () => state.user?.displayName, api, toast, esc, icon, store, reduce, softwareGl, lastfm: () => state.user?.lastfm, lastfmGone: () => { if (state.user) state.user.lastfm = null; }, share: async (t) => { try { (await chatMod()).share(chatCtx(), t); } catch { toast("Couldn't open chats", true); } } });
const chatCtx = () => ({ api, toast, esc, icon, store, reduce, avatar, myId: state.user.id, refreshBadge: updateBadge,
  nowPlaying: () => state.playerMod?.current?.() || null,
  playTrack: async (t) => { try { state.playerMod ||= await import(`/player.js${assetV()}`); state.playerMod.playTrack(playerCtx(), t); } catch { toast("Couldn't start the song", true); } } });

// ---- actions ---------------------------------------------------------------------------------
const guard = async (btn, fn) => { btn && (btn.disabled = true); try { await fn(); } catch (e) { toast(e.message, true); const er = $(".err", sheetEl || document); if (er) er.textContent = e.message; } finally { btn && (btn.disabled = false); } };
// Last.fm may leave the person on its own page. Back in the app, the connection is finished from here.
let lfBusy = false;
async function lastfmReturn() {
  const at = Number(store.get("lf.pending") || 0);
  if (!at || lfBusy || !state.user) return;
  if (Date.now() - at > 30 * 60000) return store.set("lf.pending", "");
  lfBusy = true;
  try {
    const r = await api("POST", "/lastfm/finish");
    if (r.state === "waiting") return;
    store.set("lf.pending", "");
    if (r.user) state.user = r.user;
    if (r.state === "ok") { toast("Last.fm connected. Songs you play are scrobbled."); if (sheetEl) { closeSheet(true); renderShell(); show(state.tab, { anim: false }); actions.profile(); } }
    else if (r.state === "error") toast("Couldn't connect Last.fm. Try again.", true);
  } catch { /* try again next time */ } finally { lfBusy = false; }
}
addEventListener("pageshow", () => lastfmReturn());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") lastfmReturn(); });
const afterProfileChange = () => { closeSheet(true); renderShell(); show(state.tab, { anim: false }); actions.profile(); };
// Pick a photo, then drag and zoom it under a round frame; what's inside the frame is what gets uploaded.
async function uploadPhoto(file) {
  let bmp;
  const gif = file.type === "image/gif";
  if (gif && file.size > 6 * 1024 * 1024) return toast("That GIF is over 6 MB", true);
  try { bmp = await createImageBitmap(file); } catch { return toast("Couldn't use that image", true); }
  const D = Math.min(320, innerWidth - 80), S = 320, dpr = Math.min(devicePixelRatio || 1, 2);
  const min = D / Math.min(bmp.width, bmp.height); // smallest zoom that still fills the frame
  let k = min, x = 0, y = 0; // zoom, and the image centre's offset from the frame centre
  const sh = openSheet(`<h2>Crop photo</h2><div class="crop" style="width:${D}px;height:${D}px"><canvas width="${D * dpr}" height="${D * dpr}" style="width:${D}px;height:${D}px"></canvas><i class="crop-ring"></i></div>
    <input type="range" class="crop-zoom" min="1" max="4" step="0.01" value="1" aria-label="Zoom"><div class="hint center">Drag to move, pinch or slide to zoom.${gif ? " The preview shows the first frame; it will animate once saved." : ""}</div>
    <div class="err" role="alert"></div><div class="row"><button class="btn grow" data-act="sheet-no">Cancel</button><button class="btn primary grow" data-act="crop-save">Save photo</button></div>`, () => bmp.close?.());
  const cv = $("canvas", sh), ctx = cv.getContext("2d"), zoom = $(".crop-zoom", sh);
  const clamp = () => { const mx = Math.max(0, (bmp.width * k - D) / 2), my = Math.max(0, (bmp.height * k - D) / 2); x = Math.min(mx, Math.max(-mx, x)); y = Math.min(my, Math.max(-my, y)); };
  const draw = () => { clamp(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, D, D); ctx.drawImage(bmp, D / 2 + x - (bmp.width * k) / 2, D / 2 + y - (bmp.height * k) / 2, bmp.width * k, bmp.height * k); };
  const setZoom = (z) => { z = Math.min(4, Math.max(1, z)); const r = (min * z) / k; x *= r; y *= r; k = min * z; zoom.value = z; draw(); };
  draw();
  zoom.addEventListener("input", () => setZoom(+zoom.value));
  cv.addEventListener("wheel", (e) => { e.preventDefault(); setZoom(k / min * Math.exp(-e.deltaY / 400)); }, { passive: false });
  const pts = new Map(); let pinch = 0;
  cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); pinch = 0; });
  cv.addEventListener("pointermove", (e) => {
    const p = pts.get(e.pointerId); if (!p) return;
    if (pts.size === 1) { x += e.clientX - p[0]; y += e.clientY - p[1]; pts.set(e.pointerId, [e.clientX, e.clientY]); draw(); return; }
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (pinch) setZoom(k / min * (d / pinch)); pinch = d;
  });
  const up = (e) => { pts.delete(e.pointerId); pinch = 0; };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  actions["crop-save"] = (btn) => guard(btn, async () => {
    const c = Object.assign(document.createElement("canvas"), { width: S, height: S }), f = S / D, g = c.getContext("2d");
    g.fillStyle = "#000"; g.fillRect(0, 0, S, S);
    g.drawImage(bmp, (D / 2 + x - (bmp.width * k) / 2) * f, (D / 2 + y - (bmp.height * k) / 2) * f, bmp.width * k * f, bmp.height * k * f);
    let url = "/api/me/avatar", type = "image/jpeg", blob;
    if (gif) { // an animated picture goes up as it is, with the frame to cut; the server crops every frame
      const side = D / k, sx = D / 2 + x - (bmp.width * k) / 2, sy = D / 2 + y - (bmp.height * k) / 2; // where the frame sits on the picture
      const cx = Math.max(0, Math.round(-sx / k)), cy = Math.max(0, Math.round(-sy / k)), cw = Math.min(Math.round(side), bmp.width - cx, bmp.height - cy);
      url += `?x=${cx}&y=${cy}&w=${cw}&h=${cw}`; type = "image/gif"; blob = file;
    } else blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.86));
    const r = await fetch(url, { method: "POST", headers: { "x-requested-with": "ui", "content-type": type }, body: blob });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    state.user = d.user;
    afterProfileChange();
    toast("Photo updated");
  });
}
document.addEventListener("change", (e) => { if (e.target.id === "photo" && e.target.files[0]) { const f = e.target.files[0]; e.target.value = ""; uploadPhoto(f); } });
function setBadge(n) { const b = $('.nav [data-tab="friends"]'); if (b) n ? b.setAttribute("data-badge", n) : b.removeAttribute("data-badge"); }
const updateBadge = () => Promise.all([api("GET", "/friends"), api("GET", "/chat/threads").catch(() => ({ threads: [] }))])
  .then(([r, th]) => setBadge(r.incoming.length + th.threads.reduce((a, t) => a + t.unread, 0))).catch(() => {});
const refresh = () => show(state.tab, { anim: false });
const rand = (n = 12) => { const c = "abcdefghijkmnpqrstuvwxyz23456789", a = crypto.getRandomValues(new Uint8Array(n)); return [...a].map((x) => c[x % c.length]).join(""); };

const actions = {
  tab: (el) => go(el.dataset.tab),
  copy: (el) => copy(el.dataset.text),
  "rpc-recheck": () => show("discord", { anim: false }),
  "rpc-relay": () => { const R = window.UndertowRPC; R.setRelay(!R.relayEnabled()); toast(R.relayEnabled() ? "This browser now tells Undertow what it plays" : "Stopped telling Undertow"); show("discord", { anim: false }); },
  "rpc-key": async () => { try { const r = await api("POST", "/rpc/key"); state.rpcKey = r.key; show("discord", { anim: false }); } catch (e) { toast(e.message, true); } },
  "rpc-key-copy": () => copy(`UndertowRPC --server ${location.origin} --relay-key ${state.rpcKey}`),
  "rpc-key-revoke": async () => { if (await confirmSheet("Revoke the key?", "The app on your computer stops showing phone playback until you give it a new key.", "Revoke")) { try { await api("DELETE", "/rpc/key"); state.rpcKey = null; toast("Key revoked"); show("discord", { anim: false }); } catch (e) { toast(e.message, true); } } },
  "rpc-toggle": () => { const R = window.UndertowRPC; R.setEnabled(!R.enabled()); toast(R.enabled() ? "Discord presence on" : "Discord presence off"); show("discord", { anim: false }); },
  "rpc-test": async () => { try { await window.UndertowRPC.send({ title: "Test card", artist: "Undertow", album: "", durationMs: 180000, positionMs: 0, playing: true, source: "test" }); toast("Sent. Check your Discord profile."); setTimeout(() => window.UndertowRPC.clear(), 15000); } catch { toast("Couldn't reach the app", true); } },
  "sheet-no": () => closeSheet(),
  pause() { state.paused = !state.paused; const b = $(".live"); b.setAttribute("aria-pressed", state.paused); $(".dot", b).classList.toggle("ok", !state.paused); $("#livetxt").textContent = state.paused ? "Paused" : "Live"; if (!state.paused) show("activity", { anim: false }); },
  event(el) {
    const e = state.events.find((x) => x.id === +el.dataset.id);
    if (!e) return;
    const rows = [["Time", new Date(e.t).toLocaleString()], ["App", (CLIENTS[e.client] || CLIENTS.bitchord)[0]], ["Type", e.kind], ["Detail", e.detail], e.query && ["Options sent", e.query], ["Status", e.notFound ? `${e.status} · not found` : e.status], ["Took", fmtMs(e.ms)], ["User", e.user], ["Device", e.device], ["Link", e.linkName], e.account && ["TIDAL account", e.account], e.quality && ["Quality", QNAME[e.quality] || e.quality], e.codec && ["Codec", e.codec], e.cached && ["Served from", "cache"], e.error && ["Error", e.error]].filter(Boolean);
    openSheet(`<h2>Request</h2><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`);
  },
  link: (el) => openSheet(linkDetail(state.links.find((l) => l.id === el.dataset.id))),
  "add-person": (el) => openSheet(`<h2>Add a friend</h2><label class="field"><span>Name</span><input class="input" data-f="pname" maxlength="32" placeholder="Alex" autocomplete="off"></label><div class="err" role="alert"></div><button class="btn primary" data-act="save-person" data-id="${el.dataset.id}">Add</button>`),
  "save-person": (el) => guard(el, async () => {
    const r = await api("POST", `/links/${el.dataset.id}/people`, { name: $('[data-f="pname"]', sheetEl).value });
    state.links.push(r.link); closeSheet(true); openSheet(linkDetail(r.link)); toast("Added. Send them their link");
  }),
  "rotate-join": async (el) => { if (await confirmSheet("Make a new invite URL?", "The old invite page stops working. People who already joined keep their links.", "New URL")) guard(null, async () => { await api("PATCH", `/links/${el.dataset.id}`, { rotateJoin: true }); closeSheet(true); toast("New invite URL ready"); refresh(); }); },
  "save-addon-name": (el) => guard(el, async () => {
    const r = await api("PATCH", `/links/${el.dataset.id}`, { addonName: $("#addonname").value });
    const i = state.links.findIndex((x) => x.id === r.link.id);
    if (i >= 0) state.links[i] = r.link;
    toast(r.link.addonName ? "Name saved" : `Back to ${state.appName}`);
  }),
  "copy-link"(el) { const n = $("#devname")?.value.trim(); copy(n ? `${el.dataset.url}?name=${encodeURIComponent(n)}` : el.dataset.url); },
  "new-link": () => openSheet(state.user.role === "admin" ? linkForm() : `<h2>New link</h2><label class="field"><span>Name</span><input class="input" data-f="name" maxlength="40" placeholder="My phone"></label><div class="err" role="alert"></div><button class="btn primary" data-act="save-link">Create link</button>`),
  "edit-link": (el) => openSheet(linkForm(state.links.find((l) => l.id === el.dataset.id))),
  "save-link": (el) => guard(el, async () => {
    const body = state.user.role === "admin" ? readLinkForm(sheetEl) : { name: $('[data-f="name"]', sheetEl).value };
    if (el.dataset.id) await api("PATCH", `/links/${el.dataset.id}`, body); else await api("POST", "/links", body);
    closeSheet(); toast("Saved"); refresh();
  }),
  "toggle-link": (el) => guard(el, async () => { const l = state.links.find((x) => x.id === el.dataset.id); await api("PATCH", `/links/${l.id}`, { enabled: !l.enabled }); closeSheet(); refresh(); }),
  "rotate-link": async (el) => { if (await confirmSheet("Make a new URL?", "The current URL stops working immediately. Anyone using it has to be given the new one.", "New URL")) guard(null, async () => { await api("POST", `/links/${el.dataset.id}/rotate`); toast("New URL ready"); refresh(); }); },
  "delete-link": async (el) => { if (await confirmSheet("Delete this link?", "It stops working right away and its stats are removed.")) guard(null, async () => { await api("DELETE", `/links/${el.dataset.id}`); toast("Link deleted"); refresh(); }); },

  async chat(el) { // a private chat with a friend
    const x = state.friends?.friends.find((f) => f.user.id === el.dataset.uid); if (!x) return;
    closeSheet(true);
    try { const m = await chatMod(); m.openChat(chatCtx(), x.user); } catch { toast("Couldn't open the chat", true); }
  },
  async player() { // the player loads the first time it's opened
    try {
      const v = new URL($('script[src*="/app.js"]').src).search;
      state.playerMod = await import(`/player.js${v}`);
      state.playerMod.openPlayer(playerCtx());
    } catch { toast("Couldn't open the player", true); }
  },
  connect: () => connectFlow(),
  account(el) {
    const a = state.accounts.find((x) => x.id === el.dataset.id);
    openSheet(`<div class="row"><span class="dot ${accDot(a)}"></span><h2 class="grow">${esc(a.label)}</h2>${a.plan ? `<span class="chip">${esc(a.plan)}</span>` : ""}</div>
      <label class="field"><span>Label</span><input class="input" data-f="label" value="${esc(a.label)}" maxlength="30"></label>
      <dl class="kv"><dt>Status</dt><dd>${accText(a)}</dd><dt>Calls</dt><dd>${nf.format(a.requests)} (${a.errors} failed)</dd><dt>Avg time</dt><dd>${a.avgMs ? fmtMs(a.avgMs) : "—"}</dd><dt>Max quality</dt><dd>${esc(a.quality || "unknown")}</dd><dt>Last good call</dt><dd>${ago(a.lastOkAt)}</dd>${a.lastError ? `<dt>Last error</dt><dd>${esc(a.lastError)}</dd>` : ""}</dl>
      <div class="row between"><b>In rotation</b>${sw("enabled", a.enabled)}</div><div class="err" role="alert"></div>
      <button class="btn primary" data-act="save-account" data-id="${a.id}">Save</button>
      <div class="row wrap"><button class="btn grow" data-act="restart-account" data-id="${a.id}">Restart</button>${a.status === "dead" ? `<button class="btn grow" data-act="connect">Reconnect</button>` : ""}${a.kind === "managed" ? `<button class="btn grow danger" data-act="remove-account" data-id="${a.id}">Remove</button>` : ""}</div>`);
  },
  "new-subsonic"() {
    openSheet(`<h2>Add a Subsonic server</h2>
      <label class="field"><span>Name</span><input class="input" data-f="label" maxlength="30" placeholder="gonic" autocomplete="off"></label>
      <label class="field"><span>Address</span><input class="input" data-f="url" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="https://gonic.example.com" autocomplete="off"></label>
      <label class="field"><span>Username</span><input class="input" data-f="username" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off"></label>
      <label class="field"><span>Password</span><input class="input" data-f="password" type="password" autocomplete="new-password"></label>
      <p class="small muted">The password is used once to sign in. Only a salted token is kept, and nobody can see it.</p>
      <div class="err" role="alert"></div><button class="btn primary" data-act="save-subsonic">Add server</button>`);
  },
  "save-subsonic": (el) => guard(el, async () => {
    const f = (n) => $(`[data-f="${n}"]`, sheetEl).value;
    await api("POST", "/subsonic", { label: f("label"), url: f("url"), username: f("username"), password: f("password") });
    closeSheet(); toast("Server added"); refresh();
  }),
  subsonic(el, _e, draft) {
    const x = { ...state.subsonic.find((v) => v.id === el.dataset.id), ...draft };
    openSheet(`<div class="row"><span class="dot ${accDot(x)}"></span><h2 class="grow">${esc(x.label)}</h2></div>
      <label class="field"><span>Name</span><input class="input" data-f="label" value="${esc(x.label)}" maxlength="30"></label>
      <dl class="kv"><dt>Address</dt><dd>${esc(x.url)}</dd><dt>User</dt><dd>${esc(x.username)}</dd><dt>Calls</dt><dd>${nf.format(x.requests)} (${x.errors} failed)</dd><dt>Avg time</dt><dd>${x.avgMs ? fmtMs(x.avgMs) : "—"}</dd><dt>Last good call</dt><dd>${ago(x.lastOkAt)}</dd>${x.lastError ? `<dt>Last error</dt><dd>${esc(x.lastError)}</dd>` : ""}</dl>
      <label class="field"><span>New password</span><input class="input" data-f="password" type="password" autocomplete="new-password" value="${esc(draft?.password || "")}" placeholder="Leave empty to keep the current one"></label>
      <div class="row between"><b>Use as backup</b>${sw("enabled", x.enabled)}</div>
      <div class="row between"><div><b>Send listeners directly</b><div class="small muted">Audio skips this server, but the stream link carries its login. Needs https.</div></div>${sw("direct", x.direct)}</div><div class="row between"><div><b>Normalize volume</b><div class="small muted">Brings quiet songs up to a standard loudness. Songs are re-encoded: lossless stays lossless, anything else becomes AAC. Always goes through Undertow.</div></div>${sw("normalize", x.normalize)}</div><div class="err" role="alert"></div>
      <button class="btn primary" data-act="update-subsonic" data-id="${x.id}">Save</button>
      <div class="row wrap"><button class="btn grow" data-act="test-subsonic" data-id="${x.id}">Test</button><button class="btn grow danger" data-act="remove-subsonic" data-id="${x.id}">Remove</button></div>`);
  },
  "new-video"() {
    openSheet(`<h2>Pick a video for a song</h2>
      <label class="field"><span>Song</span><input class="input" data-f="title" maxlength="120" autocomplete="off"></label>
      <label class="field"><span>Artist</span><input class="input" data-f="artist" maxlength="80" autocomplete="off"></label>
      <label class="field"><span>Video link</span><input class="input" data-f="link" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="YouTube, or any site yt-dlp supports" autocomplete="off"></label>
      <p class="small muted">Use the title and artist exactly as Eclipse shows them. Unlisted links work, and so does any site yt-dlp can read.</p>
      ${videoTiming()}
      <div class="err" role="alert"></div><button class="btn primary" data-act="save-video">Save</button>`);
  },
  "save-video": (el) => guard(el, async () => {
    const f = (n) => $(`[data-f="${n}"]`, sheetEl).value;
    await api("POST", "/videos", { key: el.dataset.key, title: f("title"), artist: f("artist"), link: f("link"), offset: f("offset"), end: f("end"), hidden: $('[data-sw="show"]', sheetEl) ? !swVal(sheetEl, "show") : false });
    closeSheet(); toast("Video saved"); refresh();
  }),
  video(el) { // change anything about a song's video: which one, how it lines up with the song, or whether it shows at all
    const v = state.videos.find((x) => x.key === el.dataset.key), url = v.url || `https://youtu.be/${v.id}`;
    openSheet(`<h2>${esc(v.title)}</h2>${v.by ? `<p class="muted small" style="margin-top:-8px">Submitted by ${esc(v.by.name)}</p>` : ""}
      <label class="field"><span>Song</span><input class="input" data-f="title" maxlength="120" value="${esc(v.title)}" autocomplete="off"></label>
      <label class="field"><span>Artist</span><input class="input" data-f="artist" maxlength="80" value="${esc(v.artist || "")}" autocomplete="off"></label>
      <label class="field"><span>Video link</span><input class="input" data-f="link" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="${esc(url)}" autocomplete="off"><span class="hint" style="padding:0">Leave it blank to keep the current video.</span></label>
      <div class="urlbox"><code>${esc(url)}</code><button class="btn sm" data-act="copy" data-text="${esc(url)}">${icon("copy")}Copy</button></div>
      ${videoTiming(v)}
      <div class="row between"><div><b>Show this video</b><div class="hint" style="padding:0">Off plays the song with its cover, never a video.</div></div>${sw("show", !v.hidden)}</div>
      <div class="err" role="alert"></div><button class="btn primary" data-act="save-video" data-key="${esc(v.key)}">Save</button>
      <button class="btn danger" data-act="remove-video" data-key="${esc(v.key)}">Remove</button>`);
  },
  "remove-video": async (el) => { if (await confirmSheet("Remove this video?", "Eclipse goes back to searching YouTube for this song.", "Remove")) guard(null, async () => { await api("DELETE", `/videos/${encodeURIComponent(el.dataset.key)}`); toast("Removed"); refresh(); }); },
  "update-subsonic": (el) => guard(el, async () => {
    const b = { label: $('[data-f="label"]', sheetEl).value, enabled: swVal(sheetEl, "enabled"), direct: swVal(sheetEl, "direct"), normalize: swVal(sheetEl, "normalize") }, pw = $('[data-f="password"]', sheetEl).value;
    if (pw) b.password = pw;
    await api("PATCH", `/subsonic/${el.dataset.id}`, b);
    closeSheet(); toast("Saved"); refresh();
  }),
  "test-subsonic": (el) => guard(el, async () => { const r = await api("POST", `/subsonic/${el.dataset.id}/test`); closeSheet(); toast(r.server.status === "ok" ? "It works" : r.server.lastError || "Not working", r.server.status !== "ok"); refresh(); }),
  "remove-subsonic": async (el) => { if (await confirmSheet("Remove this server?", "Its saved login is deleted from here. Your music on it isn't touched.", "Remove")) guard(null, async () => { await api("DELETE", `/subsonic/${el.dataset.id}`); toast("Server removed"); refresh(); }); },
  "save-account": (el) => guard(el, async () => { await api("PATCH", `/accounts/${el.dataset.id}`, { label: $('[data-f="label"]', sheetEl).value, enabled: swVal(sheetEl, "enabled") }); closeSheet(); toast("Saved"); refresh(); }),
  "restart-account": (el) => guard(el, async () => { toast("Restarting…"); await api("POST", `/accounts/${el.dataset.id}/restart`); closeSheet(); refresh(); }),
  "remove-account": async (el) => { if (await confirmSheet("Remove this account?", "Its sign-in is deleted from this server. You can connect it again later.", "Remove")) guard(null, async () => { await api("DELETE", `/accounts/${el.dataset.id}`); toast("Account removed"); refresh(); }); },

  "new-user"() {
    openSheet(`<h2>Add a user</h2><label class="field"><span>Display name</span><input class="input" data-f="displayName" maxlength="40" autocomplete="off"></label>
      <label class="field"><span>Username</span><input class="input" data-f="username" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off"></label>
      <label class="field"><span>Password</span><div class="row"><input class="input grow" data-f="password" value="${rand()}" autocapitalize="none" autocorrect="off" spellcheck="false"><button class="btn icon-btn" type="button" data-act="regen" aria-label="Generate">↻</button></div></label>
      <div class="row between"><b>Admin</b>${sw("admin", false)}</div><div class="err" role="alert"></div><button class="btn primary" data-act="create-user">Create user</button>`);
  },
  regen: () => { $('[data-f="password"]', sheetEl).value = rand(); },
  "create-user": (el) => guard(el, async () => {
    const f = (k) => $(`[data-f="${k}"]`, sheetEl).value, pw = f("password"), name = f("displayName");
    await api("POST", "/users", { displayName: name, username: f("username"), password: pw, role: swVal(sheetEl, "admin") ? "admin" : "user" });
    setSheet(`<h2>${esc(name || f("username"))} is ready</h2><p class="muted">Share these with them. They can change the password later.</p><div class="big-code mono" style="font-size:1rem">${esc(f("username"))}<br>${esc(pw)}</div><button class="btn primary" data-act="sheet-no">Done</button>`);
    refresh();
  }),
  user(el) {
    const u = state.users.find((x) => x.id === el.dataset.id), me = u.id === state.user.id;
    openSheet(`<div class="row">${avatar(u, 48)}<div class="grow"><h2>${esc(u.displayName)}</h2><div class="muted small">@${esc(u.username)} · last sign-in ${ago(u.lastLogin)}</div></div></div>
      <label class="field"><span>Display name</span><input class="input" data-f="displayName" value="${esc(u.displayName)}" maxlength="40"></label>
      <div class="row between"><b>Admin</b>${sw("admin", u.role === "admin")}</div>
      ${u.role === "admin" ? "" : `<div class="row between"><div><b>Their own link</b><div class="muted small">A BitChord / Eclipse link of their own, with their own stats. It's made for them now</div></div>${sw("selfLinks", u.selfLinks)}</div>`}
      ${u.role === "admin" ? "" : `<div class="row between"><div><b>Server speakers</b><div class="muted small">Can play music through the server's AUX out</div></div>${sw("speaker", u.speaker)}</div>`}
      ${me ? "" : `<div class="row between"><b>Account enabled</b>${sw("enabled", !u.disabled)}</div>`}
      <label class="field"><span>New password (optional)</span><input class="input" data-f="password" placeholder="Leave empty to keep it" autocomplete="new-password" autocapitalize="none"></label>
      <div class="err" role="alert"></div><button class="btn primary" data-act="save-user" data-id="${u.id}">Save</button>${me ? "" : `<button class="btn danger" data-act="delete-user" data-id="${u.id}">Delete user</button>`}`);
  },
  "save-user": (el) => guard(el, async () => {
    const me = el.dataset.id === state.user.id, body = { displayName: $('[data-f="displayName"]', sheetEl).value, role: swVal(sheetEl, "admin") ? "admin" : "user" };
    if (!me) body.disabled = !swVal(sheetEl, "enabled");
    if ($('[data-sw="speaker"]', sheetEl)) body.speaker = swVal(sheetEl, "speaker");
    if ($('[data-sw="selfLinks"]', sheetEl)) body.selfLinks = swVal(sheetEl, "selfLinks");
    const pw = $('[data-f="password"]', sheetEl).value; if (pw) body.password = pw;
    await api("PATCH", `/users/${el.dataset.id}`, body); closeSheet(); toast("Saved"); refresh();
  }),
  "delete-user": async (el) => { if (await confirmSheet("Delete this user?", "Their sign-in and all of their links are removed.")) guard(null, async () => { await api("DELETE", `/users/${el.dataset.id}`); toast("User deleted"); refresh(); }); },
  invite: () => openSheet(`<h2>New invite</h2>
    <label class="field"><span>How many people can use it</span><input class="input" data-f="uses" type="number" inputmode="numeric" min="1" max="100" value="1"></label>
    <label class="field"><span>Expires</span><select class="input" data-f="days"><option value="1">In 1 day</option><option value="7" selected>In 7 days</option><option value="14">In 14 days</option><option value="30">In 30 days</option></select></label>
    <label class="field"><span>Message (optional)</span><textarea class="input" data-f="message" maxlength="200" rows="3" placeholder="Shown on the invite page and in the link preview" style="padding:12px 14px;min-height:84px;resize:none"></textarea></label>
    <div class="err" role="alert"></div><button class="btn primary" data-act="create-invite">Create invite</button>`),
  "create-invite": (el) => guard(el, async () => {
    const f = (k) => $(`[data-f="${k}"]`, sheetEl).value;
    const r = await api("POST", "/invites", { uses: +f("uses") || 1, days: +f("days"), message: f("message") });
    setSheet(`<h2>Invite link</h2><p class="muted">${r.uses === 1 ? "Works once" : `Works for ${r.uses} people`}, expires in ${r.days} day${r.days === 1 ? "" : "s"}.</p><div class="urlbox"><code>${esc(r.url)}</code><button class="btn sm" data-act="copy" data-text="${esc(r.url)}">${icon("copy")}Copy</button></div><button class="btn primary" data-act="sheet-no">Done</button>`);
    refresh();
  }),
  "bot-token": async () => {
    const b = await api("GET", "/discordbot");
    openSheet(`<h2>Discord bot token</h2><p class="muted small">From the <b>Bot</b> tab of your application at discord.com/developers/applications (<b>Reset Token</b>). It's checked with Discord, then kept on this server. It isn't shown again, and only a key with the Discord bot switch on can fetch it.${b.configured ? ` Saved now: <b>${esc(b.name)}</b>.` : ""}</p>
      <label class="field"><span>Bot token</span><input class="input" data-f="token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Paste the token"></label>
      <div class="err" role="alert"></div><button class="btn primary" data-act="bot-token-save">Check and save</button>${b.configured ? `<button class="btn danger" data-act="bot-token-remove">Remove token</button>` : ""}`);
  },
  "bot-token-save": (el) => guard(el, async () => { const r = await api("PUT", "/discordbot", { token: $('[data-f="token"]', sheetEl).value }); closeSheet(); refresh(); toast(`Saved. Bot: ${r.name}`); }),
  "bot-token-remove": async () => { if (await confirmSheet("Remove the bot token?", "The bot can't start until a token is saved again.", "Remove")) guard(null, async () => { await api("DELETE", "/discordbot"); closeSheet(true); refresh(); toast("Token removed"); }); },
  "apikey-edit": async (el) => {
    const k = (await api("GET", "/apikeys")).keys.find((x) => x.id === el.dataset.id);
    if (!k) return toast("That key is gone", true);
    openSheet(`<h2>${esc(k.name)}</h2><p class="muted small">Starts with <b>${esc(k.prefix)}…</b>. The key itself can't be shown again. Changes apply right away.</p>
      <label class="field"><span>Name</span><input class="input" data-f="name" maxlength="40" value="${esc(k.name)}" autocomplete="off"></label>
      <label class="field"><span>Requests per minute</span><input class="input" data-f="perMin" type="number" inputmode="numeric" min="1" max="600" value="${k.perMin}"></label>
      <div class="row between"><div><b>Allow audio streaming</b><div class="hint" style="padding:0">${k.bot ? "Always on for a Discord bot key." : "For a bot that plays songs."}</div></div>${sw("stream", k.stream)}</div>
      <div class="row between"><div><b>Allow lyrics</b><div class="hint" style="padding:0">${k.bot ? "Always on for a Discord bot key." : "Lets it read a song's lyrics."}</div></div>${sw("lyrics", k.lyrics)}</div>
      <div class="err" role="alert"></div><button class="btn primary" data-act="apikey-save" data-id="${k.id}">Save</button>`);
  },
  "apikey-save": (el) => guard(el, async () => {
    const f = (n) => $(`[data-f="${n}"]`, sheetEl).value;
    await api("PATCH", `/apikeys/${el.dataset.id}`, { name: f("name"), perMin: +f("perMin") || 60, stream: swVal(sheetEl, "stream"), lyrics: swVal(sheetEl, "lyrics") });
    closeSheet(); refresh(); toast("Saved");
  }),
  "apikey-new": () => openSheet(`<h2>New API key</h2><p class="muted small">Gives an app read-only access to song, album and artist details. Name it after what will use it.</p>
    <label class="field"><span>Name</span><input class="input" data-f="name" maxlength="40" placeholder="My website" autocomplete="off"></label>
    <label class="field"><span>Requests per minute</span><input class="input" data-f="perMin" type="number" inputmode="numeric" min="1" max="600" value="60"></label>
    <div class="row between"><div><b>Allow audio streaming</b><div class="hint" style="padding:0">For a bot that plays songs, like a Discord bot. Off means details only.</div></div>${sw("stream", false)}</div>
    <div class="row between"><div><b>Allow lyrics</b><div class="hint" style="padding:0">Lets it read a song's lyrics, which are copyrighted text. Off by default.</div></div>${sw("lyrics", false)}</div>
    ${state.user.owner ? `<div class="row between"><div><b>Discord bot</b><div class="hint" style="padding:0">Lets the bot fetch its token from here when it starts. Only for the bot's own key.</div></div>${sw("bot", false)}</div>` : ""}
    <div class="err" role="alert"></div><button class="btn primary" data-act="apikey-create">Create key</button>`),
  "apikey-create": (el) => guard(el, async () => {
    const f = (k) => $(`[data-f="${k}"]`, sheetEl).value;
    const r = await api("POST", "/apikeys", { name: f("name"), perMin: +f("perMin") || 60, stream: swVal(sheetEl, "stream"), lyrics: swVal(sheetEl, "lyrics"), bot: !!$('[data-sw="bot"]', sheetEl) && swVal(sheetEl, "bot") });
    setSheet(`<h2>${esc(r.info.name)}</h2><p class="muted">Copy the key now. It's shown only this once, and can't be looked up later.</p><div class="urlbox"><code>${esc(r.key)}</code><button class="btn sm" data-act="copy" data-text="${esc(r.key)}">${icon("copy")}Copy</button></div><p class="muted small">Send it as <b>Authorization: Bearer &lt;key&gt;</b>.</p><button class="btn primary" data-act="sheet-no">Done</button>`);
    refresh();
  }),
  "apikey-del": async (el) => { if (await confirmSheet(`Remove “${el.dataset.name}”?`, "Anything using this key stops working right away.", "Remove")) guard(null, async () => { await api("DELETE", `/apikeys/${el.dataset.id}`); refresh(); toast("Key removed"); }); },
  "revoke-invite": (el) => guard(null, async () => { await api("DELETE", `/invites/${el.dataset.code}`); refresh(); }),

  "add-friend"() {
    openSheet(`<h2>Add a friend</h2><p class="muted">Enter their username. Once they accept, you see each other's photo and listening.</p>
      <label class="field"><span>Username</span><input class="input" data-f="username" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" enterkeyhint="send" placeholder="@username"></label>
      <div class="hint">Your username is <b>@${esc(state.user.username)}</b>.</div><div class="err" role="alert"></div><button class="btn primary" data-act="send-friend">Send request</button>`);
  },
  "send-friend": (el) => guard(el, async () => {
    const r = await api("POST", "/friends", { username: $('[data-f="username"]', sheetEl).value });
    closeSheet(); toast(r.accepted ? "You're friends now" : "Request sent"); refresh(); updateBadge();
  }),
  "accept-friend": (el) => guard(el, async () => { await api("POST", `/friends/${el.dataset.id}/accept`); toast("Friend added"); refresh(); updateBadge(); }),
  friend(el) {
    const x = state.friends.friends.find((f) => f.id === el.dataset.id), l = x.listening;
    openSheet(`<div class="row">${avatar(x.user, 56)}<div class="grow"><h2>${esc(x.user.displayName)}</h2><div class="muted small">@${esc(x.user.username)} · friends since ${new Date(x.since).toLocaleDateString()}</div></div></div>
      <div class="card glass" style="border-radius:20px;padding:14px 16px"><div class="hint" style="padding:0">${l && Date.now() - l.at < 5 * 60000 ? "Listening now" : "Last played"}</div><div style="font-weight:640;margin-top:2px">${l ? esc(l.track) : "Nothing recent, or they keep it private"}</div>${l ? `<div class="small muted">${ago(l.at)}</div>` : ""}</div>
      <button class="btn primary" data-act="chat" data-uid="${x.user.id}">${icon("chat")}Message</button>
      <button class="btn danger" data-act="remove-friend" data-id="${x.id}">Remove friend</button>`);
  },
  "remove-friend": async (el) => {
    const go = async () => { await guard(null, async () => { await api("DELETE", `/friends/${el.dataset.id}`); closeSheet(); refresh(); updateBadge(); }); };
    if (el.dataset.quiet) return go(); // declining or cancelling a request needs no second prompt
    closeSheet(true);
    if (await confirmSheet("Remove this friend?", "You'll stop seeing each other's photo and listening. You can add each other again later.", "Remove")) go();
  },
  photo: () => $("#photo").click(),
  "photo-remove": (el) => guard(el, async () => { const r = await api("DELETE", "/me/avatar"); state.user = r.user; afterProfileChange(); }),

  async profile() {
    const [{ stats }, bl] = await Promise.all([api("GET", "/me"), api("GET", "/botlicenses").catch(() => ({ licenses: [] }))]), u = state.user;
    openSheet(`<div class="row">${avatar(u, 72)}<div class="grow"><h2>${esc(u.displayName)}</h2><div class="muted small">@${esc(u.username)} · ${roleName(u)}</div>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="photo">${u.avatar ? "Change photo" : "Add photo"}</button>${u.avatar ? `<button class="btn sm danger" data-act="photo-remove">Remove</button>` : ""}</div></div></div><input type="file" id="photo" accept="image/*" hidden>
      <div class="tiles" style="grid-template-columns:repeat(3,1fr)"><div class="tile glass"><span>Links</span><b>${stats.links}</b></div><div class="tile glass"><span>Streams</span><b>${nf.format(stats.stream)}</b></div><div class="tile glass"><span>Searches</span><b>${nf.format(stats.search)}</b></div></div>
      <label class="field"><span>Display name</span><input class="input" data-f="displayName" value="${esc(u.displayName)}" maxlength="40"></label>
      <div class="row between"><div><b>Share what I'm listening to</b><div class="hint" style="padding:0">Friends see your current or last track. Never your searches.</div></div>${sw("share", u.shareListening)}</div>
      <button class="btn primary" data-act="save-me">Save</button>
      <details><summary class="btn">Change password</summary><div class="body" style="display:grid;gap:12px;margin-top:12px"><input class="input" data-f="current" type="password" placeholder="Current password" autocomplete="current-password"><input class="input" data-f="next" type="password" placeholder="New password (8+ characters)" autocomplete="new-password"><button class="btn primary" data-act="save-pw">Update password</button></div></details>
      ${state.discord ? `<div class="row between"><div><b>Discord</b><div class="hint" style="padding:0">${u.discord ? `Connected as ${esc(u.discord.name)}${u.discord.username && u.discord.username !== u.discord.name ? ` (@${esc(u.discord.username)})` : ""}. You can sign in with it.` : "Connect it to sign in with Discord."}</div></div>${u.discord ? `<button class="btn sm danger" data-act="discord-unlink">Disconnect</button>` : `<button class="btn sm discord" data-act="discord-link">Connect</button>`}</div>` : ""}
      ${state.lastfm || u.owner ? `<div class="row between"><div><b>Last.fm</b><div class="hint" style="padding:0">${!state.lastfm ? "Add your Last.fm API key and secret to let people scrobble from the player." : u.lastfm ? `Scrobbling to ${esc(u.lastfm.name)}. Songs you play here are added to your Last.fm profile.` : "Connect your account to scrobble what you play here."}</div></div><div class="row">${u.owner ? `<button class="btn sm" data-act="lastfm-keys">${state.lastfm ? "Keys" : "Set up"}</button>` : ""}${state.lastfm ? (u.lastfm ? `<button class="btn sm danger" data-act="lastfm-unlink">Disconnect</button>` : `<button class="btn sm" data-act="lastfm-link">Connect</button>`) : ""}</div></div>` : ""}
      ${bl.licenses.length && !bl.owner ? `<div><b>Discord bot</b><div class="hint" style="padding:0">Add the bot to your server, then run <b>/license</b> with your code there.</div>${bl.licenses.filter((l) => !l.revoked).map((l) => `<div class="row between" style="margin-top:8px"><div><div class="t">${esc(l.code)}</div><div class="hint" style="padding:0">${l.guild ? `In use: ${esc(l.guild.name || l.guild.id)}` : "Not used yet"}</div></div><button class="btn sm" data-act="copy" data-text="${esc(l.code)}">${icon("copy")}Code</button></div>`).join("")}${bl.invite ? `<button class="btn sm" style="margin-top:8px" data-act="copy" data-text="${esc(bl.invite)}">${icon("copy")}Bot invite link</button>` : ""}</div>` : ""}
      <div class="err" role="alert"></div><button class="btn danger" data-act="logout">Sign out</button>`);
  },
  async "license-new"() {
    const r = await api("GET", "/users");
    openSheet(`<h2>New bot license</h2><p class="muted small">It unlocks the Discord bot in one server. Give the code to the user (they also see it in their profile).</p>
      <label class="field"><span>For</span><select class="input" data-f="userId">${r.users.filter((u) => !u.disabled).map((u) => `<option value="${u.id}">${esc(u.displayName)} (@${esc(u.username)})</option>`).join("")}</select></label>
      <label class="field"><span>Note (optional)</span><input class="input" data-f="label" maxlength="40" placeholder="Their server's name"></label>
      <div class="err" role="alert"></div><button class="btn primary" data-act="license-make">Make license</button>`);
  },
  "license-make": (el) => guard(el, async () => { const l = await api("POST", "/botlicenses", { userId: $('[data-f="userId"]', sheetEl).value, label: $('[data-f="label"]', sheetEl).value }); closeSheet(true); refresh(); toast(`License ${l.code}`); }),
  async "license-edit"(el) {
    const l = (await api("GET", "/botlicenses")).licenses.find((x) => x.id === el.dataset.id); if (!l) return;
    openSheet(`<h2>${esc(l.code)}</h2><p class="muted small">${esc(l.user?.displayName || "Removed user")}${l.guild ? ` · used in ${esc(l.guild.name || l.guild.id)}` : " · not used yet"}${l.revoked ? " · turned off" : ""}</p>
      ${l.guild ? `<button class="btn" data-act="license-do" data-id="${l.id}" data-do="release">Free it (so it can be used in another server)</button>` : ""}
      <button class="btn" data-act="license-do" data-id="${l.id}" data-do="${l.revoked ? "restore" : "revoke"}">${l.revoked ? "Turn back on" : "Turn off"}</button>
      <button class="btn danger" data-act="license-del" data-id="${l.id}">Delete</button>`);
  },
  "license-do": (el) => guard(el, async () => { await api("PATCH", `/botlicenses/${el.dataset.id}`, { action: el.dataset.do }); closeSheet(true); refresh(); toast("Done"); }),
  "license-del": async (el) => { if (await confirmSheet("Delete this license?", "The server using it loses the bot within a couple of minutes.", "Delete")) guard(null, async () => { await api("DELETE", `/botlicenses/${el.dataset.id}`); closeSheet(true); refresh(); toast("License deleted"); }); },
  "discord-login": (el) => guard(el, async () => { const r = await api("POST", "/discord/start", { mode: "login" }); location.href = r.url; }),
  "discord-link": (el) => guard(el, async () => { const r = await api("POST", "/discord/start", { mode: "link" }); location.href = r.url; }),
  "discord-unlink": async () => { if (await confirmSheet("Disconnect Discord?", "You won't be able to sign in with it until you connect it again.", "Disconnect")) guard(null, async () => { const r = await api("POST", "/discord/unlink"); state.user = r.user; afterProfileChange(); toast("Discord disconnected"); }); },
  "lastfm-link": (el) => guard(el, async () => { const r = await api("POST", "/lastfm/start"); store.set("lf.pending", String(Date.now())); location.href = r.url; }),
  "lastfm-unlink": async () => { if (await confirmSheet("Disconnect Last.fm?", "Songs you play here stop being scrobbled until you connect again.", "Disconnect")) guard(null, async () => { const r = await api("POST", "/lastfm/unlink"); state.user = r.user; afterProfileChange(); toast("Last.fm disconnected"); }); },
  "lastfm-keys": async () => {
    const c = await api("GET", "/lastfm/config");
    openSheet(`<h2>Last.fm keys</h2><p class="muted small">Create an API account at last.fm/api/account/create. Set its callback URL to <b>${esc(location.origin)}/api/lastfm/callback</b>, then paste the API key and shared secret here. They stay on this server and are never shown again.</p>
      <label class="field"><span>API key${c.key ? ` (saved: ${esc(c.key)})` : ""}</span><input class="input" data-f="key" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="32" placeholder="32 characters"></label>
      <label class="field"><span>Shared secret</span><input class="input" data-f="secret" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="32" placeholder="${c.configured ? "Leave blank to keep the saved one" : "32 characters"}"></label>
      <div class="err" role="alert"></div><button class="btn primary" data-act="lastfm-save">Check and save</button>${c.configured ? `<button class="btn danger" data-act="lastfm-remove">Remove keys</button>` : ""}`);
  },
  "lastfm-save": (el) => guard(el, async () => { await api("PUT", "/lastfm/config", { key: $('[data-f="key"]', sheetEl).value, secret: $('[data-f="secret"]', sheetEl).value }); state.lastfm = true; const r = await api("GET", "/boot"); state.user = r.user; closeSheet(); toast("Last.fm is set up. Connect your account from your profile."); }),
  "lastfm-remove": async () => { if (await confirmSheet("Remove the Last.fm keys?", "Everyone's Last.fm connection stops working, and they'd have to connect again.", "Remove")) guard(null, async () => { await api("DELETE", "/lastfm/config"); state.lastfm = false; const r = await api("GET", "/boot"); state.user = r.user; closeSheet(); toast("Last.fm keys removed"); }); },
  "save-me": (el) => guard(el, async () => { const r = await api("PATCH", "/me", { displayName: $('[data-f="displayName"]', sheetEl).value, shareListening: swVal(sheetEl, "share") }); state.user = r.user; closeSheet(); renderShell(); show(state.tab, { anim: false }); toast("Saved"); }),
  "save-pw": (el) => guard(el, async () => { await api("POST", "/me/password", { current: $('[data-f="current"]', sheetEl).value, next: $('[data-f="next"]', sheetEl).value }); closeSheet(); toast("Password updated"); }),
  logout: () => guard(null, async () => { await api("POST", "/logout"); es?.close(); state.user = null; closeSheet(true); stopTimers(); boot(); }),
};

document.addEventListener("click", (e) => {
  const sg = e.target.closest(".seg button");
  if (sg) {
    const s = sg.parentElement;
    $$("button", s).forEach((b) => b.classList.toggle("on", b === sg));
    placeThumb(s);
    if (s.dataset.seg === "filter") { state.filter = sg.dataset.v; $("#feed").innerHTML = feedHtml(); }
    if (s.dataset.seg === "linkscope") { state.scope = sg.dataset.v; store.set("links.scope", state.scope); $("#linklist").innerHTML = linkListHtml(); }
    return;
  }
  const sx = e.target.closest(".switch");
  if (sx) {
    const on = sx.getAttribute("aria-checked") !== "true";
    if (sx.dataset.sw === "direct" && on) return void confirmDirect(); // two warnings before this turns on
    sx.setAttribute("aria-checked", on);
    if (sx.dataset.sw === "membersCreateLinks") api("PATCH", "/settings", { membersCreateLinks: on }).then(() => toast(on ? "Members can create links" : "Only admins can create links")).catch((err) => { sx.setAttribute("aria-checked", !on); toast(err.message, true); });
    if (sx.dataset.sw === "joinOpen") api("PATCH", `/links/${sx.dataset.id}`, { joinOpen: on }).then(() => toast(on ? "Open to new people" : "Closed to new people")).catch((err) => { sx.setAttribute("aria-checked", !on); toast(err.message, true); });
    if (sx.dataset.sw === "membersSubmitVideos") api("PATCH", "/settings", { membersSubmitVideos: on }).then(() => toast(on ? "Members can submit videos" : "Only admins can pick videos")).catch((err) => { sx.setAttribute("aria-checked", !on); toast(err.message, true); });
    if (sx.dataset.sw === "membersUsePlayer") api("PATCH", "/settings", { membersUsePlayer: on }).then(() => toast(on ? "Members can use the player" : "The player is for admins only")).catch((err) => { sx.setAttribute("aria-checked", !on); toast(err.message, true); });
    return;
  }
  const a = e.target.closest("[data-act]");
  if (a) actions[a.dataset.act]?.(a, e);
});
document.addEventListener("input", (e) => {
  if (e.target.matches('[data-f="delayMs"]')) $("#delayv").textContent = `${e.target.value / 1000}s`;
  if (e.target.id === "devname") { const n = e.target.value.trim(); $("#linkurl").textContent = n ? `${e.target.dataset.url}?name=${encodeURIComponent(n)}` : e.target.dataset.url; }
});

// ---- boot ------------------------------------------------------------------------------------
document.addEventListener("player-state", (e) => document.documentElement.classList.toggle("playing", e.detail.playing));
async function boot() {
  if (!state.user) { state.playerMod?.stopPlayer(); document.documentElement.classList.remove("playing"); }
  let b;
  try { b = await api("GET", "/boot"); } catch { app.innerHTML = `<main class="auth"><div class="card glass chrome"><h2>Can't reach the server</h2><button class="btn primary" onclick="location.reload()">Retry</button></div></main>`; return; }
  state.user = b.user;
  state.appName = b.name || "Undertow";
  state.discord = !!b.discord;
  state.lastfm = !!b.lastfm;
  const dc = new URLSearchParams(location.search).get("discord");
  if (dc) {
    history.replaceState(null, "", location.pathname + location.hash);
    const say = { linked: "Discord connected", ok: "Signed in with Discord", denied: "Discord sign-in cancelled", taken: "That Discord is already connected to another account", nolink: "No account is connected to that Discord. Sign in and connect it in your profile.", error: "Discord sign-in failed" }[dc];
    if (say) setTimeout(() => toast(say, !["linked", "ok"].includes(dc)), 400);
  }
  const lf = new URLSearchParams(location.search).get("lastfm");
  if (lf) {
    history.replaceState(null, "", location.pathname + location.hash); store.set("lf.pending", "");
    const say = { ok: "Last.fm connected. Songs you play are scrobbled.", denied: "Last.fm connection cancelled", error: "Couldn't connect Last.fm. Try again." }[lf];
    if (say) setTimeout(() => toast(say, lf !== "ok"), 400);
  }
  lastfmReturn();
  if (!b.user) {
    const invite = new URLSearchParams(location.search).get("invite");
    if (b.needsSetup) return authScreen("setup");
    if (invite) {
      const r = await api("GET", `/invite/${encodeURIComponent(invite)}`).catch(() => ({}));
      if (r.valid) return authScreen("register", invite, r);
      authScreen("login");
      const who = r.by ? esc(r.by.displayName) : "the person who invited you";
      const face = r.by ? `<div class="center" style="display:grid;justify-items:center;gap:6px">${avatar({ ...r.by, id: "" }, 76).replace(/src="[^"]*"/, `src="/api/invite/${encodeURIComponent(invite)}/avatar?v=${r.by.avatar}"`)}<b>${esc(r.by.displayName)}</b><span class="muted small">@${esc(r.by.username)}</span></div>` : `<div class="ring">${icon("links")}</div>`;
      const [title, why] = r.reason === "used" ? ["Invite already used", "This invite was already accepted"] : r.reason === "expired" ? ["Invite expired", "This invite has expired"] : ["Invite not found", "This invite link isn't valid"];
      history.replaceState(null, "", location.pathname);
      openSheet(`${face}<h2 class="center">${title}</h2><p class="muted center">${why}. Ask ${who} to send you a new one.</p><button class="btn primary" data-act="sheet-no">Got it</button>`);
      return;
    }
    return authScreen("login");
  }
  renderShell();
  startEvents();
  updateBadge();
  setInterval(() => state.user && updateBadge(), 30000);
  if (!partyLink()) show(location.hash.slice(2) || "overview");
  else show("overview");
}
boot();
