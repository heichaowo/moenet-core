/**
 * Auth API Validation Schemas
 *
 * Zod schemas for authentication flow validation
 */

import { z } from "zod";

/**
 * Query action - lookup auth methods for ASN
 */
export const AuthQuerySchema = z.object({
	action: z.literal("query"),
	asn: z
		.string()
		.regex(/^\d+$/, "ASN must be a number")
		.transform(Number)
		.refine((n) => n >= 4200000000 && n <= 4242429999, {
			message: "ASN must be in DN42 range (4200000000-4242429999)",
		}),
});

/**
 * Request action - select auth method
 */
export const AuthRequestSchema = z.object({
	action: z.literal("request"),
	authState: z.string().min(1, "authState is required"),
	authMethod: z
		.number()
		.int()
		.min(0, "authMethod must be a non-negative integer"),
});

/**
 * Challenge action - submit challenge response
 */
export const AuthChallengeSchema = z.object({
	action: z.literal("challenge"),
	authState: z.string().min(1, "authState is required"),
	data: z.union([
		z.string(), // Email verification code
		z.object({
			// PGP data
			publicKey: z.string().min(1),
			signedMessage: z.string().min(1),
		}),
	]),
});

/**
 * Combined auth request schema (discriminated union by action)
 */
export const AuthRequestBodySchema = z.discriminatedUnion("action", [
	AuthQuerySchema,
	AuthRequestSchema,
	AuthChallengeSchema,
]);

export type AuthQueryInput = z.infer<typeof AuthQuerySchema>;
export type AuthRequestInput = z.infer<typeof AuthRequestSchema>;
export type AuthChallengeInput = z.infer<typeof AuthChallengeSchema>;
export type AuthRequestBody = z.infer<typeof AuthRequestBodySchema>;
