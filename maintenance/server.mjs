// A stand-in for Undertow while it is down: every address answers 503 with a short "back soon" page.
import http from "node:http";
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Back soon</title>
<style>:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1c1c1e;--mute:#6b6b70;--ac:#3a6ea5}@media(prefers-color-scheme:dark){:root{--bg:#121214;--fg:#ececee;--mute:#9a9aa2;--ac:#7fb0e6}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:30rem}h1{font-size:1.6rem;margin:0 0 .5rem;letter-spacing:-.01em}p{color:var(--mute);margin:.4rem 0}
.wave{display:flex;gap:5px;align-items:flex-end;height:34px;margin-bottom:18px}.wave i{width:6px;border-radius:3px;background:var(--ac);animation:w 1.2s ease-in-out infinite}.wave i:nth-child(2){animation-delay:.15s}.wave i:nth-child(3){animation-delay:.3s}.wave i:nth-child(4){animation-delay:.45s}.wave i:nth-child(5){animation-delay:.6s}
@keyframes w{0%,100%{height:8px}50%{height:32px}}@media(prefers-reduced-motion:reduce){.wave i{animation:none;height:18px}}</style></head>
<body><main><div class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><h1>We'll be right back</h1><p>Undertow is down for maintenance while a few things get fixed.</p><p>Nothing is lost: your account, library and settings are safe. Please try again in a little while.</p></main></body></html>`;
http.createServer((req, res) => {
  res.writeHead(req.url === "/health" ? 200 : 503, { "Content-Type": "text/html; charset=utf-8", "Retry-After": "300", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(req.method === "HEAD" ? undefined : PAGE);
}).listen(7000, "0.0.0.0");
