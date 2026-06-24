import type { Context } from "hono";
import { verify } from "hono/jwt";
import { Op } from "sequelize";
import {
	generateUUID,
	getInterfaceName,
	getListenPort,
	timingSafeCompare,
} from "../common/helpers";
import { makeResponse, ResponseCode, success } from "../common/response";
import config from "../config";
import { getModels, getSequelize } from "../db/dbContext";
import { PeeringStatus, SessionPolicy } from "../db/models/bgpSessions";
import { getRedis } from "../db/redisContext";
import { getEmailProvider } from "../providers/email";
import {
	computeLoopbackIPv4,
	computeLoopbackIPv6,
	getContinentFromRegionCode,
	getNextAvailableNodeId,
} from "../services/ipAllocator";
import {
	assertTransition,
	getWhitelist,
	saveWhitelist,
} from "../services/workflowEngine";

interface JWTPayload {
	asn: string;
	person: string;
}

/**
 * Check if user is an admin
 * Accepts either:
 * 1. API_TOKEN (for bot/internal use)
 * 2. JWT from user with isAdmin flag in database
 */
async function isAdmin(c: Context): Promise<boolean> {
	const authHeader = c.req.header("Authorization");
	if (!authHeader?.startsWith("Bearer ")) return false;

	const token = authHeader.substring(7);

	// Check if it's the API token (for bot/agent)
	if (
		config.auth.agentApiKey &&
		timingSafeCompare(token, config.auth.agentApiKey)
	) {
		return true;
	}

	// Otherwise verify as JWT
	try {
		const payload = (await verify(
			token,
			config.auth.jwtSecret,
			"HS256",
		)) as unknown as JWTPayload;

		const models = getModels();
		const user = await models.users.findOne({
			where: { asn: Number(payload.asn) },
		});

		return user?.get("isAdmin") === true;
	} catch {
		return false;
	}
}

/**
 * Admin Handler - Administrative operations
 *
 * Actions:
 * - enumRouters: List all routers
 * - setRouter: Add/update router
 * - deleteRouter: Delete router
 * - enumSessions: List all sessions
 * - approveSession: Approve pending session
 * - rejectSession: Reject pending session
 * - deleteSession: Force delete session
 * - getStats: Get network statistics
 * - migrate: Migrate session to a different router
 * - blockAsn: Block an ASN from peering
 * - unblockAsn: Unblock an ASN
 * - enumBlocklist: List all blocked ASNs
 * - registerTelegramId: Upsert (asn, telegramId) into users table
 * - getNotificationTargets: Query users with active peers (for announcements)
 */
export default async function adminHandler(c: Context): Promise<Response> {
	if (!(await isAdmin(c))) {
		return makeResponse(
			c,
			ResponseCode.FORBIDDEN,
			undefined,
			"Admin access required",
		);
	}

	const body = await c.req.json();
	const action = body.action;

	switch (action) {
		case "enumRouters":
			return await enumRouters(c);
		case "setRouter":
			return await setRouter(c, body);
		case "createRouter":
			return await createRouter(c, body);
		case "getRouter":
			return await getRouter(c, body);
		case "updateRouter":
			return await updateRouter(c, body);
		case "deleteRouter":
			return await deleteRouter(c, body);
		case "enumSessions":
			return await enumSessions(c, body);
		case "approveSession":
			return await approveSession(c, body);
		case "rejectSession":
			return await rejectSession(c, body);
		case "deleteSession":
			return await deleteSessionAdmin(c, body);
		case "getSession":
			return await getSessionAdmin(c, body);
		case "updateSession":
			return await updateSessionAdmin(c, body);
		case "setMaintenance":
			return await setMaintenance(c, body);
		case "createSession":
			return await createSessionAdmin(c, body);
		case "getStats":
			return await getStats(c);
		case "migrate":
			return await migrateSession(c, body);
		case "bulkMigrate":
			return await bulkMigrateSession(c, body);
		case "blockAsn":
			return await blockAsn(c, body);
		case "unblockAsn":
			return await unblockAsn(c, body);
		case "enumBlocklist":
			return await enumBlocklist(c);
		case "sendEmail":
			return await sendVerificationEmail(c, body);
		case "whitelistAsn":
			return await whitelistAsn(c, body);
		case "unwhitelistAsn":
			return await unwhitelistAsn(c, body);
		case "enumWhitelist":
			return await enumWhitelist(c);
		case "snapshot":
			return await generateSnapshot(c);
		case "registerTelegramId":
			return await registerTelegramId(c, body);
		case "getNotificationTargets":
			return await getNotificationTargets(c, body);
		case "sendBulkEmail":
			return await sendBulkEmail(c, body);
		case "updateSessionContact":
			return await updateSessionContact(c, body);
		case "storeMigrationNotify":
			return await storeMigrationNotify(c, body);
		case "checkMigrationNotify":
			return await checkMigrationNotify(c, body);
		default:
			return makeResponse(
				c,
				ResponseCode.VALIDATION_ERROR,
				undefined,
				"Invalid action",
			);
	}
}

/**
 * List all routers with session counts
 */
async function enumRouters(c: Context): Promise<Response> {
	const models = getModels();

	const routers = await models.routers.findAll();

	const result = await Promise.all(
		routers.map(async (router) => {
			const r = router.get();
			const sessionCount = await models.bgpSessions.count({
				where: { router: r.uuid },
			});

			// Compute isOpen: node accepts new peers if capacity allows
			const maxPeers = r.maxPeers as number | null;
			const isOpen = maxPeers === null || sessionCount < maxPeers;

			return {
				...r,
				sessionCount,
				isOpen,
			};
		}),
	);

	return success(c, { routers: result });
}

/**
 * Add or update a router
 */
async function setRouter(
	c: Context,
	body: { type: string; router?: string; data: unknown },
): Promise<Response> {
	const { type, router, data } = body;

	if (!data || typeof data !== "object") {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing router data",
		);
	}

	const models = getModels();
	const routerData = data as Record<string, unknown>;

	try {
		if (type === "update" && router) {
			await models.routers.update(routerData, {
				where: { uuid: router },
			});
		} else if (type === "add") {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await models.routers.create(routerData as any);
		} else {
			return makeResponse(
				c,
				ResponseCode.VALIDATION_ERROR,
				undefined,
				"Invalid type",
			);
		}
	} catch (error) {
		console.error("[Admin] Error setting router:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to save router",
		);
	}

	return success(c, { message: "Router saved" });
}

/**
 * Create a new router (for /addnode command)
 */
interface CreateRouterBody {
	name: string;
	hostname?: string;
	ipv4?: string | null;
	ipv6?: string | null;
	role?: string;
	region: string;
	location: string;
	provider: string;
	bandwidth: string;
	maxPeers: number;
	allowCnPeers: boolean;
	bootstrapToken?: string;
}

async function createRouter(
	c: Context,
	body: CreateRouterBody,
): Promise<Response> {
	if (!body.name || !body.location) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing required fields",
		);
	}

	const models = getModels();

	// Map region string to regionCode
	const regionCodeMap: Record<string, number> = {
		"AS-E": 101,
		"AS-SE": 102,
		"AS-S": 103,
		"AS-N": 104,
		"NA-E": 201,
		"NA-C": 202,
		"NA-W": 203,
		CA: 204,
		SA: 205,
		"EU-W": 301,
		"EU-C": 302,
		"EU-E": 303,
		OC: 401,
		AF: 501,
		ME: 502,
	};
	const regionCode = regionCodeMap[body.region?.toUpperCase()] || 101;

	// Continent-aware nodeId allocation (gap-filling within range)
	const continent = getContinentFromRegionCode(regionCode);
	const allRouters = await models.routers.findAll({ attributes: ["nodeId"] });
	const existingIds = allRouters.map((r) => r.get("nodeId") as number);
	const nextNodeId = getNextAvailableNodeId(continent, existingIds);

	if (nextNodeId === null) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			`No available node IDs for continent ${continent}. Range is full.`,
		);
	}

	// Map role to nodeType
	const nodeType = body.role === "rr" ? "rr" : "client";

	try {
		const router = await models.routers.create({
			name: body.name,
			location: body.location,
			publicIp: body.ipv4 || null,
			publicIpv6: body.ipv6 || null,
			nodeType,
			provider: body.provider || null,
			bandwidth: body.bandwidth || null,
			maxPeers: body.maxPeers || 20,
			allowCnPeers: body.allowCnPeers ?? true,
			bootstrapToken: body.bootstrapToken || null,
			nodeId: nextNodeId,
			regionCode,
			supportsIpv4: !!body.ipv4,
			supportsIpv6: !!body.ipv6,
			// Auto-generate loopback IPs via IP allocator
			dn42Loopback4: computeLoopbackIPv4(nextNodeId),
			dn42Loopback6: computeLoopbackIPv6(regionCode, nextNodeId),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any);

		return success(c, {
			message: "Router created",
			router: {
				uuid: router.get("uuid"),
				nodeId: router.get("nodeId"),
				name: router.get("name"),
				regionCode: router.get("regionCode"),
				loopback4: router.get("dn42Loopback4"),
				loopback6: router.get("dn42Loopback6"),
			},
		});
	} catch (error) {
		console.error("[Admin] Error creating router:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to create router",
		);
	}
}

/**
 * Get a single router by name (for /bootstrap command)
 */
async function getRouter(
	c: Context,
	body: { name?: string },
): Promise<Response> {
	if (!body.name) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing name",
		);
	}

	const models = getModels();
	const router = await models.routers.findOne({
		where: { name: body.name },
	});

	if (!router) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Router not found",
		);
	}

	return success(c, { router: router.get() });
}

/**
 * Update a router by name (for updating bootstrapToken)
 */
async function updateRouter(
	c: Context,
	body: { name?: string; updates?: Record<string, unknown> },
): Promise<Response> {
	if (!body.name || !body.updates) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing name or updates",
		);
	}

	const models = getModels();

	try {
		const [updated] = await models.routers.update(body.updates, {
			where: { name: body.name },
		});

		if (!updated) {
			return makeResponse(
				c,
				ResponseCode.NOT_FOUND,
				undefined,
				"Router not found",
			);
		}
	} catch (error) {
		console.error("[Admin] Error updating router:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to update router",
		);
	}

	return success(c, { message: "Router updated" });
}

/**
 * Delete a router (supports both uuid and name)
 */
async function deleteRouter(
	c: Context,
	body: { router?: string; name?: string },
): Promise<Response> {
	const identifier = body.name || body.router;
	if (!identifier) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing router or name",
		);
	}

	const models = getModels();

	// Check if it's a UUID or name
	const isUuid =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			identifier,
		);
	const whereClause = isUuid ? { uuid: identifier } : { name: identifier };

	try {
		const deleted = await models.routers.destroy({
			where: whereClause,
		});

		if (!deleted) {
			return makeResponse(
				c,
				ResponseCode.NOT_FOUND,
				undefined,
				"Router not found",
			);
		}
	} catch (error) {
		console.error("[Admin] Error deleting router:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to delete router",
		);
	}

	return success(c, { message: "Router deleted" });
}

/**
 * List all sessions (optionally filtered by status and/or asn)
 */
async function enumSessions(
	c: Context,
	body: { status?: number; asn?: number },
): Promise<Response> {
	const models = getModels();

	const whereClause: Record<string, unknown> = {};
	if (body.status !== undefined) {
		whereClause.status = body.status;
	}
	if (body.asn !== undefined) {
		whereClause.asn = body.asn;
	}

	const sessions = await models.bgpSessions.findAll({
		where: whereClause,
		order: [["created_at", "DESC"]],
	});

	// Resolve router names
	const routerUuids = [
		...new Set(sessions.map((s) => s.get("router") as string)),
	];
	const routers = await models.routers.findAll({
		where: { uuid: routerUuids },
	});
	const routerMap = new Map(
		routers.map((r) => [r.get("uuid") as string, r.get("name") as string]),
	);

	return success(c, {
		sessions: sessions.map((s) => ({
			...s.get(),
			routerName: routerMap.get(s.get("router") as string) || s.get("router"),
		})),
	});
}

/**
 * Approve a pending session (moves to QUEUED_FOR_SETUP)
 */
async function approveSession(
	c: Context,
	body: { uuid?: string },
): Promise<Response> {
	if (!body.uuid) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing uuid",
		);
	}

	const models = getModels();

	// Validate state transition
	const session = await models.bgpSessions.findOne({
		where: { uuid: body.uuid },
	});
	if (!session) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Session not found",
		);
	}

	const currentStatus = session.get("status") as PeeringStatus;
	try {
		assertTransition(currentStatus, PeeringStatus.QUEUED_FOR_SETUP);
	} catch (err) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			(err as Error).message,
		);
	}

	// Optimistic lock: include current status in WHERE to prevent TOCTOU race
	const [updated] = await models.bgpSessions.update(
		{ status: PeeringStatus.QUEUED_FOR_SETUP },
		{ where: { uuid: body.uuid, status: currentStatus } },
	);

	if (!updated) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Session status changed concurrently",
		);
	}

	console.log(
		`[Admin] Session ${body.uuid} approved (PENDING_REVIEW → QUEUED_FOR_SETUP)`,
	);
	return success(c, { message: "Session approved", uuid: body.uuid });
}

/**
 * Reject a pending session (moves to REJECTED)
 */
async function rejectSession(
	c: Context,
	body: { uuid?: string; reason?: string },
): Promise<Response> {
	if (!body.uuid) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing uuid",
		);
	}

	const models = getModels();

	// Validate state transition
	const session = await models.bgpSessions.findOne({
		where: { uuid: body.uuid },
	});
	if (!session) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Session not found",
		);
	}

	const currentStatus = session.get("status") as PeeringStatus;
	try {
		assertTransition(currentStatus, PeeringStatus.REJECTED);
	} catch (err) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			(err as Error).message,
		);
	}

	// Optimistic lock: include current status in WHERE to prevent TOCTOU race
	const [updated] = await models.bgpSessions.update(
		{
			status: PeeringStatus.REJECTED,
			lastError: body.reason || "Rejected by admin",
		},
		{ where: { uuid: body.uuid, status: currentStatus } },
	);

	if (!updated) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Session status changed concurrently",
		);
	}

	console.log(
		`[Admin] Session ${body.uuid} rejected: ${body.reason || "No reason"}`,
	);
	return success(c, { message: "Session rejected", uuid: body.uuid });
}

/**
 * Force delete a session
 */
async function deleteSessionAdmin(
	c: Context,
	body: { uuid?: string },
): Promise<Response> {
	if (!body.uuid) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing uuid",
		);
	}

	const models = getModels();

	// Only delete sessions that are not already queued for deletion
	const [updated] = await models.bgpSessions.update(
		{ status: PeeringStatus.QUEUED_FOR_DELETE },
		{
			where: {
				uuid: body.uuid,
				status: { [Op.ne]: PeeringStatus.QUEUED_FOR_DELETE },
			},
		},
	);

	if (!updated) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Session not found or already queued for deletion",
		);
	}

	return success(c, { message: "Session queued for deletion" });
}

/**
 * Get a single session by uuid (for admin/bot)
 */
async function getSessionAdmin(
	c: Context,
	body: { uuid?: string },
): Promise<Response> {
	if (!body.uuid) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing uuid",
		);
	}

	const models = getModels();

	const session = await models.bgpSessions.findOne({
		where: { uuid: body.uuid },
	});

	if (!session) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Session not found",
		);
	}

	// Get router name
	const router = await models.routers.findOne({
		where: { uuid: session.get("router") as string },
	});
	const routerName = router?.get("name") || session.get("router");

	return success(c, {
		session: {
			...session.get(),
			routerName,
		},
	});
}

/**
 * Update session fields (for bot/admin)
 */
async function updateSessionAdmin(
	c: Context,
	body: { uuid?: string; [key: string]: unknown },
): Promise<Response> {
	const { uuid, ...updates } = body;

	if (!uuid) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing uuid",
		);
	}

	const models = getModels();

	// Define allowed fields for update (psk handled separately below)
	const allowedFields = [
		"ipv4",
		"ipv6",
		"ipv6LinkLocal",
		"localIpv4",
		"endpoint",
		"credential",
		"mtu",
		"extensions",
		"contact",
		"data",
		"status",
	];

	// Build update object with only allowed fields
	const updateData: Record<string, unknown> = {};
	for (const field of allowedFields) {
		if (field in updates) {
			// Validate status against enum
			if (field === "status") {
				const statusVal = Number(updates[field]);
				if (!Object.values(PeeringStatus).includes(statusVal)) {
					return makeResponse(
						c,
						ResponseCode.VALIDATION_ERROR,
						undefined,
						`Invalid status value. Valid: ${Object.entries(PeeringStatus)
							.filter(([k]) => Number.isNaN(Number(k)))
							.map(([k, v]) => `${v}=${k}`)
							.join(", ")}`,
					);
				}
				updateData[field] = statusVal;
				continue;
			}
			// Convert extensions from comma-separated string to JSON array for JSONB column
			if (field === "extensions" && typeof updates[field] === "string") {
				const extStr = updates[field] as string;
				updateData[field] = extStr
					? extStr
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean)
					: [];
			} else {
				updateData[field] = updates[field];
			}
		}
	}

	// Verify session exists (needed for PSK merge and status check)
	const session = await models.bgpSessions.findOne({ where: { uuid } });
	if (!session) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Session not found",
		);
	}

	// Special handling: PSK is stored inside credential JSON as preshared_key
	if ("psk" in updates) {
		const existingCred = session.get("credential") as string | null;
		let credObj: Record<string, unknown> = {};
		if (existingCred) {
			try {
				credObj =
					typeof existingCred === "string"
						? JSON.parse(existingCred)
						: existingCred;
			} catch {
				/* use empty */
			}
		}
		credObj.preshared_key = updates.psk ?? null;
		updateData.credential = JSON.stringify(credObj);
	}

	if (Object.keys(updateData).length === 0) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"No valid fields to update",
		);
	}

	// Auto-redeploy: any field change on an ENABLED session triggers re-setup
	// Skip if status is being explicitly set (admin override)
	const currentStatus = session.get("status") as number;
	if (currentStatus === PeeringStatus.ENABLED && !("status" in updateData)) {
		updateData.status = PeeringStatus.QUEUED_FOR_SETUP;
	}

	// Update session with error handling for PostgreSQL type errors
	try {
		await models.bgpSessions.update(updateData, { where: { uuid } });
	} catch (error) {
		console.error("[Admin] Error updating session:", error);
		const errorMsg = error instanceof Error ? error.message : "Unknown error";

		// Handle PostgreSQL INET type errors (22P02)
		if (
			errorMsg.includes("22P02") ||
			errorMsg.includes("invalid input syntax")
		) {
			return makeResponse(
				c,
				ResponseCode.VALIDATION_ERROR,
				undefined,
				"Invalid IP address format",
			);
		}

		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			`Update failed: ${errorMsg}`,
		);
	}

	if (currentStatus === PeeringStatus.ENABLED) {
		console.log(
			`[Admin] Session ${uuid} queued for re-setup after field update`,
		);
		return success(c, { message: "Session updated, re-deploying" });
	}

	return success(c, { message: "Session updated" });
}

/**
 * Set maintenance mode for a router
 * This calls the agent's maintenance API and stores state in Redis
 */
async function setMaintenance(
	c: Context,
	body: { router?: string; enabled?: boolean },
): Promise<Response> {
	const { router, enabled } = body;

	if (!router || enabled === undefined) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing router or enabled",
		);
	}

	const models = getModels();
	const routerRecord = await models.routers.findOne({
		where: { name: router },
	});

	if (!routerRecord) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Router not found",
		);
	}

	const callbackUrl = routerRecord.get("callbackUrl") as string | null;
	const publicIp = routerRecord.get("publicIp") as string;

	if (!callbackUrl && !publicIp) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Router has no callback URL or public IP",
		);
	}

	// Call agent's maintenance API (prefer callbackUrl, fallback to IP:24368)
	const agentBase = callbackUrl || `http://${publicIp}:24368`;
	const agentUrl = `${agentBase}/maintenance/${enabled ? "start" : "stop"}`;

	try {
		const agentResp = await fetch(agentUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.auth.agentApiKey}`,
				"Content-Type": "application/json",
			},
		});

		if (!agentResp.ok) {
			const errorText = await agentResp.text();
			return makeResponse(
				c,
				ResponseCode.INTERNAL_ERROR,
				undefined,
				`Agent returned: ${errorText}`,
			);
		}

		// Store maintenance state in Redis
		try {
			const redis = getRedis();
			await redis.hset(`maintenance:${router}`, {
				enabled: enabled ? "1" : "0",
				changedAt: Date.now().toString(),
			});
		} catch (redisError) {
			console.warn(
				"[Admin] Failed to store maintenance state in Redis:",
				redisError,
			);
		}

		console.log(
			`[Admin] Maintenance ${enabled ? "enabled" : "disabled"} for ${router}`,
		);
		return success(c, {
			message: `Maintenance mode ${enabled ? "enabled" : "disabled"}`,
			router,
		});
	} catch (error) {
		console.error("[Admin] Failed to call agent maintenance API:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to contact agent",
		);
	}
}

/**
 * Admin create session - creates a peering session directly with ACTIVE status
 * Bypasses JWT auth and review process.
 */
async function createSessionAdmin(
	c: Context,
	body: {
		asn: number;
		router: string;
		ipv6?: string;
		endpoint?: string;
		port?: number;
		publicKey?: string;
		mtu?: number;
		psk?: string;
		status?: number;
		extensions?: string;
		contact?: string;
	},
): Promise<Response> {
	const {
		asn,
		router,
		ipv6,
		endpoint,
		port,
		publicKey,
		mtu,
		psk,
		status,
		extensions,
		contact,
	} = body;
	const fullEndpoint = endpoint
		? port
			? `${endpoint}:${port}`
			: endpoint
		: null;
	// Default extensions to mp_bgp + extended_nexthop (recommended config)
	// Store as JSON array for JSONB column (agent expects string[])
	const defaultExtensions = ["mp_bgp", "extended_nexthop"];
	let sessionExtensions: string[];
	if (extensions !== undefined) {
		sessionExtensions =
			typeof extensions === "string"
				? extensions
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: (extensions as unknown as string[]);
	} else {
		sessionExtensions = defaultExtensions;
	}

	if (!asn || !router) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing required fields: asn, router",
		);
	}

	const models = getModels();

	// Check if router exists
	const routerRecord = await models.routers.findOne({
		where: { uuid: router },
	});

	if (!routerRecord) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Router not found",
		);
	}

	// Check if session already exists
	const existingSession = await models.bgpSessions.findOne({
		where: { router, asn },
	});

	if (existingSession) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Session already exists for this ASN on this router",
		);
	}

	const sessionUuid = generateUUID();
	const interfaceName = getInterfaceName(asn);
	const listenPort = getListenPort(asn);
	const sessionStatus =
		status === 1
			? PeeringStatus.QUEUED_FOR_SETUP
			: PeeringStatus.PENDING_REVIEW;

	try {
		await models.bgpSessions.create({
			uuid: sessionUuid,
			router,
			asn,
			status: sessionStatus,
			mtu: mtu || 1420,
			policy: SessionPolicy.FULL,
			ipv4: null,
			ipv6: ipv6 || null,
			// Auto-set our local LLA for link-local peering
			ipv6LinkLocal: ipv6?.startsWith("fe80") ? "fe80::998" : null,
			type: "wireguard",
			extensions:
				sessionExtensions.length > 0 ? JSON.stringify(sessionExtensions) : null,
			interface: interfaceName,
			endpoint: fullEndpoint,
			credential: publicKey
				? JSON.stringify({
						public_key: publicKey,
						preshared_key: psk || null,
						listen_port: listenPort,
						endpoint: fullEndpoint,
						mtu: mtu || 1420,
					})
				: null,
			data: null,
			lastError: null,
			contact: contact || null,
		});

		console.log(
			`[Admin] Created session ${sessionUuid} for AS${asn} on ${router} with status ${sessionStatus}`,
		);

		return success(c, {
			uuid: sessionUuid,
			status: sessionStatus,
			message: `Session created with status: ${sessionStatus}`,
		});
	} catch (error) {
		console.error("[Admin] Error creating session:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to create session",
		);
	}
}

/**
 * Get network statistics (aggregate counts)
 */
async function getStats(c: Context): Promise<Response> {
	const models = getModels();

	try {
		const [totalPeers, activePeers, pendingPeers, totalNodes] =
			await Promise.all([
				models.bgpSessions.count(),
				models.bgpSessions.count({ where: { status: PeeringStatus.ENABLED } }),
				models.bgpSessions.count({
					where: { status: PeeringStatus.PENDING_REVIEW },
				}),
				models.routers.count(),
			]);

		return success(c, {
			stats: {
				totalPeers,
				activePeers,
				pendingPeers,
				totalNodes,
				activeNodes: totalNodes,
			},
		});
	} catch (error) {
		console.error("[Admin] Error getting stats:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to get stats",
		);
	}
}

/**
 * Migrate a session to a different router.
 * Deletes the old session and creates a new one on the target router,
 * preserving the peer's configuration.
 */
async function migrateSession(
	c: Context,
	body: {
		uuid?: string;
		newRouter?: string;
	},
): Promise<Response> {
	const { uuid, newRouter } = body;

	if (!uuid || !newRouter) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing uuid or newRouter",
		);
	}

	const models = getModels();

	// Find existing session
	const session = await models.bgpSessions.findOne({ where: { uuid } });
	if (!session) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Session not found",
		);
	}

	// Check target router exists
	const targetRouter = await models.routers.findOne({
		where: { uuid: newRouter },
	});
	if (!targetRouter) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Target router not found",
		);
	}

	const sessionData = session.get();
	const asn = sessionData.asn as number;
	const oldRouter = sessionData.router as string;

	if (oldRouter === newRouter) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"New router is the same as current router",
		);
	}

	// Check if session already exists on target router (ignore deleted ones)
	const existing = await models.bgpSessions.findOne({
		where: { router: newRouter, asn },
	});
	if (existing) {
		const existingStatus = existing.get("status") as number;
		if (existingStatus === 0) {
			// status 0 = deleted/soft-deleted
			// Clean up old deleted session so migration can proceed
			await existing.destroy();
			console.log(
				`[Admin] Cleaned up deleted session for AS${asn} on target router`,
			);
		} else {
			return makeResponse(
				c,
				ResponseCode.VALIDATION_ERROR,
				undefined,
				"Session already exists on target router",
			);
		}
	}

	const sequelize = getSequelize();
	const t = await sequelize.transaction();

	try {
		// Queue old session for deletion
		await models.bgpSessions.update(
			{ status: PeeringStatus.QUEUED_FOR_DELETE },
			{ where: { uuid }, transaction: t },
		);

		// Create new session on target router
		const newUuid = generateUUID();
		const interfaceName = getInterfaceName(asn);

		await models.bgpSessions.create(
			{
				uuid: newUuid,
				router: newRouter,
				asn,
				status: PeeringStatus.QUEUED_FOR_SETUP,
				mtu: sessionData.mtu || 1420,
				policy: sessionData.policy || SessionPolicy.FULL,
				ipv4: sessionData.ipv4 || null,
				ipv6: sessionData.ipv6 || null,
				ipv6LinkLocal: sessionData.ipv6LinkLocal || null,
				localIpv4: sessionData.localIpv4 || null,
				type: sessionData.type || "wireguard",
				extensions: sessionData.extensions
					? typeof sessionData.extensions === "string"
						? sessionData.extensions
						: JSON.stringify(sessionData.extensions)
					: null,
				interface: interfaceName,
				endpoint: sessionData.endpoint || null,
				credential: sessionData.credential
					? typeof sessionData.credential === "string"
						? sessionData.credential
						: JSON.stringify(sessionData.credential)
					: null,
				data: null,
				lastError: null,
				contact: sessionData.contact || null,
			},
			{ transaction: t },
		);

		await t.commit();

		console.log(
			`[Admin] Migrated session AS${asn}: ${oldRouter} -> ${newRouter} (old: ${uuid}, new: ${newUuid})`,
		);

		return success(c, {
			message: "Session migration initiated",
			oldUuid: uuid,
			newUuid,
			oldRouter,
			newRouter,
		});
	} catch (error) {
		await t.rollback();
		const errMsg = error instanceof Error ? error.message : String(error);
		const errStack = error instanceof Error ? error.stack : "";
		console.error(`[Admin] Error migrating session AS${asn} ${uuid}:`, errMsg);
		if (errStack) console.error("[Admin] Stack:", errStack);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			`Failed to migrate session: ${errMsg}`,
		);
	}
}

/**
 * Bulk migrate all active sessions from one router to another.
 * Supports dryRun mode to preview without executing.
 *
 * @param body.fromRouter - Source router UUID
 * @param body.toRouter - Target router UUID
 * @param body.dryRun - If true, only return the list of sessions that would be migrated
 */
async function bulkMigrateSession(
	c: Context,
	body: {
		fromRouter?: string;
		toRouter?: string;
		dryRun?: boolean;
	},
): Promise<Response> {
	const { fromRouter, toRouter, dryRun } = body;

	if (!fromRouter || !toRouter) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing fromRouter or toRouter",
		);
	}

	if (fromRouter === toRouter) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Source and target router are the same",
		);
	}

	const models = getModels();

	// Verify both routers exist
	const [sourceRouter, targetRouter] = await Promise.all([
		models.routers.findOne({ where: { uuid: fromRouter } }),
		models.routers.findOne({ where: { uuid: toRouter } }),
	]);

	if (!sourceRouter) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Source router not found",
		);
	}
	if (!targetRouter) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Target router not found",
		);
	}

	const sourceRouterName = sourceRouter.get("name") as string;
	const targetRouterName = targetRouter.get("name") as string;

	// Find all active/enabled sessions on source router
	const sessions = await models.bgpSessions.findAll({
		where: {
			router: fromRouter,
			status: { [Op.in]: [PeeringStatus.ENABLED, PeeringStatus.PROBLEM] },
		},
	});

	if (sessions.length === 0) {
		return success(c, {
			message: "No active sessions to migrate",
			fromRouter: sourceRouterName,
			toRouter: targetRouterName,
			count: 0,
			sessions: [],
		});
	}

	// Build session preview list
	const sessionList = sessions.map((s) => ({
		uuid: s.get("uuid") as string,
		asn: s.get("asn") as number,
		contact: s.get("contact") as string | null,
		status: s.get("status") as number,
	}));

	// Dry run - just return what would be migrated
	if (dryRun) {
		return success(c, {
			dryRun: true,
			fromRouter: sourceRouterName,
			toRouter: targetRouterName,
			count: sessionList.length,
			sessions: sessionList,
		});
	}

	// Execute migration for each session
	const sequelize = getSequelize();
	const results: Array<{
		asn: number;
		uuid: string;
		newUuid: string;
		status: "ok" | "error";
		error?: string;
	}> = [];

	for (const session of sessions) {
		const sessionData = session.get();
		const asn = sessionData.asn as number;
		const uuid = sessionData.uuid as string;

		// Check if session already exists on target (ignore deleted)
		const existing = await models.bgpSessions.findOne({
			where: { router: toRouter, asn },
		});
		if (existing) {
			const existingStatus = existing.get("status") as number;
			if (existingStatus === 0) {
				await existing.destroy();
			} else {
				results.push({
					asn,
					uuid,
					newUuid: "",
					status: "error",
					error: "Already exists on target router",
				});
				continue;
			}
		}

		const t = await sequelize.transaction();
		try {
			// Queue old session for deletion
			await models.bgpSessions.update(
				{ status: PeeringStatus.QUEUED_FOR_DELETE },
				{ where: { uuid }, transaction: t },
			);

			// Create new session on target router
			const newUuid = generateUUID();
			const interfaceName = getInterfaceName(asn);

			await models.bgpSessions.create(
				{
					uuid: newUuid,
					router: toRouter,
					asn,
					status: PeeringStatus.QUEUED_FOR_SETUP,
					mtu: sessionData.mtu || 1420,
					policy: sessionData.policy || SessionPolicy.FULL,
					ipv4: sessionData.ipv4 || null,
					ipv6: sessionData.ipv6 || null,
					ipv6LinkLocal: sessionData.ipv6LinkLocal || null,
					localIpv4: sessionData.localIpv4 || null,
					type: sessionData.type || "wireguard",
					extensions: sessionData.extensions
						? typeof sessionData.extensions === "string"
							? sessionData.extensions
							: JSON.stringify(sessionData.extensions)
						: null,
					interface: interfaceName,
					endpoint: sessionData.endpoint || null,
					credential: sessionData.credential
						? typeof sessionData.credential === "string"
							? sessionData.credential
							: JSON.stringify(sessionData.credential)
						: null,
					data: null,
					lastError: null,
					contact: sessionData.contact || null,
				},
				{ transaction: t },
			);

			await t.commit();
			results.push({ asn, uuid, newUuid, status: "ok" });
			console.log(
				`[BulkMigrate] AS${asn}: ${sourceRouterName} -> ${targetRouterName} (${uuid} -> ${newUuid})`,
			);
		} catch (error) {
			await t.rollback();
			const errMsg = error instanceof Error ? error.message : String(error);
			results.push({ asn, uuid, newUuid: "", status: "error", error: errMsg });
			console.error(`[BulkMigrate] Failed AS${asn}:`, errMsg);
		}
	}

	const migrated = results.filter((r) => r.status === "ok").length;
	const failed = results.filter((r) => r.status === "error").length;

	console.log(
		`[BulkMigrate] Complete: ${migrated} migrated, ${failed} failed (${sourceRouterName} -> ${targetRouterName})`,
	);

	return success(c, {
		fromRouter: sourceRouterName,
		toRouter: targetRouterName,
		migrated,
		failed,
		results,
	});
}

// =============================================================================
// ASN Blocklist (stored in settings KV as JSON array)
// =============================================================================

const BLOCKLIST_KEY = "asn_blocklist";

interface BlockedEntry {
	asn: number;
	reason?: string;
	blockedAt: string;
}

/**
 * Get the current blocklist from settings
 */
async function getBlocklistData(): Promise<BlockedEntry[]> {
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
 * Send a verification email via Mailgun
 */
async function sendVerificationEmail(
	c: Context,
	body: { email?: string; asn?: number; code?: string },
): Promise<Response> {
	const { email, asn, code } = body;
	if (!email || !asn || !code) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing email, asn, or code",
		);
	}

	const emailProvider = getEmailProvider();
	if (!emailProvider.isEnabled()) {
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Email service not configured",
		);
	}

	const result = await emailProvider.sendVerificationCode(email, asn, code);
	if (!result.success) {
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			result.error || "Failed to send email",
		);
	}

	return success(c, { message: "Verification email sent" });
}

/**
 * Save the blocklist to settings
 */
async function saveBlocklistData(blocklist: BlockedEntry[]): Promise<void> {
	const models = getModels();
	await models.settings.upsert({
		key: BLOCKLIST_KEY,
		value: JSON.stringify(blocklist),
	});
}

/**
 * Block an ASN from peering
 */
async function blockAsn(
	c: Context,
	body: { asn?: number; reason?: string },
): Promise<Response> {
	if (!body.asn) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing asn",
		);
	}

	try {
		const blocklist = await getBlocklistData();

		// Check if already blocked
		if (blocklist.some((b) => b.asn === body.asn)) {
			return makeResponse(
				c,
				ResponseCode.VALIDATION_ERROR,
				undefined,
				"ASN already blocked",
			);
		}

		blocklist.push({
			asn: body.asn,
			reason: body.reason,
			blockedAt: new Date().toISOString(),
		});

		await saveBlocklistData(blocklist);
		console.log(
			`[Admin] Blocked ASN ${body.asn}${body.reason ? `: ${body.reason}` : ""}`,
		);

		return success(c, { message: `AS${body.asn} blocked` });
	} catch (error) {
		console.error("[Admin] Error blocking ASN:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to block ASN",
		);
	}
}

/**
 * Unblock an ASN
 */
async function unblockAsn(
	c: Context,
	body: { asn?: number },
): Promise<Response> {
	if (!body.asn) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing asn",
		);
	}

	try {
		const blocklist = await getBlocklistData();
		const filtered = blocklist.filter((b) => b.asn !== body.asn);

		if (filtered.length === blocklist.length) {
			return makeResponse(
				c,
				ResponseCode.NOT_FOUND,
				undefined,
				"ASN not in blocklist",
			);
		}

		await saveBlocklistData(filtered);
		console.log(`[Admin] Unblocked ASN ${body.asn}`);

		return success(c, { message: `AS${body.asn} unblocked` });
	} catch (error) {
		console.error("[Admin] Error unblocking ASN:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to unblock ASN",
		);
	}
}

/**
 * List all blocked ASNs
 */
async function enumBlocklist(c: Context): Promise<Response> {
	try {
		const blocklist = await getBlocklistData();
		return success(c, { blocklist });
	} catch (error) {
		console.error("[Admin] Error listing blocklist:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to list blocklist",
		);
	}
}

// =============================================================================
// ASN Auto-Approve Whitelist (stored in settings KV via workflowEngine)
// =============================================================================

/**
 * Add an ASN to the auto-approve whitelist.
 */
async function whitelistAsn(
	c: Context,
	body: { asn?: number },
): Promise<Response> {
	if (!body.asn) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing asn",
		);
	}

	try {
		const whitelist = await getWhitelist();

		if (whitelist.some((w) => w.asn === body.asn)) {
			return makeResponse(
				c,
				ResponseCode.VALIDATION_ERROR,
				undefined,
				"ASN already whitelisted",
			);
		}

		whitelist.push({
			asn: body.asn,
			addedAt: new Date().toISOString(),
		});

		await saveWhitelist(whitelist);
		console.log(`[Admin] Whitelisted ASN ${body.asn} for auto-approve`);

		return success(c, {
			message: `AS${body.asn} added to auto-approve whitelist`,
		});
	} catch (error) {
		console.error("[Admin] Error whitelisting ASN:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to whitelist ASN",
		);
	}
}

/**
 * Remove an ASN from the auto-approve whitelist.
 */
async function unwhitelistAsn(
	c: Context,
	body: { asn?: number },
): Promise<Response> {
	if (!body.asn) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing asn",
		);
	}

	try {
		const whitelist = await getWhitelist();
		const filtered = whitelist.filter((w) => w.asn !== body.asn);

		if (filtered.length === whitelist.length) {
			return makeResponse(
				c,
				ResponseCode.NOT_FOUND,
				undefined,
				"ASN not in whitelist",
			);
		}

		await saveWhitelist(filtered);
		console.log(`[Admin] Removed ASN ${body.asn} from auto-approve whitelist`);

		return success(c, {
			message: `AS${body.asn} removed from auto-approve whitelist`,
		});
	} catch (error) {
		console.error("[Admin] Error removing ASN from whitelist:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to remove ASN from whitelist",
		);
	}
}

/**
 * List all auto-approved ASNs.
 */
async function enumWhitelist(c: Context): Promise<Response> {
	try {
		const whitelist = await getWhitelist();
		return success(c, { whitelist });
	} catch (error) {
		console.error("[Admin] Error listing whitelist:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to list whitelist",
		);
	}
}

/**
 * Generate a full infrastructure snapshot for disaster recovery.
 *
 * Returns all nodes and active peers in a single JSON blob with a SHA-256
 * integrity hash. Credentials are excluded to limit exposure.
 */
async function generateSnapshot(c: Context): Promise<Response> {
	const models = getModels();

	try {
		const [allRouters, allSessions] = await Promise.all([
			models.routers.findAll(),
			models.bgpSessions.findAll({
				where: {
					status: {
						[Op.in]: [PeeringStatus.ENABLED, PeeringStatus.QUEUED_FOR_SETUP],
					},
				},
				order: [["asn", "ASC"]],
			}),
		]);

		const nodes = allRouters.map((r) => {
			const attrs = r.get() as unknown as Record<string, unknown>;
			const nodeId = (attrs.nodeId as number) ?? 0;
			const regionCode = (attrs.regionCode as number) ?? 0;
			return {
				id: nodeId,
				name: attrs.name as string,
				location: attrs.location as string,
				nodeType: (attrs.nodeType as string) ?? "client",
				regionCode,
				bandwidth: (attrs.bandwidth as string) ?? "1G",
				provider: (attrs.provider as string) ?? "",
				loopbackIpv4: computeLoopbackIPv4(nodeId),
				loopbackIpv6: computeLoopbackIPv6(regionCode, nodeId),
				lastSeen: attrs.lastSeen
					? (attrs.lastSeen as Date).toISOString()
					: null,
			};
		});

		// Build a uuid→name lookup for router resolution
		const routerNameMap = new Map(
			allRouters.map((r) => [r.get("uuid") as string, r.get("name") as string]),
		);

		const peers = allSessions.map((s) => {
			const attrs = s.get() as unknown as Record<string, unknown>;
			return {
				uuid: attrs.uuid as string,
				asn: attrs.asn as number,
				routerName: routerNameMap.get(attrs.router as string) ?? attrs.router,
				status: attrs.status as number,
				type: (attrs.type as string) ?? "wireguard",
				ipv4: attrs.ipv4 ?? null,
				ipv6: attrs.ipv6 ?? null,
				ipv6LinkLocal: attrs.ipv6LinkLocal ?? null,
				endpoint: attrs.endpoint ?? null,
				mtu: attrs.mtu ?? 1420,
				interface: attrs.interface ?? null,
				contact: attrs.contact ?? null,
				createdAt: attrs.createdAt
					? (attrs.createdAt as Date).toISOString()
					: null,
			};
		});

		const snapshot = {
			version: "3.0.0",
			generatedAt: new Date().toISOString(),
			nodesCount: nodes.length,
			peersCount: peers.length,
			nodes,
			peers,
		};

		// Compute integrity hash (deterministic JSON with recursive key sorting)
		// Sort arrays by stable keys (nodeId for nodes, uuid for peers) before hashing
		const sortedSnapshot = {
			...snapshot,
			nodes: [...snapshot.nodes].sort((a, b) => a.id - b.id),
			peers: [...snapshot.peers].sort((a, b) => a.uuid.localeCompare(b.uuid)),
		};
		const sortKeys = (_key: string, value: unknown) =>
			value && typeof value === "object" && !Array.isArray(value)
				? Object.keys(value as Record<string, unknown>)
						.sort()
						.reduce(
							(sorted, k) => {
								(sorted as Record<string, unknown>)[k] = (
									value as Record<string, unknown>
								)[k];
								return sorted;
							},
							{} as Record<string, unknown>,
						)
				: value;
		const snapshotStr = JSON.stringify(sortedSnapshot, sortKeys);
		const hashBuffer = new Bun.CryptoHasher("sha256")
			.update(snapshotStr)
			.digest("hex");

		return success(c, {
			...snapshot,
			snapshotHash: hashBuffer,
		});
	} catch (error) {
		console.error("[Admin] Error generating snapshot:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to generate snapshot",
		);
	}
}

/**
 * Register or update Telegram ID for a user.
 * Called by bot on login success and by auto-register middleware.
 */
async function registerTelegramId(
	c: Context,
	body: { asn?: number; telegramId?: number | string },
): Promise<Response> {
	const { asn, telegramId } = body;

	if (asn == null || telegramId == null) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing asn or telegramId",
		);
	}

	const models = getModels();

	try {
		const [user, created] = await models.users.findOrCreate({
			where: { asn: Number(asn) },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			defaults: {
				asn: Number(asn),
				telegramId: Number(telegramId),
				isAdmin: false,
				isBlocked: false,
			} as any,
		});

		if (!created) {
			await user.update({ telegramId: Number(telegramId) });
		}

		console.log(
			`[Admin] ${created ? "Created" : "Updated"} user AS${asn} with telegramId ${telegramId}`,
		);
		return success(c, { message: "User registered", created });
	} catch (error) {
		console.error("[Admin] Error registering telegramId:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to register user",
		);
	}
}

/**
 * Get notification targets — users with active BGP sessions and a registered telegramId.
 * Optionally filter by ASN list.
 */
async function getNotificationTargets(
	c: Context,
	body: { asns?: number[]; routers?: string[] },
): Promise<Response> {
	const models = getModels();

	try {
		let targetAsns: number[];

		if (body.asns && body.asns.length > 0) {
			// Targeted notification: query users directly by ASN (no bgp_sessions filter)
			targetAsns = body.asns.map(Number);
		} else {
			// Build where clause for bgp_sessions
			const sessionWhere: Record<string, unknown> = {
				status: {
					[Op.in]: [
						PeeringStatus.ENABLED,
						PeeringStatus.QUEUED_FOR_SETUP,
						PeeringStatus.PROBLEM,
					],
				},
			};

			// Optional: filter by specific routers (for node-targeted announcements)
			if (body.routers && body.routers.length > 0) {
				sessionWhere.router = { [Op.in]: body.routers };
			}

			const sessions = await models.bgpSessions.findAll({
				where: sessionWhere,
				attributes: ["asn"],
				group: ["asn"],
			});
			targetAsns = sessions.map((s) => s.get("asn") as number);
		}

		if (targetAsns.length === 0) {
			return success(c, { targets: [] });
		}

		// Find users with telegramId for those ASNs
		const users = await models.users.findAll({
			where: {
				asn: { [Op.in]: targetAsns },
				telegramId: { [Op.ne]: null },
			},
		});

		const targets = users.map((u) => ({
			asn: u.get("asn") as number,
			telegramId: u.get("telegramId") as number,
		}));

		// For ASNs not in users table, try to resolve via bgp_sessions.contact
		const foundAsns = new Set(targets.map((t) => t.asn));
		const missingAsns = targetAsns.filter((a) => !foundAsns.has(a));

		const emailFallbacks: Array<{ asn: number; email: string }> = [];
		if (missingAsns.length > 0) {
			const sessions = await models.bgpSessions.findAll({
				where: {
					asn: { [Op.in]: missingAsns },
					contact: { [Op.ne]: null },
				},
				attributes: ["asn", "contact"],
				group: ["asn", "contact"],
			});

			const redis = getRedis();

			for (const s of sessions) {
				const contact = ((s.get("contact") as string) || "").trim();
				const asn = s.get("asn") as number;

				// Already resolved this ASN
				if (foundAsns.has(asn)) continue;

				// Try to resolve @username via Redis cache
				let username: string | null = null;
				if (contact.startsWith("@")) {
					username = contact.slice(1).toLowerCase();
				} else if (contact.toLowerCase().startsWith("telegram:")) {
					// "telegram: @username" or "Telegram: @abc123"
					const match = contact.match(/@(\w+)/);
					if (match?.[1]) username = match[1].toLowerCase();
				}

				if (username) {
					try {
						const cachedId = await redis.get(`tg:username:${username}`);
						if (cachedId) {
							targets.push({ asn, telegramId: Number(cachedId) });
							foundAsns.add(asn);
							continue;
						}
					} catch {
						// Redis unavailable, skip
					}
				}

				// Email fallback: contact contains @ but is not a telegram username
				if (
					contact.includes("@") &&
					!contact.startsWith("@") &&
					!contact.toLowerCase().startsWith("telegram:")
				) {
					emailFallbacks.push({ asn, email: contact });
				}
			}
		}

		return success(c, { targets, emailFallbacks, allAsns: targetAsns });
	} catch (error) {
		console.error("[Admin] Error getting notification targets:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to get notification targets",
		);
	}
}

/**
 * Backfill contact info for sessions belonging to a given ASN.
 * Used by announce flow when dynamically fetching contacts from DN42 registry.
 */
async function updateSessionContact(
	c: Context,
	body: { asn?: number; contact?: string },
): Promise<Response> {
	const { asn, contact } = body;

	if (asn == null || !contact) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing asn or contact",
		);
	}

	const models = getModels();

	try {
		const [count] = await models.bgpSessions.update(
			{ contact },
			{
				where: {
					asn: Number(asn),
					contact: { [Op.or]: [null, ""] },
				},
			},
		);

		console.log(
			`[Admin] Backfilled contact for AS${asn}: ${contact} (${count} sessions)`,
		);
		return success(c, { updated: count });
	} catch (error) {
		console.error("[Admin] Error updating session contact:", error);
		return makeResponse(
			c,
			ResponseCode.INTERNAL_ERROR,
			undefined,
			"Failed to update contact",
		);
	}
}

/**
 * Send announcement emails in bulk.
 * Called by the bot after sending TG messages.
 */
async function sendBulkEmail(
	c: Context,
	body: {
		subject?: string;
		message?: string;
		targets?: Array<{ asn: number; email: string }>;
	},
): Promise<Response> {
	const { subject, message, targets } = body;

	if (!message || !targets || targets.length === 0) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing message or targets",
		);
	}

	const emailProvider = getEmailProvider();
	if (!emailProvider.isEnabled()) {
		return success(c, { sent: 0, warning: "Email service not configured" });
	}

	const emailSubject = subject || "[MoeNet DN42] Announcement";
	let sent = 0;
	let failed = 0;
	const errors: Array<{ asn: number; error: string }> = [];

	for (const target of targets) {
		const text =
			`MoeNet DN42 Announcement\n` +
			`========================\n\n` +
			`${message}\n\n` +
			`---\n` +
			`This email was sent to AS${target.asn}.\n` +
			`MoeNet DN42 - https://dn42.moenet.work`;

		const result = await emailProvider.send({
			to: target.email,
			subject: emailSubject,
			text,
		});

		if (result.success) {
			sent++;
		} else {
			failed++;
			errors.push({ asn: target.asn, error: result.error || "Unknown error" });
		}
	}

	console.log(`[Admin] Bulk email: ${sent} sent, ${failed} failed`);
	return success(c, { sent, failed, errors });
}

/**
 * Store pending migration notifications in Redis.
 * One key per ASN with 24h TTL.
 */
async function storeMigrationNotify(
	c: Context,
	body: {
		asns?: number[];
		fromRouter?: string;
		toRouter?: string;
		adminChatId?: number;
	},
): Promise<Response> {
	const { asns, fromRouter, toRouter, adminChatId } = body;
	if (!asns || !fromRouter || !toRouter) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing asns, fromRouter, or toRouter",
		);
	}

	const redis = getRedis();
	const payload = JSON.stringify({ fromRouter, toRouter, adminChatId });
	const TTL_SECONDS = 86400; // 24 hours

	for (const asn of asns) {
		await redis.set(`migrate:notify:${asn}`, payload, "EX", TTL_SECONDS);
	}

	console.log(
		`[Admin] Stored ${asns.length} migration notification(s) pending: ${fromRouter} → ${toRouter}`,
	);
	return success(c, { stored: asns.length });
}

/**
 * Check if any migrated sessions are now ENABLED and return those ready for notification.
 * Called periodically by the bot.
 */
async function checkMigrationNotify(
	c: Context,
	_body: Record<string, unknown>,
): Promise<Response> {
	const redis = getRedis();
	const models = getModels();

	// Scan for pending migration notification keys
	const keys = await redis.keys("migrate:notify:*");
	if (keys.length === 0) {
		return success(c, { ready: [], pending: 0 });
	}

	const ready: Array<{
		asn: number;
		fromRouter: string;
		toRouter: string;
		adminChatId?: number;
		serverEndpoint: string | null;
	}> = [];

	for (const key of keys) {
		const asn = Number(key.split(":").pop());
		if (Number.isNaN(asn)) continue;

		const raw = await redis.get(key);
		if (!raw) continue;

		const data = JSON.parse(raw) as {
			fromRouter: string;
			toRouter: string;
			adminChatId?: number;
		};

		// Check if this ASN has an ENABLED session (setup completed)
		const session = await models.bgpSessions.findOne({
			where: { asn, status: PeeringStatus.ENABLED },
			attributes: ["uuid", "router", "credential"],
		});

		if (session) {
			// Resolve server endpoint
			const routerUuid = session.get("router") as string;
			const router = await models.routers.findOne({
				where: { uuid: routerUuid },
			});
			const publicIp = router?.get("publicIp") as string | null;

			let serverEndpoint: string | null = null;
			const credential = session.get("credential") as string | null;
			if (credential) {
				try {
					const cred = JSON.parse(credential);
					if (publicIp && cred.listen_port) {
						serverEndpoint = `${publicIp}:${cred.listen_port}`;
					}
				} catch {
					/* ignore */
				}
			}

			ready.push({
				asn,
				fromRouter: data.fromRouter,
				toRouter: data.toRouter,
				adminChatId: data.adminChatId,
				serverEndpoint,
			});

			// Clean up — notification consumed
			await redis.del(key);
		}
	}

	return success(c, { ready, pending: keys.length - ready.length });
}
