import type { Context } from "hono";
import { verify } from "hono/jwt";
import { generateUUID, getInterfaceName } from "../common/helpers";
import { makeResponse, ResponseCode, success } from "../common/response";
import config from "../config";
import { getModels } from "../db/dbContext";
import { PeeringStatus, SessionPolicy } from "../db/models/bgpSessions";
import {
	type CreateSessionInput,
	type DeleteSessionInput,
	type GetSessionInput,
	PeeringRequestSchema,
} from "../schemas/peering";
import { isValidationError, validateBody } from "../schemas/validate";
import { determineInitialStatus } from "../services/workflowEngine";

interface JWTPayload {
	asn: string;
	person: string;
}

/**
 * Peering Handler - Session management
 *
 * Actions:
 * - create: Create new peering session
 * - list: List user's sessions
 * - get: Get session details
 * - delete: Request session deletion
 */
export default async function peeringHandler(c: Context): Promise<Response> {
	const parsed = await validateBody(c, PeeringRequestSchema);
	if (isValidationError(parsed)) return parsed;

	// Verify JWT token
	const authHeader = c.req.header("Authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return makeResponse(c, ResponseCode.UNAUTHORIZED);
	}

	let user: JWTPayload;
	try {
		user = (await verify(
			authHeader.substring(7),
			config.auth.jwtSecret,
			"HS256",
		)) as unknown as JWTPayload;
	} catch {
		return makeResponse(
			c,
			ResponseCode.UNAUTHORIZED,
			undefined,
			"Invalid token",
		);
	}

	switch (parsed.action) {
		case "create":
			return await createSession(c, parsed as CreateSessionInput, user);
		case "list":
			return await listSessions(c, user);
		case "get":
			return await getSession(c, parsed as GetSessionInput, user);
		case "update":
			return await updateSession(c, parsed, user);
		case "delete":
			return await deleteSession(c, parsed as DeleteSessionInput, user);
		default:
			return makeResponse(
				c,
				ResponseCode.VALIDATION_ERROR,
				undefined,
				"Invalid action",
			);
	}
}

interface CreateSessionRequest {
	router: string;
	endpoint?: string;
	publicKey?: string;
	ipv4?: string;
	ipv6?: string;
	ipv6LinkLocal?: string;
	mtu?: number;
	extensions?: string[];
}

/**
 * Create a new peering session
 */
async function createSession(
	c: Context,
	input: CreateSessionInput,
	user: JWTPayload,
): Promise<Response> {
	const data = input.data; // Already validated

	const models = getModels();
	const asn = Number(user.asn);

	// Check if router exists
	const router = await models.routers.findOne({
		where: { uuid: data.router },
	});

	if (!router) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Router not found",
		);
	}

	// Check if session already exists
	const existingSession = await models.bgpSessions.findOne({
		where: {
			router: data.router,
			asn,
		},
	});

	if (existingSession) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Session already exists",
		);
	}

	// Create new session
	const sessionUuid = generateUUID();
	const interfaceName = getInterfaceName(asn);

	// Determine initial status via workflow engine (auto-approve / blacklist / manual)
	const { status: initialStatus, workflowType } =
		await determineInitialStatus(asn);

	await models.bgpSessions.create({
		uuid: sessionUuid,
		router: data.router,
		asn,
		status: initialStatus,
		mtu: data.mtu || 1420,
		policy: SessionPolicy.FULL,
		ipv4: data.ipv4 || null,
		ipv6: data.ipv6 || null,
		ipv6LinkLocal: data.ipv6LinkLocal || null,
		type: "wireguard",
		extensions: data.extensions ? JSON.stringify(data.extensions) : null,
		interface: interfaceName,
		endpoint: data.endpoint || null,
		credential: data.publicKey || null,
		data: null,
		lastError:
			initialStatus === PeeringStatus.REJECTED ? "ASN is blocked" : null,
	});

	const messages: Record<string, string> = {
		manual: "Session created, pending review",
		auto_approve: "Session created, auto-approved and queued for setup",
		auto_reject: "Session rejected — ASN is blocked",
	};

	console.log(
		`[Peering] Created session ${sessionUuid} for AS${asn}, workflow: ${workflowType}`,
	);

	return success(c, {
		uuid: sessionUuid,
		status: initialStatus,
		workflowType,
		message: messages[workflowType] || "Session created",
	});
}

/**
 * List user's sessions
 */
async function listSessions(c: Context, user: JWTPayload): Promise<Response> {
	const models = getModels();
	const asn = Number(user.asn);

	const sessions = await models.bgpSessions.findAll({
		attributes: [
			"uuid",
			"router",
			"status",
			"ipv4",
			"ipv6",
			"mtu",
			"lastError",
			"credential",
			"created_at",
		],
		where: { asn },
	});

	// Resolve router info for server endpoint display
	const routerUuids = [
		...new Set(sessions.map((s) => s.get("router") as string)),
	];
	const routers =
		routerUuids.length > 0
			? await models.routers.findAll({ where: { uuid: routerUuids } })
			: [];
	const routerMap = new Map(
		routers.map((r) => [
			r.get("uuid") as string,
			{
				name: r.get("name") as string,
				publicIp: r.get("publicIp") as string | null,
				publicIpv6: r.get("publicIpv6") as string | null,
				wgPublicKey: r.get("wgPublicKey") as string | null,
			},
		]),
	);

	return success(c, {
		sessions: sessions.map((s: { get: (key?: string) => unknown }) => {
			const raw = s.get() as Record<string, unknown>;
			const routerInfo = routerMap.get(raw.router as string);

			// Extract listen_port from credential JSON
			let listenPort: number | null = null;
			if (raw.credential && typeof raw.credential === "string") {
				try {
					const cred = JSON.parse(raw.credential);
					if (cred.listen_port) listenPort = cred.listen_port;
				} catch {
					/* ignore parse errors */
				}
			}

			// Build server endpoint
			let serverEndpoint: string | null = null;
			if (routerInfo?.publicIp && listenPort) {
				serverEndpoint = `${routerInfo.publicIp}:${listenPort}`;
			} else if (routerInfo?.publicIpv6 && listenPort) {
				serverEndpoint = `[${routerInfo.publicIpv6}]:${listenPort}`;
			}

			// Don't expose raw credential to user, only server-side info
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { credential: _cred, ...sessionData } = raw;
			return {
				...sessionData,
				routerName: routerInfo?.name || raw.router,
				serverEndpoint,
				serverWgKey: routerInfo?.wgPublicKey || null,
			};
		}),
	});
}

/**
 * Get session details
 */
async function getSession(
	c: Context,
	input: GetSessionInput,
	user: JWTPayload,
): Promise<Response> {
	const { uuid } = input; // Already validated

	const models = getModels();
	const asn = Number(user.asn);

	const session = await models.bgpSessions.findOne({
		where: { uuid, asn },
	});

	if (!session) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Session not found",
		);
	}

	return success(c, { session: session.get() });
}

/**
 * Request session deletion
 */
async function deleteSession(
	c: Context,
	input: DeleteSessionInput,
	user: JWTPayload,
): Promise<Response> {
	const { uuid } = input; // Already validated

	const models = getModels();
	const asn = Number(user.asn);

	const [updated] = await models.bgpSessions.update(
		{ status: PeeringStatus.QUEUED_FOR_DELETE },
		{ where: { uuid, asn } },
	);

	if (!updated) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Session not found",
		);
	}

	return success(c, { message: "Session queued for deletion" });
}

/**
 * Update session fields
 */
async function updateSession(
	c: Context,
	input: { uuid: string; [key: string]: unknown },
	user: JWTPayload,
): Promise<Response> {
	const { uuid, ...updates } = input;

	if (!uuid) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing uuid",
		);
	}

	const models = getModels();
	const asn = Number(user.asn);

	// Define allowed fields for update
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
		"psk",
	];

	// Build update object with only allowed fields
	const updateData: Record<string, unknown> = {};
	for (const field of allowedFields) {
		if (field in updates) {
			// Handle PSK specially - store in credential field as JSON
			if (field === "psk") {
				// Parse existing credential JSON or create new
				const credentialValue = updates[field];
				updateData.credential = credentialValue
					? JSON.stringify({ pubkey: null, psk: credentialValue })
					: null;
			} else if (field === "credential") {
				// If credential is a pubkey string
				const credValue = updates[field] as string;
				updateData.credential = credValue
					? JSON.stringify({ pubkey: credValue, psk: null })
					: null;
			} else {
				updateData[field] = updates[field];
			}
		}
	}

	if (Object.keys(updateData).length === 0) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"No valid fields to update",
		);
	}

	const [updatedCount] = await models.bgpSessions.update(updateData, {
		where: { uuid, asn },
	});

	if (!updatedCount) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Session not found",
		);
	}

	return success(c, { message: "Session updated successfully" });
}
