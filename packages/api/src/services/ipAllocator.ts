/**
 * MoeNet IP Allocator Service
 *
 * Calculates loopback IP addresses and allocates node IDs with
 * continent-aware range enforcement.
 *
 * IP Allocation:
 * - IPv4: 172.22.188.{node_id}
 * - IPv6: fd00:4242:7777:{region_code}:{node_id}::1
 * - LLA:  fe80::998:{region_code}:{node_id}:1
 *
 * Node ID Ranges (per continent):
 * - Asia (AS):          1–13
 * - North America (NA): 14–26
 * - Europe (EU):        27–39
 * - Oceania/Other (OC): 40–52
 */

// ── Network Constants ──────────────────────────────────────────────

export const IPV4_PREFIX = "172.22.188";
export const IPV6_PREFIX = "fd00:4242:7777";

// ── Continent Ranges ───────────────────────────────────────────────

/**
 * Node ID ranges per continent.
 * Each continent is allocated a contiguous block of IDs.
 */
export const CONTINENT_RANGES: Record<string, [start: number, end: number]> = {
	AS: [1, 13], // Asia
	NA: [14, 26], // North America
	EU: [27, 39], // Europe
	OC: [40, 52], // Oceania / Other
};

// ── Region Mapping ─────────────────────────────────────────────────

/**
 * Map a numeric regionCode (1xx, 2xx, …) to its continent key.
 *
 * @param regionCode - RegionCode stored on the router (e.g. 101, 301)
 * @returns Continent key (AS, NA, EU, OC)
 */
export function getContinentFromRegionCode(regionCode: number): string {
	const continent = Math.floor(regionCode / 100);
	const map: Record<number, string> = {
		1: "AS",
		2: "NA",
		3: "EU",
		4: "OC",
		5: "OC", // Africa / Middle East → "Other" bucket
	};
	return map[continent] || "AS";
}

// ── Loopback IP Computation ────────────────────────────────────────

/**
 * Compute loopback IPv4 address from nodeId.
 *
 * @param nodeId - The node's unique ID
 * @returns IPv4 string, e.g. "172.22.188.4"
 */
export function computeLoopbackIPv4(nodeId: number): string {
	if (!nodeId) return "";
	return `${IPV4_PREFIX}.${nodeId}`;
}

/**
 * Compute loopback IPv6 address from regionCode and nodeId.
 *
 * @param regionCode - Region code (e.g. 101 for AS-E)
 * @param nodeId     - The node's unique ID
 * @returns IPv6 string, e.g. "fd00:4242:7777:101:4::1"
 */
export function computeLoopbackIPv6(
	regionCode: number,
	nodeId: number,
): string {
	if (!regionCode || !nodeId) return "";
	return `${IPV6_PREFIX}:${regionCode}:${nodeId}::1`;
}

/**
 * Derive link-local address from regionCode and nodeId.
 *
 * @param regionCode - Region code
 * @param nodeId     - Node ID
 * @returns LLA string, e.g. "fe80::998:101:4:1"
 */
export function deriveLLA(regionCode: number, nodeId: number): string {
	if (!regionCode || !nodeId) return "fe80::998:0:0:1";
	return `fe80::998:${regionCode}:${nodeId}:1`;
}

/**
 * Derive link-local address from a loopback IPv6 string.
 * Kept for backward compatibility with code that only has the loopback string.
 *
 * @param loopback - Loopback IPv6 string, e.g. "fd00:4242:7777:101:4::1"
 * @returns LLA string
 */
export function deriveLLAFromLoopback(loopback: string): string {
	if (!loopback) return "fe80::998:0:0:1";
	const parts = loopback.split(":");
	if (parts.length < 5) return "fe80::998:0:0:1";
	const region = parts[3] || "0";
	const nodeId = parts[4] || "0";
	return `fe80::998:${region}:${nodeId}:1`;
}

// ── Node ID Allocation ─────────────────────────────────────────────

/**
 * Get the next available node ID for a continent, filling gaps.
 *
 * Scans the continent's reserved range and returns the first unused ID.
 * Returns `null` if the range is exhausted.
 *
 * @param continent   - Continent key (AS, NA, EU, OC)
 * @param existingIds - Array of node IDs already in use (all continents)
 * @returns Next available node ID, or null if full
 */
export function getNextAvailableNodeId(
	continent: string,
	existingIds: number[],
): number | null {
	const range = CONTINENT_RANGES[continent];
	if (!range) return null;

	const [start, end] = range;
	const usedSet = new Set(existingIds);

	for (let id = start; id <= end; id++) {
		if (!usedSet.has(id)) {
			return id;
		}
	}

	return null; // Range is full
}

/**
 * Validate that a node ID falls within the correct range for its continent.
 *
 * @param nodeId    - Node ID to validate
 * @param continent - Expected continent key
 * @returns Validation result with boolean and message
 */
export function validateNodeId(
	nodeId: number,
	continent: string,
): { valid: boolean; message: string } {
	const range = CONTINENT_RANGES[continent];
	if (!range) {
		return { valid: false, message: `Unknown continent: ${continent}` };
	}

	const [start, end] = range;
	if (nodeId < start || nodeId > end) {
		return {
			valid: false,
			message: `Node ID ${nodeId} out of range for ${continent} (${start}–${end})`,
		};
	}

	return { valid: true, message: "OK" };
}

/**
 * Get the continent that owns a given node ID based on the range tables.
 *
 * @param nodeId - Node ID to look up
 * @returns Continent key, or "AS" as fallback
 */
export function getContinentFromNodeId(nodeId: number): string {
	for (const [continent, [start, end]] of Object.entries(CONTINENT_RANGES)) {
		if (nodeId >= start && nodeId <= end) {
			return continent;
		}
	}
	return "AS"; // Default fallback
}
