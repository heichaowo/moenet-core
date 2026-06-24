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
| `DB_HOST` | `postgres` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `moenet` | Database name |
| `DB_USER` | `moenet` | Database user |
| `REDIS_HOST` | `redis` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_URL` | `redis://moenet-redis:6379` | Redis connection URL |
| `RATE_LIMIT_MAX` | `20` | Bot requests per minute |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |

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

### Validate Config

```bash
./moenet-agent -validate
```
