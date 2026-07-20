/**
 * Node Provider - Fetches node configuration from API
 *
 * Replaces static AGENT_HOSTS and NODE_NAMES env vars with
 * dynamic configuration from the control plane database.
 */

import config from "../config";

export interface RouterInfo {
	uuid: string;
	name: string;
	location: string;
	callbackUrl?: string;
	ipv4?: string;
	ipv6?: string;
	isOpen: boolean;
	sessionCount?: number;
}

interface ApiResponse {
	code: number;
	message: string;
	data?: {
		routers?: RouterInfo[];
	};
}

// Cached node data
let cachedNodes: Map<string, RouterInfo> = new Map();
let lastFetch = 0;
const CACHE_TTL = 60 * 1000; // 1 minute cache

/**
 * Fetch nodes from API
 */
async function fetchNodes(): Promise<Map<string, RouterInfo>> {
	try {
		const response = await fetch(`${config.apiUrl}/admin`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiToken}`,
			},
			body: JSON.stringify({ action: "enumRouters" }),
		});

		const result = (await response.json()) as ApiResponse;

		if (result.code !== 0 || !result.data?.routers) {
			console.error("[NodeProvider] Failed to fetch nodes:", result.message);
			return cachedNodes;
		}

		const nodes = new Map<string, RouterInfo>();
		for (const router of result.data.routers) {
			// Map API response fields to RouterInfo interface
			const routerInfo: RouterInfo = {
				uuid: router.uuid,
				name: router.name,
				location: router.location,
				callbackUrl: router.callbackUrl,
				ipv4: (router as unknown as { publicIp?: string }).publicIp,
				ipv6: (router as unknown as { publicIpv6?: string }).publicIpv6,
				isOpen: router.isOpen,
				sessionCount: router.sessionCount,
			};
			nodes.set(router.name, routerInfo);
		}

		cachedNodes = nodes;
		lastFetch = Date.now();

		console.log(`[NodeProvider] Loaded ${nodes.size} nodes from API`);
		return nodes;
	} catch (error) {
		console.error("[NodeProvider] Error fetching nodes:", error);
		return cachedNodes;
	}
}

/**
 * Get all nodes (with caching)
 */
export async function getNodes(): Promise<Map<string, RouterInfo>> {
	if (Date.now() - lastFetch > CACHE_TTL || cachedNodes.size === 0) {
		await fetchNodes();
	}
	return cachedNodes;
}

/**
 * Get node by name
 */
export async function getNode(name: string): Promise<RouterInfo | undefined> {
	const nodes = await getNodes();
	return nodes.get(name);
}

/**
 * Get node names for display (keyboard buttons)
 */
export async function getNodeNames(): Promise<Record<string, string>> {
	const nodes = await getNodes();
	const names: Record<string, string> = {};

	for (const [key, node] of nodes) {
		// Use location as display name, fallback to node name
		names[key] = node.location || key;
	}

	return names;
}

/**
 * Get agent endpoint for a node
 */
export async function getAgentEndpoint(
	nodeName: string,
): Promise<string | null> {
	const node = await getNode(nodeName);

	if (!node) {
		console.warn(`[NodeProvider] Node not found: ${nodeName}`);
		return null;
	}

	// Use callbackUrl if available, otherwise try IP
	if (node.callbackUrl) {
		return node.callbackUrl;
	}

	// Fallback to IPv4/IPv6 with default port
	const host = node.ipv4 || node.ipv6;
	if (host) {
		return `http://${host}:${config.agentPort}`;
	}

	return null;
}

/**
 * Get open nodes (for peer creation)
 */
export async function getOpenNodes(): Promise<RouterInfo[]> {
	const nodes = await getNodes();
	return Array.from(nodes.values()).filter((n) => n.isOpen);
}

/**
 * Refresh nodes cache
 */
export async function refreshNodes(): Promise<void> {
	lastFetch = 0;
	await fetchNodes();
}

/**
 * Get all node names as array
 */
export async function getAllNodes(): Promise<string[]> {
	const nodes = await getNodes();
	return Array.from(nodes.keys());
}
