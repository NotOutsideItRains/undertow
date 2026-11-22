// Undertow: Monochrome Connect in Monochrome, the way Spotify Connect works: the speaker button picks where the song plays. A target is
//   - this device (the default),
//   - the server's own speakers (its sound card), for the people an admin allowed (the first player has the same), or
//   - one of YOUR Connect devices: a Raspberry Pi with a Bluetooth speaker running connect/agent.py, or a web page open on another screen (/connect).
// Nobody else's devices are ever shown. This page is the remote: it sends play, pause, resume, seek and volume, and reads back what the target is doing.
//
// The page's own <audio> keeps running, muted, because the progress bar, the lyrics and the queue follow its clock; every second it is pulled back to the
// target's place. The song is read from that element's address (/audio/<id>?quality=...), so Monochrome's own player code is not touched. When the target's
// copy ends, this page's copy ends a moment later and Monochrome takes it from there (next song, shuffle, repeat): this file never skips a song itself.
(() => {
  "use strict";
  const audio = document.getElementById("audio-player");
  if (!audio || window.__ulSpeaker) return;
  window.__ulSpeaker = true;

  const KEY = "ul-speaker", LATENCY = 0.4; // seconds between what a target sent to its sound card and what you hear
  const T = { kind: null, id: null, name: "" }; // where the song plays: null (this device), "server" or "device"
  const S = { server: null, devices: [], device: "", timer: 0, id: null, err: "", dragging: false, loading: false, lt: 0, track: 0, ended: null, userMuted: false }; // loading: a song is being handed to the target
  const on = () => T.kind !== null;
  const own = { pause: 0, play: 0, seek: 0 }; // changes this file made to the audio element itself, so their events are not taken for the listener's own
  const mine = (kind, fn) => { own[kind]++; setTimeout(() => (own[kind] = Math.max(0, own[kind] - 1)), 1500); fn(); }; // the count expires if the event never comes
  const eaten = (kind) => { if (own[kind] > 0) { own[kind]--; return true; } return false; };

  const call = async (method, path, body) => {
    const r = await fetch(path, { method, credentials: "include", headers: { "content-type": "application/json", "x-requested-with": "ui" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `Error ${r.status}`), { status: r.status });
    return j;
  };

  // ---- the targets: each sends a command and reports what it is doing in the same shape (id, playing, pos, dur, ended, volume.value, error) ----
  const asState = (d) => { // a Connect device's answer, in the shape the server's speakers give
    const s = d.state || {};
    return { id: s.id ?? null, playing: !!s.playing, pos: s.pos || 0, dur: s.dur || 0, ended: s.ended || 0, volume: { value: s.volume }, error: !d.online ? `${d.name} is offline` : s.error || null };
  };
  const drivers = {
    server: { label: () => `Server speakers${S.server?.device ? ` · ${S.server.device}` : ""}`, send: (b) => call("POST", "/__off/speaker", b), status: () => call("GET", "/__off/speaker") },
    device: {
      label: () => T.name,
      send: async (b) => { await call("POST", "/__off/connect/command", { deviceId: T.id, ...b }); return true; }, // no state comes back: it arrives with the next poll
      status: async () => { S.devices = (await call("GET", "/__off/connect/devices")).devices; const d = S.devices.find((x) => x.id === T.id); if (!d) throw new Error("That device was removed"); return asState(d); },
    },
  };
  const drv = () => drivers[T.kind];

  // ---- the song, as the page's audio element names it ----
  const trackOf = () => {
    try {
      const u = new URL(audio.currentSrc || audio.src || "", location.href);
      const m = /^\/audio\/(\d{1,12}|sub_[a-f0-9]+_[A-Za-z0-9_-]+)$/.exec(u.pathname);
      return m && u.origin === location.origin ? { id: m[1], q: u.searchParams.get("quality") || "HI_RES" } : null;
    } catch { return null; }
  };
  const text = (sel) => document.querySelector(sel)?.textContent?.trim() || "";
  const label = () => [text(".now-playing-bar .artist"), text(".now-playing-bar .title")].filter(Boolean).join(" - ").slice(0, 120);

  // ---- a little message (Monochrome's own toast is not reachable from here) ----
  let toastEl = null, toastTimer = 0;
  const say = (msg, bad) => {
    toastEl?.remove(); clearTimeout(toastTimer);
    toastEl = document.createElement("div");
    toastEl.setAttribute("role", "status");
    toastEl.textContent = msg;
    toastEl.style.cssText = `position:fixed;left:50%;top:70px;transform:translateX(-50%);width:max-content;max-width:90vw;z-index:100002;padding:10px 16px;border-radius:10px;color:#fff;font-size:.9rem;background:${bad ? "#8a2a2a" : "#222b31"};box-shadow:0 8px 24px rgba(0,0,0,.4);pointer-events:none`;
    document.body.appendChild(toastEl);
    toastTimer = setTimeout(() => { toastEl?.remove(); toastEl = null; }, 4200);
  };

  // ---- talking to the target ----
  const send = async (body) => {
    try { const s = await drv().send(body); if (s && s !== true) apply(s); return s; }
    catch (e) { say(e.message, true); if (body.action === "play") setTarget(null, null, "", true); return null; } // couldn't start there: carry on playing on this device
  };
  const loading = (v) => { S.loading = v; clearTimeout(S.lt); if (v) S.lt = setTimeout(() => (S.loading = false), 6000); }; // it can't stay on for ever
  const start = async (pos = 0) => {
    const t = trackOf(), my = ++S.track;
    if (!t) { // not a song a target can play (a downloaded file, a video ...): it plays here instead
      loading(false);
      const had = S.id; S.id = null; // first: the guard that keeps the page muted only holds while a song is on a target
      audio.muted = S.userMuted;
      if (had && on()) drv().send({ action: "stop" }).catch(() => {});
      say("That one can't be sent to another device, so it plays here");
      return;
    }
    audio.muted = true;
    const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
    loading(true);
    const s = await send({ action: "play", id: t.id, q: t.q, dur, title: label(), pos });
    if (my === S.track) { loading(false); if (s) { S.id = t.id; S.ended = s === true ? null : s.ended; } } // a Connect device tells its counter with its first report
  };
  const apply = (s) => {
    if (!on()) return;
    ui(s);
    if (s.error && s.error !== S.err) say(s.error, true);
    S.err = s.error || "";
    const t = trackOf();
    if (!t || s.id !== t.id || S.loading) return;
    const over = !s.playing && ((s.dur > 0 && s.pos >= s.dur - 0.3) || (S.ended != null && s.ended > S.ended));
    if (over) return; // the song is over there: this page's copy reaches its end a moment later, and the app takes it from there
    if (s.playing || S.ended == null) S.ended = s.ended;
    if (!s.playing && !audio.paused) mine("pause", () => audio.pause());
    else if (s.playing && audio.paused) mine("play", () => audio.play().catch(() => {}));
    const want = Math.max(0, s.pos - (s.playing ? LATENCY : 0));
    if (Math.abs(audio.currentTime - want) > 0.8) mine("seek", () => { audio.currentTime = want; });
  };
  const poll = () => { if (on()) drv().status().then(apply).catch((e) => { if (on() && T.kind === "device" && /removed/.test(e.message)) { say(e.message, true); setTarget(null, null, "", true); } }); };

  // ---- what the listener does on this page goes to the target ----
  audio.addEventListener("loadstart", () => { // a new song
    if (!on()) return;
    if (!trackOf()) { start(0); return; } // not a song a target can play: back to this device at once
    const my = ++S.track;
    audio.muted = true;
    loading(true); // the page starting a song is not the listener pressing play
    let done = false;
    const go = () => { if (done || my !== S.track) return; done = true; start(0); }; // wait for the length, which the target wants to know
    if (audio.readyState >= 1) go(); else { audio.addEventListener("loadedmetadata", go, { once: true }); setTimeout(go, 3000); }
  });
  audio.addEventListener("pause", () => { if (on() && S.id && !audio.ended && !S.loading && !eaten("pause")) send({ action: "pause" }); });
  audio.addEventListener("play", () => { if (on() && S.id && !S.loading && !eaten("play")) send({ action: "resume" }); });
  audio.addEventListener("seeked", () => { if (on() && S.id && !eaten("seek")) send({ action: "seek", pos: audio.currentTime }); });
  audio.addEventListener("volumechange", () => { if (on() && S.id && !audio.muted) audio.muted = true; }); // un-muting here would play the song twice

  // ---- the button, the menu, the panel and the "add a device" box ----
  let btn = null, panel = null, vol = null, name = null, menu = null, menuTimer = 0, dlg = null;
  const css = document.createElement("style");
  css.textContent = `#ul-speaker-btn[aria-pressed="true"]{color:var(--primary,#ffb02e)}
@media (max-width:768px),(pointer:coarse){#ul-speaker-btn{min-width:36px;min-height:36px;display:inline-flex;align-items:center;justify-content:center}}
#ul-speaker-panel,#ul-speaker-menu{position:absolute;right:12px;z-index:30;box-sizing:border-box;border-radius:var(--radius,12px);background:var(--card,#161b1f);color:var(--foreground,#fff);border:1px solid var(--border,#333);box-shadow:0 8px 24px rgba(0,0,0,.35);font-size:.85rem;max-width:calc(100vw - 24px)}
#ul-speaker-panel{bottom:calc(100% + 8px);display:flex;align-items:center;gap:10px;padding:8px 12px}
#ul-speaker-panel .ul-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:42vw}
#ul-speaker-panel input[type=range]{width:110px;min-width:70px;accent-color:var(--primary,#ffb02e)}
#ul-speaker-panel button,#ul-speaker-dlg button{flex:none;padding:4px 10px;border-radius:8px;border:1px solid var(--border,#444);background:transparent;color:inherit;cursor:pointer;font:inherit}
#ul-speaker-menu{bottom:calc(100% + 8px);width:min(320px,calc(100vw - 24px));padding:6px;max-height:60vh;overflow:auto}
#ul-speaker-menu.has-panel{bottom:calc(100% + 64px)}
#ul-speaker-menu h4{margin:6px 8px 4px;font-size:.75rem;font-weight:600;color:var(--muted-foreground,#9aa0a6);text-transform:uppercase;letter-spacing:.04em}
#ul-speaker-menu .ul-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:9px 10px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;font:inherit}
#ul-speaker-menu .ul-item:hover:not([disabled]),#ul-speaker-menu .ul-item:focus-visible{background:var(--secondary,rgba(255,255,255,.08))}
#ul-speaker-menu .ul-item[disabled]{opacity:.5;cursor:default}
#ul-speaker-menu .ul-item[aria-checked="true"]{color:var(--primary,#ffb02e)}
#ul-speaker-menu .ul-dot{width:8px;height:8px;border-radius:50%;background:#6b7075;flex:none}
#ul-speaker-menu .ul-dot.on{background:#3ecf6a}
#ul-speaker-menu .ul-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ul-speaker-menu .ul-sub{color:var(--muted-foreground,#9aa0a6);font-size:.75rem}
#ul-speaker-menu .ul-x{padding:2px 7px;border-radius:6px;border:0;background:transparent;color:var(--muted-foreground,#9aa0a6);cursor:pointer;font:inherit}
#ul-speaker-menu hr{border:0;border-top:1px solid var(--border,#333);margin:6px 2px}
#ul-speaker-dlg{position:fixed;inset:0;z-index:100003;display:grid;place-items:center;background:rgba(0,0,0,.55);padding:16px}
#ul-speaker-dlg .box{width:min(460px,100%);max-height:90vh;overflow:auto;background:var(--card,#161b1f);color:var(--foreground,#fff);border:1px solid var(--border,#333);border-radius:16px;padding:20px;font-size:.9rem;line-height:1.5}
#ul-speaker-dlg h3{margin:0 0 8px;font-size:1.1rem}
#ul-speaker-dlg code{display:block;margin:8px 0;padding:10px;border-radius:8px;background:rgba(255,255,255,.06);font-size:.78rem;overflow-wrap:anywhere;white-space:pre-wrap}
#ul-speaker-dlg label{display:block;margin:10px 0 4px;font-size:.8rem;color:var(--muted-foreground,#9aa0a6)}
#ul-speaker-dlg input{width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--border,#444);background:rgba(255,255,255,.05);color:inherit;font:inherit}
#ul-speaker-dlg .row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
#ul-speaker-dlg .bad{color:#ff8a8a;min-height:1.2em;margin-top:6px}`;
  document.head.appendChild(css);
  const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24"><rect width="16" height="20" x="4" y="2" rx="2"/><circle cx="12" cy="14" r="4"/><line x1="12" x2="12.01" y1="6" y2="6"/></svg>';
  const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === "text") e.textContent = v; else if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn); else e.setAttribute(k, v); } e.append(...kids); return e; };

  const addButton = () => {
    const row = document.querySelector(".player-actions-row");
    if (!row || btn) return;
    btn = el("button", { id: "ul-speaker-btn", type: "button", title: "Play on another device", "aria-label": "Play on another device", "aria-haspopup": "menu", "aria-pressed": "false", on: { click: (e) => { e.stopPropagation(); toggleMenu(); } } });
    btn.innerHTML = ICON;
    row.insertBefore(btn, document.getElementById("queue-btn") || null);
  };
  const showPanel = () => {
    panel?.remove(); panel = vol = name = null;
    if (!on()) return;
    const bar = document.querySelector(".now-playing-bar");
    if (!bar) return;
    panel = el("div", { id: "ul-speaker-panel", role: "group", "aria-label": "Playing on another device" });
    name = el("span", { class: "ul-name", text: drv().label() });
    vol = el("input", { type: "range", min: "0", max: "100", step: "1", "aria-label": "Volume on that device" });
    let t = 0;
    vol.addEventListener("pointerdown", () => (S.dragging = true));
    vol.addEventListener("change", () => (S.dragging = false));
    vol.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => send({ action: "volume", vol: Number(vol.value) }), 120); });
    panel.append(name, vol, el("button", { type: "button", text: "Stop", on: { click: () => setTarget(null) } }));
    bar.appendChild(panel);
  };
  const ui = (s) => { if (vol && !S.dragging && s.volume?.value != null) vol.value = s.volume.value; };

  // the menu: where to play
  const closeMenu = () => { clearInterval(menuTimer); menu?.remove(); menu = null; btn?.setAttribute("aria-expanded", "false"); };
  const outside = (e) => { if (menu && !menu.contains(e.target) && !btn?.contains(e.target)) closeMenu(); };
  document.addEventListener("click", outside);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (dlg) closeDialog(); else closeMenu(); } });
  const refreshDevices = async () => { try { S.devices = (await call("GET", "/__off/connect/devices")).devices; } catch { /* keep what we have */ } if (menu) drawMenu(); };
  const toggleMenu = async () => {
    if (menu) return closeMenu();
    const bar = document.querySelector(".now-playing-bar");
    if (!bar) return;
    menu = el("div", { id: "ul-speaker-menu", role: "menu", "aria-label": "Play on" });
    bar.appendChild(menu); btn.setAttribute("aria-expanded", "true");
    drawMenu();
    refreshDevices();
    menuTimer = setInterval(refreshDevices, 3000); // so a device that has just come online (or gone) shows
  };
  function drawMenu() {
    if (!menu) return;
    menu.classList.toggle("has-panel", on());
    const item = (props, checked, ...kids) => el("button", { type: "button", class: "ul-item", role: "menuitemradio", "aria-checked": String(!!checked), ...props }, ...kids);
    const kids = [el("h4", { text: "Play on" })];
    kids.push(item({ on: { click: () => { closeMenu(); setTarget(null); } } }, !on(), el("span", { class: "ul-dot on" }), el("span", { class: "ul-grow", text: "This device" })));
    if (S.server) kids.push(item({ on: { click: () => { closeMenu(); setTarget("server"); } } }, T.kind === "server", el("span", { class: "ul-dot on" }), el("span", { class: "ul-grow", text: "Server speakers" }), el("span", { class: "ul-sub", text: S.server.device || "" })));
    for (const d of S.devices) {
      const row = el("div", { style: "display:flex;align-items:center" });
      const pick = item({ style: "flex:1;min-width:0", ...(d.online ? {} : { disabled: "" }), on: { click: () => { closeMenu(); setTarget("device", d.id, d.name); } } }, T.kind === "device" && T.id === d.id,
        el("span", { class: "ul-dot" + (d.online ? " on" : "") }), el("span", { class: "ul-grow", text: d.name }), el("span", { class: "ul-sub", text: d.online ? (d.kind === "web" ? "screen" : "receiver") : "offline" }));
      const x = el("button", { type: "button", class: "ul-x", title: `Remove ${d.name}`, "aria-label": `Remove ${d.name}`, text: "✕", on: { click: (e) => { e.stopPropagation(); removeDevice(d); } } });
      row.append(pick, x); kids.push(row);
    }
    kids.push(el("hr"));
    kids.push(item({ role: "menuitem", on: { click: () => { closeMenu(); openDialog(); } } }, false, el("span", { class: "ul-grow", text: "Add a device…" })));
    kids.push(el("a", { class: "ul-item", role: "menuitem", href: "/connect", target: "_blank", rel: "noopener", style: "text-decoration:none" }, el("span", { class: "ul-grow", text: "Use another screen" }), el("span", { class: "ul-sub", text: "/connect" })));
    menu.replaceChildren(...kids);
  }
  async function removeDevice(d) {
    if (!confirm(`Remove "${d.name}" from your devices?`)) return;
    try { await call("POST", "/__off/connect/remove", { deviceId: d.id }); if (T.kind === "device" && T.id === d.id) setTarget(null, null, "", true); } catch (e) { say(e.message, true); }
    refreshDevices();
  }

  // adding a Raspberry Pi (or any computer): it shows a code, you type it here
  const closeDialog = () => { dlg?.remove(); dlg = null; };
  function openDialog() {
    closeDialog();
    const cmd = `curl -fsSL ${location.origin}/__off/connect/agent.py -o monochrome-connect.py\npython3 monochrome-connect.py --server ${location.origin} --name "Living room"`;
    const code = el("input", { type: "text", maxlength: "12", autocomplete: "off", placeholder: "ABCD-EFGH", "aria-label": "Pairing code", style: "text-transform:uppercase;letter-spacing:.08em;font-size:1.1rem" });
    const nm = el("input", { type: "text", maxlength: "40", autocomplete: "off", placeholder: "Living room", "aria-label": "Name" });
    const bad = el("div", { class: "bad", role: "alert" });
    const add = el("button", { type: "button", text: "Add device", style: "background:var(--primary,#ffb02e);color:#1a1200;border-color:transparent;font-weight:700" });
    add.addEventListener("click", async () => {
      add.disabled = true; bad.textContent = "";
      try { const r = await call("POST", "/__off/connect/pair/claim", { code: code.value, name: nm.value }); closeDialog(); say(`Added "${r.device.name}". Pick it from the speaker button.`); refreshDevices(); }
      catch (e) { bad.textContent = e.message; add.disabled = false; }
    });
    dlg = el("div", { id: "ul-speaker-dlg", role: "dialog", "aria-modal": "true", "aria-label": "Add a device", on: { click: (e) => { if (e.target === dlg) closeDialog(); } } },
      el("div", { class: "box" }, el("h3", { text: "Add a device" }),
        el("div", { text: "On the Raspberry Pi (or any computer with Python 3 and mpv), run this:" }), el("code", { text: cmd }),
        el("div", { text: "It prints a short code. Type it here:" }), el("label", { text: "Pairing code" }), code, el("label", { text: "Name (optional)" }), nm, bad,
        el("div", { class: "row" }, el("button", { type: "button", text: "Close", on: { click: closeDialog } }), add)));
    document.body.appendChild(dlg); code.focus();
  }

  // ---- choosing where to play ----
  function setTarget(kind, id = null, nm = "", quiet = false) {
    const was = on();
    if (was) { drv().send({ action: "stop" }).catch(() => {}); S.id = null; S.track++; } // leaving a target: stop what is playing there
    else S.userMuted = audio.muted;
    T.kind = kind; T.id = id; T.name = nm;
    try { localStorage.setItem(KEY, kind === "server" ? "server" : kind === "device" ? `dev:${id}` : "0"); } catch { /* not remembered */ }
    btn?.setAttribute("aria-pressed", String(on()));
    btn?.setAttribute("title", on() ? `Playing on ${drv().label()}` : "Play on another device");
    showPanel();
    clearInterval(S.timer);
    if (on()) {
      S.timer = setInterval(poll, 1000);
      if (trackOf() && audio.src && !audio.paused) start(audio.currentTime); // already playing here: hand it over
      else { audio.muted = !!trackOf() || S.userMuted; poll(); }
      if (!quiet) say(`Playing on ${drv().label()}`);
    } else {
      audio.muted = S.userMuted;
      if (!quiet) say("Playing on this device");
    }
  }
  const restore = () => {
    let v = "0";
    try { v = localStorage.getItem(KEY) || "0"; } catch { /* nothing remembered */ }
    if (v === "1" || v === "server") { if (S.server) setTarget("server", null, "", true); }
    else if (v.startsWith("dev:")) { const d = S.devices.find((x) => x.id === v.slice(4)); if (d?.online) setTarget("device", d.id, d.name, true); } // only a device that is there now: never a silent page
  };

  (async () => {
    try { const s = await call("GET", "/__off/speaker"); if (s.available) S.server = { device: s.device || "" }; } catch { /* not allowed, or no sound card: no server speakers in the menu */ }
    let ok = true;
    try { S.devices = (await call("GET", "/__off/connect/devices")).devices; } catch { ok = false; }
    if (!S.server && !ok) return; // neither works (an older server, or not signed in): nothing appears
    addButton();
    if (!btn) { new MutationObserver((_, o) => { addButton(); if (btn) { o.disconnect(); restore(); } }).observe(document.body, { childList: true, subtree: true }); return; }
    restore();
  })();

  window.__ulSpeakerState = () => ({ on: on(), kind: T.kind, target: T.id, id: S.id, muted: audio.muted, panel: !!panel, server: !!S.server, devices: S.devices.length });
})();
