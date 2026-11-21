// The Undertow Presence app's downloads (downloads/ next to server.mjs): what is there, and sending one as a file.
import fs from "node:fs";
import { db } from "./store.mjs";

const DIR = new URL("../downloads/", import.meta.url).pathname;
const FILES = { "UndertowRPC-windows-amd64.exe": ["windows", "Windows (64-bit)"], "UndertowRPC-x86_64.AppImage": ["linux", "Linux (AppImage)"] };

export function rpcInfo(base = "/api/rpc/file/") {
  const sums = {};
  try { for (const l of fs.readFileSync(DIR + "SHA256SUMS", "utf8").split("\n")) { const [h, n] = l.trim().split(/\s+/); if (h && n) sums[n.replace(/^\*?(\.\/)?(dist\/)?/, "")] = h; } } catch { /* no checksums */ }
  const files = Object.entries(FILES).filter(([n]) => fs.existsSync(DIR + n)).map(([n, [os, label]]) => ({ name: n, os, label, size: fs.statSync(DIR + n).size, sha256: sums[n] || null, url: base + n }));
  return { version: "1.1.0", clientId: process.env.RPC_CLIENT_ID || db.settings.rpcClientId || "1573709606671356118", port: 8892, files };
}

/** Sends one file as a download; false when there is no such file. */
export function rpcFile(req, res, name) {
  const f = DIR + name;
  if (!FILES[name] || !fs.existsSync(f)) return false;
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": fs.statSync(f).size, "Content-Disposition": `attachment; filename="${name}"`, "X-Content-Type-Options": "nosniff" });
  if (req.method === "HEAD") res.end(); else fs.createReadStream(f).pipe(res);
  return true;
}
