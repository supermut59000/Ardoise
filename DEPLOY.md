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

The compose file publishes the backend and frontend only on `127.0.0.1`, and does
not publish MariaDB at all, so nothing but Caddy reaches the internet even though
Docker bypasses UFW. Do not add public port publishes.

## 2. Start the stack

```
docker compose up -d --build
docker compose run --rm --no-deps -v ./backend:/app backend alembic upgrade head
```

The app is now on `http://localhost:3060` on the server.

## 3. Point Caddy at it

Minimal Caddyfile (Caddy handles TLS/Let's Encrypt automatically):

```caddy
ardoise.example.com {
    reverse_proxy localhost:3060
}
```

That is all: static files, the manifest, the service worker, and `/api/*` all flow
through this single upstream. HTTPS is required for the service worker, PWA install,
and persistent storage, and Caddy provides it.

## 4. First use

1. Open `https://ardoise.example.com`, menu -> **Mot de passe du serveur**, enter `API_KEY`.
   It is validated against the server and stored permanently in the browser.
2. Create a group, add expenses (works offline), then **Partager** to sync.
3. Friends open the same URL, enter the password once, and **Rejoindre** with the code.

## Notes

- The password gates **sync only** (`register`/`resolve`/`push`/`pull`). The static app
  still loads without it; you just cannot sync until it is entered. `/health` and
  `/system/ping` stay open for liveness checks.
- Changing `API_KEY` later logs everyone out of sync; they re-enter the new one once.
- Back up the MariaDB volume (`tricount-clone_mariadb-data`) and/or use the in-app
  JSON export; the JSON export is the full operation log and can be re-imported by replay.
- Ports are already loopback-only (see step 1); only Caddy -> frontend is reachable.

## Accepted risks (small trusted-friends deployment)

These are deliberate for a "me + friends behind one shared password" instance:
- **No per-user accounts / per-group authorization.** Anyone with the password can
  read/write any group they have the share code for. The password is the trust boundary.
- **No rate limiting.** A long random `API_KEY` (above) makes brute force infeasible;
  add a Caddy rate-limit if you want defense in depth.
- **No server-side validation of op contents / payload size.** A buggy or hostile
  client that already has the password could push nonsensical amounts. Trusted circle;
  add a Caddy request-body-size limit if exposing more widely.
