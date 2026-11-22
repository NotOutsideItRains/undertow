// The web player: search your sources, play them in the browser, with lyrics, a music video and an animated background.
// Loaded the first time someone opens it. The lyrics renderer (braccato) and the background (kawarp) are open-source libraries in /vendor.
import * as party from "./party.js";
let ctx; // { api, toast, esc, icon, store, reduce } from app.js
const P = { tracks: [], i: -1, videos: false, tier: "HI_RES", video: true, tab: "results", built: false, libs: null, req: 0, warmed: -1, seeking: false, shown: [], src: "results", lib: { favorites: [], playlists: [] }, view: { type: "home" }, auto: true, played: [], extending: false, can: {}, screen: "now", lyricsPhone: true, fx: false, k: null, spk: { on: false, ok: false, checked: false, device: "", sync: 0, ended: null, timer: null, err: "", dragging: false } };
let root, audio, video, motion, lyricsEl, kawarp, searchTimer;
const V = { off: 0, end: 0, skips: [], loaded: false, synced: false, id: 0, bust: 0, watch: 0, everLoaded: false, interrupted: false, retries: 0 }; // the video's place against the song
const $ = (s, r = root) => r.querySelector(s);
const mmss = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");
const SYNC_LABEL = { word: "Karaoke", line: "Line synced", plain: "Plain" };
const CAN_ALAC = (() => { try { return !!document.createElement("audio").canPlayType('audio/mp4; codecs="alac"'); } catch { return true; } })(); // only Safari and Apple devices play ALAC
const QUALITY = [["HI_RES", "Lossless"], ["HIGH", "High (AAC 320)"], ["LOW", "Low (AAC 96)"], ["ALAC", `Lossless as ALAC (converted)${CAN_ALAC ? "" : " (this browser says it can't play it)"}`], ["MP3", "MP3 V0 (converted, plays anywhere)"]];

export function openPlayer(c) {
  ctx = c;
  if (!P.built) build();
  checkSpeaker(); loadLibrary();
  root.classList.add("open");
  root.removeAttribute("inert");
  document.documentElement.classList.add("player-open");
  loadLibs().then(() => { kawarp?.resize(); });
  if (!matchMedia("(pointer: coarse)").matches) setTimeout(() => $(".p-search").focus({ preventScroll: true }), 80);
}
export function closePlayer() {
  root?.classList.remove("open");
  root?.setAttribute("inert", "");
  document.documentElement.classList.remove("player-open");
}
export function stopPlayer() { // signed out: stop everything
  if (!P.built) return;
  if (P.spk.on) { speakerSend({ action: "stop" }); clearInterval(P.spk.timer); }
  audio.pause(); audio.removeAttribute("src"); audio.load();
  video.removeAttribute("src"); video.load();
  P.tracks = []; P.i = -1; P.shown = []; P.lib = { favorites: [], playlists: [] }; P.view = { type: "home" }; P.played = [];
  closePlayer();
}
export const playing = () => P.built && !audio.paused;

function build() {
  P.built = true;
  P.tier = ctx.store.get("p.tier") || "HI_RES";
  P.video = ctx.store.get("p.video") !== "0";
  P.auto = ctx.store.get("p.auto") !== "0";
  P.lyricsPhone = ctx.store.get("p.lyricsPhone") !== "0";
  const fxSaved = ctx.store.get("p.fx"); // "1" on, "0" off; nothing saved: on only if the browser has no graphics acceleration
  P.fx = fxSaved === "1" || (fxSaved === null && !!ctx.softwareGl?.());
  P.fxAuto = fxSaved === null && P.fx;
  const { icon } = ctx;
  root = document.createElement("div");
  root.className = "player";
  root.dataset.screen = "now"; // on a phone the player is three screens: now playing, lyrics, and the lists
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Player");
  root.setAttribute("inert", "");
  root.innerHTML = `<canvas class="p-bg" aria-hidden="true"></canvas><div class="p-scrim"></div>
    <header class="p-top">
      <button class="p-btn" data-p="close" aria-label="Close player">${icon("close")}</button>
      <input class="input p-search" type="search" placeholder="Search songs" enterkeyhint="search" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="Search songs">
    </header>
    <div class="p-body">
      <section class="p-now">
        <div class="p-art"><img class="p-cover" alt="" draggable="false" hidden><video class="p-motion" muted loop playsinline preload="auto" aria-hidden="true"></video><video class="p-video" muted playsinline preload="auto"></video><button class="p-pipb" data-p="pip" aria-label="Picture in picture" aria-pressed="false">${icon("pip")}</button><div class="p-none">${icon("play")}</div><div class="p-vprog" hidden role="status"><span class="p-vtxt"></span><i class="p-vbar"><b></b></i></div></div>
        <div class="p-meta">
          <div class="p-metal"><button class="p-btn p-ab" data-p="auto" aria-label="Autoplay: keep playing similar songs" aria-pressed="${P.auto}">${icon("radio")}</button></div>
          <div class="p-mt"><div class="p-title">Nothing playing</div><div class="p-artist"></div></div>
          <div class="p-metar"><button class="p-btn p-morenow" data-p="morenow" aria-label="More for this song">${icon("more")}</button><button class="p-btn p-fav" data-p="fav" aria-label="Favorite" aria-pressed="false" disabled>${icon("heart")}</button></div>
        </div>
        <div class="p-controls glass chrome">
          <input class="p-seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek" disabled>
          <div class="p-times"><span class="p-cur">0:00</span><span class="p-dur">0:00</span></div>
          <div class="p-buttons">
            <button class="p-btn p-party" data-p="party" aria-label="Listening party" aria-pressed="false">${icon("party")}</button>
            <button class="p-btn" data-p="video" aria-label="Music video" aria-pressed="${P.video}">${icon("video")}</button>
            <button class="p-btn" data-p="prev" aria-label="Previous">${icon("prev")}</button>
            <button class="p-btn p-play" data-p="play" aria-label="Play">${icon("play")}</button>
            <button class="p-btn" data-p="next" aria-label="Next">${icon("next")}</button>
            <select class="p-q" aria-label="Quality">${QUALITY.map(([v, l]) => `<option value="${v}" ${v === P.tier ? "selected" : ""}>${l}</option>`).join("")}</select>
          </div>
          <div class="p-out" hidden>
            <button class="p-btn p-spk" data-p="spk" aria-label="Play through the server speakers" aria-pressed="false">${icon("speaker")}</button>
            <span class="p-outlabel">This device</span>
            <input class="p-vol" type="range" min="0" max="100" value="50" aria-label="Speaker volume" hidden>
          </div>
        </div>
        <nav class="p-dock" aria-label="Player views">
          <button class="p-dbtn p-dlyr" data-p="screen" data-screen="lyrics" aria-label="Lyrics">${icon("lyrics")}</button>
          <button class="p-dbtn p-ab" data-p="auto" aria-label="Autoplay: keep playing similar songs" aria-pressed="${P.auto}">${icon("radio")}</button>
          <button class="p-dbtn" data-p="screen" data-screen="list" aria-label="Songs and library">${icon("list")}</button>
          <button class="p-dbtn" data-p="screen" data-screen="queue" aria-label="Queue">${icon("queue")}</button>
        </nav>
      </section>
      <section class="p-side">
        <div class="p-lhd"><button class="p-btn" data-p="screen" data-screen="now" aria-label="Back to the player">${icon("down")}</button><span class="p-lthumb"><img alt="" hidden draggable="false"></span><span class="p-ltxt"><b class="p-m1"></b><span class="p-m2"></span></span></div>
        <div class="p-sidehead"><div class="p-tabs" role="tablist"><button role="tab" data-p="tab" data-tab="lyrics">Lyrics</button><button role="tab" data-p="tab" data-tab="results">Songs</button><button role="tab" data-p="tab" data-tab="library">Library</button><button role="tab" data-p="tab" data-tab="queue">Queue</button></div><select class="p-ly" aria-label="Lyrics source" hidden></select></div><div class="p-by" hidden></div>
        <div class="p-pane p-lyrics" data-pane="lyrics"><div class="p-note">Play a song to see its lyrics.</div></div>
        <div class="p-pane p-results" data-pane="results"><div class="p-note">Search for a song above.</div></div>
        <div class="p-pane p-library" data-pane="library"></div>
        <div class="p-pane p-queue" data-pane="queue"></div>
        <div class="p-lmini"><i class="p-lbar"><b></b></i><div class="p-lbtns"><button class="p-btn" data-p="prev" aria-label="Previous">${icon("prev")}</button><button class="p-btn p-lplay" data-p="play" aria-label="Play">${icon("play")}</button><button class="p-btn" data-p="next" aria-label="Next">${icon("next")}</button></div></div>
      </section>
    </div>
    <div class="p-minibar glass chrome" data-p="screen" data-screen="now" role="button" tabindex="0" aria-label="Open the player"><span class="p-mthumb"><img alt="" hidden draggable="false"></span><span class="p-ltxt"><b class="p-m1">Nothing playing</b><span class="p-m2"></span></span><button class="p-btn p-mplay" data-p="play" aria-label="Play">${icon("play")}</button><i class="p-mbar"><b></b></i></div>`;
  document.body.append(root);
  audio = document.createElement("audio");
  audio.id = "p-audio"; // the lyrics read this element's clock, so it has to be in the page
  audio.preload = "auto";
  root.append(audio);
  video = $(".p-video");
  motion = $(".p-motion");
  root.classList.toggle("no-pip", !document.pictureInPictureEnabled); // a browser that can't do it gets no button
  P.motion = ctx.store.get("p.motion") !== "0" && !ctx.reduce; // people who reduce motion get the still cover
  setTab("results"); renderLibrary(); renderQueue();
  applyFx();
  if (P.fxAuto && !ctx.store.get("p.fxnote")) { // asked once, the next time the player is open; leaving it unanswered asks again later
    const t = setInterval(() => {
      if (!document.documentElement.classList.contains("player-open") || P.sheet) return;
      clearInterval(t);
      sheet(`<div class="p-sheeth"><b>Effects reduced</b><span>Your browser isn't using graphics acceleration, so blur and the moving background can stutter. Effects are reduced for now. You can change this any time in the ••• menu.</span></div><button data-m="on">Keep effects reduced</button><button data-m="off">Turn all effects on</button>`, (b) => {
        P.fx = b.dataset.m === "on"; P.fxAuto = false;
        ctx.store.set("p.fx", P.fx ? "1" : "0"); ctx.store.set("p.fxnote", "1");
        applyFx(); closeSheet();
      });
    }, 1000);
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-p]");
    if (!b) { const row = e.target.closest(".p-row"); if (row) rowClick(row); return; }
    ({ close: closePlayer, party: party.openSheet, spk: toggleSpeaker, play: toggle, prev: () => step(-1), next: () => step(1), video: toggleVideo, tab: () => setTab(b.dataset.tab), screen: () => go(b.dataset.screen),
      pip: togglePip, fav: () => toggleFav(P.tracks[P.i]), auto: toggleAuto, morenow: () => { const t = P.tracks[P.i]; if (t) openMenu(t, { dataset: { list: "queue", i: String(P.i) } }); }, rowfav: () => toggleFav(itemOf(b)), more: () => openMenu(itemOf(b), b), lib: () => libAction(b), qrm: () => queueRemove(Number(b.dataset.i)), qclear: queueClear })[b.dataset.p]?.();
  });
  root.addEventListener("change", (e) => { // picking where the lyrics come from
    if (!e.target.classList?.contains("p-ly")) return;
    ctx.store.set("p.ly", e.target.value);
    if (P.i >= 0) lyrics(P.tracks[P.i]);
  });
  $(".p-art").addEventListener("click", (e) => { // a tap on the video makes it full screen (and a tap again leaves)
    if (!root.classList.contains("has-video") || e.target.closest("[data-p]")) return;
    if (document.fullscreenElement) document.exitFullscreen?.(); else $(".p-art").requestFullscreen?.().catch(() => {});
  });
  $(".p-search").addEventListener("focus", () => { if (phone() && P.screen === "now") go("list"); }); // searching happens on the list screen
  $(".p-search").addEventListener("input", (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => search(e.target.value), 320); });
  $(".p-search").addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(searchTimer); search(e.target.value); e.target.blur(); } });
  $(".p-q").addEventListener("change", (e) => {
    P.tier = e.target.value; ctx.store.set("p.tier", P.tier); P.spk.sync = Date.now() + 2500;
    if (P.tier === "ALAC" && !CAN_ALAC) ctx.toast("This browser says it can't play ALAC, so songs may stay silent. ALAC works in Safari and on Apple devices. Pick MP3 or Lossless instead.", true);
    if (P.i >= 0 && audio.src) { const t = audio.currentTime, was = !audio.paused; audio.src = srcOf(P.tracks[P.i]); audio.addEventListener("loadedmetadata", () => { audio.currentTime = t; if (was) audio.play().catch(() => {}); }, { once: true }); }
  });
  const seek = $(".p-seek");
  seek.addEventListener("pointerdown", () => (P.seeking = true));
  seek.addEventListener("input", () => { const d = audio.duration || P.tracks[P.i]?.duration || 0; $(".p-cur").textContent = mmss((seek.value / 1000) * d); });
  seek.addEventListener("change", () => { if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration; P.seeking = false; });
  addEventListener("keydown", (e) => {
    if (!root.classList.contains("open") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") { if (phone() && P.screen !== "now") return go("now"); return closePlayer(); }
    if (e.target.closest?.("input, select, textarea")) return;
    if (e.key === " ") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowRight") audio.currentTime += 5;
    else if (e.key === "ArrowLeft") audio.currentTime -= 5;
  });
  addEventListener("resize", () => { kawarp?.resize(); applyLyricsFlag(); });
  applyLyricsFlag();

  let tick;
  audio.addEventListener("playing", () => { syncMotion(); syncPlayButton(); root.classList.remove("loading"); place(); clearInterval(tick); tick = setInterval(place, 120); }); // keeps the picture tight to the song
  audio.addEventListener("pause", () => { syncMotion(); syncPlayButton(); video.pause(); clearInterval(tick); if (P.spk.on && !audio.ended && Date.now() > P.spk.sync) speakerSend({ action: "pause" }); });
  audio.addEventListener("play", () => { if (P.spk.on && Date.now() > P.spk.sync) speakerSend({ action: "resume" }); });
  $(".p-vol").addEventListener("pointerdown", () => (P.spk.dragging = true));
  $(".p-vol").addEventListener("change", () => (P.spk.dragging = false));
  let volT; $(".p-vol").addEventListener("input", (e) => { clearTimeout(volT); volT = setTimeout(() => speakerSend({ action: "volume", vol: Number(e.target.value) }), 120); });
  audio.addEventListener("seeked", () => { place(true); if (P.spk.on && Date.now() > P.spk.sync) speakerSend({ action: "seek", pos: audio.currentTime }); });
  audio.addEventListener("ratechange", () => { video.playbackRate = audio.playbackRate; });
  audio.addEventListener("waiting", () => root.classList.add("loading"));
  for (const ev of ["play", "pause", "seeked", "playing", "timeupdate"]) audio.addEventListener(ev, () => window.UndertowRPC?.sync(P.tracks[P.i], audio, rpcQuality(P.tracks[P.i])));
  for (const ev of ["play", "pause", "seeked"]) audio.addEventListener(ev, () => party.changed()); // the party host tells everyone
  party.init({ audio, tracks: () => P.tracks, index: () => P.i, load: partyLoad, setQueue: (q, i) => { P.tracks = q; P.i = i; rows(); renderQueue(); }, toast: (m, bad) => ctx.toast(m, bad), esc: (x) => ctx.esc(x), sheet: (h, f) => sheet(h, f), close: closeSheet, name: () => ctx.name?.() || "My", state: () => $(".p-party")?.setAttribute("aria-pressed", String(party.active())) }); // Discord presence, when it's turned on
  audio.addEventListener("ended", () => { if (!P.spk.on && !party.following()) step(1, true); }); // on the server speakers the server says when the song is over
  audio.addEventListener("error", () => { root.classList.remove("loading"); if (audio.src) ctx.toast("Couldn't play that one", true); });
  audio.addEventListener("loadedmetadata", () => { $(".p-dur").textContent = mmss(audio.duration); seek.disabled = false; });
  audio.addEventListener("timeupdate", () => {
    const d = audio.duration;
    if (!P.seeking && d) { seek.value = (audio.currentTime / d) * 1000; $(".p-cur").textContent = mmss(audio.currentTime); }
    if (d) for (const b of root.querySelectorAll(".p-lbar b, .p-mbar b")) b.style.width = `${(audio.currentTime / d) * 100}%`;
    if (d && audio.currentTime / d > 0.6 && P.warmed !== P.i && P.tracks[P.i + 1]) { P.warmed = P.i; fetch(srcOf(P.tracks[P.i + 1]), { headers: { Range: "bytes=0-0" } }).catch(() => {}); } // builds the next song's file while this one plays
    place(); scrobbleTick();
    if ("mediaSession" in navigator && d) { try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime, d), playbackRate: 1 }); } catch { /* not supported */ } }
  });
  motion.addEventListener("loadeddata", () => { // the clip is ready: fade it in over the cover, and let the frame take its shape (3:4 for a tall clip)
    const a = $(".p-art"), tall = motion.videoHeight > motion.videoWidth * 1.1;
    root.classList.add("has-motion"); root.classList.toggle("motion-tall", tall);
    if (tall) { a.style.setProperty("--mar", `${motion.videoWidth} / ${motion.videoHeight}`); a.style.setProperty("--marn", (motion.videoWidth / motion.videoHeight).toFixed(4)); }
    syncMotion();
  });
  motion.addEventListener("error", () => { if (motion.getAttribute("src")) { M.key = ""; root.classList.remove("has-motion", "motion-tall"); } }); // no animated cover for this album: the still one stays
  video.addEventListener("loadedmetadata", () => { // the picture frame takes the video's own shape, nothing is cropped
    frameShape(true);
  });
  video.addEventListener("enterpictureinpicture", () => $(".p-pipb").setAttribute("aria-pressed", "true"));
  video.addEventListener("leavepictureinpicture", () => $(".p-pipb").setAttribute("aria-pressed", "false"));
  video.addEventListener("loadeddata", () => { V.loaded = true; V.everLoaded = true; V.interrupted = false; V.retries = 0; V.watch++; hideProg(); reveal(); });
  video.addEventListener("error", () => {
    V.loaded = false; V.watch++; hideProg(); root.classList.remove("has-video"); frameShape(false);
    // a video that was playing and then broke (a phone gives the decoder back when you leave the browser) is loaded again, a few times
    if (V.everLoaded && video.getAttribute("src") && V.retries < 3) { V.retries++; setTimeout(() => { if (video.getAttribute("src") && !V.loaded) reloadVideo(); }, 700 * V.retries); }
  });
  document.addEventListener("visibilitychange", () => { // leaving the browser can break or stall the video: when you come back, bring it back
    if (!P.built) return;
    if (document.visibilityState === "hidden") { if (!V.loaded && video.getAttribute("src")) V.interrupted = true; return; }
    if (V.synced && !V.loaded && video.getAttribute("src") && (V.interrupted || V.everLoaded)) { V.interrupted = false; V.retries = 0; reloadVideo(); }
    else if (V.loaded) place(true); // the video and the song drifted apart while the page was away
  });
  if ("mediaSession" in navigator) { // the browser can pop the video out by itself when you leave the app (where it supports that)
    try { navigator.mediaSession.setActionHandler("enterpictureinpicture", () => { if (root.classList.contains("has-video")) video.requestPictureInPicture().catch(() => {}); }); } catch { /* not supported */ }
  }
  if ("mediaSession" in navigator) {
    for (const [a, f] of [["play", () => audio.play()], ["pause", () => audio.pause()], ["previoustrack", () => step(-1)], ["nexttrack", () => step(1)], ["seekto", (d) => { audio.currentTime = d.seekTime; }]]) { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* not supported */ } }
  }
}

// The two libraries load the first time the player opens; the page works without them (no lyrics, a plain background).
async function loadLibs() {
  if (P.libs) return P.libs;
  P.libs = (async () => {
    if (!document.getElementById("braccato-css")) document.head.append(Object.assign(document.createElement("link"), { id: "braccato-css", rel: "stylesheet", href: "/vendor/braccato.css?v=1" }));
    const [b, k] = await Promise.all([import("/vendor/braccato.js?v=1").catch(() => null), import("/vendor/kawarp.js?v=1").catch(() => null)]);
    P.k = k;
    if (k && !fxLow()) startKawarp();
    if (b) {
      lyricsEl = document.createElement("braccato-lyrics");
      lyricsEl.setAttribute("source", "#p-audio");
      P.parse = b.detectParser;
      if (P.i >= 0) lyrics(P.tracks[P.i]);
    }
    return { b, k };
  })();
  return P.libs;
}

const srcOf = (t) => `/api/play/audio/${encodeURIComponent(t.id)}?q=${/^(ALAC|MP3)$/.test(P.tier) ? `HI_RES&format=${P.tier.toLowerCase()}` : P.tier}`;
function setTab(tab) {
  P.tab = tab;
  for (const b of root.querySelectorAll(".p-tabs button")) b.setAttribute("aria-selected", b.dataset.tab === tab);
  for (const p of root.querySelectorAll(".p-pane")) p.hidden = p.dataset.pane !== tab;
  const sel = $(".p-ly");
  if (sel) sel.hidden = tab !== "lyrics" || sel.options.length < 2;
  const by = $(".p-by");
  if (by) by.hidden = tab !== "lyrics" || !by.innerHTML;
}

async function search(q) {
  q = q.trim();
  const box = $(".p-results");
  if (!q) { box.innerHTML = `<div class="p-note">Search for a song above.</div>`; return; }
  box.innerHTML = `<div class="p-note">Searching…</div>`;
  setTab("results");
  if (phone()) go("list");
  try {
    const r = await ctx.api("GET", `/play/search?q=${encodeURIComponent(q)}`);
    P.videos = r.videos;
    P.shown = r.tracks; // browsing never disturbs what's playing or queued
    rows();
  } catch (e) { box.innerHTML = `<div class="p-note">${ctx.esc(e.message)}</div>`; }
}
function rows() {
  const box = $(".p-results");
  box.innerHTML = P.shown.length ? P.shown.map((t, i) => item(t, i, "shown")).join("") : `<div class="p-note">Nothing found.</div>`;
  renderLibrary(); renderQueue(); syncFav();
}
// Last.fm: "now playing" when a song starts, and a scrobble once half of it (or 4 minutes) has really been listened to
const SC = { t: null, ts: 0, heard: 0, pos: null, sent: false };
const scrobbling = () => !!ctx.lastfm?.();
function scrobbleSend(kind, t, ts) {
  if (!scrobbling()) return;
  ctx.api("POST", "/play/scrobble", { kind, title: t.title, artist: t.artist, album: t.album || "", duration: t.duration || 0, ts }).then((r) => { if (r?.disconnected) { ctx.lastfmGone?.(); ctx.toast("Last.fm was disconnected. Connect it again from your profile.", true); } }).catch(() => {});
}
function scrobbleStart(t) {
  Object.assign(SC, { t, ts: Math.floor(Date.now() / 1000), heard: 0, pos: null, sent: false });
  scrobbleSend("now", t, SC.ts);
}
function scrobbleTick() { // called as the song plays; skips and seeks don't count as listening
  const t = SC.t; if (!t || SC.sent || audio.paused) { SC.pos = null; return; }
  const now = audio.currentTime, dt = SC.pos == null ? 0 : now - SC.pos;
  SC.pos = now;
  if (dt > 0 && dt < 2.5) SC.heard += dt;
  const dur = audio.duration || t.duration || 0;
  if (dur >= 30 && SC.heard >= Math.min(dur / 2, 240)) { SC.sent = true; scrobbleSend("scrobble", t, SC.ts); }
}
async function play(i) {
  const t = P.tracks[i];
  if (!t) return;
  P.i = i;
  P.played = [...P.played.filter((x) => x !== t.id), t.id].slice(-80);
  rows();
  if (P.auto && P.tracks.length - i <= 2 && !party.following()) extendQueue(); // line up the next songs before they're needed
  root.classList.add("loading");
  $(".p-title").textContent = t.title;
  $(".p-artist").textContent = [t.artist, t.album].filter(Boolean).join(" · ");
  const img = $(".p-cover");
  img.hidden = !t.artworkURL;
  if (t.artworkURL) img.src = t.artworkURL;
  root.classList.toggle("no-art", !t.artworkURL);
  $(".p-seek").value = 0; $(".p-seek").disabled = true; $(".p-cur").textContent = "0:00"; $(".p-dur").textContent = mmss(t.duration);
  P.spk.sync = Date.now() + 1500; // the page starting the song is not the listener pressing play
  scrobbleStart(t);
  audio.src = srcOf(t);
  audio.play().catch((e) => { if (e.name !== "AbortError") { root.classList.remove("loading"); ctx.toast("Couldn't play that one", true); } });
  if (P.spk.on) speakerStart(t);
  party.changed();
  if (P.libs) await P.libs; // the first song can start before the libraries finish loading
  syncMobileMeta(t);
  background(t); lyrics(t); musicVideo(t); loadMotion(t);
  if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album || "", artwork: t.artworkURL ? [{ src: new URL(t.artworkURL, location.href).href, sizes: "640x640" }] : [] });
}
const rpcQuality = (t) => (P.tier === "HI_RES" ? (t?.audioQuality === "HI_RES_LOSSLESS" ? "Hi-Res Lossless" : "Lossless") : P.tier === "HIGH" ? "AAC 320" : P.tier === "LOW" ? "AAC 96" : ""); // what Discord shows next to the album
function partyLoad(tracks, i, pos, playing) { // a party host's song: the queue, the place in it, and where the song is by now
  P.tracks = tracks.map((x) => ({ ...x })); P.i = i; P.src = "party"; P.warmed = -1;
  const once = () => { audio.removeEventListener("loadedmetadata", once); if (pos > 1 && Number.isFinite(audio.duration)) audio.currentTime = Math.min(pos, audio.duration - 0.2); if (!playing) audio.pause(); };
  audio.addEventListener("loadedmetadata", once);
  play(i);
}
export const joinParty = async (id) => { try { await party.join(id); } catch (e) { ctx.toast(e.message, true); } };
async function step(d, auto = false) {
  const n = P.i + d;
  if (n < 0) { audio.currentTime = 0; return; }
  if (n >= P.tracks.length) { // the end of the queue: autoplay finds more
    if (P.auto && P.i >= 0 && d > 0 && (await extendQueue()) && P.i + d < P.tracks.length) return play(P.i + d);
    if (auto) syncPlayButton();
    return;
  }
  play(n);
}
function toggle() { if (!audio.src) { if (P.tracks.length) play(Math.max(0, P.i)); return; } audio.paused ? audio.play().catch(() => {}) : audio.pause(); }
function syncPlayButton() {
  for (const b of root.querySelectorAll("[data-p=play]")) { // the big one, and the small ones on the lyrics screen and the mini player
    b.innerHTML = ctx.icon(audio.paused ? "play" : "pause");
    b.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  }
  document.dispatchEvent(new CustomEvent("player-state", { detail: { playing: !audio.paused } }));
}
function toggleVideo() {
  P.video = !P.video;
  ctx.store.set("p.video", P.video ? "1" : "0");
  $("[data-p=video]").setAttribute("aria-pressed", P.video);
  root.classList.toggle("has-video", P.video && V.loaded && V.synced);
  if (P.video && V.loaded && V.synced) place(true);
  frameShape(P.video);
  if (P.video && P.i >= 0 && !video.getAttribute("src")) musicVideo(P.tracks[P.i]);
}

// The picture follows the song. Its place is the song's time plus the offset measured on the server; small drifts are
// smoothed out by running the video a touch faster or slower, big ones by jumping.
function frameShape(on) { // the picture frame takes the video's own shape; the number lets the CSS cap its height without squashing it
  const a = $(".p-art");
  if (on && video.videoWidth && video.videoHeight) { a.style.setProperty("--ar", `${video.videoWidth} / ${video.videoHeight}`); a.style.setProperty("--arn", (video.videoWidth / video.videoHeight).toFixed(4)); }
  else { a.style.removeProperty("--ar"); a.style.removeProperty("--arn"); }
}
function place(jump = false) {
  if (!V.loaded || !video.duration) return;
  let target = audio.currentTime + V.off; // where the song is, inside the video: past each interruption, the video is that much further on
  for (const [a, b] of V.skips) if (target >= a) target += b - a;
  if (target < 0) { // the video starts after the song does: wait on its first frame
    if (!video.paused) video.pause();
    if (video.currentTime > 0.05) video.currentTime = 0;
    video.playbackRate = 1;
    return;
  }
  if (target > video.duration || (V.end && target > V.end)) { // the video (or its music, per SponsorBlock) ended before the song did: back to the cover
    video.pause();
    root.classList.remove("has-video");
    return;
  }
  if (P.video && V.synced) root.classList.add("has-video");
  const drift = video.currentTime - target; // positive: the video is ahead
  if (jump || Math.abs(drift) > 0.25) video.currentTime = target;
  video.playbackRate = Math.abs(drift) > 0.04 && Math.abs(drift) <= 0.25 ? (drift > 0 ? 0.96 : 1.04) * audio.playbackRate : audio.playbackRate;
  if (!audio.paused && video.paused) video.play().catch(() => {});
  if (audio.paused && !video.paused) video.pause();
}
function reveal() { // show the video once it has loaded and its offset is known
  if (V.loaded && V.synced && P.video) { place(true); root.classList.add("has-video"); }
}
async function syncVideo(t) {
  const my = V.id;
  try {
    const r = await ctx.api("GET", `/play/videosync/${encodeURIComponent(t.id)}`);
    if (my !== V.id) return; // a newer song took over
    V.off = r.ok ? r.offset : 0; // not sure enough? start the video with the song
    V.end = r.end || 0; // where the music ends inside the video, when SponsorBlock knows
    V.skips = r.skips || []; // spoken or non-music parts in the middle of the video, which the picture jumps over
  } catch { if (my !== V.id) return; V.off = 0; }
  V.synced = true;
  reveal();
}
function background(t) {
  if (fxLow()) { gradientFor(t).then((g) => root.style.setProperty("--fxbg", g)); return; } // reduced effects: a still gradient from the cover, not the moving background
  if (!kawarp) return;
  if (t.artworkURL) kawarp.loadImage(t.artworkURL).catch(() => kawarp.loadGradient(["#1b2a4a", "#4a1b3a", "#10151f"], 45));
  else { const h = [...(t.title || "")].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 0); kawarp.loadGradient([`hsl(${h} 55% 28%)`, `hsl(${(h + 60) % 360} 50% 20%)`, "#0b0c10"], 45); }
}
function musicVideo(t) {
  V.id++; V.off = 0; V.end = 0; V.skips = []; V.everLoaded = false; V.interrupted = false; V.retries = 0; V.loaded = false; V.synced = false; V.watch++; hideProg();
  root.classList.remove("has-video");
  frameShape(false);
  video.removeAttribute("src");
  video.load();
  if (!P.videos || !P.video) return;
  video.src = `/api/play/video/${encodeURIComponent(t.id)}${V.bust ? `?b=${V.bust}` : ""}`; // found and saved the first time; the picture appears when it's ready
  watchProgress(t);
  syncVideo(t);
}
async function lyrics(t) {
  const my = ++P.req, pane = $(".p-lyrics");
  if (!lyricsOn()) { pane.innerHTML = `<div class="p-note">Lyrics are turned off on this phone. Turn them on from the ••• menu.</div>`; $(".p-ly").hidden = true; $(".p-by").hidden = true; return; }
  if (!P.parse) { pane.innerHTML = `<div class="p-note">Lyrics aren't available here.</div>`; return; }
  pane.innerHTML = `<div class="p-note">Looking for lyrics…</div>`;
  $(".p-ly").hidden = true;
  $(".p-by").hidden = true;
  if (!phone()) setTab("lyrics"); // on a phone the lyrics have a screen of their own, and nothing jumps there by itself
  try {
    const r = await ctx.api("GET", `/play/lyrics?title=${encodeURIComponent(t.title)}&artist=${encodeURIComponent(t.artist || "")}&album=${encodeURIComponent(t.album || "")}&duration=${t.duration || 0}&isrc=${encodeURIComponent(t.isrc || "")}&provider=${encodeURIComponent(ctx.store.get("p.ly") || "")}`);
    if (my !== P.req) return; // a newer song took over
    let lines = r.lyrics;
    if (!lines?.length && r.text) { try { lines = P.parse(r.text).parse(r.text, (t.duration || audio.duration || 0) * 1000); } catch { lines = null; } } // Unison sends TTML or LRC text
    if (!lines?.length) { pane.innerHTML = `<div class="p-note">No lyrics found for this one.</div>`; return; }
    pane.innerHTML = "";
    const pref = ctx.store.get("p.ly") || "", { esc } = ctx;
    const sel = $(".p-ly");
    sel.innerHTML = `<option value="">Best match${pref ? "" : ` (${esc(r.source)})`}</option>${(r.options || []).map((o) => `<option value="${esc(o.key)}" ${pref && o.key === r.key ? "selected" : ""}>${esc(o.name)} · ${SYNC_LABEL[o.sync] || ""}</option>`).join("")}`;
    sel.hidden = P.tab !== "lyrics";
    pane.append(lyricsEl);
    lyricsEl.lyrics = lines;
    const by = $(".p-by"), sync = SYNC_LABEL[r.sync] || "", sub = r.submitter;
    const page = /^https:\/\/unison\.(boidu\.dev|betterlyrics\.org)\//.test(r.sourceHref || "") ? r.sourceHref : ""; // only Unison's own pages
    const rank = sub && [sub.level ? `Level ${sub.level}` : "", sub.badge || ""].filter(Boolean).join(" · ");
    by.innerHTML = sub
      ? `${sub.avatar ? `<img class="p-pfp" src="/api/play/pfp?u=${encodeURIComponent(sub.avatar)}" alt="" draggable="false">` : `<span class="p-pfp p-pfp-none">${esc([...sub.name][0] || "?")}</span>`}<div class="p-bytext"><div class="p-l1"><b>${esc(sub.name)}</b>${rank ? `<span>${esc(rank)}</span>` : ""}</div><div class="p-l2">synced on ${page ? `<a href="${esc(page)}" target="_blank" rel="noopener noreferrer">${esc(r.source)}</a>` : esc(r.source)} · ${sync}</div></div>`
      : `<div class="p-bytext"><div class="p-l2">Lyrics from ${esc(r.source)} · ${sync}</div></div>`;
    by.querySelector("img.p-pfp")?.addEventListener("error", (e) => { // a dead picture leaves a letter, not a broken icon
      const l = Object.assign(document.createElement("span"), { className: "p-pfp p-pfp-none", textContent: [...sub.name][0] || "?" });
      e.target.replaceWith(l);
    });
    by.hidden = P.tab !== "lyrics";
  } catch (e) { if (my === P.req) pane.innerHTML = `<div class="p-note">${ctx.esc(e.message)}</div>`; }
}

// ---- the server's speakers: the song plays out of the server's AUX, this page is the remote ----
// The local <audio> keeps running muted, because the lyrics follow its clock; every second it is pulled back to the server's place.
const SPK_LATENCY = 0.4; // seconds between what ffmpeg has sent to the sound card and what you hear
async function speakerSend(body) {
  try { const s = await ctx.api("POST", "/play/speaker", body); speakerApply(s); return s; }
  catch (e) { ctx.toast(e.message, true); if (body.action === "play") setSpeaker(false); return null; } // couldn't start there: carry on playing on this device
}
async function checkSpeaker() {
  if (P.spk.checked) return;
  P.spk.checked = true;
  try {
    const s = await ctx.api("GET", "/play/speaker");
    if (!s.available) return;
    P.spk.ok = true; P.spk.device = s.device || "";
    $(".p-out").hidden = false;
    if (ctx.store.get("p.spk") === "1") setSpeaker(true, true);
  } catch { /* not allowed, or not there: the row stays hidden */ }
}
function toggleSpeaker() { setSpeaker(!P.spk.on); }
function setSpeaker(on, quiet = false) {
  if (on && !P.spk.ok) return;
  P.spk.on = on;
  ctx.store.set("p.spk", on ? "1" : "0");
  const b = $(".p-spk");
  b.setAttribute("aria-pressed", on);
  $(".p-vol").hidden = !on;
  $(".p-outlabel").textContent = on ? `Server speakers${P.spk.device ? ` · ${P.spk.device}` : ""}` : "This device";
  audio.muted = on;
  clearInterval(P.spk.timer);
  P.spk.sync = Date.now() + 1500;
  if (on) {
    P.spk.timer = setInterval(() => ctx.api("GET", "/play/speaker").then(speakerApply).catch(() => {}), 1000);
    if (P.i >= 0 && audio.src && !audio.paused) speakerStart(P.tracks[P.i], audio.currentTime); // already playing here: hand it over
    else ctx.api("GET", "/play/speaker").then(speakerApply).catch(() => {});
    if (!quiet) ctx.toast("Playing through the server speakers");
  } else {
    speakerSend({ action: "stop" });
    if (!quiet) ctx.toast("Playing on this device");
  }
}
async function speakerStart(t, pos = 0) {
  const s = await speakerSend({ action: "play", id: t.id, q: P.tier, dur: t.duration || audio.duration || 0, title: `${t.artist} - ${t.title}`, pos });
  if (s) P.spk.ended = s.ended; // a song that ends later raises this number
}
function speakerApply(s) {
  if (!P.spk.on) return;
  const cur = P.i >= 0 ? P.tracks[P.i] : null, mine = cur && s.id === cur.id;
  const vol = $(".p-vol");
  if (!P.spk.dragging && s.volume?.value != null) vol.value = s.volume.value;
  if (s.error && s.error !== P.spk.err) ctx.toast(s.error, true);
  P.spk.err = s.error || "";
  if (!mine) return;
  if (P.spk.ended != null && s.ended > P.spk.ended) { P.spk.ended = s.ended; P.spk.sync = Date.now() + 1500; step(1, true); return; }
  P.spk.ended = P.spk.ended ?? s.ended;
  P.spk.sync = Date.now() + 500; // what happens next is the server's doing, not the listener's
  if (!s.playing && !audio.paused) audio.pause();
  else if (s.playing && audio.paused) audio.play().catch(() => {});
  const want = Math.max(0, s.pos - (s.playing ? SPK_LATENCY : 0));
  if (Math.abs(audio.currentTime - want) > 0.8) audio.currentTime = want;
}

// ---- favorites, playlists, the queue and autoplay ----
const pick = (t) => ({ id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration, artworkURL: t.artworkURL, source: t.source });
const isFav = (id) => P.lib.favorites.some((t) => t.id === id);
const plOf = (id) => P.lib.playlists.find((p) => p.id === id);
const libTracks = () => (P.view.type === "fav" ? P.lib.favorites : P.view.type === "pl" ? plOf(P.view.id)?.tracks || [] : []);
const listOf = (name) => (name === "shown" ? P.shown : name === "lib" ? libTracks() : P.tracks);
const itemOf = (el) => listOf(el.dataset.list)[Number(el.dataset.i)];
function item(t, i, list, o = {}) {
  const { esc, icon } = ctx, on = P.tracks[P.i]?.id === t.id && (list !== "queue" || i === P.i);
  return `<div class="p-item${o.past ? " past" : ""}"><button class="p-row${on ? " on" : ""}" data-list="${list}" data-i="${i}">
      <span class="p-thumb">${t.artworkURL ? `<img src="${esc(t.artworkURL)}" alt="" loading="lazy" draggable="false">` : ""}</span>
      <span class="p-rt"><b>${esc(t.title)}</b><span>${esc(t.artist)}${t.source ? ` · ${esc(t.source)}` : ""}</span></span>
      <span class="p-rd">${t.duration ? mmss(t.duration) : ""}</span></button>
    ${o.rm ? `<button class="p-mini" data-p="qrm" data-i="${i}" aria-label="Remove from queue">${icon("close")}</button>`
      : `<button class="p-mini p-rf" data-p="rowfav" data-list="${list}" data-i="${i}" aria-label="Favorite" aria-pressed="${isFav(t.id)}">${icon("heart")}</button>`}
    <button class="p-mini" data-p="more" data-list="${list}" data-i="${i}" aria-label="More">${icon("more")}</button></div>`;
}
function rowClick(row) {
  const i = Number(row.dataset.i), list = row.dataset.list;
  if (list === "queue") return play(i);
  startList(listOf(list), i, list);
}
function startList(list, i, src) {
  const t = list[i];
  if (!t) return;
  const one = src === "shown" && P.auto; // a song picked from a search plays alone, then autoplay carries on from it
  P.tracks = one ? [{ ...t }] : list.map((x) => ({ ...x }));
  P.i = one ? 0 : i; P.src = src; P.warmed = -1;
  play(P.i);
}

async function loadLibrary() {
  try { P.lib = await ctx.api("GET", "/play/library"); P.can = P.lib.can || {}; if (P.can.video) P.videos = true; renderLibrary(); rows(); } catch { /* not signed in yet */ }
}
async function libSend(body, ok) {
  try { P.lib = await ctx.api("POST", "/play/library", body); if (ok) ctx.toast(ok); rows(); return true; }
  catch (e) { ctx.toast(e.message, true); return false; }
}
function toggleFav(t) {
  if (!t) return;
  libSend(isFav(t.id) ? { action: "unfav", id: t.id } : { action: "fav", track: pick(t) }, isFav(t.id) ? "Removed from favorites" : "Added to favorites");
}
function syncFav() {
  const b = $(".p-fav"), t = P.tracks[P.i];
  if (!b) return;
  b.disabled = !t;
  b.setAttribute("aria-pressed", !!t && isFav(t.id));
  b.setAttribute("aria-label", t && isFav(t.id) ? "Remove from favorites" : "Add to favorites");
}

// Library tab: favorites and playlists
function renderLibrary() {
  const box = $(".p-library"), { esc, icon } = ctx, v = P.view;
  if (!box) return;
  if (v.type === "home") {
    box.innerHTML = `<button class="p-lrow" data-p="lib" data-do="open-fav"><span class="p-lico fav">${icon("heart")}</span><span class="p-rt"><b>Favorites</b><span>${P.lib.favorites.length} song${P.lib.favorites.length === 1 ? "" : "s"}</span></span>${icon("chev")}</button>
      <div class="p-lhead"><span>Playlists</span><button class="p-link" data-p="lib" data-do="new">New playlist</button></div>
      ${P.lib.playlists.length ? P.lib.playlists.map((p) => `<button class="p-lrow" data-p="lib" data-do="open-pl" data-pid="${esc(p.id)}"><span class="p-lico">${p.tracks[0]?.artworkURL ? `<img src="${esc(p.tracks[0].artworkURL)}" alt="" loading="lazy" draggable="false">` : icon("play")}</span><span class="p-rt"><b>${esc(p.name)}</b><span>${p.tracks.length} song${p.tracks.length === 1 ? "" : "s"}</span></span>${icon("chev")}</button>`).join("") : `<div class="p-note">No playlists yet. Tap “New playlist”, or use ••• on any song.</div>`}`;
    return;
  }
  const pl = v.type === "pl" ? plOf(v.id) : null;
  if (v.type === "pl" && !pl) { P.view = { type: "home" }; return renderLibrary(); }
  const tracks = libTracks();
  box.innerHTML = `<div class="p-lhead"><button class="p-link" data-p="lib" data-do="back">${icon("back")} Library</button>${pl ? `<span class="p-lbtns"><button class="p-link" data-p="lib" data-do="rename">Rename</button><button class="p-link bad" data-p="lib" data-do="delete">Delete</button></span>` : ""}</div>
    <div class="p-ltitle">${esc(pl ? pl.name : "Favorites")}</div>
    ${tracks.length ? `<div class="p-lact"><button class="p-pill" data-p="lib" data-do="play">${icon("play")} Play</button><button class="p-pill" data-p="lib" data-do="shuffle">${icon("shuffle")} Shuffle</button></div>${tracks.map((t, i) => item(t, i, "lib")).join("")}` : `<div class="p-note">${pl ? "Nothing here yet. Use ••• on a song to add it." : "Tap the heart on a song to keep it here."}</div>`}`;
}
function libAction(b) {
  const d = b.dataset.do;
  if (d === "open-fav") P.view = { type: "fav" };
  else if (d === "open-pl") P.view = { type: "pl", id: b.dataset.pid };
  else if (d === "back") P.view = { type: "home" };
  else if (d === "new") return promptSheet("New playlist", "", "Create", (name) => libSend({ action: "pl-create", name }, "Playlist created"));
  else if (d === "rename") { const p = plOf(P.view.id); return promptSheet("Rename playlist", p?.name || "", "Save", (name) => libSend({ action: "pl-rename", pid: P.view.id, name })); }
  else if (d === "delete") return confirmSheet(`Delete “${plOf(P.view.id)?.name}”?`, "The songs stay wherever else you saved them.", "Delete", async () => { if (await libSend({ action: "pl-delete", pid: P.view.id }, "Playlist deleted")) P.view = { type: "home" }; renderLibrary(); });
  else if (d === "play" || d === "shuffle") {
    let list = libTracks().map((x) => ({ ...x }));
    if (d === "shuffle") for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    P.tracks = list; P.i = 0; P.src = "lib"; P.warmed = -1; return play(0);
  }
  renderLibrary();
  $(".p-library").scrollTop = 0;
}

// Queue tab
function renderQueue() {
  const box = $(".p-queue");
  if (!box) return;
  if (!P.tracks.length) { box.innerHTML = `<div class="p-note">Nothing queued. Play a song and its next ones show up here${P.auto ? ", with autoplay finding more" : ""}.</div>`; return; }
  const out = []; let divided = false;
  P.tracks.forEach((t, i) => {
    if (i === P.i) out.push(`<div class="p-lhead"><span>Now playing</span></div>`);
    if (i === P.i + 1) out.push(`<div class="p-lhead"><span>Up next</span><button class="p-link" data-p="qclear">Clear</button></div>`);
    if (t.auto && !divided && i > P.i) { divided = true; out.push(`<div class="p-lhead"><span>Autoplay · similar songs</span></div>`); }
    out.push(item(t, i, "queue", { rm: i > P.i, past: i < P.i }));
  });
  box.innerHTML = `${out.join("")}${P.extending ? `<div class="p-note">Finding more…</div>` : ""}`;
  const cur = box.querySelector(".p-row.on"); if (cur && P.tab === "queue") cur.scrollIntoView({ block: "nearest" });
}
function queueRemove(i) { if (i > P.i) { P.tracks.splice(i, 1); renderQueue(); } }
function queueClear() { P.tracks.splice(P.i + 1); renderQueue(); }
function toggleAuto() {
  P.auto = !P.auto;
  ctx.store.set("p.auto", P.auto ? "1" : "0");
  for (const b of root.querySelectorAll(".p-ab")) b.setAttribute("aria-pressed", P.auto);
  ctx.toast(P.auto ? "Autoplay on: similar songs keep playing" : "Autoplay off");
  if (P.auto && P.i >= 0 && P.tracks.length - P.i <= 2) extendQueue();
  else renderQueue();
}
// Autoplay asks the server for songs like the one playing (and the person's taste), skipping everything already played or queued.
async function extendQueue() {
  if (P.extending || P.i < 0 || !P.tracks[P.i]) return 0;
  P.extending = true; renderQueue();
  try {
    const seed = P.tracks[P.i], ex = [...new Set([...P.tracks.map((t) => t.id), ...P.played])].slice(-60);
    const r = await ctx.api("GET", `/play/radio?id=${encodeURIComponent(seed.id)}&exclude=${encodeURIComponent(ex.join(","))}`);
    const add = (r.tracks || []).map((t) => ({ ...t, auto: true }));
    P.tracks.push(...add);
    return add.length;
  } catch { return 0; }
  finally { P.extending = false; renderQueue(); }
}

// The ••• menu, and small sheets for naming and confirming
function sheet(html, onClick) {
  closeSheet();
  const el = document.createElement("div");
  el.className = "p-sheetbg";
  el.innerHTML = `<div class="p-sheet glass chrome" role="dialog">${html}</div>`;
  el.addEventListener("click", (e) => { if (e.target === el) return closeSheet(); const b = e.target.closest("[data-m]"); if (b) onClick(b, el); });
  root.append(el);
  requestAnimationFrame(() => el.classList.add("on"));
  P.sheet = el;
  return el;
}
function closeSheet() { const el = P.sheet; if (!el) return; P.sheet = null; el.classList.remove("on"); setTimeout(() => el.remove(), 220); }
addEventListener("keydown", (e) => { if (e.key === "Escape" && P.sheet) { e.stopPropagation(); closeSheet(); } }, true);
function openMenu(t, btn) {
  if (!t) return;
  const { esc } = ctx, list = btn.dataset.list, inPl = list === "lib" && P.view.type === "pl", i = Number(btn.dataset.i);
  const head = `<div class="p-sheeth"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></div>`;
  const main = () => `${head}
    <button data-m="fav">${isFav(t.id) ? "Remove from favorites" : "Add to favorites"}</button>
    <button data-m="pl">Add to playlist…</button>
    <button data-m="next">Play next</button>
    <button data-m="queue">Add to queue</button>
    ${ctx.share ? `<button data-m="chat">Send in a chat…</button>` : ""}
    ${P.can.submit ? `<button data-m="video">Submit music video…</button>` : ""}
    ${phone() ? `<button data-m="lyricsphone">Lyrics on this phone <span>${P.lyricsPhone ? "On" : "Off"}</span></button>` : ""}
    ${ctx.reduce ? "" : `<button data-m="fx">Reduce effects <span>${P.fx ? (P.fxAuto ? "On (no graphics acceleration)" : "On") : "Off"}</span></button>`}
    ${ctx.reduce ? "" : `<button data-m="motion">Animated covers <span>${P.motion ? "On" : "Off"}</span></button>`}
    ${inPl ? `<button data-m="up"${i === 0 ? " disabled" : ""}>Move up</button><button data-m="down"${i >= libTracks().length - 1 ? " disabled" : ""}>Move down</button><button data-m="rm" class="bad">Remove from this playlist</button>` : ""}`;
  const el = sheet(main(), (b) => {
    const m = b.dataset.m, put = (x) => { P.tracks.splice(x, 0, { ...t }); renderQueue(); };
    if (m === "fav") { toggleFav(t); closeSheet(); }
    else if (m === "next") { if (P.i < 0) { P.tracks = [{ ...t }]; P.i = 0; play(0); } else put(P.i + 1); ctx.toast("Playing next"); closeSheet(); }
    else if (m === "queue") { if (P.i < 0) { P.tracks = [{ ...t }]; P.i = 0; play(0); } else { const at = P.tracks.findLastIndex((x) => !x.auto); put(Math.max(at, P.i) + 1); } ctx.toast("Added to queue"); closeSheet(); }
    else if (m === "lyricsphone") {
      P.lyricsPhone = !P.lyricsPhone; ctx.store.set("p.lyricsPhone", P.lyricsPhone ? "1" : "0"); applyLyricsFlag();
      if (!P.lyricsPhone && P.screen === "lyrics") go("now");
      if (P.i >= 0) lyrics(P.tracks[P.i]);
      ctx.toast(P.lyricsPhone ? "Lyrics on" : "Lyrics off on this phone"); closeSheet();
    }
    else if (m === "chat") { closeSheet(); ctx.share?.(t); }
    else if (m === "fx") { P.fx = !P.fx; P.fxAuto = false; ctx.store.set("p.fx", P.fx ? "1" : "0"); applyFx(); ctx.toast(P.fx ? "Effects reduced: still background, no blur" : "Effects back on"); closeSheet(); }
    else if (m === "motion") { P.motion = !P.motion; ctx.store.set("p.motion", P.motion ? "1" : "0"); M.key = ""; if (P.i >= 0) loadMotion(P.tracks[P.i]); ctx.toast(P.motion ? "Animated covers on" : "Animated covers off"); closeSheet(); }
    else if (m === "video") { closeSheet(); setTimeout(() => promptSheet(`Music video for “${t.title}”`, "", "Submit", (link) => submitVideo(t, link), { placeholder: "YouTube link", max: 200, url: true, hint: "Paste the YouTube link of the song's official music video. Everyone who plays this song will see it." }), 240); }
    else if (m === "pl") el.firstElementChild.innerHTML = `${head}<button data-m="back">‹ Back</button><button data-m="newpl">New playlist…</button>${P.lib.playlists.map((p) => `<button data-m="addto" data-pid="${esc(p.id)}">${esc(p.name)} <span>${p.tracks.some((x) => x.id === t.id) ? "Added" : p.tracks.length}</span></button>`).join("")}`;
    else if (m === "back") el.firstElementChild.innerHTML = main();
    else if (m === "newpl") { closeSheet(); promptSheet("New playlist", "", "Create", (name) => libSend({ action: "pl-create", name, track: pick(t) }, "Added to the new playlist")); }
    else if (m === "addto") { libSend({ action: "pl-add", pid: b.dataset.pid, track: pick(t) }, "Added to the playlist"); closeSheet(); }
    else if (m === "rm") { libSend({ action: "pl-remove", pid: P.view.id, id: t.id }); closeSheet(); }
    else if (m === "up" || m === "down") { libSend({ action: "pl-move", pid: P.view.id, from: i, to: i + (m === "up" ? -1 : 1) }); closeSheet(); }
  });
}
function promptSheet(title, value, label, done, o = {}) {
  const { esc } = ctx;
  const el = sheet(`<div class="p-sheeth"><b>${esc(title)}</b>${o.hint ? `<span>${esc(o.hint)}</span>` : ""}</div><input class="input p-sheetin" maxlength="${o.max || 60}" value="${esc(value)}" placeholder="${esc(o.placeholder || "Name")}" ${o.url ? 'inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false"' : ""} autocomplete="off" enterkeyhint="done"><button data-m="ok" class="p-sheetok">${esc(label)}</button>`, (b) => { if (b.dataset.m === "ok") submit(); });
  const inp = el.querySelector("input"), submit = () => { const v = inp.value.trim(); if (!v) return; closeSheet(); done(v); };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  setTimeout(() => { inp.focus({ preventScroll: true }); inp.select(); }, 60);
}
// Someone says which video belongs to a song. It's checked on the server (YouTube, the right length), then everyone gets it.
async function submitVideo(t, link) {
  try {
    const r = await ctx.api("POST", "/play/video-submit", { id: t.id, title: t.title, artist: t.artist, link });
    ctx.toast(`Video added: ${r.title}`);
    P.videos = true; V.bust = Date.now(); // the old picture, if any, is replaced
    if (P.tracks[P.i]?.id === t.id) musicVideo(t);
  } catch (e) { ctx.toast(e.message, true); }
}
function confirmSheet(title, text, label, done) {
  const { esc } = ctx;
  sheet(`<div class="p-sheeth"><b>${esc(title)}</b><span>${esc(text)}</span></div><button data-m="ok" class="bad">${esc(label)}</button><button data-m="no">Cancel</button>`, (b) => { closeSheet(); if (b.dataset.m === "ok") done(); });
}

// While a song's video isn't saved yet (finding it, then downloading), a small bar on the cover says where it is, so it never looks stuck.
const hideProg = () => { const p = $(".p-vprog"); if (p) p.hidden = true; };
function showProg(text, pct) {
  const p = $(".p-vprog"); if (!p) return;
  p.hidden = false;
  $(".p-vtxt").textContent = text;
  p.classList.toggle("wait", pct == null); // no number to show: a moving bar instead
  $(".p-vbar b").style.width = pct == null ? "" : `${Math.max(3, pct)}%`;
}
async function watchProgress(t) {
  const my = ++V.watch, until = Date.now() + 4 * 60 * 1000;
  let shown = false;
  while (my === V.watch && Date.now() < until) {
    let s;
    try { s = await ctx.api("GET", `/play/video-status/${encodeURIComponent(t.id)}`); } catch { break; }
    if (my !== V.watch) return;
    if (s.state === "ready" || s.state === "none") { if (shown) hideProg(); return; } // saved already, or this song has no video
    if (s.state === "error") { showProg("Couldn't get the video", null); setTimeout(() => { if (my === V.watch) hideProg(); }, 4000); return; }
    shown = true;
    if (s.state === "downloading") showProg(`Downloading video ${Math.round(s.pct)}%`, s.pct);
    else if (s.state === "finishing") showProg("Almost there…", null);
    else if (s.state === "queued") showProg("Getting the video ready…", null);
    else showProg("Finding the video…", null);
    await new Promise((r) => setTimeout(r, s.state === "downloading" ? 450 : 700));
  }
  if (my === V.watch) hideProg();
}

// ---- animated album covers (Apple Music's motion artwork), from the server; the player only ----
// Phones get the tall (3:4) clip when the album has one, everything else the square one. The server falls back to square by itself.
const M = { key: "" };
const smallTouch = () => matchMedia("(max-width: 600px) and (pointer: coarse)").matches; // a phone in the hand: asks for the tall clip
function syncMotion() { // it moves while the song does
  if (!motion || !root.classList.contains("has-motion")) return;
  if (audio.paused) motion.pause(); else motion.play().catch(() => {});
}
function loadMotion(t) {
  const shape = smallTouch() ? "tall" : "square", key = `${t.artist}|${t.album}|${shape}`;
  if (!P.motion || fxLow() || !t.album || !t.artist) { M.key = ""; clearMotion(); return; }
  if (key === M.key) { syncMotion(); return; } // the next song is on the same album: keep the clip going
  M.key = key;
  clearMotion();
  motion.src = `/api/play/motion?artist=${encodeURIComponent(String(t.artist).split(",")[0])}&album=${encodeURIComponent(t.album)}&shape=${shape}`;
}
function clearMotion() {
  root.classList.remove("has-motion", "motion-tall");
  const a = $(".p-art"); a.style.removeProperty("--mar"); a.style.removeProperty("--marn");
  if (motion.getAttribute("src")) { motion.pause(); motion.removeAttribute("src"); motion.load(); }
}

// ---- the phone layout: now playing, lyrics and the lists are three screens (desktop keeps its two columns) ----
const phone = () => matchMedia("(max-width: 899px)").matches;
const lyricsOn = () => !phone() || P.lyricsPhone;
function applyLyricsFlag() { root.classList.toggle("no-lyrics", phone() && !P.lyricsPhone); }
function go(screen) {
  if (screen === "queue") { P.screen = "list"; setTab("queue"); }
  else {
    P.screen = screen;
    if (screen === "lyrics") setTab("lyrics");
    else if (screen === "list") setTab(["results", "library", "queue"].includes(P.tab) ? P.tab : "results");
  }
  root.dataset.screen = P.screen;
  $(".p-body").scrollTop = 0;
}
function syncMobileMeta(t) { // the small copies of the title and cover: the lyrics header and the mini player
  for (const el of root.querySelectorAll(".p-mthumb img, .p-lthumb img")) { el.hidden = !t.artworkURL; if (t.artworkURL) el.src = t.artworkURL; }
  for (const el of root.querySelectorAll(".p-m1")) el.textContent = t.title;
  for (const el of root.querySelectorAll(".p-m2")) el.textContent = t.artist;
  for (const b of root.querySelectorAll(".p-lbar b, .p-mbar b")) b.style.width = "0";
}

// Picture in picture: the video in a small window that stays over other apps. (The sound is the page's own, so it keeps playing as it is.)
async function togglePip() {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (document.pictureInPictureEnabled && video.readyState >= 2) await video.requestPictureInPicture();
    else ctx.toast("Picture-in-picture isn't available here", true);
  } catch { ctx.toast("Picture-in-picture isn't available here", true); }
}

function reloadVideo() { // ask for the same video again, keeping what is known about how it lines up with the song
  const src = video.getAttribute("src");
  if (!src) return;
  video.removeAttribute("src"); video.load();
  video.setAttribute("src", src);
}

// A song from a chat: it starts playing without opening the player (the player's button shows it's playing).
export function playTrack(c, t) {
  ctx = c; if (!P.built) build();
  P.tracks = [{ ...t }]; P.i = 0; P.src = "shared"; P.warmed = -1;
  play(0);
}
export const current = () => (P.built && P.i >= 0 ? P.tracks[P.i] || null : null);

// ---- reduced effects: for slow or fussy graphics cards, and for anyone who asks their device to reduce motion ----
// A still gradient from the cover replaces the moving background, the panels keep their see-through look without the blur (see the stylesheet),
// and the lyrics lose their blur and extra graphics layer. The page-wide part is the "fx-low" class on <html>.
const fxLow = () => P.fx || !!ctx?.reduce;
function applyFx() {
  const low = fxLow();
  document.documentElement.classList.toggle("fx-low", low);
  if (low) kawarp?.stop();
  else if (kawarp) { kawarp.resize(); kawarp.start(); }
  else if (P.k) startKawarp();
  if (P.i >= 0) { background(P.tracks[P.i]); loadMotion(P.tracks[P.i]); }
}
function startKawarp() {
  if (!P.k || kawarp) return;
  try { kawarp = new P.k.Kawarp($(".p-bg"), { animationSpeed: 1, warpIntensity: 0.9, saturation: 1.4, transitionDuration: 1200 }); kawarp.resize(); kawarp.start(); if (P.i >= 0) background(P.tracks[P.i]); }
  catch { kawarp = null; }
}
export async function _gradientFor(t) { return gradientFor(t); } // exported for tests
function gradientFor(t) { // three colours from the cover (top-left, middle, bottom-right), darkened so the text stays readable
  const hue = [...(t.title || "")].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 0);
  const fallback = `linear-gradient(165deg, hsl(${hue} 45% 26%), hsl(${(hue + 50) % 360} 40% 16%) 60%, #0b0c10)`;
  if (!t.artworkURL) return Promise.resolve(fallback);
  return new Promise((ok) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas"); c.width = c.height = 3;
        const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0, 3, 3);
        const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
        const shade = ([r, gg, b], k) => `rgb(${[r, gg, b].map((v, i) => Math.round(v * k + [11, 12, 16][i] * (1 - k))).join(",")})`;
        const [a, m, z] = [px(0, 0), px(1, 1), px(2, 2)];
        ok(`linear-gradient(165deg, ${shade(a, 0.55)} 0%, ${shade(m, 0.45)} 55%, ${shade(z, 0.35)} 100%)`);
      } catch { ok(fallback); }
    };
    img.onerror = () => ok(fallback);
    img.src = t.artworkURL;
  });
}
