# Deployment

## Prerequisites

- Docker & Docker Compose v2
- Domain with DNS configured
- SSL certificates (Traefik handles via Let's Encrypt)

## Quick Start

```bash
git clone https://github.com/heichaowo/moenet-core.git
cd moenet-core
cp .env.example .env
vim .env  # Configure all required values

docker compose up -d
```

## First Run & Database Initialization

A fresh deployment works out of the box — no manual SQL is required:

- **Schema migrations** in the `migrations/` directory run automatically on API
  startup (serialized with a Postgres advisory lock, and tracked in the
  `settings` table so each runs once). The directory is copied into the API
  image, so this also works in containers.
- **A default BIRD policy is auto-seeded** on first start. Without it the agent
  would get `No default BIRD policy configured` and BIRD would never come up.
  The seed uses sane defaults: the DN42 ASN, the DN42 address prefixes, two
  standard RPKI sources (`rpki.akae.re`, `rpki.dn42.launchpadx.top`), and the
  standard community/limit set. An existing policy row is never overwritten.

::: warning Deploying with your own ASN
The seeded defaults use MoeNet's ASN (`4242420998`) and prefixes. If you run
your own DN42 network, update the default `bird_policies` row (ASN, prefixes,
RPKI servers) after first start — the agents render their BIRD config (eBGP/iBGP
`local as`, RPKI protocols) from this policy, so no source changes are needed.
:::

## Services

| Service | Port | Description |
|---------|------|-------------|
| `api` | 3000 | Hono.js REST API |
| `bot` | 8443 | Telegram Bot (webhook) |
| `postgres` | 5432 | PostgreSQL database |
| `redis` | 6379 | Session/cache store |
| `traefik` | 80/443 | Reverse proxy with TLS |

## Updating

```bash
cd /opt/moenet-core
git pull origin main
docker compose up -d --build
```

## Server-local Compose override

The control plane keeps a `docker-compose.override.yml` — and the
`traefik-tls.yml` it mounts — alongside this repo's `docker-compose.yml`.
Neither file is part of moenet-core: they adapt the shared Traefik instance to
unrelated services co-hosted on that machine. Both are gitignored, and are
host state rather than repo state.

Two consequences are invisible from this repo alone.

**Traefik's production flags come entirely from the override.** In Compose,
`command:` is a single-value option — an override *replaces* it rather than
appending to it. The `command:` block on the `traefik` service in
`docker-compose.yml` is therefore **dead on the control plane**: editing it
changes nothing in production. Any flag added here must be mirrored into the
server's override by hand, or it silently fails to apply. This duplication is
forced, not accidental: Traefik's static configuration sources (file,
command-line, environment) are mutually exclusive, so an override cannot merge
in a few extra flags via `environment:` — it has to restate the whole command.

::: danger Never deploy with an explicit `-f docker-compose.yml`
Compose auto-discovers `docker-compose.override.yml` **only when no `-f` is
given**. Passing `-f` silently drops the override: Traefik comes back up
without its file provider and without the extra certificate mounts, and
nothing is printed to say so.

Use a bare `docker compose up -d`, or name both files explicitly:

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d
```
:::

## CI/CD

Push to `main` triggers:

1. Run tests
2. Build Docker images
3. Push to GHCR
4. Deploy to server (if secrets configured)

Required GitHub Secrets:

| Secret | Description |
|--------|-------------|
| `DEPLOY_HOST` | Server hostname |
| `DEPLOY_USER` | SSH username |
| `DEPLOY_KEY` | SSH private key |

## Backup & Restore

### PostgreSQL

```bash
# Backup
docker exec moenet-postgres pg_dump -U moenet moenet > backup.sql

# Restore
docker exec -i moenet-postgres psql -U moenet moenet < backup.sql
```

### Redis

```bash
# Backup
docker cp moenet-redis:/data/dump.rdb ./redis-backup.rdb

# Restore
docker cp ./redis-backup.rdb moenet-redis:/data/dump.rdb
docker restart moenet-redis
```
