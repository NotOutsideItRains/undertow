// Monochrome Connect, the web receiver (/connect): this page plays what Monochrome tells it to, so a phone, a laptop or a TV browser becomes a device.
// It behaves like the Raspberry Pi program (connect/agent.py): it holds a request open for the next command, plays the song address it is given and reports
// what it is doing about once a second. It keeps its own token (not your sign-in) once it is registered.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id), a = $("a"), KEY = "ul-connect-web";
  const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="; // a moment of nothing, to unlock sound on iPhones and iPads
  const S = { id: null, title: "", ended: 0, error: null };
  let dev = null, running = false, ctl = null, ticker = 0, wake = null;
  const store = { get() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } }, set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* not remembered */ } }, clear() { try { localStorage.removeItem(KEY); } catch { /* fine */ } } };

  const say = (m, bad) => { const e = $("msg"); e.textContent = m || ""; e.className = bad ? "bad" : ""; };
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const guessName = () => {
    const u = navigator.userAgent, os = /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) ? "iPad" : /Android/.test(u) ? "Android" : /Windows/.test(u) ? "Windows" : /Mac OS/.test(u) ? "Mac" : /CrOS/.test(u) ? "Chromebook" : /Linux/.test(u) ? "Linux" : "Browser";
    const br = /Edg\//.test(u) ? "Edge" : /Firefox\//.test(u) ? "Firefox" : /Chrome\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "";
    return `${os}${br ? " " + br : ""}`;
  };
  const api = async (path, body, bearer) => {
    const r = await fetch(path, { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-requested-with": "ui", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `Error ${r.status}`), { status: r.status });
    return j;
  };

  // ---- what it is playing
  const draw = () => {
    $("title").textContent = S.id ? (S.title || "A song") : "Waiting for Monochrome…";
    const dur = Number.isFinite(a.duration) ? a.duration : 0;
    $("sub").textContent = S.error ? S.error : S.id ? `${a.paused ? "Paused" : "Playing"} · ${mmss(a.currentTime)}${dur ? " / " + mmss(dur) : ""}` : "Connected. Pick this device in Monochrome.";
    $("fill").style.width = dur ? `${Math.min(100, (a.currentTime / dur) * 100)}%` : "0";
  };
  const volume = (v) => { v = Math.max(0, Math.min(100, Number(v) || 0)); a.volume = v / 100; $("vol").value = v; };
  const play = () => a.play().catch((e) => { S.error = e.name === "NotAllowedError" ? "Press Start receiving on this page first (the browser needs a tap before it may play)." : "Could not play that song."; draw(); });
  const handle = (c) => {
    if (c.action === "play") {
      S.id = c.id; S.title = c.title || ""; S.error = null;
      if (c.vol != null) volume(c.vol);
      a.src = c.url;
      const at = Number(c.pos) || 0;
      if (at > 0) a.addEventListener("loadedmetadata", () => { a.currentTime = at; }, { once: true });
      play();
      if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: S.title || "Monochrome" });
    } else if (c.action === "pause") a.pause();
    else if (c.action === "resume") play();
    else if (c.action === "seek") a.currentTime = Number(c.pos) || 0;
    else if (c.action === "volume") volume(c.vol);
    else if (c.action === "stop") { a.pause(); a.removeAttribute("src"); a.load(); S.id = null; S.error = null; }
    draw(); report();
  };
  a.addEventListener("ended", () => { if (!S.id) return; S.ended++; draw(); report(); }); // the silent clip played at Start is not a song
  a.addEventListener("error", () => { if (S.id) { S.error = "That song could not be loaded."; draw(); report(); } });
  $("vol").addEventListener("input", (e) => volume(e.target.value));

  // ---- talking to the server
  const report = () => {
    if (!running || !dev) return;
    api("/__off/connect/report", { id: S.id, playing: !!S.id && !a.paused && !a.ended, pos: a.currentTime || 0, dur: Number.isFinite(a.duration) ? a.duration : 0, ended: S.ended, volume: Math.round(a.volume * 100), error: S.error }, dev.token).catch((e) => { if (e.status === 401) removed(); });
  };
  const loop = async () => {
    let seq = null, wait = 1;
    while (running) {
      try {
        const r = await fetch(`/__off/connect/poll${seq == null ? "" : `?since=${seq}`}`, { headers: { Authorization: `Bearer ${dev.token}` }, signal: ctl.signal });
        if (r.status === 401) return removed();
        const j = await r.json();
        seq = j.seq; wait = 1;
        say("");
        for (const c of j.commands || []) handle(c);
      } catch (e) {
        if (!running) return;
        say("Lost the connection. Trying again…", true);
        await new Promise((ok) => setTimeout(ok, wait * 1000));
        wait = Math.min(wait * 2, 15);
      }
    }
  };
  const removed = () => { stop(); store.clear(); say("This device was removed in Monochrome. Press Start to add it again.", true); };

  async function start() {
    const name = $("name").value.trim() || guessName(), saved = store.get();
    $("go").disabled = true;
    try {
      // a tap is what lets the browser play sound later without another one
      a.src = SILENCE; await a.play().catch(() => {}); a.pause(); a.removeAttribute("src");
      dev = await api("/__off/connect/web/register", { name, id: saved?.id || "", token: saved?.token || "" });
      store.set({ id: dev.id, token: dev.token, name: dev.name });
      running = true; ctl = new AbortController();
      $("setup").hidden = true; $("live").hidden = false; say(""); draw();
      ticker = setInterval(() => { draw(); report(); }, 1000);
      loop();
      try { wake = await navigator.wakeLock?.request("screen"); } catch { /* the screen may sleep; the sound goes on */ }
    } catch (e) {
      say(e.status === 401 ? "You are signed out. Sign in again, then come back to this page." : e.message, true);
      if (e.status === 401) setTimeout(() => (location.href = "/__login?next=/connect"), 1500);
    } finally { $("go").disabled = false; }
  }
  function stop() {
    running = false; ctl?.abort(); clearInterval(ticker); a.pause(); a.removeAttribute("src"); S.id = null;
    try { wake?.release(); } catch { /* fine */ }
    $("live").hidden = true; $("setup").hidden = false;
  }
  $("go").addEventListener("click", start);
  $("stop").addEventListener("click", () => { api("/__off/connect/report", { id: null, playing: false, pos: 0, dur: 0, ended: S.ended, volume: 0, error: null }, dev?.token).catch(() => {}); stop(); say("Stopped. This device shows as offline in Monochrome."); });
  $("forget").addEventListener("click", async () => {
    if (!confirm("Remove this device from your account?")) return;
    try { await api("/__off/connect/remove", { deviceId: dev.id }); } catch { /* it may already be gone */ }
    stop(); store.clear(); say("Removed.");
  });
  document.addEventListener("visibilitychange", async () => { if (running && document.visibilityState === "visible") { try { wake = await navigator.wakeLock?.request("screen"); } catch { /* fine */ } } });

  $("name").value = store.get()?.name || guessName();
  const known = store.get();
  if (known) say(`This browser is "${known.name}". Press Start to receive again.`);
})();
