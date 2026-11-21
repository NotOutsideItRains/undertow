// The encryption for chats. It runs in the browser (and in Node, for tests) using the built-in WebCrypto; the server never sees a key or a word.
//  - each account has a key pair (ECDH, P-256). The public half is shared; the private half stays in this browser.
//  - two friends turn their two keys into one shared secret (ECDH, then HKDF), and every message is sealed with AES-GCM under it.
//  - a message is tied to who sent it and to whom, so it can't be replayed as coming from the other person.
// There is no forward secrecy: if someone's private key were ever stolen, their old messages could be read. The safety number lets two people
// check that nobody has swapped a key in between.
const subtle = globalThis.crypto.subtle, enc = new TextEncoder(), dec = new TextDecoder();
export const b64 = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64 = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const EC = { name: "ECDH", namedCurve: "P-256" };
const canon = (p) => `${p.x}.${p.y}`;
const sha = async (text) => new Uint8Array(await subtle.digest("SHA-256", enc.encode(text)));

export const newIdentity = () => subtle.generateKey(EC, true, ["deriveBits"]);
export async function publicJwk(pair) { const j = await subtle.exportKey("jwk", pair.publicKey); return { kty: j.kty, crv: j.crv, x: j.x, y: j.y }; }
export const privateJwk = (pair) => subtle.exportKey("jwk", pair.privateKey);
export async function importPair(priv) { // back from the saved private key
  const { d, ...pub } = priv;
  return { privateKey: await subtle.importKey("jwk", { ...priv, ext: true }, EC, true, ["deriveBits"]), publicKey: await subtle.importKey("jwk", { ...pub, ext: true }, EC, true, []) };
}

// A number two people can read to each other: if it matches on both phones, nobody has swapped a key in between.
export async function safetyNumber(a, b) {
  const h = await sha([canon(a), canon(b)].sort().join("|"));
  const groups = [];
  for (let i = 0; i < 12; i++) groups.push(String(((h[i * 2] << 8) | h[i * 2 + 1]) % 100000).padStart(5, "0"));
  return groups.join(" ");
}
export const fingerprint = async (pub) => b64((await sha(canon(pub))).slice(0, 12)); // to notice a friend's key changing

// The key two friends share: the same on both sides, and nobody else can make it.
export async function sharedKey(myPrivate, myPub, theirPub) {
  const their = await subtle.importKey("jwk", { ...theirPub, ext: true }, EC, false, []);
  const bits = await subtle.deriveBits({ name: "ECDH", public: their }, myPrivate, 256);
  const base = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const salt = await sha([canon(myPub), canon(theirPub)].sort().join("|"));
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("undertow-chat-v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const PAD = 128; // messages are padded, so their length gives less away
const aad = (from, to) => enc.encode(`${from}>${to}`);
export async function seal(key, fromId, toId, obj) {
  const text = enc.encode(JSON.stringify(obj)), buf = new Uint8Array(Math.ceil((text.length + 2) / PAD) * PAD);
  new DataView(buf.buffer).setUint16(0, text.length); buf.set(text, 2);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(fromId, toId) }, key, buf));
  return { iv: b64(iv), ct: b64(ct) };
}
export async function open(key, fromId, toId, m) { // throws if it was changed, or isn't from who it says
  const buf = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: unb64(m.iv), additionalData: aad(fromId, toId) }, key, unb64(m.ct)));
  const len = new DataView(buf.buffer).getUint16(0);
  return JSON.parse(dec.decode(buf.slice(2, 2 + len)));
}

// A copy of the private key that only the passphrase can open, kept on the server so a second device can pick the chats up.
const ITER = 300000;
async function pass(passphrase, salt, iter) {
  const k = await subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, k, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function wrapPrivate(privJwk, passphrase) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16)), iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, await pass(passphrase, salt, ITER), enc.encode(JSON.stringify(privJwk))));
  return { salt: b64(salt), iv: b64(iv), ct: b64(ct), iter: ITER };
}
export async function unwrapPrivate(bk, passphrase) { // throws on the wrong passphrase
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(bk.iv) }, await pass(passphrase, unb64(bk.salt), bk.iter), unb64(bk.ct));
  return JSON.parse(dec.decode(pt));
}
