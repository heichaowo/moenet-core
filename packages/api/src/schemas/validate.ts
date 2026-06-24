/**
 * Validation Middleware & Helpers
 *
 * Provides utilities for using Zod schemas in Hono handlers
 */

import type { Context } from "hono";
import type { z } from "zod";
import { makeResponse, ResponseCode } from "../common/response";

/**
 * Parse and validate request body with a Zod schema
 *
 * @param c - Hono context
 * @param schema - Zod schema to validate against
 * @returns Parsed data or validation error response
 *
 * @example
 * const parsed = await validateBody(c, AuthRequestBodySchema);
 * if (parsed instanceof Response) return parsed;
 * // parsed is now typed correctly
 */
export async function validateBody<T extends z.ZodType>(
	c: Context,
	schema: T,
): Promise<z.infer<T> | Response> {
	try {
		const body = await c.req.json();
		const result = schema.safeParse(body);

		if (!result.success) {
			const errors = (
				result.error.issues as Array<{ path: PropertyKey[]; message: string }>
			).map((e) => ({
				path: String(e.path.join(".")),
				message: e.message,
			}));

			return makeResponse(
				c,
				ResponseCode.VALIDATION_ERROR,
				{ errors },
				errors[0]?.message || "Validation failed",
			);
		}

		return result.data;
	} catch (_error) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Invalid JSON body",
		);
	}
}

/**
 * Validate query parameters with a Zod schema
 */
export function validateQuery<T extends z.ZodType>(
	c: Context,
	schema: T,
): z.infer<T> | Response {
	const query = c.req.query();
	const result = schema.safeParse(query);

	if (!result.success) {
		const errors = (
			result.error.issues as Array<{ path: PropertyKey[]; message: string }>
		).map((e) => ({
			path: String(e.path.join(".")),
			message: e.message,
		}));

		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			{ errors },
			errors[0]?.message || "Invalid query parameters",
		);
	}

	return result.data;
}

/**
 * Type guard to check if result is a Response (validation failed)
 */
export function isValidationError(result: unknown): result is Response {
	return result instanceof Response;
}
