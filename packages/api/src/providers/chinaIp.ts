/**
 * China IP Detection Service
 *
 * Fetches and maintains China IP ranges for peer rejection.
 * Uses CIDR matching for efficient IP detection.
 *
 * Sources:
 * - IPv4: https://raw.githubusercontent.com/metowolf/iplist/master/data/special/china.txt
 * - IPv6: https://raw.githubusercontent.com/bingxin666/china-ip-list/master/chnroute_v6.txt
 */

import { Address4, Address6 } from "ip-address";

// IP list sources
const IPV4_SOURCE =
	"https://raw.githubusercontent.com/metowolf/iplist/master/data/special/china.txt";
const IPV6_SOURCE =
	"https://raw.githubusercontent.com/bingxin666/china-ip-list/master/chnroute_v6.txt";

// Update interval (4 hours in ms)
const UPDATE_INTERVAL = 4 * 60 * 60 * 1000;

// Cache
let chinaIPv4: string[] = [];
let chinaIPv6: string[] = [];
const whitelist: string[] = [];
let lastUpdate = 0;
let isUpdating = false;

/**
 * Fetch and update China IP ranges from external sources.
 */
export async function updateChinaIPLists(): Promise<boolean> {
	if (isUpdating) return false;
	isUpdating = true;

	try {
		// Fetch IPv4 list
		try {
			const ipv4Resp = await fetch(IPV4_SOURCE);
			if (ipv4Resp.ok) {
				const text = await ipv4Resp.text();
				chinaIPv4 = text
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line && !line.startsWith("#"));
				console.log(`[ChinaIP] Loaded ${chinaIPv4.length} IPv4 ranges`);
			}
		} catch (e) {
			console.warn("[ChinaIP] Failed to fetch IPv4 list:", e);
		}

		// Fetch IPv6 list
		try {
			const ipv6Resp = await fetch(IPV6_SOURCE);
			if (ipv6Resp.ok) {
				const text = await ipv6Resp.text();
				chinaIPv6 = text
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line && !line.startsWith("#"));
				console.log(`[ChinaIP] Loaded ${chinaIPv6.length} IPv6 ranges`);
			}
		} catch (e) {
			console.warn("[ChinaIP] Failed to fetch IPv6 list:", e);
		}

		lastUpdate = Date.now();
		return true;
	} catch (e) {
		console.error("[ChinaIP] Failed to update IP lists:", e);
		return false;
	} finally {
		isUpdating = false;
	}
}

/**
 * Check if an IP address is from China.
 *
 * @param ip - IP address string (IPv4 or IPv6)
 * @returns true if IP is from China (and not in whitelist)
 */
export function isChinaIP(ip: string): boolean {
	// Trigger update if needed
	if (
		Date.now() - lastUpdate > UPDATE_INTERVAL ||
		(chinaIPv4.length === 0 && chinaIPv6.length === 0)
	) {
		// Fire and forget - don't block
		updateChinaIPLists();
	}

	try {
		// Check whitelist first
		if (whitelist.length > 0 && isInCIDRList(ip, whitelist)) {
			return false;
		}

		// Determine IP version and check
		if (ip.includes(":")) {
			return isInCIDRList(ip, chinaIPv6);
		} else {
			return isInCIDRList(ip, chinaIPv4);
		}
	} catch (e) {
		console.warn(`[ChinaIP] Invalid IP address: ${ip}`, e);
		return false;
	}
}

/**
 * Check if an IP is in a list of CIDR ranges.
 */
function isInCIDRList(ip: string, cidrList: string[]): boolean {
	try {
		if (ip.includes(":")) {
			// IPv6
			let addr: Address6;
			try {
				addr = new Address6(ip);
			} catch {
				return false; // Invalid IP
			}

			for (const cidr of cidrList) {
				try {
					const network = new Address6(cidr);
					if (addr.isInSubnet(network)) {
						return true;
					}
				} catch {
					// Skip invalid CIDR
				}
			}
		} else {
			// IPv4
			let addr: Address4;
			try {
				addr = new Address4(ip);
			} catch {
				return false; // Invalid IP
			}

			for (const cidr of cidrList) {
				try {
					const network = new Address4(cidr);
					if (addr.isInSubnet(network)) {
						return true;
					}
				} catch {
					// Skip invalid CIDR
				}
			}
		}
	} catch {
		return false;
	}

	return false;
}

/**
 * Add IP or network to whitelist.
 */
export function addWhitelist(ipOrNetwork: string): boolean {
	try {
		whitelist.push(ipOrNetwork);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve domain to IP address.
 *
 * @param endpoint - Domain name or IP address (may include port)
 * @returns IP address string or null
 */
export async function resolveEndpoint(
	endpoint: string,
): Promise<string | null> {
	// Remove port if present
	let host = endpoint;

	if (host.includes(":") && !host.startsWith("[")) {
		// IPv4 with port - split always returns at least one element
		host = host.split(":")[0] as string;
	} else if (host.startsWith("[")) {
		// IPv6 with port like [::1]:8080
		host = (host.split("]")[0] ?? "").replace("[", "");
	}

	// Check if already an IP
	try {
		new Address4(host);
		return host; // Was parsed successfully, it's an IP
	} catch {
		// Not an IPv4
	}

	try {
		new Address6(host);
		return host; // Was parsed successfully, it's an IP
	} catch {
		// Not an IPv6
	}

	// Resolve domain using native DNS
	try {
		const dns = await import("node:dns/promises");
		const results = await dns.lookup(host);
		if (results?.address) {
			return results.address;
		}
	} catch (e) {
		console.warn(`[ChinaIP] Failed to resolve ${host}:`, e);
	}

	return null;
}

/**
 * Get cache stats for debugging.
 */
export function getCacheStats() {
	return {
		ipv4Count: chinaIPv4.length,
		ipv6Count: chinaIPv6.length,
		whitelistCount: whitelist.length,
		lastUpdate: lastUpdate ? new Date(lastUpdate).toISOString() : "never",
		isStale: Date.now() - lastUpdate > UPDATE_INTERVAL,
	};
}

/**
 * Error message for CN peer rejection.
 */
export const CN_REJECTION_MESSAGE = `❌ Peering with Chinese Mainland is not allowed on this node
该节点不允许与中国大陆 Peer

Please note that do NOT try to bypass this restriction.
Your data will be dropped by the firewall.
请注意，不要尝试绕过该限制，你的数据会被防火墙丢弃。

If you believe this is an error, please contact @HeiCha
如果您认为这是个错误，请联系 @HeiCha`;

// Initialize on import
updateChinaIPLists().catch(() => {});
