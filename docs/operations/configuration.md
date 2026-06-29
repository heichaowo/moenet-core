# Configuration

## Control Plane (moenet-core)

All configuration is via environment variables in `.env`.

### Required Variables

| Variable | Description |
|----------|-------------|
| `DB_PASSWORD` | PostgreSQL password |
| `JWT_SECRET` | Secret for JWT token signing |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_ADMIN_USERNAME` | Admin Telegram username |
| `TELEGRAM_ADMIN_CHAT_ID` | Admin chat ID for notifications |
| `WEBHOOK_DOMAIN` | Bot webhook domain |
| `WEBHOOK_SECRET` | Webhook validation secret |
| `AGENT_API_KEY` | Shared key for agent authentication |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | API server bind address. Defaults to all interfaces (required so the bot/traefik containers can reach it); set to `127.0.0.1` to restrict. |
| `DB_HOST` | `postgres` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `moenet` | Database name |
| `DB_USER` | `moenet` | Database user |
| `REDIS_HOST` | `redis` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_URL` | `redis://moenet-redis:6379` | Redis connection URL |
| `TRUSTED_PROXY_COUNT` | `1` | Number of trusted reverse proxies in front of the API. Controls which `X-Forwarded-For` hop is used as the client IP for rate limiting and audit logs — set it to match your proxy chain or per-client limits will be wrong. |
| `AGENT_AUTOUPDATE` | on | Set to `false` to stop the Control Plane telling agents to auto-update. Use this when running custom/locally-built agent binaries (otherwise the stable auto-updater reverts them). |
| `GRAFANA_PASSWORD` | — | Grafana admin password (used by the monitoring stack — set it, the compose no longer silently defaults to `admin`). |
| `RATE_LIMIT_MAX` | `20` | Bot requests per minute |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |

::: tip Rate limiting
The API exempts internal clients that present a valid `AGENT_API_KEY` (the bot and all agents) from rate limiting; limits apply to public traffic (login, the user `/session` API). See [Monitoring](/operations/monitoring).
:::

### Email Verification (Optional)

| Variable | Description |
|----------|-------------|
| `MAILGUN_API_KEY` | Mailgun API key |
| `MAILGUN_DOMAIN` | Mailgun sending domain |
| `MAILGUN_FROM` | Sender email address |

## Agent (moenet-agent)

Agent configuration is via JSON config file. See [Agent Config Reference](/reference/agent-config) for the full specification.

### Config File Locations

The agent searches in order:

1. Command line: `./moenet-agent -config /path/to/config.json`
2. Current directory: `./config.json`
3. System: `/etc/moenet-agent/config.json`
4. User: `~/.config/moenet-agent/config.json`

### Environment Variable Overrides

| Variable | Config Path | Description |
|----------|-------------|-------------|
| `MOENET_NODE_NAME` | `node.name` | Node name |
| `MOENET_NODE_ID` | `node.id` | Node ID |
| `MOENET_CP_URL` | `controlPlane.url` | Control Plane URL |
| `MOENET_CP_TOKEN` | `controlPlane.token` | Agent token |
| `MESH_ENABLED` | — | Set to `false` to disable the agent's full-mesh iBGP-over-WireGuard (MeshSync). Default on; turn it off only when using a different inter-node interconnect. |

### Validate Config

```bash
./moenet-agent -validate
```
