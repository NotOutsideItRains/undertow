// TIDAL serves audio as DASH: an init segment plus fragmented-MP4 pieces. Players that only take plain
// files (Eclipse) can't use that, so this stitches the pieces into one ordinary file:
//   FLAC    -> .flac  ("fLaC" + the header from the init's dfLa box + the frames from every mdat)
//   AAC/EC3 -> .m4a   (a normal MP4: the init's sample description plus rebuilt sample tables)
import fs from "node:fs";

const get = async (u) => {
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`TIDAL segment HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};
function boxes(b, o = 0, end = b.length) {
  const out = [];
  while (o + 8 <= end) {
    const size = b.readUInt32BE(o), type = b.toString("latin1", o + 4, o + 8);
    if (size < 8 || o + size > end) throw new Error("bad MP4 box");
    out.push({ type, start: o, size });
    o += size;
  }
  return out;
}
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
const tree = (b, o, end) => boxes(b, o, end).map((x) => (CONTAINERS.has(x.type) ? { type: x.type, kids: tree(b, x.start + 8, x.start + x.size) } : { type: x.type, data: b.subarray(x.start + 8, x.start + x.size) }));
const box = (type, body) => { const h = Buffer.alloc(8); h.writeUInt32BE(body.length + 8, 0); h.write(type, 4, "latin1"); return Buffer.concat([h, body]); };
const ser = (nodes) => Buffer.concat(nodes.map((n) => box(n.type, n.kids ? ser(n.kids) : n.data)));
const u32a = (v) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4)); return b; };
const u32s = (...v) => u32a(v);

// Sample sizes and durations of one fragment, plus its raw payload.
function fragment(seg) {
  const top = boxes(seg), moof = top.find((x) => x.type === "moof"), mdat = top.find((x) => x.type === "mdat");
  if (!moof || !mdat) throw new Error("bad fragment");
  const traf = boxes(seg, moof.start + 8, moof.start + moof.size).find((x) => x.type === "traf");
  const kids = boxes(seg, traf.start + 8, traf.start + traf.size), tfhd = kids.find((x) => x.type === "tfhd"), trun = kids.find((x) => x.type === "trun");
  let o = tfhd.start + 8;
  const tf = seg.readUIntBE(o + 1, 3);
  o += 8;
  if (tf & 1) o += 8;
  if (tf & 2) o += 4;
  let defDur = 0, defSize = 0;
  if (tf & 8) { defDur = seg.readUInt32BE(o); o += 4; }
  if (tf & 0x10) { defSize = seg.readUInt32BE(o); o += 4; }
  let p = trun.start + 8;
  const rf = seg.readUIntBE(p + 1, 3), n = seg.readUInt32BE(p + 4);
  p += 8;
  if (rf & 1) p += 4;
  if (rf & 4) p += 4;
  const sizes = [], durs = [];
  for (let i = 0; i < n; i++) {
    if (rf & 0x100) { durs.push(seg.readUInt32BE(p)); p += 4; } else durs.push(defDur);
    if (rf & 0x200) { sizes.push(seg.readUInt32BE(p)); p += 4; } else sizes.push(defSize);
    if (rf & 0x400) p += 4;
    if (rf & 0x800) p += 4;
  }
  const payload = seg.subarray(mdat.start + 8, mdat.start + mdat.size);
  if (sizes.reduce((a, b) => a + b, 0) !== payload.length) throw new Error("unexpected fragment layout");
  return { sizes, durs, payload };
}

// A normal MP4 from the init segment (sample description, handler…) and every sample.
function buildM4a(init, sizes, durs, payloads) {
  const mo = boxes(init).find((x) => x.type === "moov");
  const moov = tree(init, mo.start + 8, mo.start + mo.size).filter((n) => n.type !== "mvex"); // not fragmented any more
  const mvhd = moov.find((n) => n.type === "mvhd"), trak = moov.find((n) => n.type === "trak");
  trak.kids = trak.kids.filter((n) => n.type !== "edts");
  const tkhd = trak.kids.find((n) => n.type === "tkhd"), mdia = trak.kids.find((n) => n.type === "mdia"), mdhd = mdia.kids.find((n) => n.type === "mdhd");
  const stbl = mdia.kids.find((n) => n.type === "minf").kids.find((n) => n.type === "stbl");
  if (mvhd.data[0] || tkhd.data[0] || mdhd.data[0]) throw new Error("unsupported MP4 version");
  const total = durs.reduce((a, b) => a + b, 0), mediaTs = mdhd.data.readUInt32BE(12), movieTs = mvhd.data.readUInt32BE(12);
  mdhd.data.writeUInt32BE(total, 16);
  mvhd.data.writeUInt32BE(Math.round((total * movieTs) / mediaTs), 16);
  tkhd.data.writeUInt32BE(Math.round((total * movieTs) / mediaTs), 20);
  const runs = [];
  for (const d of durs) { if (runs.length && runs[runs.length - 1][1] === d) runs[runs.length - 1][0]++; else runs.push([1, d]); }
  const data = Buffer.concat(payloads);
  const ftyp = box("ftyp", Buffer.concat([Buffer.from("M4A "), u32s(0), Buffer.from("M4A mp42isom")]));
  const make = (offset) => {
    stbl.kids = stbl.kids.filter((n) => n.type === "stsd").concat([
      { type: "stts", data: Buffer.concat([u32s(0, runs.length), u32a(runs.flat())]) },
      { type: "stsc", data: u32s(0, 1, 1, sizes.length, 1) },
      { type: "stsz", data: Buffer.concat([u32s(0, 0, sizes.length), u32a(sizes)]) },
      { type: "stco", data: u32s(0, 1, offset) },
    ]);
    return box("moov", ser(moov));
  };
  const size = make(0).length;
  return Buffer.concat([ftyp, make(ftyp.length + size + 8), box("mdat", data)]);
}

// Builds a plain audio file from a TIDAL DASH manifest URL; resolves to its extension.
export async function assemble(mpdUrl, base) {
  const mpd = await (await fetch(mpdUrl, { signal: AbortSignal.timeout(15000) })).text();
  // A manifest can list several renditions of the same song (say FLAC 44.1 kHz and FLAC_HIRES 48 kHz), each with its own segments.
  // Take the best one and read the address and the segment count from that one only, or the pieces of two renditions get mixed up.
  const reps = [...mpd.matchAll(/<Representation [\s\S]*?<\/Representation>/g)].map((m) => m[0]).filter((r) => /<SegmentTemplate/.test(r));
  const rep = reps.sort((x, y) => Number((y.match(/bandwidth="(\d+)"/) || [])[1] || 0) - Number((x.match(/bandwidth="(\d+)"/) || [])[1] || 0))[0];
  const scope = rep || mpd;
  const flac = /codecs="flac"/.test(rep ? mpd.slice(0, mpd.indexOf("<Representation")) + rep : mpd);
  if (!flac && !/codecs="(mp4a|ec-3)/.test(rep ? mpd.slice(0, mpd.indexOf("<Representation")) + rep : mpd)) throw new Error("unsupported stream");
  const attr = (n) => (scope.match(new RegExp(`${n}="([^"]+)"`)) || [])[1]?.replace(/&amp;/g, "&");
  const init = attr("initialization"), media = attr("media"), first = Number(attr("startNumber") || 1);
  const count = [...scope.matchAll(/<S d="\d+"(?: r="(\d+)")?/g)].reduce((n, m) => n + 1 + Number(m[1] || 0), 0);
  if (!init || !media || !count) throw new Error("unexpected manifest");
  const ib = await get(init), ext = flac ? "flac" : "m4a", file = `${base}.${ext}`, tmp = `${file}.part`;
  const segs = async (each) => {
    for (let n = 0; n < count; n += 6) { // a few at a time, handled in order
      const parts = await Promise.all(Array.from({ length: Math.min(6, count - n) }, (_, k) => get(media.replace("$Number$", String(first + n + k)))));
      for (const seg of parts) each(seg);
    }
  };
  if (flac) {
    const at = ib.indexOf("dfLa");
    if (at < 4) throw new Error("no FLAC header in the stream");
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, Buffer.concat([Buffer.from("fLaC"), ib.subarray(at + 8, at - 4 + ib.readUInt32BE(at - 4))]));
      await segs((seg) => { for (const x of boxes(seg)) if (x.type === "mdat") fs.writeSync(fd, seg.subarray(x.start + 8, x.start + x.size)); });
    } catch (e) { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); throw e; }
    fs.closeSync(fd);
  } else {
    const sizes = [], durs = [], payloads = [];
    await segs((seg) => { const f = fragment(seg); sizes.push(...f.sizes); durs.push(...f.durs); payloads.push(f.payload); });
    fs.writeFileSync(tmp, buildM4a(ib, sizes, durs, payloads));
  }
  fs.renameSync(tmp, file);
  return ext;
}
