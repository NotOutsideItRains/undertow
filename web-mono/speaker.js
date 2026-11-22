// Undertow: the server's speakers in Monochrome, the same idea as in Undertow's first player: the song plays out of the server's AUX (ffmpeg into its
// sound card) and this page is the remote. Only people an admin allowed see anything: the server answers 403 to everyone else, and then no button appears.
//
// The page's own <audio> keeps running, muted, because the progress bar, the lyrics and the queue follow its clock; every second it is pulled back to the
// server's place. The song is read from that element's address (/audio/<id>?quality=...), so Monochrome's own player code is not touched. When the server's
// copy ends, this page's copy ends a moment later and Monochrome takes it from there (next song, shuffle, repeat): this file never skips a song itself.
(() => {
  "use strict";
  const audio = document.getElementById("audio-player");
  if (!audio || window.__ulSpeaker) return;
  window.__ulSpeaker = true;

  const KEY = "ul-speaker", LATENCY = 0.4; // seconds between what ffmpeg sent to the sound card and what you hear
  const S = { ok: false, on: false, device: "", timer: 0, id: null, err: "", dragging: false, loading: false, lt: 0, track: 0, ended: null, userMuted: false }; // loading: a song is being handed to the server
  const own = { pause: 0, play: 0, seek: 0 }; // changes this file made to the audio element itself, so their events are not taken for the listener's own
  const mine = (kind, fn) => { own[kind]++; setTimeout(() => (own[kind] = Math.max(0, own[kind] - 1)), 1500); fn(); }; // the count expires if the event never comes
  const eaten = (kind) => { if (own[kind] > 0) { own[kind]--; return true; } return false; };

  const api = async (method, body) => {
    const r = await fetch("/__off/speaker", { method, credentials: "include", headers: { "content-type": "application/json", "x-requested-with": "ui" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `Error ${r.status}`), { status: r.status });
    return j;
  };

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

  // ---- talking to the server ----
  const send = async (body) => {
    try { const s = await api("POST", body); apply(s); return s; }
    catch (e) { say(e.message, true); if (body.action === "play") setOn(false, true); return null; } // couldn't start there: carry on playing on this device
  };
  const loading = (on) => { S.loading = on; clearTimeout(S.lt); if (on) S.lt = setTimeout(() => (S.loading = false), 6000); }; // it can't stay on for ever
  const start = async (pos = 0) => {
    const t = trackOf(), my = ++S.track;
    if (!t) { // not a song this server can send (a downloaded file, a video ...): it plays here instead
      loading(false);
      const had = S.id; S.id = null; // first: the guard that keeps the page muted only holds while a song is on the speakers
      audio.muted = S.userMuted;
      if (had) api("POST", { action: "stop" }).catch(() => {});
      say("That one can't be sent to the speakers, so it plays on this device");
      return;
    }
    audio.muted = true;
    const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
    loading(true);
    const s = await send({ action: "play", id: t.id, q: t.q, dur, title: label(), pos });
    if (my === S.track) { loading(false); if (s) { S.id = t.id; S.ended = s.ended; } }
  };
  const apply = (s) => {
    if (!S.on) return;
    ui(s);
    if (s.error && s.error !== S.err) say(s.error, true);
    S.err = s.error || "";
    const t = trackOf();
    if (!t || s.id !== t.id || S.loading) return;
    const over = !s.playing && ((s.dur > 0 && s.pos >= s.dur - 0.3) || (S.ended != null && s.ended > S.ended));
    if (over) return; // the song is over there: this page's copy reaches its end a moment later, and the app takes it from there
    if (s.playing) S.ended = s.ended;
    if (!s.playing && !audio.paused) mine("pause", () => audio.pause());
    else if (s.playing && audio.paused) mine("play", () => audio.play().catch(() => {}));
    const want = Math.max(0, s.pos - (s.playing ? LATENCY : 0));
    if (Math.abs(audio.currentTime - want) > 0.8) mine("seek", () => { audio.currentTime = want; });
  };
  const poll = () => api("GET").then(apply).catch(() => {});

  // ---- what the listener does on this page goes to the speakers ----
  audio.addEventListener("loadstart", () => { // a new song
    if (!S.on) return;
    if (!trackOf()) { start(0); return; } // not a song the server can send: back to this device at once
    const my = ++S.track;
    audio.muted = true;
    loading(true); // the page starting a song is not the listener pressing play
    let done = false;
    const go = () => { if (done || my !== S.track) return; done = true; start(0); }; // wait for the length, which the speakers want to know
    if (audio.readyState >= 1) go(); else { audio.addEventListener("loadedmetadata", go, { once: true }); setTimeout(go, 3000); }
  });
  audio.addEventListener("pause", () => { if (S.on && S.id && !audio.ended && !S.loading && !eaten("pause")) send({ action: "pause" }); });
  audio.addEventListener("play", () => { if (S.on && S.id && !S.loading && !eaten("play")) send({ action: "resume" }); });
  audio.addEventListener("seeked", () => { if (S.on && S.id && !eaten("seek")) send({ action: "seek", pos: audio.currentTime }); });
  audio.addEventListener("volumechange", () => { if (S.on && S.id && !audio.muted) audio.muted = true; }); // un-muting here would play the song twice

  // ---- the button and the little panel ----
  let btn = null, panel = null, vol = null, name = null;
  const css = document.createElement("style");
  css.textContent = `#ul-speaker-btn[aria-pressed="true"]{color:var(--primary,#ffb02e)}
@media (max-width:768px),(pointer:coarse){#ul-speaker-btn{min-width:36px;min-height:36px;display:inline-flex;align-items:center;justify-content:center}}
#ul-speaker-panel{position:absolute;right:12px;bottom:calc(100% + 8px);z-index:30;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 24px);box-sizing:border-box;padding:8px 12px;border-radius:var(--radius,12px);background:var(--card,#161b1f);color:var(--foreground,#fff);border:1px solid var(--border,#333);box-shadow:0 8px 24px rgba(0,0,0,.35);font-size:.85rem}
#ul-speaker-panel .ul-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:42vw}
#ul-speaker-panel input[type=range]{width:110px;min-width:70px;accent-color:var(--primary,#ffb02e)}
#ul-speaker-panel button{flex:none;padding:4px 10px;border-radius:8px;border:1px solid var(--border,#444);background:transparent;color:inherit;cursor:pointer;font:inherit}`;
  document.head.appendChild(css);
  const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24"><rect width="16" height="20" x="4" y="2" rx="2"/><circle cx="12" cy="14" r="4"/><line x1="12" x2="12.01" y1="6" y2="6"/></svg>';
  const addButton = () => {
    const row = document.querySelector(".player-actions-row");
    if (!row || btn) return;
    btn = document.createElement("button");
    btn.id = "ul-speaker-btn"; btn.type = "button";
    btn.title = "Play through the server speakers"; btn.setAttribute("aria-label", "Play through the server speakers"); btn.setAttribute("aria-pressed", "false");
    btn.innerHTML = ICON;
    btn.addEventListener("click", () => setOn(!S.on));
    row.insertBefore(btn, document.getElementById("queue-btn") || null);
  };
  const showPanel = (on) => {
    if (!on) { panel?.remove(); panel = vol = name = null; return; }
    if (panel) return;
    const bar = document.querySelector(".now-playing-bar");
    if (!bar) return;
    panel = document.createElement("div");
    panel.id = "ul-speaker-panel"; panel.setAttribute("role", "group"); panel.setAttribute("aria-label", "Server speakers");
    panel.innerHTML = '<span class="ul-name"></span><input type="range" min="0" max="100" step="1" aria-label="Server speaker volume"><button type="button">Stop</button>';
    name = panel.querySelector(".ul-name"); vol = panel.querySelector("input");
    name.textContent = `Server speakers${S.device ? ` · ${S.device}` : ""}`;
    let t = 0;
    vol.addEventListener("pointerdown", () => (S.dragging = true));
    vol.addEventListener("change", () => (S.dragging = false));
    vol.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => send({ action: "volume", vol: Number(vol.value) }), 120); });
    panel.querySelector("button").addEventListener("click", () => setOn(false));
    bar.appendChild(panel);
  };
  const ui = (s) => { if (vol && !S.dragging && s.volume?.value != null) vol.value = s.volume.value; };

  function setOn(on, quiet = false) {
    if (on && !S.ok) return;
    S.on = on;
    try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* not remembered */ }
    btn?.setAttribute("aria-pressed", String(on));
    showPanel(on);
    clearInterval(S.timer);
    if (on) {
      S.userMuted = audio.muted;
      S.timer = setInterval(poll, 1000);
      if (trackOf() && audio.src && !audio.paused) start(audio.currentTime); // already playing here: hand it over
      else { audio.muted = !!trackOf() || S.userMuted; poll(); }
      if (!quiet) say("Playing through the server speakers");
    } else {
      audio.muted = S.userMuted;
      S.id = null; S.track++;
      api("POST", { action: "stop" }).catch(() => {});
      if (!quiet) say("Playing on this device");
    }
  }

  (async () => {
    try {
      const s = await api("GET");
      if (!s.available) return; // no sound card on the server
      S.ok = true; S.device = s.device || "";
    } catch { return; } // not allowed (or not signed in): nothing appears
    addButton();
    if (!btn) { new MutationObserver((_, o) => { addButton(); if (btn) { o.disconnect(); if (localStorage.getItem(KEY) === "1") setOn(true, true); } }).observe(document.body, { childList: true, subtree: true }); return; }
    try { if (localStorage.getItem(KEY) === "1") setOn(true, true); } catch { /* not remembered */ }
  })();

  window.__ulSpeakerState = () => ({ ok: S.ok, on: S.on, id: S.id, muted: audio.muted, panel: !!panel });
})();
