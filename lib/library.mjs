// Each person's favorites and playlists. A song is stored as a small, cleaned copy of what the player needs to show and play it.
import { save, httpError } from "./store.mjs";

const MAX_FAV = 1000, MAX_PL = 30, MAX_TRACKS = 300;
const clip = (x, n) => String(x ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const ART = /^\/api\/play\/(tcover\/[0-9a-f-]{36}|art\/[a-f0-9]+\/[^/?#]{1,200})$/; // only pictures this server itself serves

export function cleanTrack(t, validId) {
  const id = clip(t?.id, 120);
  if (!id || !validId(id)) return null;
  return { id, title: clip(t.title, 200) || "Untitled", artist: clip(t.artist, 200), album: clip(t.album, 200), duration: Number.isFinite(+t.duration) ? Math.max(0, Math.min(+t.duration, 7200)) : 0, ...(ART.test(t.artworkURL || "") ? { artworkURL: t.artworkURL } : {}), ...(t.source ? { source: clip(t.source, 40) } : {}) };
}
const lib = (u) => (u.library ||= { favorites: [], playlists: [] });
export const view = (u) => { const l = lib(u); return { favorites: l.favorites, playlists: l.playlists.map((p) => ({ id: p.id, name: p.name, tracks: p.tracks, updatedAt: p.updatedAt })) }; };

export function mutate(u, b, validId) {
  const l = lib(u), now = Date.now();
  const track = () => { const t = cleanTrack(b.track, validId); if (!t) throw httpError(400, "That song can't be saved"); return t; };
  const pl = () => { const p = l.playlists.find((x) => x.id === b.pid); if (!p) throw httpError(404, "No such playlist"); return p; };
  const name = () => { const n = clip(b.name, 60); if (!n) throw httpError(400, "Give the playlist a name"); return n; };
  switch (b.action) {
    case "fav": {
      const t = track();
      if (!l.favorites.some((x) => x.id === t.id)) { if (l.favorites.length >= MAX_FAV) throw httpError(400, "Favorites are full"); l.favorites.unshift({ ...t, addedAt: now }); }
      break;
    }
    case "unfav": l.favorites = l.favorites.filter((x) => x.id !== String(b.id)); break;
    case "pl-create": {
      if (l.playlists.length >= MAX_PL) throw httpError(400, "That's the most playlists you can have");
      const p = { id: Math.random().toString(36).slice(2, 10), name: name(), tracks: [], createdAt: now, updatedAt: now };
      if (b.track) p.tracks.push(track());
      l.playlists.unshift(p);
      break;
    }
    case "pl-rename": { const p = pl(); p.name = name(); p.updatedAt = now; break; }
    case "pl-delete": l.playlists = l.playlists.filter((x) => x.id !== b.pid); break;
    case "pl-add": {
      const p = pl(), t = track();
      if (!p.tracks.some((x) => x.id === t.id)) { if (p.tracks.length >= MAX_TRACKS) throw httpError(400, "That playlist is full"); p.tracks.push(t); p.updatedAt = now; }
      break;
    }
    case "pl-remove": { const p = pl(); p.tracks = p.tracks.filter((x) => x.id !== String(b.id)); p.updatedAt = now; break; }
    case "pl-move": { // drag a song to a new place
      const p = pl(), from = Number(b.from), to = Number(b.to);
      if (Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= 0 && from < p.tracks.length && to < p.tracks.length) { p.tracks.splice(to, 0, p.tracks.splice(from, 1)[0]); p.updatedAt = now; }
      break;
    }
    default: throw httpError(400, "Unknown action");
  }
  save();
  return view(u);
}
