# Deploying Ardoise (self-hosted, behind Caddy)

The app is one self-contained origin: the frontend container (nginx) serves the PWA
and reverse-proxies `/api/` to the backend. So your public reverse proxy only needs
**one upstream**: the frontend container.

```
Internet ──HTTPS──► Caddy ──► frontend:3060 ──► nginx ──┬── static PWA
                                                        └── /api/ -> backend:8000 -> MariaDB
```

## 1. Set the shared password and DB secrets

Create an **untracked** `.env` next to `docker-compose.yml` (never edit the tracked
files on the server, or `git pull` will conflict):

```
API_KEY=<a-long-random-string>          # the shared password friends enter once
DB_PASSWORD=<a-strong-db-password>      # used by both MariaDB and the backend
DB_ROOT_PASSWORD=<another-strong-one>
```

`docker compose` reads `.env` automatically and injects these over the tracked
defaults (`backend/.env.docker` stays pristine dev defaults, `DEBUG=false` included).

Generate a good key, e.g.:

```
openssl rand -base64 32
```

Leave `API_KEY` empty only for local development (auth disabled). Keep `DEBUG=false`
in production (it gates `/docs`, `/api/v1/openapi.json`, SQL echo, and reload).

The compose file publishes the backend only on `127.0.0.1` and does not publish
MariaDB at all. The frontend is published on the LAN (`3060:80`) because Caddy
runs in a different LXC and proxies to this host's :3060 (see D25); sync stays
gated by `API_KEY`. Docker bypasses UFW, so never port-forward 3060 to the WAN
and do not add other public port publishes.

## 2. Enable push notifications (optional but recommended)

Generate a VAPID key pair once (after the first `docker compose build`, which
installs pywebpush) and add the private key to the same untracked `.env`:

```
docker compose run --rm --no-deps backend python -c "
from py_vapid import Vapid02, b64urlencode
v = Vapid02(); v.generate_keys()
print('VAPID_PRIVATE_KEY=' + b64urlencode(v.private_key.private_numbers().private_value.to_bytes(32, 'big')))
"
```

```
VAPID_PRIVATE_KEY=<the line printed above>
VAPID_SUBJECT=mailto:you@example.com
```

Keep the key stable: rotating it silently invalidates every phone's
subscription (each user would have to toggle notifications off and on again).
Leave it empty to run without notifications; everything else still works and
the app hides the notification menu entry.

Platform reality: Android and desktop browsers work everywhere; iPhones need
iOS 16.4+ AND the app installed on the home screen (in Safari itself the menu
shows "installer l'app d'abord"). Users enable notifications from the home
menu; the author of a change is never notified about their own edit.

## 3. Start the stack

```
docker compose up -d --build
docker compose run --rm --no-deps -v ./backend:/app backend alembic upgrade head
```

The app is now on `http://localhost:3060` on the server.

## 4. Point Caddy at it

Minimal Caddyfile (Caddy handles TLS/Let's Encrypt automatically):

```caddy
ardoise.example.com {
    reverse_proxy localhost:3060
}
```

That is all: static files, the manifest, the service worker, and `/api/*` all flow
through this single upstream. HTTPS is required for the service worker, PWA install,
and persistent storage, and Caddy provides it.

## 5. First use

1. Open `https://ardoise.example.com`, menu -> **Mot de passe du serveur**, enter `API_KEY`.
   It is validated against the server and stored permanently in the browser.
2. Create a group, add expenses (works offline), then **Partager** to sync.
3. For the simplest friend setup, let them scan the QR code shown in **Partager**. It carries the group code and your current server password in the URL fragment, joins automatically, and removes the credentials from the address bar before contacting the server. The fragment is not sent to Caddy/nginx access logs. Treat the QR like the shared password and show it only to trusted people.
4. The manual fallback remains: friends open the same URL, enter the password once, and **Rejoindre** with the code.

### QR security boundary

The QR is convenient, not one-time or bulletproof. It is a reusable bearer credential containing the instance-wide `API_KEY` plus one group code. URL fragments keep it out of normal HTTP/proxy logs, the app removes it from the address bar immediately, and HTTPS protects it in transit. Those measures do not protect a screenshot, camera/scanner history, browser extension, compromised phone, or anyone who can see the QR. It has no independent expiry or revocation; rotate `API_KEY` to invalidate it, which also signs every existing device out of sync. Use it only face-to-face with trusted friends. A public or externally forwarded invitation needs expiring, one-time, group-scoped server tokens instead.

## Notes

- The password gates **sync only** (`register`/`resolve`/`push`/`pull`). The static app
  still loads without it; you just cannot sync until it is entered. `/health` and
  `/system/ping` stay open for liveness checks (`/health` returns 503 when the DB is down).
- Changing `API_KEY` later logs everyone out of sync; they re-enter the new one once or scan a newly generated group QR code.
- **The server is disposable.** If its database is ever wiped or restored from an old
  backup, the phones detect it and automatically re-register and re-upload the full
  history (see context/02). The only visible effect of a full wipe is a new share code
  for each group (shown in Partager); old invite links stop working.
- **No server-side backup needed: the phones are the backup.** Every device keeps
  the full operation log locally and re-seeds a lost or stale server automatically.
  For an offline copy, use the in-app JSON export (full operation log, re-importable
  from the home menu: "Importer un export (JSON)"; it replays safely, duplicates are
  ignored, imported changes re-sync to the server). If you ever do want a server-side
  snapshot, the volume is `ardoise_mariadb-data` (`docker compose exec mariadb
  mariadb-dump ardoise`); there is no automated backup by design.
- Ports (see step 1): backend loopback-only, MariaDB unpublished, frontend on the
  LAN for the Caddy LXC. Only Caddy should be reachable from the WAN.
- App updates: after a redeploy, open apps show a "Nouvelle version disponible" toast
  and reload on tap (never mid-edit); freshly opened apps get the new version directly.
- D41 (2026-08-13) changed backend dependencies (fastapi 0.141.1, starlette >= 1.0.1 for
  CVE-2026-48710) and the sync wire (`reseed` flag on push). Rebuild the backend image
  (`docker compose up -d --build`); no migration is needed.

## Hardening for internet exposure (defense in depth)

The API key is the trust boundary and, generated with `openssl rand -base64 32`
over HTTPS with a constant-time compare, it is not brute-forceable in practice.
The realistic threats are elsewhere: software vulnerabilities in the exposed
stack (Caddy, nginx, FastAPI) and noise/abuse against the open endpoints. The
layers below are ordered by value; the first three cost minutes.

**1. Caddy headers + body cap.** The homelab already has a shared
`(security_headers)` snippet (HSTS+preload, nosniff, SAMEORIGIN, referrer
policy, Permissions-Policy, banner stripping): import it and add the Ardoise
body cap per site:

```caddy
ardoise.example.com {
    import security_headers
    request_body {
        max_size 12MB
    }
    reverse_proxy <app-lxc-ip>:3060
}
```

Ardoise needs none of the sensor/camera/geolocation permissions, so the shared
snippet's Permissions-Policy is fine as is. One note on that snippet:
`X-XSS-Protection` is a legacy header; the browser XSS auditor it controlled
was removed years ago, and OWASP now recommends dropping it (or `"0"`) because
old implementations enabled cross-site leaks. Harmless for Ardoise either way.

**2. Keep the software current.** The most likely real-world compromise is a
known CVE in an outdated image or proxy. Monthly: `git pull`,
`docker compose build --pull`, `docker compose up -d`, and keep Caddy updated
in its LXC. This matters more than any header.

**3. Rate limiting / ban on 401 spam.** Stock Caddy has no rate limiter, so
either build it with the `mholt/caddy-ratelimit` plugin (xcaddy), or better on
a homelab: CrowdSec in the Caddy LXC. Concretely: give the site a JSON access
log (`log { output file /var/log/caddy/ardoise.log format json }`), install
`crowdsec` + the `caddy` collection (`cscli collections install
crowdsecurity/caddy`), point an acquisition at that log file, and add the
`crowdsec-firewall-bouncer` so offending IPs get dropped at the firewall.
This turns key-guessing and scanner noise into bans.

**4. Only expose what friends need.** Caddy should be the single WAN entry.
The compose file already keeps backend and MariaDB off the network; the
frontend's LAN port 3060 must never be port-forwarded (Docker bypasses UFW).
`DEBUG=false` keeps /docs and the OpenAPI schema dead in production.

**5. Stronger than a shared key, if ever wanted** (each trades friend-UX):
- Cloudflare Tunnel + Access, or a VPN (Tailscale/WireGuard): the app stops
  being reachable at all without enrollment. Strongest, but every friend must
  install something, which defeats the share-a-link flow.
- Caddy `forward_auth` to Authelia/Authentik (real SSO accounts): overkill for
  a friends instance, noted for completeness.
- Rotating `API_KEY` now and then is cheap: change `.env`, restart backend,
  everyone re-enters once (menu -> Mot de passe du serveur).

What an attacker WITHOUT the key can reach today: the static PWA files,
`/health` (a boolean), `/system/ping`, and 401s on everything else. Sync,
push subscriptions and share codes are all behind the key.

## Accepted risks (small trusted-friends deployment)

These are deliberate for a "me + friends behind one shared password" instance:
- **No per-user accounts / per-group authorization.** Anyone with the password can
  read/write any group they have the share code for. The password is the trust boundary.
- **No rate limiting.** A long random `API_KEY` (above) makes brute force infeasible;
  add a Caddy rate-limit if you want defense in depth.
- **No server-side validation of op contents / payload size.** A buggy or hostile
  client that already has the password could push nonsensical amounts. Trusted circle;
  add a Caddy request-body-size limit if exposing more widely.
