# Getting Started

## For Users — Peering via Telegram Bot

The easiest way to peer with MoeNet on DN42 is through the Telegram Bot.

### Prerequisites

- A registered [DN42](https://dn42.dev) AS number
- Authentication credential registered in DN42 registry (GPG key, SSH key, or email)
- A server with WireGuard installed

### Step 1: Login

Open [@moenet_dn42_bot](https://t.me/moenet_dn42_bot) and authenticate:

```
/login 4242421080
```

The bot will ask you to choose an authentication method:
- **GPG** — Sign a challenge with your registered GPG key
- **SSH** — Sign a challenge with your SSH key
- **Email** — Receive a one-time code at your registered email

### Step 2: Create Peer

```
/peer
```

The peer creation wizard guides you through:

1. **Select node** — Choose the nearest MoeNet node
2. **WireGuard endpoint** — Your server's public IP and port
3. **WireGuard public key** — Your WireGuard public key
4. **IPv6 address** — Your DN42 IPv6 address
5. **Link-local** — Your link-local IPv6 address
6. **MTU** — Tunnel MTU (default: 1420)

### Step 3: Configure Your Side

After admin approval, the bot sends you the server-side details:

```
✅ Peer approved!

Server endpoint: jp.moenet.work:24001
Server public key: ABC123...
Server link-local: fe80::998:1
```

Configure your WireGuard interface and BIRD accordingly.

### Step 4: Verify

```
/status
```

Check that your WireGuard tunnel is up and BGP session is established.

## For Operators — Deploying a Node

### Bootstrap Mode (Recommended)

1. **Add node** via Telegram Bot (admin only):
   ```
   /addnode
   ```
   Follow the wizard to register node name, location, and public IP.

2. **Generate bootstrap script**:
   ```
   /bootstrap <node-name>
   ```

3. **Run on your server**:
   ```bash
   curl -fsSL "https://api.moenet.work/bootstrap/YOUR_TOKEN" | bash
   ```

The bootstrap script:
- Downloads the latest `moenet-agent` binary
- Creates systemd service
- Writes initial config with Control Plane token
- Starts the agent (auto-connects and self-configures)

### Manual Installation

```bash
# Download latest release
curl -L -o /opt/moenet-agent/moenet-agent \
  https://github.com/heichaowo/moenet-agent/releases/latest/download/moenet-agent-linux-amd64
chmod +x /opt/moenet-agent/moenet-agent

# Create config
cat > /etc/moenet-agent/config.json << 'EOF'
{
  "controlPlane": {
    "url": "https://api.moenet.work",
    "token": "your-agent-token"
  },
  "server": {
    "listen": ":24368"
  }
}
EOF

# Start
systemctl enable --now moenet-agent
```

## Useful Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/info` | View your current peers |
| `/modify` | Change peer settings (endpoint, MTU) |
| `/remove` | Delete a peer |
| `/restart` | Restart WireGuard tunnel |
| `/ping <target>` | Ping from MoeNet nodes |
| `/trace <target>` | Traceroute from nodes |
| `/whois <query>` | DN42 WHOIS lookup |
| `/route <prefix>` | BGP route lookup |
