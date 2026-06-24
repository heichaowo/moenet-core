# Troubleshooting

## Bot Issues

### Bot not receiving updates

```bash
# Check webhook status
curl https://api.telegram.org/bot<token>/getWebhookInfo

# Manually set webhook
curl -X POST "https://api.telegram.org/bot<token>/setWebhook?url=https://bot.moenet.work/bot<token>"
```

### Bot rate limited by Telegram

Reduce `RATE_LIMIT_MAX` or increase `RATE_LIMIT_WINDOW_MS` in `.env`.

### Session data lost after restart

Check Redis connectivity:

```bash
docker exec moenet-redis redis-cli ping
# Expected: PONG

docker logs moenet-bot | grep -i redis
```

If Redis is unavailable, the bot falls back to in-memory storage (lost on restart).

## API Issues

### 401 Unauthorized

- JWT token expired — re-authenticate via `/login`
- Agent token mismatch — check `AGENT_API_KEY` in `.env`

### 429 Rate Limited

Check rate limit headers in the response:

```bash
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1704067200
```

Wait for the reset timestamp before retrying.

### Database connection refused

```bash
# Check PostgreSQL health
docker exec moenet-postgres pg_isready
# Expected: accepting connections

# Check connection from API container
docker exec moenet-api bun -e "console.log('ok')"
```

## Agent Issues

### Agent not connecting to Control Plane

```bash
# Check agent logs
journalctl -u moenet-agent -f

# Verify config
./moenet-agent -validate

# Test connectivity
curl -H "Authorization: Bearer $TOKEN" \
  https://api.moenet.work/agent/$(hostname)/heartbeat
```

### WireGuard tunnel not coming up

```bash
# Check interface exists
ip link show | grep wg_

# Check WireGuard status
wg show

# Verify peer configuration
wg show wg_24001
```

### BIRD config not reloading

```bash
# Check BIRD status
birdc show status

# Manually reload
birdc configure

# Check config syntax
birdc configure check

# View BIRD logs
journalctl -u bird -f
```

### BGP session not establishing

```bash
# Check protocol status
birdc show protocols all | grep -A5 "peer_name"

# Check routes
birdc show route protocol peer_name

# Common issues:
# - Wrong link-local address
# - Firewall blocking BGP (port 179)
# - WireGuard tunnel not up
```

## Network Issues

### Peers can't reach each other

```bash
# Ping via WireGuard interface
ping -I wg_24001 fe80::peer%wg_24001

# Check WireGuard handshake
wg show wg_24001
# "latest handshake" should be recent

# Check firewall
iptables -L -n | grep -i drop
```

### Mesh IGP not converging

```bash
# Check Babel protocol in BIRD
birdc show protocols | grep babel

# View Babel routes
birdc show route protocol babel1

# Check mesh interfaces
ip link show | grep mesh_
```

## Common Error Codes

| Code | Meaning | Fix |
|------|---------|-----|
| `AUTH_FAILED` | Bad signature | Re-sign the challenge |
| `INVALID_TOKEN` | Expired JWT | Re-authenticate |
| `ASN_BLOCKED` | ASN blocked | Contact admin |
| `SESSION_EXISTS` | Duplicate peer | Remove existing session first |
| `SETUP_FAILED` | Agent failed to configure | Check agent logs |
