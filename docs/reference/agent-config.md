# Agent Configuration

The MoeNet Agent is configured via a JSON file with the following sections.

## Modes

### Bootstrap Mode (Recommended)

Minimal config — the agent fetches remaining settings from the Control Plane at startup:

```json
{
  "controlPlane": {
    "url": "https://api.moenet.work",
    "token": "your-agent-token"
  },
  "server": {
    "listen": ":24368"
  }
}
```

Bootstrap automatically fetches: node ID, region, loopback IPs, ASN, mesh peers, iBGP peers.

### Full Configuration

See below for all available sections.

## Configuration Sections

### server

```json
{
  "server": {
    "listen": ":24368",
    "readTimeout": 30,
    "writeTimeout": 30,
    "idleTimeout": 120
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `listen` | string | `:24368` | HTTP listen address |
| `readTimeout` | int | `30` | Read timeout (seconds) |
| `writeTimeout` | int | `30` | Write timeout (seconds) |
| `idleTimeout` | int | `120` | Idle timeout (seconds) |

### node

```json
{
  "node": {
    "name": "jp-edge",
    "id": 1,
    "region": "ap-northeast",
    "location": "Tokyo",
    "provider": "Vultr"
  }
}
```

::: info
In Bootstrap mode, `name` is the only required field. Other fields are fetched from the Control Plane.
:::

### controlPlane

```json
{
  "controlPlane": {
    "url": "https://api.moenet.work",
    "token": "your-agent-token",
    "requestTimeout": 15,
    "heartbeatInterval": 30,
    "syncInterval": 60,
    "metricInterval": 60,
    "maxRetries": 3,
    "retryInitialDelay": 1000
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string | **required** | Control Plane API URL |
| `token` | string | **required** | Agent authentication token |
| `requestTimeout` | int | `15` | HTTP request timeout (seconds) |
| `heartbeatInterval` | int | `30` | Heartbeat interval (seconds) |
| `syncInterval` | int | `60` | Session sync interval (seconds) |
| `metricInterval` | int | `60` | Metric report interval (seconds) |
| `maxRetries` | int | `3` | Max retry attempts |
| `retryInitialDelay` | int | `1000` | Initial retry delay (ms) |

### bird

```json
{
  "bird": {
    "controlSocket": "/var/run/bird/run/bird.ctl",
    "poolSize": 5,
    "poolSizeMax": 64,
    "peerConfDir": "/etc/bird/peers",
    "ebgpConfTemplateFile": "/opt/moenet-agent/templates/ebgp.conf.tmpl",
    "ibgpConfDir": "/etc/bird/ibgp.d"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `controlSocket` | string | `/var/run/bird/run/bird.ctl` | BIRD control socket path |
| `poolSize` | int | `5` | Connection pool initial size |
| `poolSizeMax` | int | `64` | Connection pool max size |
| `peerConfDir` | string | `/etc/bird/peers` | eBGP peer config directory |
| `ebgpConfTemplateFile` | string | — | eBGP config template path |
| `ibgpConfDir` | string | `/etc/bird/ibgp.d` | iBGP config directory |

### wireguard

```json
{
  "wireguard": {
    "privateKeyPath": "/etc/wireguard/private.key",
    "publicKeyPath": "/etc/wireguard/public.key",
    "configDir": "/etc/wireguard",
    "persistentKeepaliveInterval": 25,
    "dn42Ipv4": "",
    "dn42Ipv6": "",
    "dn42Ipv6LinkLocal": "fe80::1"
  }
}
```

::: warning
MoeNet Agent uses direct kernel WireGuard interface management. Do NOT use `wg-quick`.
:::

### metric

```json
{
  "metric": {
    "pingTimeout": 5,
    "pingCount": 4,
    "pingWorkers": 32
  }
}
```

### autoUpdate

```json
{
  "autoUpdate": {
    "enabled": true,
    "checkInterval": 60,
    "channel": "stable",
    "githubRepo": "heichaowo/moenet-agent"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool | `true` | Enable auto-update |
| `checkInterval` | int | `60` | Check interval (minutes) |
| `channel` | string | `stable` | Release channel: `stable`, `beta`, `dev` |
| `githubRepo` | string | `heichaowo/moenet-agent` | GitHub repository for releases |

## Full Example

See [config.example.json](https://github.com/heichaowo/moenet-agent/blob/main/configs/config.example.json) for the complete configuration file.
