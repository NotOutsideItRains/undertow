// Undertow: seasonal and special-day touches. One file, shared by the Undertow site and the Monochrome player (monochrome-port/patch.py copies it there).
// Everything is decided from the visitor's own clock and time zone, never the server's.
//
//   Falling or floating things ...  December: snow | 14 Feb: hearts | 17 Mar: shamrocks | 21 Jun (World Music Day): music notes
//                                   23 Sep - 15 Nov: autumn leaves | 31 Oct: pumpkins and bats
//   The logo and the browser-tab icon ... 24-26 Dec: a Santa hat | June: a rainbow | for Romanian visitors: the Romanian flag on 1 Dec (National Day),
//                                   24 Jan (Union Day) and 9 May (Independence Day), and a red-and-white Martisor on 1 Mar | 1 Apr: upside down
//                                   "Romanian" = the browser's language is Romanian, or its time zone is Bucharest or Chisinau.
//   New Year ................... a countdown in the last 10 seconds of 31 December, then fireworks at midnight (if the page is open), and a short
//                                show the first time the site is opened on 1 January
//   4 May ...................... "May the Fourth be with you" and a lightsaber that sweeps across the screen once (once per tab session)
//
// Try one on any day: add ?seasonal=snow, hearts, shamrocks, music, leaves, halloween, hat, rainbow, flag, martisor, april, newyear or may4 to the address.
// To try a date and time (they keep running from there): ?seasonal_date=2026-12-31T23:59:45
// Off switch: the small ✦ tab on the right edge (remembered per browser), the device's "reduce motion" setting, or Undertow's reduced-effects setting.
// The animations also stay off when the browser draws without graphics acceleration (slow): Undertow's page handles that itself, Monochrome is checked here.
// Clicking the ✦ tab on overrides that. The logo changes are not animations and are unaffected.
(() => {
  "use strict";
  if (window.__ulSeasonal) return;
  window.__ulSeasonal = true;

  const qs = new URLSearchParams(location.search);
  const skew = (() => { const s = qs.get("seasonal_date"), t = s ? new Date(s).getTime() : NaN; return Number.isFinite(t) ? t - Date.now() : 0; })();
  const now = () => new Date(Date.now() + skew);
  const only = (qs.get("seasonal") || "").toLowerCase();
  const rand = (a, b) => a + Math.random() * (b - a);
  const pickOne = (list) => list[Math.floor(Math.random() * list.length)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const KEY = "ul-seasonal";
  let on = true;
  try { on = localStorage.getItem(KEY) !== "off"; } catch { /* no storage: effects stay on */ }
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("fx-low");
  // Undertow's own page switches its reduced-effects mode on (fx-low) when the browser draws on the CPU, because it is slow, and the line above follows it.
  // Monochrome has no such mode, so the same check is made here for it. Clicking the ✦ tab on (remembered as "on") overrides it, like Undertow's own setting.
  let forced = false;
  try { forced = localStorage.getItem(KEY) === "on"; } catch { /* no storage */ }
  let swGl;
  const softwareGl = () => (swGl ??= (() => {
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      if (!gl) return true;
      const x = gl.getExtension("WEBGL_debug_renderer_info");
      return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(x ? String(gl.getParameter(x.UNMASKED_RENDERER_WEBGL)) : "");
    } catch { return true; }
  })());
  const slow = () => !forced && !!document.querySelector("svg.app-logo") && softwareGl(); // only the animations are held back; the flag logo is not an animation

  const isRomanian = () => {
    try {
      const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""];
      if (langs.some((l) => /^ro(-|$)/i.test(l))) return true;
      return /^Europe\/(Bucharest|Chisinau)$/.test(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch { return false; }
  };

  const d0 = now(), month = d0.getMonth(), day = d0.getDate(), ro = isRomanian();
  const is = (m, d) => month === m && day === d;
  const pick = (name, test) => (only ? only === name : test);
  const today = {
    snow: pick("snow", month === 11),
    hearts: pick("hearts", is(1, 14)),
    shamrocks: pick("shamrocks", is(2, 17)),
    music: pick("music", is(5, 21)),
    leaves: pick("leaves", (month === 8 && day >= 23) || (month === 9 && day !== 31) || (month === 10 && day <= 15)),
    halloween: pick("halloween", is(9, 31)),
    hat: pick("hat", month === 11 && day >= 24 && day <= 26),
    rainbow: pick("rainbow", month === 5),
    flag: pick("flag", ro && (is(11, 1) || is(0, 24) || is(4, 9))),
    martisor: pick("martisor", ro && is(2, 1)),
    april: pick("april", is(3, 1)),
    newyear: pick("newyear", (month === 11 && day === 31) || (month === 0 && day === 1)),
    may4: pick("may4", is(4, 4)),
  };
  const logoMode = today.flag ? "flag" : today.martisor ? "martisor" : today.hat ? "hat" : today.rainbow ? "rainbow" : today.april ? "flip" : "";
  const ambientKind = ["halloween", "hearts", "shamrocks", "music", "snow", "leaves"].find((k) => today[k]) || "";
  window.__ulSeasonal = { today: Object.keys(today).filter((k) => today[k]), ambient: ambientKind, logo: logoMode }; // what is on today (also read by the tests)
  if (!Object.values(today).some(Boolean)) return; // an ordinary day: nothing is added to the page
  const once = (k) => { try { if (sessionStorage.getItem(k) && !only) return false; sessionStorage.setItem(k, "1"); } catch { /* fine: do it */ } return true; };

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
  const TAU = 6.2832;
  const fall = (o) => Object.assign({ x: rand(0, W), ph: rand(0, 6.3) }, o);
  const heartPath = (g, x, y, s) => {
    g.beginPath(); g.moveTo(x, y + s * 0.9);
    g.bezierCurveTo(x - s * 1.6, y - s * 0.1, x - s * 0.8, y - s * 1.2, x, y - s * 0.35);
    g.bezierCurveTo(x + s * 0.8, y - s * 1.2, x + s * 1.6, y - s * 0.1, x, y + s * 0.9);
    g.fill();
  };
  const pumpkin = (g, x, y, s) => {
    g.fillStyle = "#f4811f"; g.strokeStyle = "rgba(120,50,0,.55)"; g.lineWidth = 1;
    g.beginPath(); g.ellipse(x, y, s * 1.1, s * 0.9, 0, 0, TAU); g.fill(); g.stroke();
    g.beginPath(); g.ellipse(x, y, s * 0.45, s * 0.9, 0, 0, TAU); g.stroke();
    g.fillStyle = "#4a7c2a"; g.fillRect(x - s * 0.12, y - s * 1.2, s * 0.24, s * 0.4);
  };
  const bat = (g, x, y, s, flap) => {
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
  const leaf = (g, s) => { // a leaf pointing up, centred on 0,0
    g.beginPath(); g.moveTo(0, -s);
    g.bezierCurveTo(s * 0.95, -s * 0.5, s * 0.8, s * 0.6, 0, s);
    g.bezierCurveTo(-s * 0.8, s * 0.6, -s * 0.95, -s * 0.5, 0, -s);
    g.fill();
    g.strokeStyle = "rgba(60,25,5,.45)"; g.lineWidth = 1; g.beginPath(); g.moveTo(0, -s * 0.8); g.lineTo(0, s * 1.15); g.stroke();
  };
  const clover = (g, s) => { // three heart-shaped leaves round a point, and a stem
    for (let k = 0; k < 3; k++) { g.save(); g.rotate((k * TAU) / 3); heartPath(g, 0, -s * 0.95, s * 0.62); g.restore(); }
    g.strokeStyle = "#1d6b34"; g.lineWidth = 1.4; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(s * 0.3, s * 0.8, s * 0.1, s * 1.5); g.stroke();
  };
  const note = (g, s, double) => { // an eighth note, or two joined by a beam
    const head = (x, y) => { g.beginPath(); g.ellipse(x, y, s * 0.55, s * 0.4, -0.35, 0, TAU); g.fill(); };
    g.lineWidth = Math.max(1.2, s * 0.16); g.lineCap = "round";
    if (double) {
      head(0, 0); head(s * 1.5, -s * 0.3);
      g.beginPath(); g.moveTo(s * 0.5, -s * 0.1); g.lineTo(s * 0.5, -s * 2.4); g.lineTo(s * 2.0, -s * 2.7); g.lineTo(s * 2.0, -s * 0.4); g.stroke();
      g.beginPath(); g.moveTo(s * 0.5, -s * 2.4); g.lineTo(s * 2.0, -s * 2.7); g.lineWidth = s * 0.45; g.stroke();
    } else {
      head(0, 0);
      g.beginPath(); g.moveTo(s * 0.5, -s * 0.1); g.lineTo(s * 0.5, -s * 2.3); g.quadraticCurveTo(s * 1.2, -s * 1.9, s * 1.1, -s * 1.1); g.stroke();
    }
  };
  const SWAY = (p, dt, amp) => { p.ph += dt; p.x += Math.sin(p.ph) * amp * dt; };
  const fadeEnds = (p) => clamp(Math.min(p.y / (H * 0.25), (H - p.y) / 40), 0, 0.9); // for things that rise: in at the bottom, out at the top
  const KINDS = {
    snow: {
      n: () => clamp(Math.round((W * H) / 16000), 40, 130),
      make: (init) => { const r = rand(1.2, 3.8); return fall({ y: init ? rand(0, H) : -8, r, vy: 18 + r * 14, sw: rand(8, 26) }); },
      step(g, p, dt, i) {
        p.ph += dt * 0.9; p.y += p.vy * dt; p.x += Math.sin(p.ph) * p.sw * dt + 6 * dt;
        if (p.y > H + 8 || p.x > W + 10) amb.items[i] = Object.assign(this.make(false), { x: p.x > W + 10 ? -8 : rand(0, W) });
        g.globalAlpha = clamp(0.5 + p.r / 8, 0.5, 0.95);
        g.fillStyle = "#fff"; g.strokeStyle = "rgba(60,100,155,.85)"; g.lineWidth = 1; // the outline is what shows on a light page
        g.beginPath(); g.arc(p.x, p.y, p.r, 0, TAU); g.fill(); g.stroke();
      },
    },
    hearts: {
      n: () => 22,
      make: (init) => fall({ y: init ? rand(0, H) : H + 24, s: rand(5, 12), vy: -rand(30, 70), hue: rand(330, 350), light: rand(55, 70) }),
      step(g, p, dt, i) {
        SWAY(p, dt, 18); p.y += p.vy * dt;
        if (p.y < -30) amb.items[i] = this.make(false);
        g.globalAlpha = fadeEnds(p); g.fillStyle = `hsl(${p.hue} 85% ${p.light}%)`; heartPath(g, p.x, p.y, p.s);
      },
    },
    music: {
      n: () => 18,
      make: (init) => fall({ y: init ? rand(0, H) : H + 40, s: rand(6, 11), vy: -rand(28, 60), hue: rand(0, 360), two: Math.random() < 0.4 }),
      step(g, p, dt, i) {
        SWAY(p, dt, 22); p.y += p.vy * dt;
        if (p.y < -50) amb.items[i] = this.make(false);
        g.globalAlpha = fadeEnds(p); g.fillStyle = g.strokeStyle = `hsl(${p.hue} 75% 62%)`;
        g.save(); g.translate(p.x, p.y); note(g, p.s, p.two); g.restore();
      },
    },
    shamrocks: {
      n: () => 22,
      make: (init) => fall({ y: init ? rand(0, H) : -30, s: rand(7, 13), vy: rand(26, 56), rot: rand(0, TAU), vr: rand(-1.2, 1.2), tone: pickOne(["#2e9e4f", "#3cb55e", "#1f8a43", "#55c36f"]) }),
      step(g, p, dt, i) {
        SWAY(p, dt, 26); p.y += p.vy * dt; p.rot += p.vr * dt;
        if (p.y > H + 30) amb.items[i] = this.make(false);
        g.globalAlpha = 0.95; g.fillStyle = p.tone; g.save(); g.translate(p.x, p.y); g.rotate(p.rot); clover(g, p.s); g.restore();
      },
    },
    leaves: {
      n: () => clamp(Math.round((W * H) / 30000), 18, 48),
      make: (init) => fall({ y: init ? rand(0, H) : -30, s: rand(6, 12), vy: rand(30, 70), rot: rand(0, TAU), vr: rand(-1.6, 1.6), tone: pickOne(["#d9541e", "#e8892c", "#c9301f", "#e3b02c", "#9a5a22"]) }),
      step(g, p, dt, i) {
        SWAY(p, dt, 38); p.y += p.vy * dt; p.rot += p.vr * dt;
        if (p.y > H + 30) amb.items[i] = this.make(false);
        g.globalAlpha = 0.95; g.fillStyle = p.tone; g.save(); g.translate(p.x, p.y); g.rotate(p.rot); leaf(g, p.s); g.restore();
      },
    },
    halloween: {
      n: () => 16,
      make: (init) => Math.random() < 0.55
        ? fall({ t: "pumpkin", y: init ? rand(0, H) : -30, s: rand(9, 16), vy: rand(22, 48) })
        : fall({ t: "bat", x: rand(-40, W), by: rand(30, H * 0.6), s: rand(8, 14), vx: rand(40, 90), y: 0 }),
      step(g, p, dt, i) {
        p.ph += dt * (p.t === "bat" ? 2 : 1); g.globalAlpha = 0.95;
        if (p.t === "pumpkin") { p.y += p.vy * dt; p.x += Math.sin(p.ph) * 12 * dt; if (p.y > H + 30) amb.items[i] = this.make(false); pumpkin(g, p.x, p.y, p.s); }
        else { p.x += p.vx * dt; p.y = p.by + Math.sin(p.ph) * 18; if (p.x > W + 40) amb.items[i] = this.make(false); bat(g, p.x, p.y, p.s, Math.sin(p.ph * 6)); }
      },
    },
  };
  const seed = (kind) => { amb.kind = kind; amb.items = Array.from({ length: KINDS[kind].n() }, () => KINDS[kind].make(true)); };
  const stepAmbient = (dt) => {
    const g = layer("amb", 99990).g, k = KINDS[amb.kind];
    g.clearRect(0, 0, W, H);
    amb.items.forEach((p, i) => k.step(g, p, dt, i));
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

  // ---- 4 May: a lightsaber that sweeps across the screen once ----
  const saber = { t0: 0, color: "" };
  const SABER_MS = 2800;
  const saberLive = () => saber.t0 > 0 && performance.now() - saber.t0 < SABER_MS;
  const stepSaber = () => {
    const g = layer("saber", 99996).g, k = (performance.now() - saber.t0) / SABER_MS, ease = 0.5 - 0.5 * Math.cos(Math.PI * k);
    const px = W / 2, py = H + 8, len = Math.hypot(W, H) * 1.05, ang = ((-80 + 160 * ease) * Math.PI) / 180 - Math.PI / 2;
    const fade = k > 0.85 ? (1 - k) / 0.15 : Math.min(1, k / 0.08); // in and out
    const ex = px + Math.cos(ang) * len, ey = py + Math.sin(ang) * len;
    g.clearRect(0, 0, W, H);
    g.lineCap = "round";
    for (const [w, c, a] of [[34, saber.color, 0.18], [18, saber.color, 0.45], [8, saber.color, 0.9], [4, "#fff", 1]]) { // glow, then the blade, then its bright core
      g.globalAlpha = fade * a; g.strokeStyle = c; g.lineWidth = w;
      g.beginPath(); g.moveTo(px, py); g.lineTo(ex, ey); g.stroke();
    }
    g.globalAlpha = 1;
  };
  const startSaber = () => {
    if (!once("ul-may4")) return;
    if (!on) return;
    banner("May the Fourth be with you", 5500);
    if (reduced() || slow()) return;
    saber.t0 = performance.now(); saber.color = pickOne(["#4aa8ff", "#4cff6a", "#ff4a4a"]);
    layer("saber", 99996); kick();
  };

  // ---- one loop for everything; it stops by itself when nothing is left to draw ----
  let raf = 0, last = 0;
  const ambOn = () => on && amb.kind && !reduced() && !slow();
  const frame = (t) => {
    raf = 0;
    const dt = Math.min(0.05, (t - (last || t)) / 1000); last = t;
    let more = false;
    if (ambOn()) { stepAmbient(dt); more = true; } else if (layers.amb) dropLayer("amb"); // e.g. reduced motion was switched on
    if (fwLive()) { stepFireworks(dt); more = true; } else if (layers.fw) dropLayer("fw");
    if (saberLive()) { stepSaber(); more = true; } else if (layers.saber) dropLayer("saber");
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
    if (!reduced() && !slow()) startFireworks(ms);
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

  // ---- the logo and the browser-tab icon: a flag, a rainbow, a Santa hat ... (or upside down on 1 April) ----
  // Monochrome's logo is a 3x3 pixel picture (an inline svg.app-logo, plus a 1024px placeholder cover, appicon.png); Undertow's is /icon.svg.
  const SKINS = {
    flag: { dir: "x", cols: ["#002B7F", "#FCD116", "#CE1126"] },
    martisor: { dir: "x", cols: ["#C8102E", "#FFFFFF", "#C8102E"], edge: "#7a1020" }, // the red and white of the Martisor string
    rainbow: { dir: "y", cols: ["#E40303", "#FF8C00", "#FFED00", "#008026", "#24408E", "#732982"] },
    hat: { hat: true },
  };
  const dataSvg = (svg) => "data:image/svg+xml," + encodeURIComponent(svg);
  const stops = (cols) => cols.map((c, i) => `<stop offset="${i / cols.length}" stop-color="${c}"/><stop offset="${(i + 1) / cols.length}" stop-color="${c}"/>`).join("");
  const grad = (id, sk) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${sk.dir === "x" ? 3 : 0}" y2="${sk.dir === "y" ? 3 : 0}">${stops(sk.cols)}</linearGradient>`;
  const PIX = "M1 0h2v1H1zM2 1h1v1H2zM0 2h2v1H0zM0 1h1v1H0z";
  // a Santa hat for the 3x3 picture (it sits on the top edge, tilted, and reaches above it) and one for the 64px Undertow icon
  const HAT3 = '<g shape-rendering="geometricPrecision" transform="rotate(-9 2.1 0.1)"><path d="M1.15 0.12C1.25-0.62 1.85-1.02 2.45-0.92C2.95-0.84 3.2-0.52 3.3-0.14L3.05 0.12Z" fill="#d42426"/><rect x="0.95" y="-0.06" width="2.35" height="0.36" rx="0.18" fill="#fff"/><circle cx="3.36" cy="-0.1" r="0.27" fill="#fff"/></g>';
  const HAT64 = '<g transform="rotate(-9 46 16)"><path d="M33 17C34 4 44-1 52 3C57 5.5 59 10 60 16L57 17Z" fill="#d42426"/><rect x="31" y="13.5" width="30" height="7.5" rx="3.75" fill="#fff"/><circle cx="60.5" cy="15.5" r="4.6" fill="#fff"/></g>';
  const ICON64 = '<rect width="64" height="64" rx="12" fill="#061820"/><path d="M-2 18c10-6 18 3 28-1s20-9 40-2M-2 26c10-6 18 3 28-1s20-9 40-2M-2 54c12-6 20 3 30-1s18-6 36 0" fill="none" stroke="#7fe0cf" stroke-width="1.4" opacity=".2"/><path d="M20 14v20a12 12 0 0 0 24 0V14" fill="none" stroke="#ffb02e" stroke-width="6.5" stroke-linecap="round"/><path d="M24.5 35c2.6-2.8 5.2 2.8 7.5 0s4.9 2.8 7.5 0" fill="none" stroke="#e4f3ee" stroke-width="3" stroke-linecap="round"/><path d="M26.5 41c2-2.2 4-.1 5.5-.1s3.5-2.1 5.5.1" fill="none" stroke="#e4f3ee" stroke-width="2.6" stroke-linecap="round" opacity=".5"/>';
  const monoBody = (sk, id) => `<defs>${sk.cols ? grad(id, sk) : ""}</defs><path shape-rendering="crispEdges" d="${PIX}" fill="${sk.cols ? `url(#${id})` : "#fff"}"${sk.edge ? ` stroke="${sk.edge}" stroke-width=".08" stroke-linejoin="round"` : ""}/>${sk.hat ? HAT3 : ""}`;
  const monoIcon = (sk) => dataSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${sk.hat ? "-0.4 -1.2 4 4.2" : "0 0 3 3"}">${monoBody(sk, "g")}</svg>`);
  const monoApp = (sk) => dataSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="#000"/><g transform="${sk.hat ? "translate(190 270) scale(215)" : "translate(128 128) scale(256)"}">${monoBody(sk, "g")}</g></svg>`);
  const undertowIcon = (sk) => {
    if (sk.hat) return dataSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${ICON64}${HAT64}</svg>`);
    const n = sk.cols.length, bands = sk.cols.map((c, i) => (sk.dir === "x" ? `<rect x="${(64 / n) * i}" width="${64 / n + 0.2}" height="64" fill="${c}"/>` : `<rect y="${(64 / n) * i}" width="64" height="${64 / n + 0.2}" fill="${c}"/>`)).join("");
    return dataSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="c"><rect width="64" height="64" rx="12"/></clipPath></defs><g clip-path="url(#c)">${bands}</g>${sk.edge ? `<rect x="1" y="1" width="62" height="62" rx="11" fill="none" stroke="${sk.edge}" stroke-width="2"/>` : ""}<path d="M20 14v20a12 12 0 0 0 24 0V14" fill="none" stroke="#061820" stroke-width="10.5" stroke-linecap="round" opacity=".5"/><path d="M20 14v20a12 12 0 0 0 24 0V14" fill="none" stroke="#fff" stroke-width="6.5" stroke-linecap="round"/></svg>`);
  };
  let logoCount = 0, logoObserver = null, logoTimer = 0;
  const paintLogos = () => {
    if (!logoMode) return;
    if (logoMode === "flip") { // a harmless prank: the logos are upside down
      document.querySelectorAll('svg.app-logo, img[src^="/icon.svg"], img[src*="appicon.png"]').forEach((el) => { if (el.dataset.ulTf === undefined) { el.dataset.ulTf = el.style.transform; el.style.transform = "rotate(180deg)"; } });
      return;
    }
    const sk = SKINS[logoMode], mono = !!document.querySelector("svg.app-logo");
    document.querySelectorAll("svg.app-logo:not([data-ul-skin])").forEach((svg) => {
      const g = svg.querySelector("g");
      if (!g) return;
      const id = `ul-skin-${++logoCount}`;
      svg.dataset.ulSkin = id;
      if (sk.cols) { svg.insertAdjacentHTML("afterbegin", `<defs data-ul-skin-defs>${grad(id, sk)}</defs>`); g.dataset.ulFill = g.getAttribute("fill") || ""; g.setAttribute("fill", `url(#${id})`); }
      if (sk.edge) { g.setAttribute("stroke", sk.edge); g.setAttribute("stroke-width", ".08"); g.setAttribute("stroke-linejoin", "round"); }
      if (sk.hat) { svg.dataset.ulOverflow = svg.style.overflow; svg.style.overflow = "visible"; svg.insertAdjacentHTML("beforeend", `<g data-ul-skin-extra="1">${HAT3}</g>`); }
    });
    const swap = (img, to) => { if (!img.dataset.ulSrc) img.dataset.ulSrc = img.getAttribute("src"); img.src = to; };
    document.querySelectorAll('img[src^="/icon.svg"]').forEach((img) => swap(img, undertowIcon(sk)));
    document.querySelectorAll('img[src*="appicon.png"]').forEach((img) => swap(img, monoApp(sk)));
    document.querySelectorAll('link[rel~="icon"]:not([data-ul-href])').forEach((l) => { l.dataset.ulHref = l.getAttribute("href"); l.href = mono ? monoIcon(sk) : undertowIcon(sk); l.type = "image/svg+xml"; });
  };
  const logosOn = () => {
    if (!logoMode) return;
    paintLogos();
    if (!logoObserver) {
      logoObserver = new MutationObserver(() => { clearTimeout(logoTimer); logoTimer = setTimeout(paintLogos, 150); }); // the apps redraw their logos as pages change
      logoObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    }
  };
  const logosOff = () => {
    logoObserver?.disconnect(); logoObserver = null; clearTimeout(logoTimer);
    document.querySelectorAll("svg[data-ul-skin]").forEach((svg) => {
      const g = svg.querySelector("g");
      if (g) { if (g.dataset.ulFill !== undefined) g.setAttribute("fill", g.dataset.ulFill || "#fff"); g.removeAttribute("stroke"); g.removeAttribute("stroke-width"); g.removeAttribute("stroke-linejoin"); delete g.dataset.ulFill; }
      svg.querySelector("[data-ul-skin-defs]")?.remove(); svg.querySelector("[data-ul-skin-extra]")?.remove();
      if (svg.dataset.ulOverflow !== undefined) { svg.style.overflow = svg.dataset.ulOverflow; delete svg.dataset.ulOverflow; }
      delete svg.dataset.ulSkin;
    });
    document.querySelectorAll("[data-ul-tf]").forEach((el) => { el.style.transform = el.dataset.ulTf; delete el.dataset.ulTf; });
    document.querySelectorAll("img[data-ul-src]").forEach((img) => { img.src = img.dataset.ulSrc; delete img.dataset.ulSrc; });
    document.querySelectorAll("link[data-ul-href]").forEach((l) => { l.href = l.dataset.ulHref; delete l.dataset.ulHref; });
  };

  // ---- start, and the little switch ----
  const start = () => {
    if (!on) return;
    if (ambientKind && !reduced() && !slow()) { measure(); seed(ambientKind); kick(); }
    logosOn();
  };
  const stopAll = () => {
    amb.kind = ""; amb.items = []; dropLayer("amb");
    fw.until = 0; fw.rockets = []; fw.sparks = []; dropLayer("fw");
    saber.t0 = 0; dropLayer("saber");
    hideBanner(); logosOff();
  };
  const makeSwitch = () => {
    const b = document.createElement("button");
    b.type = "button";
    const label = () => {
      const held = on && slow(); // on, but the animations are held back because this device draws without graphics acceleration
      b.setAttribute("aria-label", on && !held ? "Turn seasonal effects off" : "Turn seasonal effects on");
      b.title = held ? "Seasonal animations are off on this device (no graphics acceleration, so they would be slow). Click to turn them on." : on ? "Seasonal effects: on (click to turn off)" : "Seasonal effects: off (click to turn on)";
      b.setAttribute("aria-pressed", String(on && !held)); b.style.opacity = on && !held ? "0.5" : "0.3";
    };
    b.textContent = "✦";
    b.style.cssText = "position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:100001;width:22px;height:44px;padding:0;border:0;border-radius:10px 0 0 10px;background:rgba(0,0,0,.4);color:#fff;font:14px/1 sans-serif;cursor:pointer";
    b.addEventListener("mouseenter", () => (b.style.opacity = "1"));
    b.addEventListener("mouseleave", label);
    b.addEventListener("click", () => {
      if (on && slow()) forced = true; // asked for on a slow device: the animations start
      else { on = !on; forced = on; }
      try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* not remembered */ }
      if (on) start(); else stopAll();
      label();
    });
    label();
    document.body.appendChild(b);
  };
  const init = () => { makeSwitch(); start(); if (today.newyear) watchNewYear(); if (today.may4) startSaber(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
