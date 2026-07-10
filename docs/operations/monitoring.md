# Monitoring

## Service Endpoints

| Service | Port | Domain |
|---------|------|--------|
| API | 3000 | `api.moenet.work` |
| Bot | 8443 | `bot.moenet.work` |
| Prometheus | 9090 | `prom.moenet.work` |
| Grafana | 3002 | `grafana.moenet.work` |

## Access & Authentication

The monitoring endpoints are internet-facing through Traefik, so they must be
protected:

- **Prometheus** has no built-in authentication. It is fronted by a Traefik
  HTTP **basic-auth** middleware, already declared on the `prometheus` service
  labels in `docker-compose.yml`. The credential itself is **not** in git — the
  labels read it from `PROM_BASICAUTH`:

  ```yaml
  labels:
    - "traefik.http.routers.prometheus.middlewares=prom-auth"
    - "traefik.http.middlewares.prom-auth.basicauth.users=${PROM_BASICAUTH:?...}"
  ```

  Set it in `.env`, **single-quoted, with single `$`**:

  ```dotenv
  PROM_BASICAUTH='admin:$apr1$SALT$HASH'
  ```

  Generate the hash with `openssl passwd -apr1 '<password>'` and prefix the
  username. Recreate the container to apply: `docker compose up -d prometheus`.

  ::: warning Do not double the `$` in `.env`
  The `$$` escape applies **only** to a hash written inline in compose YAML.
  Compose interpolates unquoted and double-quoted `.env` values, so single
  quotes are what protect the `$` here — inside single quotes `$$` is taken
  literally and the hash will never match. If you are migrating a hash out of a
  compose file, **un-double** it first.
  :::

  Because the variable is declared `:?`, `docker compose up` **fails** when it
  is unset or empty rather than starting Prometheus unauthenticated.

- **Grafana** uses its own admin login — set `GRAFANA_PASSWORD` in `.env`
  (the compose no longer defaults it to `admin`).

- **Agent API** (the CP-facing HTTP server on each node) must be firewalled to
  the Control Plane's IP only — it authenticates with the agent API key, but
  should not be reachable from the wider DN42 network.

## Health Checks

### API Health

```bash
curl https://api.moenet.work/health
# {"status": "ok"}
```

### Bot Health

```bash
# Check webhook status
curl https://api.telegram.org/bot<token>/getWebhookInfo
```

### Agent Health

Each agent exposes a local HTTP endpoint:

```bash
curl http://localhost:24368/health
```

## Prometheus Metrics

### API Metrics

```bash
curl https://api.moenet.work/metrics
```

Exposed metrics include:
- `http_requests_total` — Request count by endpoint and status
- `http_request_duration_seconds` — Request latency histogram
- `active_sessions_total` — BGP session count by status
- `agent_heartbeat_timestamp` — Last heartbeat per node

### Agent Metrics

The agent reports metrics to the Control Plane every 60s:
- Per-session RTT (ping latency)
- Per-session traffic (rx/tx bytes)
- Per-session route count (imported/exported)
- System uptime

## Docker Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f api
docker compose logs -f bot
docker compose logs -f postgres
```

## Common Alerts

| Condition | Check |
|-----------|-------|
| Agent offline | No heartbeat for > 5 minutes |
| Session stuck | Status `QUEUED_FOR_SETUP` for > 10 minutes |
| High error rate | > 5% of API requests returning 5xx |
| Database connection | PostgreSQL health check failing |
| Redis connection | Redis PING failing |
