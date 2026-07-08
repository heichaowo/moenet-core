# API Contract (drift triage)

Single source of truth for the JSON shapes exchanged between the **Control
Plane / bot** (TypeScript, this repo) and the **agent** (Go,
[`moenet-agent`](https://github.com/heichaowo/moenet-agent)).

These are two separate servers; there are two specs:

| Spec | Server | Client | Covers |
|------|--------|--------|--------|
| [`agent-api.openapi.yaml`](./agent-api.openapi.yaml) | agent (`:24368`) | bot / CP | `/ping` `/tcping` `/trace` `/route` `/path` `/dig`, `/community`, `/probe/now` `/probe/stats` |
| [`cp-agent-api.openapi.yaml`](./cp-agent-api.openapi.yaml) | CP (`/api/v1/agent/{router}`) | agent | `/bird-config` (more to add) |

## Why this exists

Every drift bug we've hit came from the two sides describing the same JSON
differently, in different languages, with nothing checking them:

- **`dn42As`** — CP sent it as a JSON *number* (BIGINT column); the agent's
  struct wants a *string* → decode failed, bird-config sync silently broke fleet-wide.
- **`/community`** response, **`serverEndpoint`**, **`/dig`** (endpoint existed
  on one side only), **probe** shapes — same class.

A spec both sides generate from turns these into compile-time errors.

## Codegen

**TypeScript (this repo)** — generate types and check calls against them:

```bash
bunx openapi-typescript contract/agent-api.openapi.yaml   -o packages/bot/src/generated/agent-api.d.ts
bunx openapi-typescript contract/cp-agent-api.openapi.yaml -o packages/api/src/generated/agent-config.d.ts
```

**Go (moenet-agent)** — generate structs (models only):

```bash
go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@latest \
  -generate types -package apicontract \
  -o internal/apicontract/agent_api.gen.go  contract/agent-api.openapi.yaml
```

Then replace the hand-written `ToolResponse`, `BirdPolicy`, `CommunityStats`,
`ProbeResult`, … with the generated types (or assert against them in a test).

## Keeping the two repos in sync (until we monorepo)

The specs live here (the CP is the hub); this branch (`dev`) is the source of
truth. **This is now automated** via the vendored-copy + drift-check approach:

- `moenet-agent` vendors copies under its own `contract/` and codegens Go types
  from them (`go generate ./internal/apicontract/`).
- Its **Contract sync** CI job fails if those copies differ from
  `moenet-core@dev` here, or if the generated types are stale.
- To re-sync after changing a spec here: run `scripts/sync-contract.sh` in
  `moenet-agent` (re-fetches the specs + regenerates) and commit.

When core + agent become a monorepo, `contract/` moves to the repo root and both
subtrees codegen from it directly — no vendoring, no drift check needed.

## Validate the spec

```bash
bunx @redocly/cli lint contract/agent-api.openapi.yaml contract/cp-agent-api.openapi.yaml
```

## Status

Triage stage — the specs cover the endpoints that have actually drifted, not the
full surface. Expand `cp-agent-api.openapi.yaml` (`/config`, `/mesh`,
`/heartbeat`, `/modify`, `/rtt`, `/report`) as those are formalised.
