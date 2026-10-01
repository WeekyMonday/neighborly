# Neighborly — agent rules

## Always ship when you finish a change

The live site is wired to **auto-deploy every commit pushed to `main`**
(`render.yaml` → `autoDeployTrigger: commit`, repo
<https://github.com/WeekyMonday/neighborly>).

Therefore: **never end a task telling the user to "deploy", "push", or "redeploy
the site".** The only time you mention deploying is to explain a *build failure*
on Render's side.

After every task that changes files, finish with:

```powershell
npm run ship          # stage + bump PWA cache + commit + push -> Render redeploys
```

Rules that follow from this:

- `npm run ship` is idempotent and safe when the tree is clean — it just says
  "Nothing to ship".
- A plain `git commit` also ships: `scripts/setup-hooks.js` installs a
  `post-commit` hook that pushes. `npm run ship` installs that hook first.
- Bump commit messages: `npm run ship "Fix friend request accept"`.
- Preview without committing: `node scripts/ship.js --dry-run`.
- Escape hatch for WIP commits: `NEIGHBORLY_NO_AUTOPUSH=1 git commit -m "wip"`.
- Only branch `main` auto-deploys. Work on a feature branch and merge to `main`
  when it is ready to go live.

## Service worker cache

`FRONTEND/www/sw.js` precaches assets under `CACHE_NAME`
(`neighborly-vNN`). `npm run ship` bumps it automatically whenever frontend
files change, so returning users get the new version instead of a stale cache.
Don't hand-edit it — let the script do it.

## In-memory data

Chat history, friends and presence live in memory (`BACKEND/socketManager.js`),
so they reset on every redeploy. Don't present that as a deploy failure; it's
expected on this host.

## Tests

`npm test` runs the socket/friend/voice/invite suites. Run it after backend or
protocol changes.

`npm run smoke` (i.e. `node smoke.js`) boots the real server and requests
`/api`, `/login.html`, `/register.html`, `/Neighborly.html`, `/sw.js` and
`/js/app.js`, reporting HTTP status + byte counts and printing the current
service-worker cache name. Run it after touching anything under
`FRONTEND/www` — it catches 404s and syntax errors in served pages before a
push ships them.