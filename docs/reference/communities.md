# BGP Communities

MoeNet uses BGP Large Communities (RFC 8092) to implement routing policies.

## Large Community Format

```
ASN : Function : Value
4242420998 : <function> : <value>
```

## Community Functions

### Region Tagging

Applied at ingress to mark where a route entered the network.

| Community | Meaning |
|-----------|---------|
| `(4242420998, 1, 1)` | Received in Asia Pacific |
| `(4242420998, 1, 2)` | Received in North America |
| `(4242420998, 1, 3)` | Received in Europe |

### Cold Potato Routing

Controls traffic egress point — keep traffic inside backbone as long as possible.

| Community | Meaning |
|-----------|---------|
| `(4242420998, 2, <nodeId>)` | Prefer exit via node `<nodeId>` |

### Latency Classification

Automatically applied based on RTT measurement.

| Community | Meaning |
|-----------|---------|
| `(4242420998, 3, 1)` | RTT < 10ms |
| `(4242420998, 3, 2)` | RTT 10–50ms |
| `(4242420998, 3, 3)` | RTT 50–100ms |
| `(4242420998, 3, 4)` | RTT > 100ms |

### Route Origin

Indicates how a route was learned.

| Community | Meaning |
|-----------|---------|
| `(4242420998, 4, 1)` | Learned via eBGP |
| `(4242420998, 4, 2)` | Learned via iBGP |
| `(4242420998, 4, 3)` | Originated locally |

## Standard Communities

MoeNet also supports DN42 standard communities:

| Community | Meaning |
|-----------|---------|
| `(64511, 1, <region>)` | DN42 region tag |
| `(64511, 2, <country>)` | DN42 country tag |

## Using Communities

### Check via Bot

```
/community
```

Shows the current community table.

### Check via BIRD

```bash
birdc show route all where bgp_large_community ~ [(4242420998, *, *)]
```
