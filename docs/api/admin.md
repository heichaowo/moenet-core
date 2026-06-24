# Admin API

**Base URL:** `https://api.moenet.work`

Admin operations require admin privileges (verified via Telegram username).

```bash
Authorization: Bearer <admin-jwt-token>
```

## POST /admin

Multi-action endpoint for administrative operations.

### List Pending Sessions

```bash
curl -X POST https://api.moenet.work/admin \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action": "pending"}'
```

### Approve Session

```bash
curl -X POST https://api.moenet.work/admin \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action": "approve", "uuid": "session-uuid"}'
```

### Reject Session

```bash
curl -X POST https://api.moenet.work/admin \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "reject",
    "uuid": "session-uuid",
    "reason": "Invalid configuration"
  }'
```

### Block ASN

```bash
curl -X POST https://api.moenet.work/admin \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "block",
    "asn": 4242421080,
    "reason": "Policy violation"
  }'
```

### Unblock ASN

```bash
curl -X POST https://api.moenet.work/admin \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action": "unblock", "asn": 4242421080}'
```

## Rate Limits

| Route | Limit |
|-------|-------|
| `/admin` | 30 requests/min |

## Error Codes

| Code | Description |
|------|-------------|
| `NOT_ADMIN` | Admin privileges required |
| `SESSION_NOT_FOUND` | Session UUID not found |
| `ASN_BLOCKED` | ASN is already blocked |
