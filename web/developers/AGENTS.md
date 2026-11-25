# Undertow API: guide for AI agents

This file tells an AI agent (or a developer) how to use this Undertow server's API. The server's address is `{{ORIGIN}}`; every path below is relative to it.

Machine-readable descriptions: the REST API is at `{{ORIGIN}}/v1/openapi.json` (OpenAPI 3.1) and the OAuth settings are at `{{ORIGIN}}/.well-known/oauth-authorization-server`.

## First: which way to authenticate

| You want to… | Use | Where it comes from |
| --- | --- | --- |
| Search the catalog, read tracks, albums, artists, playlists, mixes | An **API key** (`ut_…`) | An admin makes it in the app: **Users → API keys → New key** |
| Also stream audio or read lyrics with your own key | An API key that an admin gave the **audio** or **lyrics** switch | Same place |
| See what a **person** is playing, or act for them | **OAuth** (an access token, `uo_a_…`) | The person approves your app; an admin registers the app first at `{{ORIGIN}}/developers` |

Rules that apply to everything below:

- **You can't get a key or register an app yourself.** If you don't have one, ask the human for it and say what it is for (and which scopes, below). Never ask anyone for their Undertow password or TIDAL login.
- Send credentials only in the `Authorization: Bearer <token>` header (API keys may also use `X-API-Key`). Never put them in URLs, logs, commits or chat. They are shown once when made.
- Everything here is **read-only** (GET). There is no way to change anything on the server or in anyone's account.
- Use HTTPS in production. Plain `http://` works only for a server on the same machine.

## Errors and limits

- Errors from `/v1` look like `{"error":{"status":429,"message":"…"}}`. OAuth endpoints (`/oauth/token`, `/oauth/revoke`) use the standard `{"error":"invalid_grant","error_description":"…"}`.
- `401` the key or token is wrong or expired. A bad token → refresh it (OAuth) or stop. Repeated wrong credentials from one address are blocked for a minute.
- `403` the key or token doesn't have this permission (the message says which). Don't retry; ask the human.
- `429` too many requests. Wait `Retry-After` seconds. Every response has `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`. API keys default to 60 requests a minute; OAuth tokens get 120.
- Results are cached for a few minutes. Don't poll faster than you need; once or twice a second is the most for "currently playing", and every 5–10 seconds is plenty.

## The catalog (API key, or an OAuth token with `user-stream-audio`)

All `GET`, JSON. `id`s are strings. Songs from the owner's own Subsonic servers have ids like `sub:<server>:<song>`; use them exactly as returned.

| Path | What it returns |
| --- | --- |
| `/v1/search?q=<text>&type=track\|album\|artist&limit=1..50&offset=0..500` | Search. `type` defaults to `track`. Tracks can include the owner's own library. |
| `/v1/tracks/{id}` | One track: `title`, `artists[]`, `album{id,title,cover}`, `duration` (seconds), `isrc`, `audioQuality`, `explicit`… |
| `/v1/albums/{id}?limit&offset` | An album and its tracks |
| `/v1/playlists/{uuid}` | A playlist and its tracks |
| `/v1/mixes/{id}` | A mix and its tracks |
| `/v1/artists/{id}` | An artist |
| `/v1/artists/{id}/albums`, `/v1/artists/{id}/top-tracks` | An artist's albums, and top tracks |
| `/v1/tracks/{id}/lyrics` | Lyrics (synced when available). **API keys only**, and only if an admin turned lyrics on for the key. |

Typical flow: `search` → pick a track `id` → `tracks/{id}` for details → `tracks/{id}/stream` for audio.

## Audio

`GET /v1/tracks/{id}/stream?quality=CD`

- Returns the audio file itself (FLAC, or AAC for the lossy tiers) with `Range` support, so players can seek. The first request for a song can take a few seconds while the server prepares it; wait, don't retry in a loop.
- `quality`: `LOW` and `HIGH` (AAC), `CD` (16-bit FLAC, the default), `HI_RES` (the best available FLAC). Ask for the lowest that is good enough.
- Needs an API key with audio streaming on, **or** an OAuth token with the `user-stream-audio` scope. Limits: 3 streams at a time per key, 2 per person for an OAuth app.
- Download only what you will actually play. The audio comes from the owner's TIDAL accounts, which is the owner's resource, so don't bulk-download.

## OAuth: acting for a person

Standard OAuth 2.0 authorization code flow. **PKCE with S256 is required** for every app, even ones with a secret.

You need from the human (admin): a **client id** (`uc_…`) and, for server-side apps, a **client secret** (`us_…`), made at `{{ORIGIN}}/developers`, and your redirect address registered there (`https://…`, `http://localhost:<any port>/path`, or an app scheme like `myapp://callback`; exact match, except any port on localhost). Audio needs the admin to tick "May ask for audio" for your app.

Scopes (space separated, in `scope=`):

| Scope | Lets you |
| --- | --- |
| `user-read-profile` | `GET /v1/me` → `{"id","display_name"}` |
| `user-read-currently-playing` | `GET /v1/me/player/currently-playing` |
| `user-stream-audio` | The catalog and `GET /v1/tracks/{id}/stream` (above). The consent page shows this one **in red**. |

Ask for the fewest scopes you need. People see them on the consent page.

### 1. Make a PKCE pair and send the person to the consent page

```js
import crypto from "node:crypto";
const verifier = crypto.randomBytes(48).toString("base64url");              // keep this secret, per sign-in
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const state = crypto.randomBytes(16).toString("base64url");                  // check it comes back unchanged
const url = `{{ORIGIN}}/oauth/authorize?` + new URLSearchParams({
  response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: "user-read-currently-playing",
  state, code_challenge: challenge, code_challenge_method: "S256" });
// open `url` in the person's browser
```

The person signs in and presses **Allow**. They are sent to your redirect with `?code=…&state=…`, or `?error=access_denied&state=…` if they said no. Check `state`.

### 2. Swap the code for tokens (within 10 minutes, once)

```bash
curl -X POST {{ORIGIN}}/oauth/token \
  -d grant_type=authorization_code -d code=CODE -d redirect_uri=REDIRECT \
  -d client_id=CLIENT_ID -d code_verifier=VERIFIER -d client_secret=SECRET   # secret only if the app has one (or use HTTP Basic)
```

Returns `{"access_token":"uo_a_…","token_type":"Bearer","expires_in":3600,"refresh_token":"uo_r_…","scope":"…"}`.

### 3. Call the API

```bash
curl {{ORIGIN}}/v1/me/player/currently-playing -H "Authorization: Bearer ACCESS_TOKEN"
```

```json
{ "is_playing": true, "progress_ms": 91234, "timestamp": 1760000000000,
  "item": { "id": "123456", "name": "Song", "artists": [{ "name": "Artist" }],
            "album": { "name": "Album", "images": [{ "url": "https://…" }] }, "duration_ms": 200000, "source": "Undertow" } }
```

Nothing playing: `{"is_playing":false,"progress_ms":0,"item":null}` (HTTP 200). A song only appears while one of the person's players is **sharing** it (the "share what I'm playing" switch in the player), so `is_playing:false` can also mean "not shared". `progress_ms` is already advanced to now. `item.id` is the catalog id when known, so you can pass it to `/v1/tracks/{id}`.

### 4. Refresh (access tokens last 1 hour)

```bash
curl -X POST {{ORIGIN}}/oauth/token -d grant_type=refresh_token -d refresh_token=REFRESH -d client_id=CLIENT_ID -d client_secret=SECRET
```

**Every refresh returns a new refresh token and the old one stops working. Save the new one before you use the new access token.** A refresh token lasts 60 days from its last use. If refreshing fails with `invalid_grant`, the person removed the app or it expired: send them through step 1 again.

### 5. Disconnect

`POST {{ORIGIN}}/oauth/revoke` with `token=<access or refresh token>` (and your client credentials). People can also remove an app themselves at `{{ORIGIN}}/developers`.

## Good behaviour checklist

1. Ask for the smallest scopes; explain to the person why.
2. Keep tokens and secrets out of logs and out of anything you show the person.
3. On `429`, wait `Retry-After`. On `401` with an OAuth token, refresh once, then re-authorize.
4. Cache what you can (track details, covers); don't poll `currently-playing` faster than every second or two.
5. Don't resell or republish the audio, and don't use it to build a copy of the library.
6. If something isn't allowed, say so and ask the human to change the key or app settings; don't look for a way around it.
