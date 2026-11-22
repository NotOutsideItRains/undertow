// Speed for the text the servers send: compression (brotli or gzip, whichever the browser accepts) and revalidation (ETag, so a file that did not change
// costs a few bytes instead of the whole file). Both sites use it: Undertow's own pages and Monochrome's.
//
// - A file on disk is compressed once per version (its size and time) and kept in memory; a request only sends the kept bytes.
// - A page or JSON answer built on the fly is gzip-compressed when it is big enough to matter (small ones are sent as they are).
// - Nothing that is already compressed (images, fonts, audio, video) and nothing streamed (events, audio) goes through here.
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const brotli = promisify(zlib.brotliCompress), gzip = promisify(zlib.gzip);
const MIN = 1024; // below this the saving is smaller than the extra header
const DYNAMIC_MAX = 2 * 1024 * 1024; // a page or an answer built on the fly: bigger than this is sent as it is, so the event loop is never held up for long
export const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json|xml)|image\/svg\+xml)/i;

// The best encoding the browser accepts (br, then gzip), or null. "gzip;q=0" means "not gzip".
export function pickEncoding(req) {
  const h = String(req.headers["accept-encoding"] || "");
  if (!h) return null;
  const q = {};
  for (const part of h.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const m = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    q[name] = m ? Number(m.slice(2)) : 1;
  }
  const ok = (e) => (q[e] ?? q["*"] ?? 0) > 0;
  return ok("br") ? "br" : ok("gzip") ? "gzip" : null;
}

const withVary = (headers) => {
  const have = String(headers.Vary || headers.vary || "");
  return /accept-encoding/i.test(have) ? have : have ? `${have}, Accept-Encoding` : "Accept-Encoding";
};
const etagMatches = (header, etag) => String(header).split(",").some((t) => { t = t.trim(); return t === "*" || t === etag || t.replace(/^W\//, "") === etag.replace(/^W\//, ""); });

// ---- files on disk: compressed once per version and kept ----
const kept = new Map(); // "file|encoding" -> { stamp, promise }
const KEPT_MAX = 600;
const stamp = (st) => `${st.size}-${Math.floor(st.mtimeMs)}`;
export function compressedFile(file, st, enc) {
  const key = `${file}|${enc}`, hit = kept.get(key);
  if (hit && hit.stamp === stamp(st)) return hit.promise;
  const promise = fs.promises.readFile(file).then((buf) => (enc === "br"
    ? brotli(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }) // 9: close to the best, and it is done once per file
    : gzip(buf, { level: 9 })));
  kept.set(key, { stamp: stamp(st), promise });
  promise.catch(() => kept.delete(key)); // a failure is not kept
  if (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value);
  return promise;
}

// A file from disk, with an ETag (answers 304 when the browser already has it) and compression for text.
export async function serveFile(req, res, file, st, { type, cache = "no-cache", headers = {} }) {
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const base = { "Content-Type": type, "Cache-Control": cache, ETag: etag, ...headers, Vary: withVary(headers) };
  if (req.headers["if-none-match"] && etagMatches(req.headers["if-none-match"], etag)) {
    const { "Content-Type": _t, ...h } = base; // a 304 has no body, and so no type
    res.writeHead(304, h);
    return void res.end();
  }
  const enc = !req.headers.range && st.size >= MIN && COMPRESSIBLE.test(type) ? pickEncoding(req) : null;
  if (enc) {
    let body;
    try { body = await compressedFile(file, st, enc); } catch { body = null; }
    if (body) {
      res.writeHead(200, { ...base, "Content-Encoding": enc, "Content-Length": body.length });
      return void (req.method === "HEAD" ? res.end() : res.end(body));
    }
  }
  res.writeHead(200, { ...base, "Content-Length": st.size });
  if (req.method === "HEAD") return void res.end();
  fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

// An answer built on the fly (a page, a JSON body): gzip when it is big enough and the browser accepts it.
export function sendBody(res, status, body, headers = {}) {
  const req = res.req, type = String(headers["Content-Type"] || headers["content-type"] || "");
  let buf = typeof body === "string" ? Buffer.from(body) : body;
  if (buf && req && status !== 204 && status !== 304 && buf.length >= MIN && buf.length <= DYNAMIC_MAX && COMPRESSIBLE.test(type) && !headers["Content-Encoding"]) {
    headers = { ...headers, Vary: withVary(headers) }; // on every answer that could have been compressed, so a shared cache keeps the two kinds apart
    if (pickEncoding(req)) {
      try { buf = zlib.gzipSync(buf, { level: 5 }); headers = { ...headers, "Content-Encoding": "gzip" }; } catch { /* sent as it is */ }
    }
  }
  res.writeHead(status, { ...headers, "Content-Length": buf ? buf.length : 0 });
  res.end(buf);
}

// Compress the kept copies ahead of time, in the background, so the first visitor does not wait for it.
export async function warm(dir, { skip = /\.(?:gz|map)$/ } = {}) {
  const walk = async (d) => {
    for (const e of await fs.promises.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { await walk(f); continue; }
      if (skip.test(f) || !/\.(?:html|js|mjs|css|json|svg|webmanifest|txt)$/i.test(f)) continue;
      const st = await fs.promises.stat(f).catch(() => null);
      if (!st || st.size < MIN) continue;
      await compressedFile(f, st, "br").catch(() => {});
      await compressedFile(f, st, "gzip").catch(() => {});
    }
  };
  await walk(dir);
}
