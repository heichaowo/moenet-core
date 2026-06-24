# Monitoring

## Service Endpoints

| Service | Port | Domain |
|---------|------|--------|
| API | 3000 | `api.moenet.work` |
| Bot | 8443 | `bot.moenet.work` |
| Prometheus | 9090 | `prom.moenet.work` |
| Grafana | 3002 | `grafana.moenet.work` |

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
