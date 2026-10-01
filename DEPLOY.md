# Deploying Neighborly as a Website

Neighborly is **already a web app**. `BACKEND/server.js` is a standard Express +
Socket.io server that serves the entire frontend (`FRONTEND/www`) over HTTP, so
deploying it puts the whole app online. The Electron file (`main.js`) is only a
desktop wrapper that starts this same server and opens a browser window —
it is **not** used on the web.

## What runs where

| Piece | File | Notes |
|---|---|---|
| Web server + realtime (chat, voice, presence) | `BACKEND/server.js` | Serves static files + Socket.io |
| Frontend UI | `FRONTEND/www/*.html` | Entry: `/login.html` → `/Neighborly.html` |
| Auth | `FRONTEND/www/js/firebase.js` | Firebase Auth (browser SDK from CDN) |
| Voice / video / screen share | `FRONTEND/www/js/webrtcClient.js` | Browser WebRTC + `getDisplayMedia()` |

The server honours `process.env.PORT` and listens on `0.0.0.0`, so it works on
any Node host. It **does not** depend on Electron.

---

## 1. Test it locally (already verified working)

```powershell
cd "C:\Users\ACER\Desktop\New folder\Neiborly.zip"
npm install
npm start
```

Then open <http://localhost:3001>. You should see the login page, and
`http://localhost:3001/api` should return the backend status JSON.

---

## 1b. Getting a working, shareable link

`npm start` / `node BACKEND/server.js` serves the whole app (frontend + realtime)
on `http://localhost:3001`. That link is **always working** while the server runs
and is the best one to test with on this PC.

> **Heads-up for this machine:** PowerShell blocks `npm.ps1`
> (`running scripts is disabled on this system`). Run the server directly with
> `node` instead:
>
> ```powershell
> cd "C:\Users\ACER\Desktop\New folder\Neiborly.zip"
> node BACKEND/server.js
> ```

> ⚠️ **The old public preview URLs are dead.** The previous
> `*.trycloudflare.com` quick-tunnel link only existed while that machine + task
> were running, and the task no longer exists here. Treat any saved
> `trycloudflare.com` link as expired — always grab a fresh one.

### Option 1 — Test locally (works right now)

Open <http://localhost:3001> (or <http://localhost:3001/api> for the status
JSON). `localhost` counts as a **secure context**, so the microphone, camera and
screen-share APIs all work without HTTPS. This is the link to use for testing
calls and screen sharing on one machine.

### Option 2 — Public HTTPS link

Two ways to get a link other people can open:

1. **Render (permanent, recommended)** — see section 2. Gives you
   `https://<service>.onrender.com` that survives reboots.
2. **Cloudflare quick tunnel (temporary)** — only if `cloudflared` is installed:

   ```powershell
   node BACKEND/server.js            # terminal 1
   cloudflared tunnel --url http://localhost:3001   # terminal 2
   ```

   `cloudflared` is **not installed** on this PC right now
   (`where.exe cloudflared` finds nothing). Install it first, or just use
   Render. The printed `https://<random>.trycloudflare.com` URL dies when the
   PC sleeps or the tunnel restarts, so re-copy it each time.

WebRTC calls and screen sharing need **HTTPS or localhost**. Plain
`http://<lan-ip>` will load the UI but block camera/mic/screen-share.


---

## 2. Deploy to the internet

### Step 0 — GitHub ✅ DONE, and now fully automatic ✅

The code lives on branch `main` at:

**<https://github.com/WeekyMonday/neighborly>** (public)

Render is connected to that branch with `autoDeployTrigger: commit`
(see `render.yaml`), so **every push to `main` goes live on its own.** There is
no manual deploy button to press, and no need to say "deploy" — just commit.

#### Ship an update

```powershell
cd "C:\Users\ACER\Desktop\New folder\Neiborly.zip"
npm run ship                       # stage + bump PWA cache + commit + push
npm run ship "Fix login redirect"  # ...with your own message
```

That single command:

1. stages everything (`git add -A`),
2. bumps `CACHE_NAME` in `FRONTEND/www/sw.js` if any frontend file changed,
   so returning users aren't stuck on a stale cached build,
3. commits,
4. pushes to `origin/main` → Render builds and redeploys automatically.

You only have to remember **`npm run ship`** — not "deploy".

#### Why a plain `git commit` is enough too

`npm run setup` installs a `post-commit` hook in `.git/hooks` that pushes for
you, so even a hand-typed `git commit` updates the live site. (`npm run ship`
runs this setup first, which is why fresh clones work immediately.) The hook is
deliberately conservative:

- skips when `NEIGHBORLY_NO_AUTOPUSH=1` is set (WIP commits),
- skips during rebase / merge / cherry-pick,
- only runs on `main`,
- never fails your commit if the network or credentials are unavailable.

#### Seeing what would happen

```powershell
node scripts/ship.js --dry-run
```

> `git` may not be on PATH until you restart VS Code. Until then, use the full
> path: `& "C:\Program Files\Git\cmd\git.exe" push`

> **On this PC, type `npm.cmd` instead of `npm`** in PowerShell — the
> execution policy blocks `npm.ps1`:
>
> ```powershell
> npm.cmd run ship
> ```
>
> VS Code's integrated terminal, or `cmd`, use plain `npm` fine. The `node`
> commands (`node scripts/ship.js`) work either way.

### Tests run before anything goes live

`.github/workflows/ci.yml` runs `npm test` (socket chat, friend requests,
voice rooms, invite links) on every push to `main`. Local:

```powershell
npm.cmd test
```

### Option A — Railway (fastest, no Git required)

```powershell
npm install -g @railway/cli
railway login
railway init
railway up
```

Railway reads `Procfile` (`web: node BACKEND/server.js`), detects Node, injects
`PORT`, and gives you a public `https://…up.railway.app` URL. WebSockets are
supported on all plans.

### Option B — Render (free tier, via the included blueprint)

`render.yaml` is already set up as a Render Blueprint.

1. The repo is already on GitHub: **<https://github.com/WeekyMonday/neighborly>**
2. On <https://dashboard.render.com> → **New → Blueprint** → pick that repo.
3. Render reads `render.yaml`, runs `npm install --omit=dev`, then `npm start`,
   and health-checks `/api`.

### Option C — Heroku / any Node host

- Build: `npm install --omit=dev`
- Run:   `npm start`  (or `node BACKEND/server.js`)
- `Procfile` is included.

> **Never upload `node_modules/`.** It is in `.gitignore`. The host installs
> dependencies itself.

---

## 2b. Custom domain (e.g. `app.neighborly.gg`)

Cloudflare **quick** tunnels (`*.trycloudflare.com`) **cannot be renamed** — the
name is randomly generated. To get a branded URL you need two things: your **own
domain**, and a **permanent host** (a custom domain attaches to the Render
service, not to the tunnel).

1. **Register the domain.** `.gg` costs roughly **$50/year** (Spaceship ~$49.49,
   Porkbun ~$50.80, Dynadot ~$53.50). Cheaper alternatives: `.app` / `.dev`
   (~$12/yr) or `.com` (~$11/yr).
2. **Deploy to Render** (see Option B).
3. Render Dashboard → your service → **Settings → Custom Domains →
   + Add Custom Domain** → enter `app.neighborly.gg`.
   (Free/Hobby plans include 2 custom domains at no extra cost.)
4. **At your domain's DNS provider**, add:

   | Type  | Name  | Value                        |
   |-------|-------|------------------------------|
   | CNAME | `app` | `neighborly.onrender.com`    |

5. Wait for Render to verify — it **automatically issues and renews free TLS**
   and redirects all HTTP traffic to HTTPS.
6. Add `app.neighborly.gg` to **Firebase → Authentication → Settings →
   Authorized domains**, or login fails with `auth/unauthorized-domain`.

The `*.onrender.com` subdomain keeps working alongside your custom domain.

> **Free alternative:** pick a nicer service name on Render and you get
> `https://neighborly.onrender.com` at no cost — no domain purchase or DNS
> needed. (`render.yaml` already uses `name: neighborly`.)
>
> **Alternative:** Cloudflare **named** tunnels (free Cloudflare account + your
> domain) can also serve a custom hostname from your own PC — but the site still
> dies whenever the PC sleeps, so Render + a custom domain is the better pairing.

---

## 3. Post-deploy configuration (required — do this after you get the URL)

1. **Firebase authorized domains — NOT required for this app's login ✅**

   This was **verified empirically**: email/password sign-in and sign-up are
   *not* subject to Firebase's authorized-domain restriction. Calling
   `identitytoolkit.googleapis.com/v1/accounts:signInWithPassword` and
   `...:signUp` with `Origin: https://<your-domain>` returned normal app-level
   responses (`INVALID_LOGIN_CREDENTIALS`, `WEAK_PASSWORD`) — **not**
   `UNAUTHORIZED_DOMAIN`. So login and registration work on any hostname.

   You only need to add the domain (Firebase Console → Authentication →
   Settings → **Authorized domains**) if you later add:
   - an **OAuth provider** (Google / Facebook / Apple popup or redirect sign-in), or
   - **email-link sign-in**, or a custom `continueUrl` for verification emails.

   Adding it anyway is harmless and future-proofs the app.

2. **Supabase → allow the password-reset redirect** (only used by the reset flow)
   Supabase Dashboard → **Authentication → URL Configuration**:
   - **Site URL**: `https://<your-domain>`
   - **Redirect URLs**: add `https://<your-domain>/update-password.html`

3. **Environment variables**
   `PORT` is provided by the host automatically. `JWT_SECRET` is generated by the
   Render blueprint. You can set either manually if your host asks.

---

## 4. Things to know about this app

- **Data persistence:** chat history and online users live in memory
  (`BACKEND/socketManager.js`), and locally-registered accounts are written to
  `BACKEND/data/users.json`. On most hosts the filesystem is **ephemeral**, so
  this data resets on restart/redeploy. Firebase Auth is the real login system,
  so users still work — but move chat to a database (Firebase/Supabase/Postgres)
  if you need history to survive restarts.
- **Free tiers sleep:** Render's free web service spins down after inactivity, so
  the first visit may take ~30–60s to wake up.
- **Friends:** friend requests, friends and presence are relayed over Socket.io
  and kept in memory (`BACKEND/socketManager.js`). Both people must have opened
  Neighborly at least once in the current server session (in-memory store), and
  they are matched by **@username/handle** — the handle comes from the Firebase
  account's email prefix unless a profile was set. Adding a friend who has never
  connected returns a friendly "could not find @…" notice.
- **Voice/video:** WebRTC requires HTTPS (all the hosts above give you HTTPS) or
  `localhost`. Calls work between most networks via the default STUN servers. For
  users behind strict corporate NATs/firewalls you need a **TURN** relay — the
  client supports it without code changes: define `window.NEIGHBORLY_ICE_SERVERS`
  (an `iceServers` array) or `window.NEIGHBORLY_TURN_CREDENTIALS_URL` (a URL that
  returns such an array, e.g. the Metered/Open Relay credentials API) before
  `js/webrtcClient.js` runs.
- **Service worker cache:** `FRONTEND/www/sw.js` precaches pages and assets under
  `CACHE_NAME` (`neighborly-vNN`). `npm run ship` bumps it automatically when
  frontend files change, so **you never have to edit it by hand** — just ship.
- **`app.get("*")` fallback** serves the app for unknown paths (SPA support),
  so a bad asset path returns the HTML instead of a 404.

---

## 5. Handy commands

```powershell
npm start              # run the website (backend + frontend) on $PORT or 3001
npm run start:desktop  # run the old Electron desktop version
npm test               # run the socket/voice test suite
```
