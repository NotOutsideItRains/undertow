// The server's own speakers: ffmpeg plays a song into the sound card (the AUX out) and the web player acts as the remote.
// Pause and seek stop ffmpeg and start it again at the right place; its progress output says where the song is.
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";

const st = { id: null, title: "", dur: 0, base: 0, t0: null, playing: false, ended: 0, err: null, open: null, proc: null, gen: 0, sw: 60 };
const ctl = { card: null, name: null, loaded: false }; // the card's hardware volume control, when it has one

function detect() {
  if (process.env.SPEAKER_DEVICE) return { dev: process.env.SPEAKER_DEVICE, name: process.env.SPEAKER_NAME || process.env.SPEAKER_DEVICE, card: process.env.SPEAKER_CARD || null };
  let txt = "";
  try { txt = fs.readFileSync("/proc/asound/cards", "utf8"); } catch { return null; }
  const cards = [...txt.matchAll(/^\s*(\d+)\s+\[(\S+)\s*\]:\s+(\S+)\s+-\s+(.+)$/gm)];
  if (!cards.length) return null;
  const pick = cards.find((c) => /USB-Audio/i.test(c[3])) || cards.find((c) => !/hdmi/i.test(c[4])) || cards[0]; // the AUX is normally a USB dongle or the analog jack; HDMI is a last resort
  return { dev: `plughw:CARD=${pick[2]},DEV=0`, name: pick[4].trim(), card: pick[1] };
}
const run = (cmd, args) => new Promise((ok) => execFile(cmd, args, { timeout: 4000 }, (e, out) => ok(e ? null : String(out))));
async function loadControl(card) {
  if (ctl.loaded && ctl.card === card) return;
  ctl.loaded = true; ctl.card = card; ctl.name = null;
  if (card == null) return;
  const out = await run("amixer", ["-c", String(card), "scontrols"]);
  const names = [...(out || "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const n of ["PCM", "Speaker", "Headphone", "Master", "Headset"]) {
    if (!names.includes(n)) continue;
    const g = await run("amixer", ["-c", String(card), "sget", n]);
    if (g && /pvolume/i.test(g)) { ctl.name = n; return; } // it has a playback volume
  }
}
async function hwVolume(card) {
  const g = await run("amixer", ["-c", String(card), "sget", ctl.name]);
  const m = g && g.match(/\[(\d+)%\]/);
  return m ? Number(m[1]) : null;
}

// ffmpeg's ALSA output reports no progress while it plays, so the place is the start point plus the time since its first output (it writes at the card's speed)
const pos = () => Math.max(0, Math.min(st.dur || 1e9, st.base + (st.playing && st.t0 ? (Date.now() - st.t0) / 1000 : 0)));
function killProc() {
  st.gen++;
  const p = st.proc; st.proc = null;
  if (p) { try { p.kill("SIGKILL"); } catch { /* already gone */ } }
}
async function start(at) {
  killProc();
  const gen = st.gen, dev = detect();
  if (!dev) { st.playing = false; st.err = "No sound card found"; throw Object.assign(new Error(st.err), { status: 503 }); }
  st.base = at; st.t0 = null; st.playing = true; st.err = null;
  let inp;
  try { inp = await st.open(); }
  catch (e) { if (gen === st.gen) { st.playing = false; st.err = e.message; } throw e; }
  if (gen !== st.gen) { inp.stream?.destroy(); return; }
  const gain = ctl.name ? 1 : (st.sw / 100) ** 2;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-progress", "pipe:1", "-nostats", "-stats_period", "0.25"];
  if (at > 0) args.push("-ss", String(at));
  args.push("-i", inp.file || "pipe:0", "-vn",
    "-af", `aresample=48000:dither_method=triangular_hp${gain < 1 ? `,volume=${gain.toFixed(4)}` : ""},aformat=sample_fmts=s16:channel_layouts=stereo`,
    "-f", "alsa", dev.dev);
  const p = spawn("ffmpeg", args, { stdio: [inp.stream ? "pipe" : "ignore", "pipe", "pipe"] });
  st.proc = p;
  if (inp.stream) { inp.stream.on("error", () => p.kill("SIGKILL")); p.stdin.on("error", () => {}); inp.stream.pipe(p.stdin); }
  let err = "";
  p.stdout.on("data", () => { if (gen === st.gen && st.t0 == null) st.t0 = Date.now(); }); // the first progress report: ffmpeg is up and writing
  p.stderr.on("data", (d) => { err = (err + d).slice(-400); });
  p.on("error", (e) => { if (gen === st.gen) { st.playing = false; st.err = e.message; } });
  p.on("close", (code) => {
    if (gen !== st.gen) return; // stopped or replaced on purpose
    st.proc = null; st.playing = false;
    if (code === 0) { st.base = st.dur || pos(); st.ended++; }
    else st.err = err.trim().split("\n").pop() || `ffmpeg stopped (${code})`;
  });
}

export async function status() {
  const dev = detect();
  if (dev) await loadControl(dev.card);
  const vol = dev && ctl.name ? { mode: "hardware", value: await hwVolume(dev.card) } : { mode: "software", value: st.sw };
  return { available: !!dev, device: dev ? dev.name : null, volume: vol, id: st.id, title: st.title, playing: st.playing, pos: Math.round(pos() * 10) / 10, dur: st.dur, ended: st.ended, error: st.err };
}
export async function play({ id, title, dur, at = 0, open }) {
  st.id = id; st.title = title || ""; st.dur = dur || 0; st.open = open;
  const dev = detect(); if (dev) await loadControl(dev.card);
  await start(Math.max(0, at));
}
export async function pause() { if (!st.playing) return; st.base = pos(); killProc(); st.playing = false; st.t0 = null; }
export async function resume() { if (st.playing || !st.id || !st.open) return; await start(st.base); }
export async function seek(at) {
  at = Math.max(0, Math.min(at, (st.dur || at) - 0.5));
  if (st.playing) await start(at); else { st.base = at; }
}
export async function stop() { killProc(); st.playing = false; st.id = null; st.title = ""; st.dur = 0; st.base = 0; st.t0 = null; st.open = null; st.err = null; }
export async function volume(v) {
  v = Math.max(0, Math.min(100, Math.round(v)));
  const dev = detect(); if (dev) await loadControl(dev.card);
  if (dev && ctl.name) { await run("amixer", ["-c", String(dev.card), "sset", ctl.name, `${v}%`]); return; }
  st.sw = v;
  if (st.playing) await start(pos()); // software gain is part of the ffmpeg command, so it restarts at the same place
}
process.on("exit", () => { try { st.proc?.kill("SIGKILL"); } catch { /* gone */ } });
