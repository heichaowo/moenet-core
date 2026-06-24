import type { Context } from "hono";
import config from "../config";
import { getModels } from "../db/dbContext";

/**
 * Bootstrap Handler
 *
 * GET /bootstrap/:token - Returns installation script for node setup
 */
export default async function bootstrapHandler(c: Context): Promise<Response> {
	const token = c.req.param("token");

	if (!token) {
		return c.text("# Error: Missing bootstrap token\nexit 1", 400);
	}

	const models = getModels();
	const router = await models.routers.findOne({
		where: { bootstrapToken: token },
	});

	if (!router) {
		return c.text("# Error: Invalid or expired bootstrap token\nexit 1", 404);
	}

	const nodeId = router.get("nodeId") as number;
	const name = router.get("name") as string;
	const coreUrl = config.app.coreUrl || "https://api.moenet.work";
	const agentApiKey = config.auth.agentApiKey;
	const agentDownloadUrl =
		config.app.agentDownloadUrl ||
		"https://github.com/heichaowo/moenet-agent/releases/latest/download/moenet-agent-linux-amd64";
	const birdDownloadUrl =
		config.app.birdDownloadUrl ||
		"https://github.com/heichaowo/dn42-binaries/releases/latest/download/bird";
	const birdcDownloadUrl =
		config.app.birdcDownloadUrl ||
		"https://github.com/heichaowo/dn42-binaries/releases/latest/download/birdc";

	const script = `#!/bin/bash
set -e

# ============================================================================
# MoeNet DN42 Node Bootstrap Script
# Generated for: ${name} (node_id=${nodeId})
# ============================================================================

echo "=== MoeNet DN42 Node Bootstrap ==="
echo "Node: ${name} (ID: ${nodeId})"
echo ""

# Check if running as root
if [ "$(id -u)" != "0" ]; then
   echo "Error: This script must be run as root"
   exit 1
fi

# ============================================================================
# 1. Locale Configuration
# ============================================================================
echo "[1/7] Configuring locale..."
locale-gen en_US.UTF-8 || true
update-locale LANG=en_US.UTF-8 || true

# ============================================================================
# 2. Install Dependencies
# ============================================================================
echo "[2/7] Installing dependencies..."
apt-get update
apt-get install -y wireguard-tools iptables-persistent curl

# ============================================================================
# 3. Sysctl Configuration
# ============================================================================
echo "[3/7] Configuring kernel parameters..."
cat > /etc/sysctl.d/60-dn42.conf << 'SYSCTL_EOF'
# DN42 Required Settings
net.ipv4.conf.all.rp_filter=0
net.ipv4.conf.default.rp_filter=0
net.ipv4.conf.all.forwarding=1
net.ipv6.conf.all.forwarding=1
net.ipv4.conf.all.accept_local=1
net.ipv4.conf.default.accept_local=1

# Optimization for large routing tables
net.core.rmem_max=16777216
net.core.rmem_default=8388608
net.ipv4.route.max_size=8388608
net.ipv6.route.max_size=8388608
net.ipv4.neigh.default.gc_thresh1=1024
net.ipv4.neigh.default.gc_thresh2=4096
net.ipv4.neigh.default.gc_thresh3=8192
net.ipv6.neigh.default.gc_thresh1=1024
net.ipv6.neigh.default.gc_thresh2=4096
net.ipv6.neigh.default.gc_thresh3=8192
SYSCTL_EOF
sysctl -p /etc/sysctl.d/60-dn42.conf

# ============================================================================
# 4. Firewall Configuration
# ============================================================================
echo "[4/7] Configuring firewall..."

# IPv4 Rules
iptables -A INPUT -p tcp --dport 179 -j ACCEPT -m comment --comment "Allow DN42 BGP"
iptables -A INPUT -p udp --dport 51820:51829 -j ACCEPT -m comment --comment "Allow WireGuard Mesh"
iptables -A INPUT -p tcp --dport 24368 -j ACCEPT -m comment --comment "Allow Agent API (Token auth)"
iptables -A INPUT -p icmp --icmp-type echo-request -j ACCEPT -m comment --comment "Allow Ping"
iptables -A FORWARD -i dn42+ -o dn42+ -j ACCEPT -m comment --comment "Allow DN42 Forwarding"
iptables -A INPUT -i dn42+ -j ACCEPT -m comment --comment "Allow DN42 Inbound"
iptables -A INPUT -p tcp --dport 5479 -j ACCEPT -m comment --comment "Allow Bird-LG-Proxy"

# IPv6 Rules
ip6tables -A INPUT -p tcp --dport 179 -j ACCEPT -m comment --comment "Allow DN42 BGP IPv6"
ip6tables -A INPUT -p udp --dport 51820:51829 -j ACCEPT -m comment --comment "Allow WireGuard Mesh IPv6"
ip6tables -A INPUT -p tcp --dport 24368 -j ACCEPT -m comment --comment "Allow Agent API IPv6 (Token auth)"
ip6tables -A INPUT -p icmpv6 -j ACCEPT -m comment --comment "Allow ICMPv6"
ip6tables -A FORWARD -i dn42+ -o dn42+ -j ACCEPT -m comment --comment "Allow DN42 Forwarding IPv6"

netfilter-persistent save

# ============================================================================
# 5. Loopback (dummy0) Interface
# ============================================================================
echo "[5/7] Setting up loopback interface..."
modprobe dummy
echo dummy > /etc/modules-load.d/dummy.conf
ip link add dummy0 type dummy 2>/dev/null || true
ip link set dummy0 up

mkdir -p /etc/systemd/network
cat > /etc/systemd/network/10-dummy0.netdev << 'NETDEV_EOF'
[NetDev]
Name=dummy0
Kind=dummy
NETDEV_EOF

cat > /etc/systemd/network/10-dummy0.network << 'NETWORK_EOF'
[Match]
Name=dummy0

[Link]
RequiredForOnline=no
# NOTE: IP addresses are configured by moenet-agent based on node_id
NETWORK_EOF

systemctl restart systemd-networkd || true

# ============================================================================
# 6. WireGuard Setup
# ============================================================================
echo "[6/7] Setting up WireGuard..."
mkdir -p /etc/wireguard
chmod 700 /etc/wireguard

if [ ! -f /etc/wireguard/private.key ]; then
    wg genkey > /etc/wireguard/private.key
    chmod 600 /etc/wireguard/private.key
    echo "Generated new WireGuard private key"
else
    echo "Using existing WireGuard private key"
fi

wg pubkey < /etc/wireguard/private.key > /etc/wireguard/public.key
echo "WireGuard public key: $(cat /etc/wireguard/public.key)"

# ============================================================================
# 7. BIRD3 & Agent Installation
# ============================================================================
echo "[7/7] Installing BIRD3 and Agent..."

# Create bird user
useradd -r -s /usr/sbin/nologin bird 2>/dev/null || true

# Clean old configs and create directories
rm -rf /etc/bird/peers/* /etc/bird/ibgp.d/* 2>/dev/null || true
mkdir -p /etc/bird/peers /etc/bird/ibgp.d /var/run/bird/run
chown -R bird:bird /etc/bird /var/run/bird

# Stop existing services to avoid "Text file busy" error
systemctl stop bird 2>/dev/null || true
systemctl stop moenet-agent 2>/dev/null || true

# Download BIRD3
curl -L "${birdDownloadUrl}" -o /usr/sbin/bird
chmod +x /usr/sbin/bird
curl -L "${birdcDownloadUrl}" -o /usr/sbin/birdc
chmod +x /usr/sbin/birdc

# Create bird systemd service
cat > /etc/systemd/system/bird.service << 'BIRD_EOF'
[Unit]
Description=BIRD Internet Routing Daemon
After=network.target

[Service]
Type=forking
ExecStart=/usr/sbin/bird -c /etc/bird/bird.conf
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
User=root

[Install]
WantedBy=multi-user.target
BIRD_EOF

# Create minimal bird.conf for bootstrap (agent will sync full config later)
cat > /etc/bird/bird.conf << 'BIRD_CONF_EOF'
# MoeNet DN42 Bootstrap Configuration
# Full config will be synced by agent

log syslog all;
router id 172.22.188.${nodeId};

protocol device {
    scan time 10;
}

protocol direct direct1 {
    ipv4;
    ipv6;
    interface "dn42*", "dummy0", "lo";
}

# Static routes for our prefixes
protocol static static_v4 {
    ipv4;
    route 172.22.188.0/26 unreachable;
}

protocol static static_v6 {
    ipv6;
    route fd00:4242:7777::/48 unreachable;
}

# Kernel protocol
protocol kernel kernel1 {
    ipv4 {
        export filter {
            if dest = RTD_UNREACHABLE then reject;
            if net ~ [ 172.16.0.0/12+, 10.0.0.0/8+ ] then {
                krt_prefsrc = 172.22.188.${nodeId};
                accept;
            }
            reject;
        };
        import filter {
            if net ~ [ 172.16.0.0/12+, 10.0.0.0/8+ ] then accept;
            reject;
        };
    };
}

protocol kernel kernel2 {
    ipv6 {
        export filter {
            if dest = RTD_UNREACHABLE then reject;
            if net ~ [ fd00::/8+ ] then {
                krt_prefsrc = fd00:4242:7777::${nodeId};
                accept;
            }
            reject;
        };
        import filter {
            if net ~ [ fd00::/8+ ] then accept;
            reject;
        };
    };
}

# Peer configurations (empty for bootstrap)
include "/etc/bird/peers/*.conf";
include "/etc/bird/ibgp.d/*.conf";
BIRD_CONF_EOF

# Create empty include files to prevent BIRD errors
touch /etc/bird/peers/.keep
touch /etc/bird/ibgp.d/.keep
chown -R root:root /etc/bird

# Download Agent
mkdir -p /opt/moenet-agent
curl -L "${agentDownloadUrl}" -o /opt/moenet-agent/moenet-agent
chmod +x /opt/moenet-agent/moenet-agent

# Create agent config
cat > /opt/moenet-agent/config.json << 'AGENT_EOF'
{
  "bootstrap": {
    "apiUrl": "${coreUrl}",
    "nodeName": "${name}",
    "token": "${agentApiKey}"
  },
  "server": {
    "listen": ":24368"
  }
}
AGENT_EOF

# Create agent systemd service
cat > /etc/systemd/system/moenet-agent.service << 'AGENT_SERVICE_EOF'
[Unit]
Description=MoeNet Agent
After=network.target bird.service
Requires=bird.service

[Service]
Type=simple
WorkingDirectory=/opt/moenet-agent
ExecStart=/opt/moenet-agent/moenet-agent
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
AGENT_SERVICE_EOF

systemctl daemon-reload

# Start BIRD first
echo ""
echo "=== Starting BIRD ==="
systemctl enable bird
systemctl start bird
sleep 2

# Verify BIRD is running
if ! birdc show status > /dev/null 2>&1; then
    echo "Warning: BIRD may not be fully started yet"
fi

# Enable and start agent
echo ""
echo "=== Starting Agent ==="
systemctl enable moenet-agent
systemctl start moenet-agent

echo ""
echo "=== Bootstrap Complete ==="
echo "Node: ${name} (ID: ${nodeId})"
echo "Loopback IPv4: 172.22.188.${nodeId}"
echo "Loopback IPv6: fd00:4242:7777::${nodeId}"
echo ""
echo "Services started. Check logs with:"
echo "  journalctl -u bird -f"
echo "  journalctl -u moenet-agent -f"
echo ""
`;

	return c.text(script, 200, {
		"Content-Type": "text/x-shellscript",
	});
}
