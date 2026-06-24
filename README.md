# MoeNet Core

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9%2B-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-Latest-pink.svg)](https://bun.sh/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Control Plane for the [MoeNet DN42](https://dn42.moenet.work) network. Provides a REST API for agent communication and a Telegram Bot for user interaction.

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Bot Commands](#bot-commands)
- [API Reference](#api-reference)
- [Architecture](#architecture)
- [BGP Communities](#bgp-communities)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

## Features

- **Telegram Bot** - Complete peering management via [@moenet_dn42_bot](https://t.me/moenet_dn42_bot)
- **Multi-auth** - GPG, SSH, or Email verification against DN42 registry
- **Node Bootstrap** - One-command setup for new nodes
- **Real-time Status** - WireGuard and BGP status via network tools
- **Bilingual** - English and Chinese interface
- **Rate Limiting** - Configurable per-endpoint rate limits
- **Prometheus Metrics** - Full observability

## Quick Start

### Development

```bash
# Install dependencies (requires Bun)
bun install

# Configure environment
cp .env.example .env
# Edit .env with your values

# Start development server
bun run dev
```

### Production (Docker)

```bash
# Clone and configure
git clone https://github.com/moenet/moenet-core.git
cd moenet-core
cp .env.example .env
vim .env

# Deploy
docker compose up -d
```

## Configuration

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token from [@BotFather](https://t.me/botfather) |
| `DB_PASSWORD` | PostgreSQL password |
| `JWT_SECRET` | Secret for JWT tokens |
| `WEBHOOK_DOMAIN` | Bot webhook domain |
| `WEBHOOK_SECRET` | Webhook validation secret |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_ADMIN_USERNAME` | - | Admin username |
| `TELEGRAM_ADMIN_CHAT_ID` | - | Admin notification chat |
| `REDIS_URL` | (memory) | Redis for session persistence |
| `LOCAL_ASN` | `4242420998` | Network ASN |
| `MAILGUN_API_KEY` | - | Mailgun API key (enables email login) |
| `MAILGUN_DOMAIN` | `dn42.moenet.work` | Mailgun sending domain |
| `MAILGUN_FROM` | `DN42 Bot <bot@dn42.moenet.work>` | Email sender address |

See `.env.example` for all options.

## Bot Commands

### User Commands

| Command | Description |
|---------|-------------|
| `/start` | Show welcome message |
| `/help` | List all commands |
| `/login` | Authenticate with DN42 ASN (GPG / SSH / Email) |
| `/peer` | Create new peering session |
| `/info` | View your active peers |
| `/modify` | Change peer settings |
| `/remove` | Delete a peer |
| `/status` | Check tunnel status |
| `/restart` | Restart WireGuard tunnel |

### Network Tools

| Command | Description |
|---------|-------------|
| `/ping <target>` | Ping from nodes |
| `/trace <target>` | Traceroute |
| `/whois <query>` | DN42 WHOIS lookup |
| `/dig <domain>` | DNS lookup |
| `/route <prefix>` | BGP route lookup |

### Admin Commands

| Command | Description |
|---------|-------------|
| `/addnode` | Add new node (wizard) |
| `/bootstrap <node>` | Generate setup script |
| `/pending` | View pending approvals |
| `/nodes` | List all nodes |

## API Reference

### Agent Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/agent/:router/sessions` | GET | Fetch BGP sessions |
| `/agent/:router/bird-config` | GET | Fetch BIRD filters |
| `/agent/:router/mesh` | GET | Fetch mesh peers |
| `/agent/:router/config` | GET | Full bootstrap config |
| `/agent/:router/heartbeat` | POST | Agent health report |
| `/agent/:router/modify` | POST | Update session status |
| `/agent/:router/report` | POST | Report metrics |

### Public Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth` | POST | User authentication |
| `/session` | POST | Peering management |
| `/health` | GET | Health check |
| `/metrics` | GET | Prometheus metrics |
| `/bootstrap/:token` | GET | Bootstrap script |

### Services

| Service | Port | Domain |
|---------|------|--------|
| API | 3000 | api.moenet.work |
| Bot | 3001 | bot.moenet.work |
| Prometheus | 9090 | prom.moenet.work |
| Grafana | 3002 | grafana.moenet.work |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       Users (Telegram)                          │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Telegram Bot                              │
│                   (grammY + Hono.js + Bun)                       │
│  • Session Management (Redis)                                    │
│  • Rate Limiting                                                 │
│  • Peer Creation Wizard                                          │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Control Plane API                           │
│                      (Hono.js + Bun)                             │
│  • Agent Authentication (JWT)                                    │
│  • Session CRUD                                                  │
│  • Bootstrap Token Management                                    │
└─────────────────────────────────────────────────────────────────┘
         │                        │                        │
         ▼                        ▼                        ▼
┌───────────────┐        ┌───────────────┐        ┌───────────────┐
│  PostgreSQL   │        │     Redis     │        │    Agents     │
│  (persistent) │        │   (session)   │        │   (Go nodes)  │
└───────────────┘        └───────────────┘        └───────────────┘
```

### Directory Structure

```
moenet-core/
├── packages/
│   ├── api/                    # Hono.js REST API
│   │   └── src/
│   │       ├── handlers/       # Request handlers
│   │       ├── db/             # Sequelize models
│   │       └── providers/      # WHOIS, Email (Mailgun), IP detection
│   │
│   └── bot/                    # grammY Telegram Bot
│       └── src/
│           ├── commands/       # Command handlers
│           ├── middleware.ts   # Rate limiting
│           └── i18n.ts         # Localization
│
├── docker-compose.yml          # Stack deployment
└── .env.example                # Environment template
```

## BGP Communities

### MoeNet Large Communities

| Type | Format | Purpose |
|------|--------|---------|
| Accepted | `(4242420998, 100, <nodeId>)` | Ingress node |
| Rejected | `(4242420998, 150, <reason>)` | Rejection reason |
| Origin | `(4242420998, 3, <nodeId>)` | Cold potato routing |

### DN42 Standard Communities

| Type | Range | Example |
|------|-------|---------|
| Latency | `(64511, 1-9)` | `(64511, 3)` = <20ms |
| Bandwidth | `(64511, 21-25)` | `(64511, 21)` = ≥100Mbps |
| Encryption | `(64511, 31-34)` | `(64511, 33)` = WireGuard |
| Region | `(64511, 41-53)` | `(64511, 50)` = Asia-East |

## Development

### Prerequisites

- [Bun](https://bun.sh/) 1.0+
- PostgreSQL 16
- Redis (optional, for session persistence)

### Commands

```bash
# Install dependencies
bun install

# Development mode
bun run dev        # All packages
bun run dev:api    # API only
bun run dev:bot    # Bot only

# Testing
bun test

# Linting
bun run lint

# Type checking
bun run check
```

### Build

```bash
bun run build
# Output: packages/*/dist/
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - System design
- [API Reference](docs/API.md) - Endpoint details
- [Database Schema](docs/DATABASE.md) - Table definitions
- [Bot Development](docs/BOT.md) - Adding commands
- [Production](docs/PRODUCTION.md) - Deployment guide

## License

MIT License - see [LICENSE](LICENSE)
