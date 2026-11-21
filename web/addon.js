"use strict";
document.getElementById("copy")?.addEventListener("click", async (e) => {
  const b = e.currentTarget, label = b.textContent, url = document.getElementById("url").textContent;
  try { await navigator.clipboard.writeText(url); b.textContent = "Copied"; }
  catch { const r = document.createRange(); r.selectNodeContents(document.getElementById("url")); getSelection().removeAllRanges(); getSelection().addRange(r); b.textContent = "Press copy"; }
  setTimeout(() => (b.textContent = label), 1800);
});
