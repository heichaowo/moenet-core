import type { Context } from "hono";
import { Op } from "sequelize";
import { timingSafeCompare } from "../common/helpers";
import { makeResponse, ResponseCode, success } from "../common/response";
import config from "../config";
import { getModels } from "../db/dbContext";
import {
	type BgpSessionAttributes,
	PeeringStatus,
} from "../db/models/bgpSessions";
import { getRedis } from "../db/redisContext";
import {
	computeLoopbackIPv4,
	computeLoopbackIPv6,
	deriveLLAFromLoopback,
} from "../services/ipAllocator";

/**
 * Map regionCode to continent and subregion LC constants
 * RegionCode format: 1xx=Asia, 2xx=NA, 3xx=EU, 4xx=OC, 5xx=Other
 */
function getRegionLCs(regionCode: number): {
	continentLc: string;
	subregionLc: string;
} {
	const subregionMap: Record<number, string> = {
		101: "LC_REGION_AS_E", // East Asia
		102: "LC_REGION_AS_SE", // Southeast Asia
		103: "LC_REGION_AS_S", // South Asia
		104: "LC_REGION_AS_N", // North Asia
		201: "LC_REGION_NA_E", // North America East
		202: "LC_REGION_NA_C", // North America Central
		203: "LC_REGION_NA_W", // North America West
		204: "LC_REGION_CA", // Central America
		205: "LC_REGION_SA", // South America
		301: "LC_REGION_EU_W", // Europe West
		302: "LC_REGION_EU_C", // Europe Central
		303: "LC_REGION_EU_E", // Europe East
		401: "LC_REGION_OC", // Oceania
		501: "LC_REGION_AF", // Africa
		502: "LC_REGION_ME", // Middle East
	};

	const continentMap: Record<number, string> = {
		1: "LC_ORIGIN_AS",
		2: "LC_ORIGIN_NA",
		3: "LC_ORIGIN_EU",
		4: "LC_ORIGIN_OC",
		5: "LC_ORIGIN_OTHER",
	};

	const continent = Math.floor(regionCode / 100);
	return {
		continentLc: continentMap[continent] || "LC_ORIGIN_AS",
		subregionLc: subregionMap[regionCode] || "LC_REGION_AS_E",
	};
}

/**
 * Map regionCode to DN42 region community constant name
 */
function getRegionCommunity(regionCode: number): string {
	const regionMap: Record<number, string> = {
		101: "DN42_REGION_AS_E", // East Asia
		102: "DN42_REGION_AS_SE", // Southeast Asia
		103: "DN42_REGION_AS_S", // South Asia
		104: "DN42_REGION_AS_N", // North Asia
		201: "DN42_REGION_NA_E", // North America East
		202: "DN42_REGION_NA_C", // North America Central
		203: "DN42_REGION_NA_W", // North America West
		204: "DN42_REGION_CA", // Central America
		205: "DN42_REGION_SA", // South America
		301: "DN42_REGION_EU", // Europe (DN42 uses single EU)
		302: "DN42_REGION_EU", // Europe
		303: "DN42_REGION_EU", // Europe
		401: "DN42_REGION_OC", // Oceania
		501: "DN42_REGION_AF", // Africa
		502: "DN42_REGION_ME", // Middle East
	};
	return regionMap[regionCode] || "DN42_REGION_AS_E";
}

/**
 * Map bandwidth string to DN42 bandwidth community constant name
 */
function getBandwidthCommunity(bandwidth: string): string {
	const bwMap: Record<string, string> = {
		"10G": "DN42_BW_10G_PLUS",
		"5G": "DN42_BW_1G_PLUS",
		"2G": "DN42_BW_1G_PLUS",
		"1G": "DN42_BW_1G_PLUS",
		"500M": "DN42_BW_100M_PLUS",
		"200M": "DN42_BW_100M_PLUS",
		"100M": "DN42_BW_100M_PLUS",
		"50M": "DN42_BW_10M_PLUS",
		"10M": "DN42_BW_10M_PLUS",
		"100K": "DN42_BW_100K_PLUS",
	};
	return bwMap[bandwidth?.toUpperCase()] || "DN42_BW_1G_PLUS";
}

/**
 * Verify agent API key (simple token comparison)
 */
async function verifyAgentApiKey(
	c: Context,
	_router: string,
): Promise<boolean> {
	const header = c.req.header("Authorization");
	if (!header) return false;

	const token = header.split("Bearer ")[1];
	if (!token) return false;

	// Simple token comparison
	return config.auth.agentApiKey
		? timingSafeCompare(token, config.auth.agentApiKey)
		: false;
}

/**
 * Agent API Handler
 *
 * Routes:
 * - GET/POST /agent/:router/sessions - Get sessions for agent
 * - POST /agent/:router/modify - Modify session status
 * - POST /agent/:router/report - Report metrics
 * - POST /agent/:router/heartbeat - Agent heartbeat
 * - POST /agent/heartbeat - Global heartbeat (node_id in body)
 */
export default async function agentHandler(c: Context): Promise<Response> {
	const { action, router } = c.req.param();

	// Handle global heartbeat (no router in path, node_id in body)
	if (c.req.path === "/api/v1/agent/heartbeat" && !router) {
		return handleGlobalHeartbeat(c);
	}

	// Handle mesh/status nested route
	const meshStatusMatch = c.req.path.match(
		/^\/api\/v1\/agent\/([^/]+)\/mesh\/status$/,
	);
	if (meshStatusMatch) {
		const routerName = meshStatusMatch[1] as string;
		if (!(await verifyAgentApiKey(c, routerName))) {
			return makeResponse(c, ResponseCode.UNAUTHORIZED);
		}
		const models = getModels();
		const routerRecord = await models.routers.findOne({
			where: { name: routerName },
		});
		if (!routerRecord) {
			return makeResponse(
				c,
				ResponseCode.NOT_FOUND,
				undefined,
				"Router not found",
			);
		}
		return handleMeshStatus(c, routerRecord.get("uuid") as string);
	}

	if (!router || !action) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Missing router or action",
		);
	}

	// Verify API key
	if (!(await verifyAgentApiKey(c, router))) {
		return makeResponse(c, ResponseCode.UNAUTHORIZED);
	}

	// Verify router exists (lookup by name OR uuid if valid)
	const models = getModels();
	const isUuid =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			router,
		);
	const whereClause = isUuid
		? { [Op.or]: [{ uuid: router }, { name: router }] }
		: { name: router };

	const routerRecord = await models.routers.findOne({
		where: whereClause,
	});

	if (!routerRecord) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Router not found",
		);
	}

	const routerUuid = routerRecord.get("uuid") as string;

	// Route to appropriate handler
	switch (action) {
		case "sessions":
			return await handleSessions(c, routerUuid);
		case "modify":
			return await handleModify(c, routerUuid);
		case "report":
			return await handleReport(c, routerUuid);
		case "heartbeat":
			return await handleHeartbeat(c, routerUuid);
		case "mesh":
			return await handleMesh(c, routerUuid, routerRecord);
		case "mesh/status":
			return await handleMeshStatus(c, routerUuid);
		case "config":
			return await handleConfig(c, routerRecord);
		case "bird-config":
			return await handleBirdConfig(c, routerRecord);
		case "rtt":
			return await handleRtt(c, routerUuid);
		default:
			return makeResponse(
				c,
				ResponseCode.NOT_FOUND,
				undefined,
				`Unknown action: ${action}`,
			);
	}
}

/**
 * GET /agent/:router/sessions
 * Returns all BGP sessions for the agent to configure
 */
async function handleSessions(c: Context, router: string): Promise<Response> {
	const models = getModels();

	const sessions = await models.bgpSessions.findAll({
		attributes: [
			"uuid",
			"asn",
			"status",
			"ipv4",
			"ipv6",
			"ipv6LinkLocal",
			"type",
			"extensions",
			"interface",
			"endpoint",
			"credential",
			"data",
			"mtu",
			"policy",
			"lastError",
			"contact",
		],
		where: { router },
	});

	const bgpSessions = sessions.map((session: { get: () => unknown }) => {
		const s = session.get() as BgpSessionAttributes;
		// Extract listen_port from credential JSON for firewall sync
		let port = 0;
		if (s.credential) {
			try {
				const cred =
					typeof s.credential === "string"
						? JSON.parse(s.credential)
						: s.credential;
				if (cred?.listen_port) port = cred.listen_port;
			} catch {
				/* ignore parse errors */
			}
		}
		return {
			uuid: s.uuid,
			asn: parseInt(String(s.asn), 10), // Convert to number for Go agent
			name: `AS${s.asn}`,
			description: s.contact
				? `AS${s.asn} - ${String(s.contact).replace(/[";{}\\]/g, "")}`
				: `AS${s.asn}`,
			status: s.status,
			ipv4: s.ipv4,
			ipv6: s.ipv6,
			ipv6LinkLocal: s.ipv6LinkLocal,
			type: (s.type || "").toLowerCase(),
			extensions:
				typeof s.extensions === "string"
					? JSON.parse(s.extensions)
					: s.extensions || [],
			interface: s.interface,
			endpoint: s.endpoint,
			credential:
				typeof s.credential === "string"
					? s.credential
					: s.credential
						? JSON.stringify(s.credential)
						: "",
			data: typeof s.data === "string" ? JSON.parse(s.data) : s.data || null,
			mtu: s.mtu,
			port,
			policy: s.policy,
			lastError: s.lastError,
		};
	});

	return success(c, { bgpSessions });
}

/**
 * POST /agent/:router/modify
 * Modify a session status
 */
async function handleModify(c: Context, router: string): Promise<Response> {
	const body = await c.req.json();
	// Accept both 'uuid' and 'peer_id' — agent sends 'peer_id'
	const uuid = body.uuid || body.peer_id;
	const { lastError } = body;

	// Map string status to PeeringStatus enum if needed
	let status = body.status;
	if (typeof status === "string") {
		const statusMap: Record<string, PeeringStatus> = {
			active: PeeringStatus.ENABLED,
			enabled: PeeringStatus.ENABLED,
			problem: PeeringStatus.PROBLEM,
			deleted: PeeringStatus.TEARDOWN,
		};
		status = statusMap[status] ?? status;
	}

	if (!uuid || status === undefined) {
		console.log(
			"[handleModify] REJECTED - uuid:",
			uuid,
			"body:",
			JSON.stringify(body),
		);
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing uuid or status",
		);
	}

	const models = getModels();

	// If agent reports deletion complete (status=0), destroy the session row
	if (status === 0) {
		const deleted = await models.bgpSessions.destroy({
			where: { uuid, router },
		});
		if (!deleted) {
			return makeResponse(
				c,
				ResponseCode.NOT_FOUND,
				undefined,
				"Session not found",
			);
		}
		console.log(
			`[handleModify] Destroyed session ${uuid} (agent reported deletion complete)`,
		);
		return success(c, { deleted: true });
	}

	const [updated] = await models.bgpSessions.update(
		{
			status: status as PeeringStatus,
			lastError: lastError || null,
		},
		{ where: { uuid, router } },
	);

	if (!updated) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Session not found",
		);
	}

	return success(c, { updated: true });
}

/**
 * POST /agent/:router/report
 * Receive metrics from agent and store in Redis
 */
async function handleReport(c: Context, router: string): Promise<Response> {
	const body = await c.req.json();
	const { sessions, node_id, timestamp } = body;

	if (!sessions || !Array.isArray(sessions)) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing sessions array",
		);
	}

	try {
		const redis = getRedis();
		const pipeline = redis.pipeline();
		const reportTs = timestamp || Date.now();

		// Store each session's metrics
		for (const session of sessions) {
			if (session.name && session.state) {
				const key = `metrics:${router}:${session.name}`;
				pipeline.hset(key, {
					state: session.state,
					info: session.info || "",
					type: session.type || "bgp",
					timestamp: reportTs,
				});
				pipeline.expire(key, 3600); // 1 hour TTL
			}
		}

		// Store summary for this router
		const summaryKey = `metrics:${router}:_summary`;
		pipeline.hset(summaryKey, {
			sessionCount: sessions.length,
			lastReport: reportTs,
			nodeId: node_id || router,
		});
		pipeline.expire(summaryKey, 3600);

		await pipeline.exec();

		console.log(`[Agent ${router}] Report: ${sessions.length} sessions stored`);
	} catch (error) {
		console.error(`[Agent ${router}] Metrics storage error:`, error);
	}

	return success(c, { received: true, count: sessions?.length || 0 });
}

/**
 * POST /agent/:router/heartbeat
 * Receive heartbeat from agent
 */
async function handleHeartbeat(c: Context, router: string): Promise<Response> {
	const body = await c.req.json();
	const models = getModels();

	// Update last_seen timestamp
	await models.routers.update(
		{ lastSeen: new Date() },
		{ where: { uuid: router } },
	);

	console.log(`[Agent ${router}] Heartbeat:`, body);

	return success(c, {
		received: true,
		timestamp: Date.now(),
	});
}

/**
 * POST /agent/heartbeat (global)
 * Receive heartbeat from agent with node_id in body
 */
async function handleGlobalHeartbeat(c: Context): Promise<Response> {
	// Verify API key (no router param)
	const header = c.req.header("Authorization");
	if (!header) {
		return makeResponse(c, ResponseCode.UNAUTHORIZED);
	}
	const token = header.split("Bearer ")[1];
	if (
		!token ||
		!config.auth.agentApiKey ||
		!timingSafeCompare(token, config.auth.agentApiKey)
	) {
		return makeResponse(c, ResponseCode.UNAUTHORIZED);
	}

	const body = await c.req.json();
	const nodeId = body.node_id;
	const status = body.status || {};

	if (!nodeId) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing node_id",
		);
	}

	const models = getModels();

	// Build update payload - always include lastSeen
	const updatePayload: Record<string, unknown> = {
		lastSeen: new Date(),
	};

	// Update mesh_public_key and wg_public_key if provided
	// Both fields use the same public key from /etc/wireguard/public.key
	if (status.meshPublicKey) {
		updatePayload.meshPublicKey = status.meshPublicKey;
		updatePayload.wgPublicKey = status.meshPublicKey;
		console.log(
			`[Agent ${nodeId}] Updated meshPublicKey + wgPublicKey: ${status.meshPublicKey.substring(0, 20)}...`,
		);
	}

	// Update public IPs if provided
	if (status.publicIpv4) {
		updatePayload.publicIp = status.publicIpv4;
		console.log(`[Agent ${nodeId}] Updated IPv4: ${status.publicIpv4}`);
	}
	if (status.publicIpv6) {
		updatePayload.publicIpv6 = status.publicIpv6;
		console.log(`[Agent ${nodeId}] Updated IPv6: ${status.publicIpv6}`);
	}

	await models.routers.update(updatePayload, { where: { name: nodeId } });

	console.log(
		`[Agent ${nodeId}] Heartbeat: load=${status.loadAvg}, uptime=${status.uptime}s`,
	);

	return success(c, {
		received: true,
		timestamp: Date.now(),
	});
}

/**
 * GET /agent/:router/mesh
 * Returns mesh peer configuration for WireGuard tunnel setup
 *
 * Regional topology:
 * - Intra-region: Full mesh (all nodes in same region connect to each other)
 * - Inter-region: Only RRs connect to RRs in other regions
 */
async function handleMesh(
	c: Context,
	router: string,
	// biome-ignore lint/suspicious/noExplicitAny: Sequelize model instance
	routerRecord: any,
): Promise<Response> {
	const models = getModels();

	// Build self info from the requesting router
	const selfNodeId = (routerRecord.get("nodeId") as number) ?? 0;
	const selfNodeName = routerRecord.get("name") as string;
	const selfNodeType = (routerRecord.get("nodeType") as string) ?? "client";
	const selfRegionCode = (routerRecord.get("regionCode") as number) ?? 0;
	const selfIsRr = selfNodeType === "rr" || selfNodeName.includes("-rr");

	const self = {
		nodeId: selfNodeId,
		nodeName: selfNodeName,
		nodeType: selfNodeType,
		regionCode: selfRegionCode,
		loopbackIpv4: computeLoopbackIPv4(selfNodeId),
		loopbackIpv6: computeLoopbackIPv6(selfRegionCode, selfNodeId),
		isRr: selfIsRr,
	};

	// Get all routers except the requesting one
	const allRouters = await models.routers.findAll({
		attributes: [
			"uuid",
			"name",
			"publicIp",
			"meshPublicKey",
			"nodeId",
			"dn42Loopback4",
			"dn42Loopback6",
			"nodeType",
			"regionCode",
		],
		where: {
			uuid: { [Op.ne]: router },
		},
	});

	// Filter peers based on regional topology
	const peers = allRouters
		.map((r: { get: (key: string) => unknown }) => {
			const nodeName = r.get("name") as string;
			const nodeType = (r.get("nodeType") as string) ?? "client";
			const nodeId = (r.get("nodeId") as number) ?? 0;
			const peerRegionCode = (r.get("regionCode") as number) ?? 0;
			const peerIsRr = nodeType === "rr" || nodeName.includes("-rr");

			return {
				nodeId,
				nodeName,
				nodeType,
				regionCode: peerRegionCode,
				loopbackIpv4: computeLoopbackIPv4(nodeId),
				loopbackIpv6: computeLoopbackIPv6(peerRegionCode, nodeId),
				publicKey: (r.get("meshPublicKey") as string) ?? "",
				// Peer listens on 51820 + requester's nodeId (for this specific connection)
				endpoint: r.get("publicIp")
					? `${r.get("publicIp")}:${51820 + selfNodeId}`
					: "",
				mtu: 1420,
				isRr: peerIsRr,
			};
		})
		.filter((peer) => {
			// Same region: always connect (intra-region full mesh)
			if (peer.regionCode === selfRegionCode) {
				return true;
			}
			// Different region: only RR-to-RR connections
			// Self is RR and peer is RR = connect
			if (selfIsRr && peer.isRr) {
				return true;
			}
			// Client nodes don't connect to other regions
			return false;
		});

	return success(c, {
		self,
		peers,
	});
}

/**
 * POST /agent/:router/mesh/status
 * Receives mesh tunnel status reports from agents
 */
async function handleMeshStatus(
	c: Context,
	_router: string,
): Promise<Response> {
	const body = await c.req.json().catch(() => ({}));
	const { node_id, timestamp, peers } = body;

	// Log mesh status (can be extended to store in DB or emit events)
	console.log(`[MeshStatus] ${node_id} reported at ${timestamp}:`, peers);

	// Store mesh status in Redis for real-time monitoring (optional)
	// For now, just acknowledge receipt
	return success(c, {
		received: true,
		timestamp: Date.now(),
	});
}

/**
 * GET /agent/:router/config
 * Returns agent configuration for bootstrap mode
 */
async function handleConfig(
	c: Context,
	// biome-ignore lint/suspicious/noExplicitAny: Sequelize model instance
	routerRecord: any,
): Promise<Response> {
	const name = routerRecord.get("name") as string;
	const region = routerRecord.get("region") as string;
	const location = routerRecord.get("location") as string;

	// Build agent configuration
	const agentConfig = {
		node: {
			name,
			id: (routerRecord.get("nodeId") as number) ?? 0,
			region,
			location,
			provider: (routerRecord.get("provider") as string) ?? "",
		},
		bird: {
			controlSocket: "/var/run/bird/run/bird.ctl",
			poolSize: 5,
			poolSizeMax: 64,
			peerConfDir: "/etc/bird/peers",
			ebgpConfTemplateFile: "/opt/moenet-agent/templates/ebgp.conf.tmpl",
			ibgpConfDir: "/etc/bird/ibgp.d",
		},
		wireguard: {
			privateKeyPath: "/etc/wireguard/private.key",
			publicKeyPath: "/etc/wireguard/public.key",
			configDir: "/etc/wireguard",
			persistentKeepaliveInterval: 25,
			// Compute loopback addresses from nodeId and regionCode
			dn42Ipv4: computeLoopbackIPv4(
				(routerRecord.get("nodeId") as number) ?? 0,
			),
			dn42Ipv6: computeLoopbackIPv6(
				(routerRecord.get("regionCode") as number) ?? 0,
				(routerRecord.get("nodeId") as number) ?? 0,
			),
			// Derive LLA from computed loopback
			dn42Ipv6LinkLocal: deriveLLAFromLoopback(
				computeLoopbackIPv6(
					(routerRecord.get("regionCode") as number) ?? 0,
					(routerRecord.get("nodeId") as number) ?? 0,
				),
			),
		},
		metric: {
			pingTimeout: 5,
			pingCount: 4,
			pingWorkers: 32,
		},
		autoUpdate: {
			enabled: true,
			checkInterval: 60,
			channel: "stable",
			githubRepo: "heichaowo/moenet-agent",
		},
	};

	return success(c, agentConfig);
}

/**
 * POST /agent/:router/rtt
 * Receive RTT measurements from agent and store in Redis
 */
async function handleRtt(c: Context, router: string): Promise<Response> {
	const body = await c.req.json();
	const { measurements } = body;

	if (!measurements || !Array.isArray(measurements)) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing measurements array",
		);
	}

	try {
		const redis = getRedis();
		const timestamp = Date.now();

		// Store RTT data in Redis hash with 1 hour TTL
		const key = `rtt:${router}`;
		const pipeline = redis.pipeline();

		for (const m of measurements) {
			if (m.target && typeof m.rtt_ms === "number") {
				pipeline.hset(
					key,
					m.target,
					JSON.stringify({
						rtt_ms: m.rtt_ms,
						loss: m.loss ?? 0,
						timestamp,
					}),
				);
			}
		}

		pipeline.expire(key, 3600); // 1 hour TTL
		await pipeline.exec();

		console.log(
			`[Agent ${router}] RTT: received ${measurements.length} measurements`,
		);

		return success(c, {
			received: true,
			count: measurements.length,
		});
	} catch (error) {
		console.error(`[Agent ${router}] RTT storage error:`, error);
		return success(c, {
			received: true,
			warning: "Redis unavailable, data not stored",
		});
	}
}

/**
 * GET /agent/:router/bird-config
 * Returns BIRD configuration parameters for agent to render templates
 */
async function handleBirdConfig(
	c: Context,
	// biome-ignore lint/suspicious/noExplicitAny: Sequelize model instance
	routerRecord: any,
): Promise<Response> {
	const models = getModels();

	// Get default BIRD policy
	const policy = await models.birdPolicies.findOne({
		where: { isDefault: true },
	});

	if (!policy) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"No default BIRD policy configured",
		);
	}

	const policyData = policy.get() as unknown as Record<string, unknown>;

	// Get router-specific settings
	const nodeId = (routerRecord.get("nodeId") as number) ?? 0;
	const nodeName = routerRecord.get("name") as string;
	const nodeType = (routerRecord.get("nodeType") as string) ?? "client";
	const regionCode = (routerRecord.get("regionCode") as number) ?? 0;
	const bandwidth = (routerRecord.get("bandwidth") as string) ?? "1G";
	// Compute loopback addresses from regionCode and nodeId (authoritative source)
	const loopback4 = computeLoopbackIPv4(nodeId);
	const loopback6 = computeLoopbackIPv6(regionCode, nodeId);
	const selfIsRr = nodeType === "rr" || nodeName.includes("-rr");

	// Get all other routers for iBGP peer filtering
	const allRouters = await models.routers.findAll({
		attributes: [
			"uuid",
			"name",
			"dn42Loopback4",
			"dn42Loopback6",
			"nodeId",
			"nodeType",
			"regionCode",
		],
		where: {
			uuid: { [Op.ne]: routerRecord.get("uuid") },
		},
	});

	// Filter iBGP peers based on node type:
	// - RR: connect to ALL other RRs (6 RR full mesh)
	// - Client: connect only to RRs in same region
	const ibgpPeers = allRouters
		.map((r: { get: (key: string) => unknown }) => ({
			nodeId: (r.get("nodeId") as number) ?? 0,
			nodeName: r.get("name") as string,
			nodeType: (r.get("nodeType") as string) ?? "client",
			regionCode: (r.get("regionCode") as number) ?? 0,
			// Compute loopback addresses from regionCode and nodeId
			loopbackIpv4: computeLoopbackIPv4((r.get("nodeId") as number) ?? 0),
			loopbackIpv6: computeLoopbackIPv6(
				(r.get("regionCode") as number) ?? 0,
				(r.get("nodeId") as number) ?? 0,
			),
			isRr:
				((r.get("nodeType") as string) ?? "") === "rr" ||
				(r.get("name") as string).includes("-rr"),
		}))
		.filter((peer) => {
			if (selfIsRr) {
				// RR connects to:
				// 1. All other RRs (regardless of region) - for RR full mesh
				// 2. Clients in the same region - RR reflects routes to local clients
				return peer.isRr || peer.regionCode === regionCode;
			}
			// Client connects only to RRs in same region
			return peer.isRr && peer.regionCode === regionCode;
		});

	// Build configuration hash for change detection
	const configHash = Bun.hash(
		JSON.stringify({
			policy: policyData,
			nodeId,
			bandwidth,
			regionCode,
			ibgpPeers: ibgpPeers.length,
		}),
	).toString(16);

	const regionLCs = getRegionLCs(regionCode);

	return success(c, {
		configHash,
		node: {
			id: nodeId,
			name: nodeName,
			type: nodeType,
			bandwidth,
			regionCode,
			loopbackIpv4: loopback4,
			loopbackIpv6: loopback6,
			continentLc: regionLCs.continentLc,
			subregionLc: regionLCs.subregionLc,
			regionCommunity: getRegionCommunity(regionCode),
			bandwidthCommunity: getBandwidthCommunity(bandwidth),
		},
		policy: {
			dn42As: policyData.dn42As,
			dn42Ipv4Prefix: policyData.dn42Ipv4Prefix,
			dn42Ipv6Prefix: policyData.dn42Ipv6Prefix,
			rpkiServers: policyData.rpkiServers,
			ebgpImportLimit: policyData.ebgpImportLimit,
			ebgpExportLimit: policyData.ebgpExportLimit,
			ibgpImportLimit: policyData.ibgpImportLimit,
			ibgpExportLimit: policyData.ibgpExportLimit,
			asPathMaxLen: policyData.asPathMaxLen,
			communities: policyData.communities,
			largeCommunities: policyData.largeCommunities,
		},
		ibgpPeers,
	});
}
