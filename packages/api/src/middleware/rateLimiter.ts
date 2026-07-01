/**
 * Rate Limiter Middleware
 *
 * Uses Redis sliding window for rate limiting.
 * - Public API: 60 requests/minute
 * - Agent API: 300 requests/minute
 */

import type { Context, Next } from "hono";
import { timingSafeCompare } from "../common/helpers";
import config from "../config";
import { getRedis } from "../db/redisContext";

interface RateLimitConfig {
	windowMs: number; // Window size in milliseconds
	maxRequests: number; // Max requests per window
	keyPrefix: string; // Redis key prefix
}

// Route-specific configurations.
// NOTE: keys must match the real mounted paths, which are prefixed with
// /api/v1 (see routes.ts). The old "/agent" etc. never matched
// `path.startsWith(...)`, so every route silently fell back to `default`.
const ROUTE_LIMITS: Record<string, RateLimitConfig> = {
	"/api/v1/agent": {
		windowMs: 60 * 1000,
		maxRequests: 300,
		keyPrefix: "rl:agent",
	},
	"/api/v1/auth": {
		windowMs: 60 * 1000,
		maxRequests: 60,
		keyPrefix: "rl:auth",
	},
	"/api/v1/admin": {
		windowMs: 60 * 1000,
		maxRequests: 30,
		keyPrefix: "rl:admin",
	},
	default: {
		windowMs: 60 * 1000,
		maxRequests: 60,
		keyPrefix: "rl:default",
	},
};

/**
 * Get client identifier from request.
 * Uses TRUSTED_PROXY_COUNT to pick the correct IP from X-Forwarded-For.
 * Default 1 (typical single reverse proxy like nginx).
 */
function getClientKey(c: Context): string {
	const trustedHops = Number(process.env.TRUSTED_PROXY_COUNT) || 1;

	const forwarded = c.req.header("X-Forwarded-For");
	if (forwarded) {
		const ips = forwarded.split(",").map((s) => s.trim());
		// Pick the IP that is `trustedHops` from the right
		// e.g. with 1 trusted proxy: "client, proxy" → pick "client" (index len-2)
		const idx = Math.max(0, ips.length - trustedHops);
		return ips[idx] ?? "unknown";
	}

	// Fall back to X-Real-IP
	const realIp = c.req.header("X-Real-IP");
	if (realIp) {
		return realIp;
	}

	// Use connection info as last resort
	return "unknown";
}

/**
 * Get rate limit config for a route
 */
function getConfigForRoute(path: string): RateLimitConfig {
	for (const [prefix, config] of Object.entries(ROUTE_LIMITS)) {
		if (prefix !== "default" && path.startsWith(prefix)) {
			return config;
		}
	}
	return ROUTE_LIMITS.default as RateLimitConfig;
}

/**
 * Rate limiter middleware using Redis sliding window
 */
export function rateLimiter() {
	return async (c: Context, next: Next) => {
		// Skip rate limiting in standalone mode
		if (process.env.STANDALONE === "true") {
			return next();
		}

		// Skip health and metrics endpoints
		const path = c.req.path;
		if (path === "/health" || path === "/metrics") {
			return next();
		}

		// Exempt trusted internal clients: the bot and all agents authenticate
		// with the agent API key. They legitimately make high-frequency calls
		// (heartbeats every few seconds, admin queries per command), so rate
		// limiting them would 429 core traffic. External/public callers (user
		// JWTs on /session, login on /auth, anonymous) still get limited.
		const authHeader = c.req.header("Authorization");
		const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
		if (
			bearer &&
			config.auth.agentApiKey &&
			timingSafeCompare(bearer, config.auth.agentApiKey)
		) {
			return next();
		}

		const routeConfig = getConfigForRoute(path);
		const clientKey = getClientKey(c);
		const redisKey = `${routeConfig.keyPrefix}:${clientKey}`;
		const now = Date.now();
		const windowStart = now - routeConfig.windowMs;

		try {
			const redis = getRedis();

			// Use Redis transaction for atomic operations
			const pipeline = redis.pipeline();

			// Remove old entries outside the window
			pipeline.zremrangebyscore(redisKey, 0, windowStart);

			// Count current requests in window
			pipeline.zcard(redisKey);

			// Add current request
			pipeline.zadd(redisKey, now, `${now}-${Math.random()}`);

			// Set TTL to window size
			pipeline.pexpire(redisKey, routeConfig.windowMs);

			const results = await pipeline.exec();

			// Get count from zcard result (index 1)
			const currentCount = (results?.[1]?.[1] as number) || 0;

			// Set rate limit headers
			c.header("X-RateLimit-Limit", String(routeConfig.maxRequests));
			c.header(
				"X-RateLimit-Remaining",
				String(Math.max(0, routeConfig.maxRequests - currentCount - 1)),
			);
			c.header(
				"X-RateLimit-Reset",
				String(Math.ceil((now + routeConfig.windowMs) / 1000)),
			);

			// Check if limit exceeded
			if (currentCount >= routeConfig.maxRequests) {
				c.header("Retry-After", String(Math.ceil(routeConfig.windowMs / 1000)));
				return c.json(
					{
						code: 429,
						message: "Too Many Requests",
						retryAfter: Math.ceil(routeConfig.windowMs / 1000),
					},
					429,
				);
			}
		} catch (error) {
			// Log error but don't block request if Redis fails
			console.error("[RateLimiter] Redis error:", error);
			// Continue without rate limiting if Redis is unavailable
		}

		return next();
	};
}
