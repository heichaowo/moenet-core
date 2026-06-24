---
layout: home

hero:
  name: MoeNet DN42
  text: Network Documentation
  tagline: Automated BGP Peering on DN42 — Control Plane & Agent
  actions:
    - theme: brand
      text: Get Started
      link: /guide/overview
    - theme: alt
      text: API Reference
      link: /api/authentication
    - theme: alt
      text: Code Docs (DeepWiki)
      link: https://deepwiki.com/heichaowo/moenet-core

features:
  - icon: 🤖
    title: Telegram Bot
    details: Full peering lifecycle via @moenet_dn42_bot — login, create peers, check status, network tools.
  - icon: 🔗
    title: Automated BGP
    details: WireGuard tunnels and BIRD 3.x configuration managed automatically by distributed agents.
  - icon: 🌐
    title: Mesh IGP
    details: WireGuard-based underlay with Babel routing for internal backbone connectivity.
  - icon: 📊
    title: Observability
    details: Real-time RTT metrics, route statistics, and Prometheus monitoring across all nodes.
  - icon: 🔒
    title: Multi-Auth
    details: GPG, SSH, or Email verification against DN42 registry for secure peering.
  - icon: ⚡
    title: Bootstrap Deploy
    details: One-command node setup — curl a token URL and the agent self-configures.
---

## Architecture

```mermaid
graph TB
    Users["👤 Users (Telegram)"] --> Bot["🤖 Telegram Bot<br/>grammY + Hono"]
    Bot --> API["🌐 Control Plane API<br/>Hono.js + Bun"]
    API --> PG[("🐘 PostgreSQL")]
    API --> Redis[("⚡ Redis")]
    API --> Agent1["📡 Agent jp1<br/>Go + BIRD 3"]
    API --> Agent2["📡 Agent hk1<br/>Go + BIRD 3"]
    API --> Agent3["📡 Agent us1<br/>Go + BIRD 3"]
    Agent1 <--> |"WireGuard Mesh"| Agent2
    Agent2 <--> |"WireGuard Mesh"| Agent3
    Agent1 <--> |"WireGuard Mesh"| Agent3
```
