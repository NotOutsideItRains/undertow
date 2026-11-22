// Undertow: seasonal and special-day touches. One file, shared by the Undertow site and the Monochrome player (monochrome-port/patch.py copies it there).
// Everything is decided from the visitor's own clock and time zone, never the server's.
//
//   December ............ snow
//   New Year ............ a countdown in the last 10 seconds of 31 December, then fireworks at midnight (if the page is open), and a short show
//                         the first time the site is opened on 1 January
//   1 December, Romanian  the logo and the browser-tab icon become the Romanian flag (National Day). "Romanian" = the browser's language is
//                         Romanian, or its time zone is Bucharest or Chisinau.
//   14 February ......... floating hearts
//   31 October .......... pumpkins and bats
//
// Try one on any day: add ?seasonal=snow, newyear, flag, hearts or halloween to the address. To try a date and time (they keep running from there):
// ?seasonal_date=2026-12-31T23:59:45
// Off switch: the small ✦ tab on the right edge (remembered per browser), the device's "reduce motion" setting, or Undertow's reduced-effects setting.
(() => {
  "use strict";
  if (window.__ulSeasonal) return;
  window.__ulSeasonal = true;

  const qs = new URLSearchParams(location.search);
  const skew = (() => { const s = qs.get("seasonal_date"), t = s ? new Date(s).getTime() : NaN; return Number.isFinite(t) ? t - Date.now() : 0; })();
  const now = () => new Date(Date.now() + skew);
  const only = (qs.get("seasonal") || "").toLowerCase();
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const KEY = "ul-seasonal";
  let on = true;
  try { on = localStorage.getItem(KEY) !== "off"; } catch { /* no storage: effects stay on */ }
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("fx-low");

  const isRomanian = () => {
    try {
      const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""];
      if (langs.some((l) => /^ro(-|$)/i.test(l))) return true;
      return /^Europe\/(Bucharest|Chisinau)$/.test(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch { return false; }
  };

  const d0 = now(), month = d0.getMonth(), day = d0.getDate();
  const today = {
    snow: only ? only === "snow" : month === 11,
    hearts: only ? only === "hearts" : month === 1 && day === 14,
    halloween: only ? only === "halloween" : month === 9 && day === 31,
    flag: only ? only === "flag" : month === 11 && day === 1 && isRomanian(),
    newyear: only ? only === "newyear" : (month === 11 && day === 31) || (month === 0 && day === 1),
  };
  if (!Object.values(today).some(Boolean)) return; // an ordinary day: nothing is added to the page

  // ---- drawing surfaces: one for falling things, one for fireworks (which fade their trails) ----
  let W = 0, H = 0, dpr = 1;
  const layers = {};
  const fit = (l) => { l.c.width = Math.round(W * dpr); l.c.height = Math.round(H * dpr); l.g.setTransform(dpr, 0, 0, dpr, 0, 0); };
  const measure = () => { dpr = Math.min(window.devicePixelRatio || 1, 1.5); W = window.innerWidth; H = window.innerHeight; Object.values(layers).forEach(fit); };
  const layer = (name, z) => {
    if (layers[name]) return layers[name];
    if (!W) measure();
    const c = document.createElement("canvas");
    c.setAttribute("aria-hidden", "true");
    c.style.cssText = `position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:${z}`;
    document.body.appendChild(c);
    const l = (layers[name] = { c, g: c.getContext("2d") });
    fit(l);
    return l;
  };
  const dropLayer = (name) => { layers[name]?.c.remove(); delete layers[name]; };
  addEventListener("resize", measure);

  // ---- falling and floating things ----
  const amb = { kind: "", items: [] };
  const flake = (init) => { const r = rand(1.2, 3.8); return { x: rand(0, W), y: init ? rand(0, H) : -8, r, vy: 18 + r * 14, ph: rand(0, 6.3), sw: rand(8, 26) }; };
  const heart = (init) => ({ x: rand(0, W), y: init ? rand(0, H) : H + 24, s: rand(5, 12), vy: -rand(30, 70), ph: rand(0, 6.3), hue: rand(330, 350), light: rand(55, 70) });
  const spooky = (init) => Math.random() < 0.55
    ? { t: "pumpkin", x: rand(0, W), y: init ? rand(0, H) : -30, s: rand(9, 16), vy: rand(22, 48), ph: rand(0, 6.3) }
    : { t: "bat", x: rand(-40, W), by: rand(30, H * 0.6), s: rand(8, 14), vx: rand(40, 90), ph: rand(0, 6.3), y: 0 };
  const seed = (kind) => {
    amb.kind = kind;
    const make = { snow: flake, hearts: heart, halloween: spooky }[kind];
    const n = { snow: clamp(Math.round((W * H) / 16000), 40, 130), hearts: 22, halloween: 16 }[kind];
    amb.items = Array.from({ length: n }, () => make(true));
  };
  const drawHeart = (g, x, y, s) => {
    g.beginPath(); g.moveTo(x, y + s * 0.9);
    g.bezierCurveTo(x - s * 1.6, y - s * 0.1, x - s * 0.8, y - s * 1.2, x, y - s * 0.35);
    g.bezierCurveTo(x + s * 0.8, y - s * 1.2, x + s * 1.6, y - s * 0.1, x, y + s * 0.9);
    g.fill();
  };
  const drawPumpkin = (g, x, y, s) => {
    g.fillStyle = "#f4811f"; g.strokeStyle = "rgba(120,50,0,.55)"; g.lineWidth = 1;
    g.beginPath(); g.ellipse(x, y, s * 1.1, s * 0.9, 0, 0, 6.2832); g.fill(); g.stroke();
    g.beginPath(); g.ellipse(x, y, s * 0.45, s * 0.9, 0, 0, 6.2832); g.stroke();
    g.fillStyle = "#4a7c2a"; g.fillRect(x - s * 0.12, y - s * 1.2, s * 0.24, s * 0.4);
  };
  const drawBat = (g, x, y, s, flap) => {
    g.fillStyle = "#2a1d44"; g.strokeStyle = "rgba(255,255,255,.4)"; g.lineWidth = 1;
    const w = s * 1.6, lift = s * 0.9 * flap;
    g.beginPath(); g.moveTo(x, y);
    g.quadraticCurveTo(x - w * 0.5, y - lift, x - w, y - lift * 0.2);
    g.quadraticCurveTo(x - w * 0.6, y + s * 0.25, x - w * 0.3, y + s * 0.15);
    g.lineTo(x, y + s * 0.4); g.lineTo(x + w * 0.3, y + s * 0.15);
    g.quadraticCurveTo(x + w * 0.6, y + s * 0.25, x + w, y - lift * 0.2);
    g.quadraticCurveTo(x + w * 0.5, y - lift, x, y);
    g.fill(); g.stroke();
  };
  const stepAmbient = (dt) => {
    const g = layer("amb", 99990).g;
    g.clearRect(0, 0, W, H);
    amb.items.forEach((p, i) => {
      if (amb.kind === "snow") {
        p.ph += dt * 0.9; p.y += p.vy * dt; p.x += Math.sin(p.ph) * p.sw * dt + 6 * dt;
        if (p.y > H + 8 || p.x > W + 10) amb.items[i] = Object.assign(flake(false), { x: p.x > W + 10 ? -8 : rand(0, W) });
        g.globalAlpha = clamp(0.5 + p.r / 8, 0.5, 0.95);
        g.fillStyle = "#fff"; g.strokeStyle = "rgba(60,100,155,.85)"; g.lineWidth = 1; // the outline is what shows on a light page
        g.beginPath(); g.arc(p.x, p.y, p.r, 0, 6.2832); g.fill(); g.stroke();
      } else if (amb.kind === "hearts") {
        p.ph += dt; p.y += p.vy * dt; p.x += Math.sin(p.ph) * 18 * dt;
        if (p.y < -30) amb.items[i] = heart(false);
        g.globalAlpha = clamp(Math.min(p.y / (H * 0.25), (H - p.y) / 40), 0, 0.9);
        g.fillStyle = `hsl(${p.hue} 85% ${p.light}%)`;
        drawHeart(g, p.x, p.y, p.s);
      } else {
        p.ph += dt * (p.t === "bat" ? 2 : 1);
        if (p.t === "pumpkin") { p.y += p.vy * dt; p.x += Math.sin(p.ph) * 12 * dt; if (p.y > H + 30) amb.items[i] = spooky(false); g.globalAlpha = 0.95; drawPumpkin(g, p.x, p.y, p.s); }
        else { p.x += p.vx * dt; p.y = p.by + Math.sin(p.ph) * 18; if (p.x > W + 40) amb.items[i] = spooky(false); g.globalAlpha = 0.95; drawBat(g, p.x, p.y, p.s, Math.sin(p.ph * 6)); }
      }
    });
    g.globalAlpha = 1;
  };

  // ---- fireworks ----
  const fw = { until: 0, next: 0, rockets: [], sparks: [] };
  const fwLive = () => performance.now() < fw.until || fw.rockets.length > 0 || fw.sparks.length > 0;
  const burst = (x, y, hue) => {
    const sc = clamp(Math.min(W, H) / 700, 0.6, 1.5), ring = Math.random() < 0.4;
    const n = Math.round(rand(60, 100) * (W < 600 ? 0.7 : 1));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.2832 + rand(-0.04, 0.04), sp = (ring ? 190 : rand(60, 260)) * sc;
      fw.sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0, life: rand(1.1, 1.8), hue: hue + rand(-18, 18), sc });
    }
  };
  const stepFireworks = (dt) => {
    const t = performance.now(), g = layer("fw", 99995).g;
    g.globalCompositeOperation = "destination-out"; g.fillStyle = "rgba(0,0,0,.2)"; g.fillRect(0, 0, W, H); // fades the trails
    g.globalCompositeOperation = "source-over";
    if (t < fw.until && t >= fw.next) {
      const n = Math.random() < 0.25 ? 2 : 1;
      for (let i = 0; i < n; i++) fw.rockets.push({ x: rand(W * 0.12, W * 0.88), y: H, vy: H * rand(0.75, 1), ty: H * rand(0.16, 0.45), hue: rand(0, 360) });
      fw.next = t + rand(280, 850);
    }
    fw.rockets = fw.rockets.filter((r) => {
      r.y -= r.vy * dt;
      g.strokeStyle = `hsl(${r.hue} 100% 85%)`; g.lineWidth = 2; g.beginPath(); g.moveTo(r.x, r.y + 12); g.lineTo(r.x, r.y); g.stroke();
      if (r.y <= r.ty) { burst(r.x, r.y, r.hue); return false; }
      return true;
    });
    const drag = Math.pow(0.985, dt * 60);
    fw.sparks = fw.sparks.filter((s) => {
      s.age += dt;
      if (s.age >= s.life) return false;
      s.vx *= drag; s.vy = s.vy * drag + 140 * s.sc * dt; s.x += s.vx * dt; s.y += s.vy * dt;
      const a = 1 - s.age / s.life;
      g.fillStyle = `hsla(${s.hue} 100% ${60 + 25 * a}% / ${a})`;
      g.beginPath(); g.arc(s.x, s.y, 1.2 + 1.2 * a, 0, 6.2832); g.fill();
      return true;
    });
  };
  const startFireworks = (ms) => { fw.until = Math.max(fw.until, performance.now() + ms); layer("fw", 99995); kick(); };

  // ---- one loop for both; it stops by itself when nothing is left to draw ----
  let raf = 0, last = 0;
  const ambOn = () => on && amb.kind && !reduced();
  const frame = (t) => {
    raf = 0;
    const dt = Math.min(0.05, (t - (last || t)) / 1000); last = t;
    let more = false;
    if (ambOn()) { stepAmbient(dt); more = true; } else if (layers.amb) dropLayer("amb"); // e.g. reduced motion was switched on
    if (fwLive()) { stepFireworks(dt); more = true; } else if (layers.fw) dropLayer("fw");
    if (more) raf = requestAnimationFrame(frame); else last = 0;
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

  // ---- the words ----
  let bannerEl = null, bannerTimer = 0;
  const banner = (text, ms) => {
    if (!bannerEl) {
      bannerEl = document.createElement("div");
      bannerEl.setAttribute("role", "status");
      bannerEl.style.cssText = "position:fixed;left:50%;top:18%;transform:translateX(-50%);max-width:92vw;box-sizing:border-box;text-align:center;z-index:100000;pointer-events:none;color:#fff;font-weight:800;font-size:clamp(1.6rem,6vw,3.4rem);line-height:1.15;text-shadow:0 2px 12px rgba(0,0,0,.6);padding:.18em .6em;border-radius:.4em;background:rgba(6,24,32,.62);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)";
      document.body.appendChild(bannerEl);
    }
    bannerEl.textContent = text;
    clearTimeout(bannerTimer);
    if (ms) bannerTimer = setTimeout(hideBanner, ms);
  };
  const hideBanner = () => { clearTimeout(bannerTimer); bannerEl?.remove(); bannerEl = null; };
  const celebrate = (year, ms) => {
    if (!on) return;
    banner(isRomanian() ? `La mulți ani ${year}!` : `Happy New Year ${year}!`, 8000);
    if (!reduced()) startFireworks(ms);
  };
  const midnight = (year) => new Date(year, 0, 1).getTime();

  // 31 December: count the last ten seconds, then celebrate. 1 January: a show the first time the site is opened (once per tab session).
  const watchNewYear = () => {
    const d = now();
    if (only === "newyear") return void celebrate(d.getFullYear() + (d.getMonth() >= 6 ? 1 : 0), 20000); // a preview: right away, for the coming new year
    if (d.getMonth() === 11 && d.getDate() === 31) {
      const mid = midnight(d.getFullYear() + 1);
      const timer = setInterval(() => {
        const left = Math.ceil((mid - (Date.now() + skew)) / 1000);
        if (left > 10) return;
        if (left >= 1) { if (on) banner(String(left)); return; }
        clearInterval(timer);
        if (left >= -120) celebrate(new Date(mid).getFullYear(), 60000); // a tab that woke up much later gets no show
        else hideBanner();
      }, 250);
    } else if (d.getMonth() === 0 && d.getDate() === 1) {
      const k = `ul-ny-${d.getFullYear()}`;
      try { if (sessionStorage.getItem(k)) return; sessionStorage.setItem(k, "1"); } catch { /* fine: show it */ }
      celebrate(d.getFullYear(), d.getHours() === 0 ? 45000 : 14000);
    }
  };

  // ---- the Romanian flag as the logo (1 December, Romanian users): the page's logos and the browser-tab icon ----
  const FLAG = ["#002B7F", "#FCD116", "#CE1126"];
  const dataSvg = (svg) => "data:image/svg+xml," + encodeURIComponent(svg);
  const monoFlagIcon = () => dataSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 3" shape-rendering="crispEdges"><path fill="${FLAG[0]}" d="M0 1h1v2H0z"/><path fill="${FLAG[1]}" d="M1 0h1v1H1zM1 2h1v1H1z"/><path fill="${FLAG[2]}" d="M2 0h1v2H2z"/></svg>`);
  const monoAppIconFlag = () => dataSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="#000"/><g transform="translate(128 128) scale(256)" shape-rendering="crispEdges"><path fill="${FLAG[0]}" d="M0 1h1v2H0z"/><path fill="${FLAG[1]}" d="M1 0h1v1H1zM1 2h1v1H1z"/><path fill="${FLAG[2]}" d="M2 0h1v2H2z"/></g></svg>`);
  const undertowFlagIcon = () => dataSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="c"><rect width="64" height="64" rx="12"/></clipPath></defs><g clip-path="url(#c)"><rect width="21.4" height="64" fill="${FLAG[0]}"/><rect x="21.3" width="21.4" height="64" fill="${FLAG[1]}"/><rect x="42.6" width="21.4" height="64" fill="${FLAG[2]}"/></g><path d="M20 14v20a12 12 0 0 0 24 0V14" fill="none" stroke="#061820" stroke-width="10.5" stroke-linecap="round" opacity=".5"/><path d="M20 14v20a12 12 0 0 0 24 0V14" fill="none" stroke="#fff" stroke-width="6.5" stroke-linecap="round"/></svg>`);
  let flagCount = 0, flagObserver = null, flagTimer = 0;
  const paintFlag = () => {
    const mono = !!document.querySelector("svg.app-logo");
    document.querySelectorAll("svg.app-logo:not([data-ul-flag])").forEach((svg) => {
      const g = svg.querySelector("g"), id = `ul-flag-${++flagCount}`;
      if (!g) return;
      svg.dataset.ulFlag = id;
      svg.insertAdjacentHTML("afterbegin", `<defs data-ul-flag-defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="3" y2="0"><stop offset="0" stop-color="${FLAG[0]}"/><stop offset=".3333" stop-color="${FLAG[0]}"/><stop offset=".3333" stop-color="${FLAG[1]}"/><stop offset=".6667" stop-color="${FLAG[1]}"/><stop offset=".6667" stop-color="${FLAG[2]}"/><stop offset="1" stop-color="${FLAG[2]}"/></linearGradient></defs>`);
      g.dataset.ulFill = g.getAttribute("fill") || "";
      g.setAttribute("fill", `url(#${id})`);
    });
    const swap = (img, flag) => { if (!img.dataset.ulSrc) img.dataset.ulSrc = img.getAttribute("src"); img.src = flag; };
    document.querySelectorAll('img[src^="/icon.svg"]').forEach((img) => swap(img, undertowFlagIcon()));
    document.querySelectorAll('img[src*="appicon.png"]').forEach((img) => swap(img, monoAppIconFlag()));
    document.querySelectorAll('link[rel~="icon"]:not([data-ul-href])').forEach((l) => { l.dataset.ulHref = l.getAttribute("href"); l.href = mono ? monoFlagIcon() : undertowFlagIcon(); l.type = "image/svg+xml"; });
  };
  const flagOn = () => {
    paintFlag();
    if (!flagObserver) {
      flagObserver = new MutationObserver(() => { clearTimeout(flagTimer); flagTimer = setTimeout(paintFlag, 150); }); // the apps redraw their logos as pages change
      flagObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    }
  };
  const flagOff = () => {
    flagObserver?.disconnect(); flagObserver = null; clearTimeout(flagTimer);
    document.querySelectorAll("svg[data-ul-flag]").forEach((svg) => { const g = svg.querySelector("g"); if (g) g.setAttribute("fill", g.dataset.ulFill || "#fff"); svg.querySelector("[data-ul-flag-defs]")?.remove(); delete svg.dataset.ulFlag; });
    document.querySelectorAll("img[data-ul-src]").forEach((img) => { img.src = img.dataset.ulSrc; delete img.dataset.ulSrc; });
    document.querySelectorAll("link[data-ul-href]").forEach((l) => { l.href = l.dataset.ulHref; delete l.dataset.ulHref; });
  };

  // ---- start, and the little switch ----
  const start = () => {
    if (!on) return;
    const kind = today.snow ? "snow" : today.hearts ? "hearts" : today.halloween ? "halloween" : "";
    if (kind && !reduced()) { measure(); seed(kind); kick(); }
    if (today.flag) flagOn();
  };
  const stopAll = () => {
    amb.kind = ""; amb.items = []; dropLayer("amb");
    fw.until = 0; fw.rockets = []; fw.sparks = []; dropLayer("fw");
    hideBanner(); flagOff();
  };
  const makeSwitch = () => {
    const b = document.createElement("button");
    b.type = "button";
    const label = () => { b.setAttribute("aria-label", on ? "Turn seasonal effects off" : "Turn seasonal effects on"); b.title = on ? "Seasonal effects: on (click to turn off)" : "Seasonal effects: off (click to turn on)"; b.setAttribute("aria-pressed", String(on)); b.style.opacity = on ? "0.5" : "0.3"; };
    b.textContent = "✦";
    b.style.cssText = "position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:100001;width:22px;height:44px;padding:0;border:0;border-radius:10px 0 0 10px;background:rgba(0,0,0,.4);color:#fff;font:14px/1 sans-serif;cursor:pointer";
    b.addEventListener("mouseenter", () => (b.style.opacity = "1"));
    b.addEventListener("mouseleave", label);
    b.addEventListener("click", () => {
      on = !on;
      try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* not remembered */ }
      if (on) start(); else stopAll();
      label();
    });
    label();
    document.body.appendChild(b);
  };
  const init = () => { makeSwitch(); start(); if (today.newyear) watchNewYear(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
