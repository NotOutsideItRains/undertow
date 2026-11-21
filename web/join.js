// The page a friend opens from a shared link. An account comes first (Discord, a new username, or an existing one),
// so the link they get belongs to them and is always there under Links if they lose it.
const code = location.pathname.split("/").pop(), $ = (s) => document.querySelector(s);
const view = (name) => { for (const x of ["wall", "done"]) $("#" + x).hidden = x !== name; };
const call = async (method, path, body) => {
  const r = await fetch(path, { method, headers: { "x-requested-with": "ui", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Something went wrong");
  return d;
};
const show = (d) => {
  $("#u1").textContent = d.url; $("#u2").textContent = d.eclipse;
  $("#title").textContent = `You're in, ${d.name}`; $("#sub").textContent = "Add one of these in the app you use.";
  view("done");
};
const join = () => call("POST", `/api/join/${code}`).then(show);
const flags = { error: "Discord sign-in didn't work. Try again.", denied: "You cancelled the Discord sign-in.", nolink: "That Discord account can't be used here.", closed: "This invite isn't open anymore." };

call("GET", `/api/join/${code}`).then((d) => {
  if (!d.name) { $("#title").textContent = "Link not found"; $("#sub").textContent = "Ask whoever sent you this for a new one."; return; }
  $("#title").textContent = d.name;
  if (d.link) return show(d.link); // already joined: here is the same link again
  if (!d.open) { $("#sub").textContent = "This invite isn't open right now."; return; }
  if (d.user) { $("#sub").textContent = `Signed in as ${d.user.displayName}.`; return join().catch((x) => { $("#sub").textContent = x.message; }); }
  $("#sub").textContent = "Make an account first. It keeps your link safe, so you can always find it again if you lose it.";
  $("#dc").hidden = $("#or").hidden = !d.discord;
  view("wall");
  const f = new URLSearchParams(location.search).get("discord");
  if (f && flags[f]) $("#e1").textContent = flags[f];
}).catch(() => { $("#sub").textContent = "Couldn't load this. Try again."; });

$("#dc").addEventListener("click", async (e) => {
  e.currentTarget.disabled = true;
  try { const r = await call("POST", "/api/discord/start", { mode: "join", code }); location.href = r.url; }
  catch (x) { $("#e1").textContent = x.message; e.currentTarget.disabled = false; }
});
$("#seg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  for (const x of $("#seg").children) x.classList.toggle("on", x === b);
  $("#fnew").hidden = b.dataset.v !== "new"; $("#fin").hidden = b.dataset.v !== "in";
});
const wire = (form, btn, err, send) => form.addEventListener("submit", async (e) => {
  e.preventDefault(); $(btn).disabled = true; $(err).textContent = "";
  try { await send(); } catch (x) { $(err).textContent = x.message; $(btn).disabled = false; }
});
wire($("#fnew"), "#b1", "#e1", () => call("POST", `/api/join/${code}/account`, { displayName: $("#dn").value, username: $("#un").value, password: $("#pw").value }).then(show));
wire($("#fin"), "#b2", "#e2", async () => { await call("POST", "/api/login", { username: $("#un2").value, password: $("#pw2").value }); await join(); });
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-copy]"); if (!b) return;
  const t = document.getElementById(b.dataset.copy).textContent;
  try { await navigator.clipboard.writeText(t); } catch { const r = document.createRange(); r.selectNodeContents(document.getElementById(b.dataset.copy)); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1500);
});
