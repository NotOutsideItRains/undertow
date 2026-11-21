"use strict";
// Talks to the Undertow Presence app on this computer (http://127.0.0.1:8892), which puts "Listening to ..." on your Discord profile.
// The browser asks your permission to reach local devices the first time. Nothing is sent anywhere else, and nothing at all unless you turn it on.
window.UndertowRPC = (() => {
  const BASE = "http://127.0.0.1:8892", KEY = "rpc.on", RELAY = "rpc.relay";
  const get = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };
  const relayOn = () => { try { return localStorage.getItem(RELAY) === "1"; } catch { return false; } }; // also tell the server, so the presence app on another computer can show it
  const call = async (path, body) => {
    const r = await fetch(BASE + path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  };
  let last = { key: "", at: 0, pos: 0, playing: null }, down = 0;
  const cover = (u) => { // Discord can only show a picture from a public address
    const m = String(u || "").match(/tcover\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return m ? `https://resources.tidal.com/images/${m[1].replaceAll("-", "/")}/640x640.jpg` : /^https:\/\//.test(u || "") ? u : "";
  };
  const relayPost = (p) => { if (relayOn()) fetch("/api/rpc/now", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ui" }, body: JSON.stringify(p), cache: "no-store", keepalive: true }).catch(() => {}); };
  const api = {
    enabled: get,
    setEnabled(on) { try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private window */ } if (!on) api.clear(); },
    status: () => call("/status").catch(() => null),
    send: (p) => call("/presence", p),
    relayEnabled: relayOn,
    setRelay(on) { try { localStorage.setItem(RELAY, on ? "1" : "0"); } catch { /* private window */ } if (!on) relayPost({ playing: false }); },
    clear() { last = { key: "", at: 0, pos: 0, playing: null }; relayPost({ playing: false }); return get() ? call("/clear", {}).catch(() => {}) : Promise.resolve(); },
    /** A track and the state of its audio element: call it freely, it only talks to the app when something changed (or every 15 s while playing). */
    sync(t, audio, quality) {
      if ((!get() && !relayOn()) || !t || !audio) return;
      const playing = !audio.paused && !audio.ended, pos = audio.currentTime || 0, now = Date.now();
      const key = `${t.id}|${t.title}`, moved = Math.abs(pos - (last.pos + (last.playing ? (now - last.at) / 1000 : 0))) > 3;
      if (key === last.key && playing === last.playing && !moved && now - last.at < 15000) return;
      last = { key, at: now, pos, playing };
      const body = { title: t.title, artist: t.artist || "", album: [t.album, quality].filter(Boolean).join(" · "), durationMs: Math.round((audio.duration || t.duration || 0) * 1000), positionMs: Math.round(pos * 1000), playing,
        coverUrl: cover(t.artworkURL), tidalId: /^\d+$/.test(String(t.id)) ? String(t.id) : "", source: "undertow" };
      relayPost(body);
      if (get() && Date.now() >= down) api.send(body).catch(() => { down = Date.now() + 30000; }); // the app isn't running: try again in 30 s
    },
  };
  return api;
})();
