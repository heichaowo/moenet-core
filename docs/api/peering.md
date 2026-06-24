# Peering API

**Base URL:** `https://api.moenet.work`

All peering endpoints require authentication. Include the JWT token:

```bash
Authorization: Bearer <jwt-token>
```

## POST /session

Multi-action endpoint for peering session management.

### List Sessions

```bash
curl -X POST https://api.moenet.work/session \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action": "list"}'
```

**Response:**

```json
{
  "sessions": [
    {
      "uuid": "abc-123",
      "router": "jp1",
      "routerName": "Tokyo #1",
      "status": 1,
      "statusName": "ACTIVE",
      "ipv6": "fe80::1",
      "ipv6LinkLocal": "fe80::2",
      "mtu": 1420,
      "createdAt": "2024-01-01T00:00:00Z"
    }
  ]
}
```

### Create Session

```bash
curl -X POST https://api.moenet.work/session \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "create",
    "router": "uuid-of-router",
    "ipv6": "fe80::1",
    "linkLocal": "fe80::2",
    "endpoint": "example.com:51820",
    "publicKey": "wireguard-public-key",
    "mtu": 1420
  }'
```

**Response:**

```json
{
  "uuid": "new-session-uuid",
  "status": 3,
  "statusName": "PENDING_REVIEW",
  "serverEndpoint": "jp.moenet.work:24001",
  "serverPublicKey": "server-wireguard-key",
  "serverLinkLocal": "fe80::998:1"
}
```

### Modify Session

```bash
curl -X POST https://api.moenet.work/session \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "modify",
    "uuid": "session-uuid",
    "endpoint": "new-endpoint.com:51820",
    "mtu": 1400
  }'
```

### Delete Session

```bash
curl -X POST https://api.moenet.work/session \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action": "delete", "uuid": "session-uuid"}'
```

### Restart Session

Triggers WireGuard tunnel restart on the node.

```bash
curl -X POST https://api.moenet.work/session \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action": "restart", "uuid": "session-uuid"}'
```

## Session Status Codes

| Code | Name | Description |
|------|------|-------------|
| `0` | `DISABLED` | Session disabled |
| `1` | `ACTIVE` | Session active and running |
| `2` | `ERROR` | Session has errors |
| `3` | `PENDING_REVIEW` | Awaiting admin approval |
| `4` | `QUEUED_FOR_SETUP` | Approved, waiting for agent |
| `5` | `QUEUED_FOR_DELETE` | Marked for deletion |
| `6` | `SETUP_FAILED` | Agent setup failed |

## Error Codes

| Code | Description |
|------|-------------|
| `SESSION_EXISTS` | Duplicate session for this router |
| `SESSION_NOT_FOUND` | Session UUID not found |
| `INVALID_TOKEN` | JWT token invalid or expired |
| `RATE_LIMITED` | Too many requests |

## Rate Limits

| Route | Limit |
|-------|-------|
| Default | 60 requests/min |
