/**
 * Agent API Validation Schemas
 *
 * Zod schemas for agent-to-control-plane communication
 */

import { z } from "zod";

/**
 * Heartbeat payload from agent
 */
export const HeartbeatSchema = z.object({
	node_id: z.string().min(1),
	agent_version: z.string().min(1),
	status: z.object({
		version: z.string(),
		kernel: z.string().optional(),
		loadAvg: z.string().optional(),
		uptime: z.number().int().nonnegative().optional(),
		timestamp: z.number().int().positive().optional(),
		txBytes: z.number().int().nonnegative().optional(),
		rxBytes: z.number().int().nonnegative().optional(),
		tcpConns: z.number().int().nonnegative().optional(),
		udpConns: z.number().int().nonnegative().optional(),
	}),
});

/**
 * Session modify request from agent
 */
export const ModifySessionSchema = z.object({
	uuid: z.string().uuid("Invalid session UUID"),
	status: z.union([
		z.literal("active"),
		z.literal("enabled"),
		z.literal("problem"),
		z.literal("deleted"),
	]),
	lastError: z.string().optional(),
});

/**
 * Metrics report from agent
 */
export const MetricsReportSchema = z.object({
	sessions: z
		.array(
			z.object({
				uuid: z.string().uuid(),
				importedPrefixes: z.number().int().nonnegative().optional(),
				exportedPrefixes: z.number().int().nonnegative().optional(),
				uptime: z.number().int().nonnegative().optional(),
				state: z.string().optional(),
				lastError: z.string().optional(),
			}),
		)
		.optional(),
	mesh: z
		.object({
			peers: z.array(
				z.object({
					nodeId: z.number().int(),
					latencyMs: z.number().nonnegative().optional(),
					lastHandshake: z.number().int().optional(),
				}),
			),
		})
		.optional(),
});

/**
 * iBGP sync request
 */
export const IBGPSyncRequestSchema = z.object({
	peers: z.array(
		z.object({
			nodeId: z.number().int(),
			nodeName: z.string(),
			loopbackIpv4: z
				.string()
				.regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, "Invalid IPv4")
				.optional(),
			loopbackIpv6: z
				.string()
				.regex(/^[a-fA-F0-9:]+$/, "Invalid IPv6")
				.optional(),
			isRr: z.boolean(),
		}),
	),
});

export type HeartbeatInput = z.infer<typeof HeartbeatSchema>;
export type ModifySessionInput = z.infer<typeof ModifySessionSchema>;
export type MetricsReportInput = z.infer<typeof MetricsReportSchema>;
export type IBGPSyncRequestInput = z.infer<typeof IBGPSyncRequestSchema>;
