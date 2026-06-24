/**
 * Audit Log Service
 *
 * Records important security and operational events for compliance and debugging.
 */

import type { Context } from "hono";
import { getLogContext } from "../common/logger";
import { getModels } from "../db/dbContext";

export type AuditAction =
	// Auth events
	| "auth.query"
	| "auth.request"
	| "auth.success"
	| "auth.failure"
	// Session events
	| "session.create"
	| "session.update"
	| "session.delete"
	// Admin events
	| "admin.approve"
	| "admin.reject"
	| "admin.block"
	// Agent events
	| "agent.heartbeat"
	| "agent.sync"
	| "agent.modify";

export type ActorType = "user" | "admin" | "system" | "agent";
export type TargetType = "session" | "user" | "router" | "config";

interface AuditEventOptions {
	action: AuditAction;
	actorType: ActorType;
	actorId: string;
	targetType?: TargetType;
	targetId?: string;
	metadata?: Record<string, unknown>;
	c?: Context; // Request context for extracting IP, user-agent
}

/**
 * Get client IP from context
 */
function getClientIp(c?: Context): string | null {
	if (!c) return null;
	return (
		c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
		c.req.header("X-Real-IP") ||
		null
	);
}

/**
 * Record an audit event
 */
export async function recordAuditEvent(
	options: AuditEventOptions,
): Promise<void> {
	const { action, actorType, actorId, targetType, targetId, metadata, c } =
		options;

	try {
		const models = getModels();
		const logContext = getLogContext();

		await models.auditLogs.create({
			action,
			actorType,
			actorId: String(actorId),
			targetType: targetType || null,
			targetId: targetId || null,
			metadata: metadata ? JSON.stringify(metadata) : null,
			ip: getClientIp(c),
			userAgent: c?.req.header("User-Agent") || null,
			requestId: logContext.requestId || null,
		});
	} catch (error) {
		// Log error but don't throw - audit logging should not break normal operation
		console.error("[AuditLog] Failed to record event:", error, options);
	}
}

/**
 * Helper for user-initiated actions
 */
export async function auditUserAction(
	c: Context,
	action: AuditAction,
	userAsn: string | number,
	target?: { type: TargetType; id: string },
	metadata?: Record<string, unknown>,
): Promise<void> {
	await recordAuditEvent({
		action,
		actorType: "user",
		actorId: String(userAsn),
		targetType: target?.type,
		targetId: target?.id,
		metadata,
		c,
	});
}

/**
 * Helper for admin actions
 */
export async function auditAdminAction(
	c: Context,
	action: AuditAction,
	adminId: string | number,
	target?: { type: TargetType; id: string },
	metadata?: Record<string, unknown>,
): Promise<void> {
	await recordAuditEvent({
		action,
		actorType: "admin",
		actorId: String(adminId),
		targetType: target?.type,
		targetId: target?.id,
		metadata,
		c,
	});
}

/**
 * Helper for agent actions
 */
export async function auditAgentAction(
	action: AuditAction,
	routerName: string,
	target?: { type: TargetType; id: string },
	metadata?: Record<string, unknown>,
): Promise<void> {
	await recordAuditEvent({
		action,
		actorType: "agent",
		actorId: routerName,
		targetType: target?.type,
		targetId: target?.id,
		metadata,
	});
}

/**
 * Helper for system actions
 */
export async function auditSystemAction(
	action: AuditAction,
	target?: { type: TargetType; id: string },
	metadata?: Record<string, unknown>,
): Promise<void> {
	await recordAuditEvent({
		action,
		actorType: "system",
		actorId: "system",
		targetType: target?.type,
		targetId: target?.id,
		metadata,
	});
}
