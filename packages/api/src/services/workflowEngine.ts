/**
 * Workflow Engine — Peer approval state machine.
 *
 * Validates status transitions and provides auto-approve/blacklist logic.
 * Based on the iedon-style session lifecycle from the old Python WorkflowEngine.
 *
 * State diagram:
 *   PENDING_REVIEW → QUEUED_FOR_SETUP (approve) | REJECTED (reject)
 *   QUEUED_FOR_SETUP → ENABLED (agent ok) | PROBLEM (agent fail) | TEARDOWN
 *   ENABLED → QUEUED_FOR_DELETE | PROBLEM | DISABLED | QUEUED_FOR_SETUP (re-deploy)
 *   PROBLEM → ENABLED (recover) | QUEUED_FOR_DELETE | TEARDOWN
 *   QUEUED_FOR_DELETE → DISABLED (agent confirms)
 *   DISABLED → QUEUED_FOR_SETUP (re-enable)
 *   REJECTED → (terminal)
 *   TEARDOWN → DISABLED
 */

import { getModels } from "../db/dbContext";
import { PeeringStatus } from "../db/models/bgpSessions";

const WHITELIST_KEY = "asn_whitelist";
const BLOCKLIST_KEY = "asn_blocklist";

/** Valid state transitions */
const VALID_TRANSITIONS: Record<number, Set<number>> = {
	[PeeringStatus.PENDING_REVIEW]: new Set([
		PeeringStatus.QUEUED_FOR_SETUP,
		PeeringStatus.REJECTED,
	]),
	[PeeringStatus.QUEUED_FOR_SETUP]: new Set([
		PeeringStatus.ENABLED,
		PeeringStatus.PROBLEM,
		PeeringStatus.TEARDOWN,
	]),
	[PeeringStatus.ENABLED]: new Set([
		PeeringStatus.QUEUED_FOR_DELETE,
		PeeringStatus.PROBLEM,
		PeeringStatus.DISABLED,
		PeeringStatus.QUEUED_FOR_SETUP,
	]),
	[PeeringStatus.PROBLEM]: new Set([
		PeeringStatus.ENABLED,
		PeeringStatus.QUEUED_FOR_DELETE,
		PeeringStatus.TEARDOWN,
	]),
	[PeeringStatus.QUEUED_FOR_DELETE]: new Set([PeeringStatus.DISABLED]),
	[PeeringStatus.DISABLED]: new Set([PeeringStatus.QUEUED_FOR_SETUP]),
	[PeeringStatus.REJECTED]: new Set([]),
	[PeeringStatus.TEARDOWN]: new Set([PeeringStatus.DISABLED]),
};

/**
 * Check if a status transition is valid.
 *
 * @param from - Current status
 * @param to - Target status
 * @returns true if the transition is allowed
 */
export function canTransition(from: PeeringStatus, to: PeeringStatus): boolean {
	const allowed = VALID_TRANSITIONS[from];
	if (!allowed) return false;
	return allowed.has(to);
}

/**
 * Assert that a status transition is valid, throwing on failure.
 *
 * @param from - Current status
 * @param to - Target status
 * @throws Error if the transition is not allowed
 */
export function assertTransition(from: PeeringStatus, to: PeeringStatus): void {
	if (!canTransition(from, to)) {
		const fromName = PeeringStatus[from] ?? String(from);
		const toName = PeeringStatus[to] ?? String(to);
		throw new Error(
			`Invalid status transition: ${fromName} (${from}) → ${toName} (${to})`,
		);
	}
}

/**
 * Get a human-readable label for a PeeringStatus code.
 */
export function statusLabel(status: PeeringStatus): string {
	return PeeringStatus[status] ?? `UNKNOWN(${status})`;
}

// ---------------------------------------------------------------------------
// Auto-approve whitelist helpers (stored in settings KV, same as blocklist)
// ---------------------------------------------------------------------------

interface WhitelistEntry {
	asn: number;
	addedAt: string;
}

interface BlockedEntry {
	asn: number;
	reason?: string;
	blockedAt: string;
}

/**
 * Get auto-approve whitelist from settings table.
 */
export async function getWhitelist(): Promise<WhitelistEntry[]> {
	const models = getModels();
	const setting = await models.settings.findOne({
		where: { key: WHITELIST_KEY },
	});
	if (!setting) return [];
	try {
		return JSON.parse(setting.get("value") as string) as WhitelistEntry[];
	} catch {
		return [];
	}
}

/**
 * Save auto-approve whitelist to settings table.
 */
export async function saveWhitelist(
	whitelist: WhitelistEntry[],
): Promise<void> {
	const models = getModels();
	await models.settings.upsert({
		key: WHITELIST_KEY,
		value: JSON.stringify(whitelist),
	});
}

/**
 * Check if an ASN is on the auto-approve whitelist.
 */
export async function isWhitelisted(asn: number): Promise<boolean> {
	const whitelist = await getWhitelist();
	return whitelist.some((w) => w.asn === asn);
}

/**
 * Get blocklist from settings table.
 */
export async function getBlocklist(): Promise<BlockedEntry[]> {
	const models = getModels();
	const setting = await models.settings.findOne({
		where: { key: BLOCKLIST_KEY },
	});
	if (!setting) return [];
	try {
		return JSON.parse(setting.get("value") as string) as BlockedEntry[];
	} catch {
		return [];
	}
}

/**
 * Check if an ASN is on the blocklist.
 */
export async function isBlocked(asn: number): Promise<boolean> {
	const blocklist = await getBlocklist();
	return blocklist.some((b) => b.asn === asn);
}

/**
 * Determine the initial status for a new peer session.
 *
 * @param asn - The peer's ASN
 * @returns Object with status and workflowType
 */
export async function determineInitialStatus(asn: number): Promise<{
	status: PeeringStatus;
	workflowType: "auto_approve" | "auto_reject" | "manual";
}> {
	// Blacklist check first
	if (await isBlocked(asn)) {
		return { status: PeeringStatus.REJECTED, workflowType: "auto_reject" };
	}

	// Auto-approve whitelist
	if (await isWhitelisted(asn)) {
		return {
			status: PeeringStatus.QUEUED_FOR_SETUP,
			workflowType: "auto_approve",
		};
	}

	// Default: manual review
	return { status: PeeringStatus.PENDING_REVIEW, workflowType: "manual" };
}
