/**
 * Request ID Middleware
 *
 * Generates or extracts request ID for tracing
 * and sets up logging context for the request.
 */

import type { Context, Next } from "hono";
import { clearLogContext, setLogContext } from "../common/logger";

/**
 * Generate a short unique request ID
 */
function generateRequestId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `${timestamp}-${random}`;
}

/**
 * Request ID middleware
 *
 * - Extracts X-Request-ID from headers or generates one
 * - Sets logging context with requestId
 * - Adds X-Request-ID to response headers
 */
export function requestId() {
	return async (c: Context, next: Next) => {
		// Extract or generate request ID
		const reqId = c.req.header("X-Request-ID") || generateRequestId();

		// Set logging context
		setLogContext({ requestId: reqId });

		// Add to response headers
		c.header("X-Request-ID", reqId);

		try {
			await next();
		} finally {
			// Clear context after request
			clearLogContext();
		}
	};
}
