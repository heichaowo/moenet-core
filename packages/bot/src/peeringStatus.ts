/**
 * Peering session status.
 *
 * MUST stay in sync with the API enum in
 * packages/api/src/db/models/bgpSessions.ts (PeeringStatus).
 * The bot historically used a wrong mapping (treating 1 as "active"),
 * which made enabled peers show as "no active peers".
 */
export enum PeeringStatus {
	DISABLED = 1,
	ENABLED = 2,
	PENDING_REVIEW = 3,
	QUEUED_FOR_SETUP = 4,
	QUEUED_FOR_DELETE = 5,
	PROBLEM = 6,
	TEARDOWN = 7,
	REJECTED = 8,
}

/** Human-readable label + icon for each status. */
export const STATUS_LABELS: Record<number, string> = {
	[PeeringStatus.DISABLED]: "⚫ Disabled",
	[PeeringStatus.ENABLED]: "🟢 Active",
	[PeeringStatus.PENDING_REVIEW]: "⏳ Pending Review",
	[PeeringStatus.QUEUED_FOR_SETUP]: "🔄 Queued for Setup",
	[PeeringStatus.QUEUED_FOR_DELETE]: "🗑️ Queued for Delete",
	[PeeringStatus.PROBLEM]: "🔴 Problem",
	[PeeringStatus.TEARDOWN]: "🔧 Teardown",
	[PeeringStatus.REJECTED]: "🚫 Rejected",
};

/** A session is "active" when BGP is meant to be running on it. */
export function isActiveStatus(status: number): boolean {
	return status === PeeringStatus.ENABLED;
}
