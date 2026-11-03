# Moving SprayWall to the Raspberry Pi

The frontend stays on Cloudflare Pages (free). Only the **backend** and
**database** move to the Pi, and the frontend gets repointed at the Pi's URL.
Database starts **fresh** (empty) on the Pi.

## 0. Prerequisites on the Pi (one time)

- **64-bit Raspberry Pi OS** (sharp's image-processing binaries need arm64).
- Docker + the Compose plugin:
  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER   # log out/in so `docker` works without sudo
  ```

## 1. Get the code onto the Pi
```bash
git clone <your spraywall-backend repo> spraywall-backend
cd spraywall-backend
```

## 2. Create the `.env` (beside docker-compose.yml)
Compose reads this for secrets. Do **not** commit it.
```bash
cp .env.example .env
nano .env
```
Set at least:
- `POSTGRES_PASSWORD` — any strong password (only used inside the Pi).
- `JWT_SECRET` — generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `ROBOFLOW_API_KEY` — your key (only needed for hold detection on setup).

## 3. Bring up the stack
```bash
docker compose up -d --build
```
What happens: Postgres starts, Compose waits until it's healthy, then the api
container runs `npm run migrate` (creates the schema from `migrations/*.sql` on
the fresh DB) and starts the server on port 3000. `restart: unless-stopped`
means both come back automatically after a reboot or crash.

Check it:
```bash
curl localhost:3000/health          # {"status":"ok","db":"connected"}
docker compose logs -f api          # watch startup / migrations
```

## 4. Expose it publicly with Tailscale Funnel (free, HTTPS, stable URL)
The frontend is HTTPS, so the API must be HTTPS too — Funnel provides that.
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# In the Tailscale admin console, enable HTTPS certificates and Funnel for this machine.
sudo tailscale funnel 3000
```
This gives a stable public URL like `https://<pi-name>.<tailnet>.ts.net`.
Confirm from your phone (off wifi): open `https://.../health`.

## 5. Repoint the frontend (Cloudflare)
In the Cloudflare Pages/Workers project settings, set the build variable:
```
VITE_API_BASE_URL = https://<pi-name>.<tailnet>.ts.net
```
Then redeploy (push, or trigger a build). The app now talks to the Pi.

## 6. First use on the fresh DB
The database is empty, so: register your account again, set up the wall
(upload the photo, detect/adjust holds), and recreate climbs.

---

## Day-to-day on the Pi
```bash
docker compose pull            # (if using a prebuilt image)
git pull && docker compose up -d --build   # deploy new code
docker compose logs -f api     # logs
docker compose down            # stop (data is kept in the pgdata volume)
npm run migrate                # migrations also run automatically on api start
```

## Notes
- **New migrations later:** drop a new `NNN_*.sql` in `migrations/`. It runs
  automatically on the next api start (tracked in `schema_migrations`, applied once).
- **Backups:** the data lives in the `pgdata` Docker volume. Back it up with
  `docker compose exec db pg_dump -U spraywall spraywall > backup.sql`.
- **Authoritative schema (optional):** `000_baseline.sql` was reconstructed from
  code. It is complete for a fresh start, but if you want it dumped from the real
  DB, run against Neon from your Mac:
  `pg_dump --schema-only "<neon-connection-string>" > migrations/000_baseline.sql`
