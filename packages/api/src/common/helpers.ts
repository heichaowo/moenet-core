import { timingSafeEqual } from "node:crypto";
import * as bcrypt from "bcrypt";

/**
 * Hash a string with bcrypt
 */
export async function bcryptHash(value: string, rounds = 10): Promise<string> {
	return bcrypt.hash(value, rounds);
}

/**
 * Compare a string with bcrypt hash
 */
export async function bcryptCompare(
	value: string,
	hash: string,
): Promise<boolean> {
	return bcrypt.compare(value, hash);
}

/**
 * Generate a random UUID
 */
export function generateUUID(): string {
	return crypto.randomUUID();
}

/**
 * Parse JSON extensions safely
 */
export function parseExtensions(extensions: string | null): string[] {
	if (!extensions) return [];
	try {
		return JSON.parse(extensions);
	} catch {
		return [];
	}
}

/**
 * Calculate WireGuard interface name from ASN
 */
export function getInterfaceName(asn: number): string {
	return `dn42_${asn}`;
}

/**
 * Calculate WireGuard listen port from ASN
 * Convention: 30000 + (ASN % 10000)
 */
export function getListenPort(asn: number): number {
	return 30000 + (asn % 10000);
}

/**
 * Extract region from router name (e.g., "hk-edge" -> "hk")
 */
export function extractRegion(routerName: string): string {
	const parts = routerName.split("-");
	return parts[0] || routerName;
}

/**
 * Timing-safe string comparison to prevent timing attacks on token/secret comparison.
 * Returns false if lengths differ (constant-time for equal-length strings).
 */
export function timingSafeCompare(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
