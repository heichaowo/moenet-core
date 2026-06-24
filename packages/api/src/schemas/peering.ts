/**
 * Peering/Session API Validation Schemas
 *
 * Zod schemas for peering session management
 */

import { z } from "zod";

/**
 * IPv4 address validation (standard or DN42)
 */
const ipv4Schema = z
	.string()
	.regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, "Invalid IPv4 address");

/**
 * IPv6 address validation
 */
const ipv6Schema = z.string().regex(/^[a-fA-F0-9:]+$/, "Invalid IPv6 address");

/**
 * WireGuard public key format (Base64, 44 chars)
 */
const wireguardPublicKeySchema = z
	.string()
	.length(44, "WireGuard public key must be 44 characters")
	.regex(/^[A-Za-z0-9+/]{43}=$/, "Invalid WireGuard public key format");

/**
 * Create session request
 */
export const CreateSessionSchema = z.object({
	action: z.literal("create"),
	data: z.object({
		router: z.string().uuid("Invalid router UUID"),
		endpoint: z
			.string()
			.regex(/^[\w.-]+:\d+$/, "Endpoint must be in format host:port")
			.optional(),
		publicKey: wireguardPublicKeySchema.optional(),
		ipv4: ipv4Schema.optional(),
		ipv6: ipv6Schema.optional(),
		ipv6LinkLocal: z
			.string()
			.regex(/^fe80::/i, "Must be a link-local IPv6 address")
			.optional(),
		mtu: z.number().int().min(1280).max(9000).optional(),
		extensions: z
			.array(
				z.enum(["mp_bgp", "extended_nexthop", "add_path", "graceful_restart"]),
			)
			.optional(),
	}),
});

/**
 * List sessions request
 */
export const ListSessionsSchema = z.object({
	action: z.literal("list"),
});

/**
 * Get session request
 */
export const GetSessionSchema = z.object({
	action: z.literal("get"),
	uuid: z.string().uuid("Invalid session UUID"),
});

/**
 * Delete session request
 */
export const DeleteSessionSchema = z.object({
	action: z.literal("delete"),
	uuid: z.string().uuid("Invalid session UUID"),
});

/**
 * Update session request
 */
export const UpdateSessionSchema = z.object({
	action: z.literal("update"),
	uuid: z.string().uuid("Invalid session UUID"),
	// Optional fields that can be updated
	ipv4: ipv4Schema.optional().nullable(),
	ipv6: ipv6Schema.optional().nullable(),
	ipv6LinkLocal: z.string().optional().nullable(),
	localIpv4: ipv4Schema.optional().nullable(),
	endpoint: z.string().optional().nullable(),
	mtu: z.number().int().min(1280).max(9000).optional(),
	extensions: z.string().optional().nullable(),
	contact: z.string().max(200).optional().nullable(),
	psk: z.string().optional().nullable(),
});

/**
 * Combined peering request schema (discriminated union by action)
 */
export const PeeringRequestSchema = z.discriminatedUnion("action", [
	CreateSessionSchema,
	ListSessionsSchema,
	GetSessionSchema,
	UpdateSessionSchema,
	DeleteSessionSchema,
]);

export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;
export type ListSessionsInput = z.infer<typeof ListSessionsSchema>;
export type GetSessionInput = z.infer<typeof GetSessionSchema>;
export type UpdateSessionInput = z.infer<typeof UpdateSessionSchema>;
export type DeleteSessionInput = z.infer<typeof DeleteSessionSchema>;
export type PeeringRequest = z.infer<typeof PeeringRequestSchema>;
