# Security Policy

MoeNet is a live [DN42](https://dn42.dev) network (AS4242420998): a control
plane (this repo — HTTP API + Telegram bot) plus an agent that runs on every
node and configures BIRD and WireGuard. A single flaw can therefore affect the
whole fleet, so we take reports seriously and would rather hear about a problem
early.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report privately through GitHub:

1. Go to the **Security** tab → **Report a vulnerability** (GitHub private
   vulnerability reporting).
2. If that is unavailable, email **noc@asn.moe** with `SECURITY` in the
   subject.

Please include:

- what the issue is and where (endpoint, command, file, or node behaviour),
- steps to reproduce, or a proof of concept,
- the impact you think it has, and
- any suggested fix, if you have one.

We aim to acknowledge a report within **72 hours** and to keep you updated as
we investigate. This is a small, volunteer-run network — timelines are
best-effort, not contractual.

## Scope

**In scope** (this repo and the agent it drives):

- authentication/authorization on the control-plane API, including the
  control-plane ↔ agent channel (`AGENT_API_KEY`) and the rendered BIRD policy,
- Telegram bot command authorization (a normal peer reaching admin-only
  actions, acting on another peer's session, etc.),
- the node agent's HTTP endpoints and its **auto-update** path — a poisoned or
  spoofed release reaches every node within an hour,
- injection, SSRF, path traversal, or secret disclosure in either component,
- exposure of secrets (tokens, WireGuard keys, credentials) via the API, bot,
  logs, or images.

**Out of scope:**

- the infrastructure of DN42 peers or of DN42 itself,
- volumetric denial of service (DN42 is an experimental network),
- social engineering, physical access, or spam/abuse of the bot,
- findings that require an already-compromised node or the control-plane host,
- missing hardening with no demonstrated impact (e.g. a header preference).

## Supported versions

Only the **latest released version** is supported; production runs a pinned
release and fixes ship forward. There are no backports to older tags.

## Safe harbor

We will not pursue or support action against good-faith research that follows
this policy: report privately, don't access or modify data that isn't yours,
don't degrade the network, and give us reasonable time to remediate before any
disclosure. If in doubt about whether an action is in scope, ask first via the
private report.
