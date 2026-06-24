/**
 * Bot Middleware: Rate Limiting, Metrics
 */
import type { Context, NextFunction } from 'grammy';
import config from './config';
import { getRedisClient } from './storage';

/**
 * Rate limit tracking per user (capped to prevent unbounded growth)
 */
const rateLimitMap = new Map<number, { count: number; resetAt: number }>();
const RATE_LIMIT_MAP_CAP = 10_000;

/**
 * Metrics counters
 */
export const metrics = {
    totalRequests: 0,
    commandCounts: new Map<string, number>(),
    errors: 0,
    rateLimited: 0,
    startTime: Date.now(),
};

/**
 * Rate limiting middleware
 * Limits requests per user within a time window
 */
export function rateLimitMiddleware<C extends Context>() {
    return async (ctx: C, next: NextFunction) => {
        const userId = ctx.from?.id;
        if (!userId) {
            return next();
        }

        const now = Date.now();
        const windowMs = config.rateLimit.windowMs;
        const maxRequests = config.rateLimit.maxRequests;

        let userData = rateLimitMap.get(userId);

        if (!userData || now > userData.resetAt) {
            // Skip tracking if map is at capacity (still allow the request)
            if (rateLimitMap.size >= RATE_LIMIT_MAP_CAP && !rateLimitMap.has(userId)) {
                return next();
            }
            userData = { count: 1, resetAt: now + windowMs };
            rateLimitMap.set(userId, userData);
        } else {
            userData.count++;
        }

        if (userData.count > maxRequests) {
            metrics.rateLimited++;
            const waitSeconds = Math.ceil((userData.resetAt - now) / 1000);
            await ctx.reply(
                `⏱️ Rate limited. Please wait ${waitSeconds}s.\n` +
                `请稍等 ${waitSeconds} 秒后再试。`
            );
            return;
        }

        return next();
    };
}

/**
 * Metrics collection middleware
 */
export function metricsMiddleware<C extends Context>() {
    return async (ctx: C, next: NextFunction) => {
        metrics.totalRequests++;

        // Track command usage
        const command = ctx.message && 'text' in ctx.message
            ? ctx.message.text?.split(' ')[0] || ''
            : '';

        if (command.startsWith('/')) {
            const cmd = command.slice(1).toLowerCase().split('@')[0] || '';
            // Only track if already known or under cap (prevents unbounded growth)
            if (metrics.commandCounts.has(cmd) || metrics.commandCounts.size < 100) {
                metrics.commandCounts.set(cmd, (metrics.commandCounts.get(cmd) || 0) + 1);
            }
        }

        try {
            await next();
        } catch (error) {
            metrics.errors++;
            throw error;
        }
    };
}

/**
 * Get metrics summary
 */
export function getMetricsSummary(): Record<string, unknown> {
    const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
    const topCommands: Array<{ command: string; count: number }> = [];

    metrics.commandCounts.forEach((count, command) => {
        topCommands.push({ command, count });
    });

    topCommands.sort((a, b) => b.count - a.count);

    return {
        uptime_seconds: uptime,
        total_requests: metrics.totalRequests,
        errors: metrics.errors,
        rate_limited: metrics.rateLimited,
        top_commands: topCommands.slice(0, 10),
        active_rate_limits: rateLimitMap.size,
    };
}

/**
 * Cleanup expired rate limit entries (call periodically)
 */
export function cleanupRateLimits(): void {
    const now = Date.now();
    for (const [userId, data] of rateLimitMap.entries()) {
        if (now > data.resetAt) {
            rateLimitMap.delete(userId);
        }
    }
}

/**
 * Auto-register middleware for backfilling existing users.
 * If the session has an ASN (user is logged in) but hasn't been registered
 * to the DB yet in this session, silently call the API to persist the mapping.
 */
export function autoRegisterMiddleware<C extends Context & { session: { asn?: number; _registered?: boolean } }>(apiUrl: string, apiToken: string) {
    return async (ctx: C, next: NextFunction) => {
        // Only run if user is logged in and not yet registered in this session
        if (ctx.session.asn && !ctx.session._registered && ctx.from?.id) {
            // Fire-and-forget: don't block the command handler
            const asn = ctx.session.asn;
            const telegramId = ctx.from.id;
            fetch(`${apiUrl}/admin`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiToken}`,
                },
                body: JSON.stringify({
                    action: 'registerTelegramId',
                    asn,
                    telegramId,
                }),
            }).then(() => {
                ctx.session._registered = true;
            }).catch((error) => {
                console.error('[AutoRegister] Failed to register telegramId:', error);
            });
        }

        return next();
    };
}

/**
 * Username→ID cache middleware.
 * Stores every interacting user's @username→numeric_id mapping in Redis
 * so the notification system can resolve @username contacts to chat IDs.
 */
export function usernameCacheMiddleware<C extends Context>() {
    return async (ctx: C, next: NextFunction) => {
        const user = ctx.from;
        if (user?.username && user.id) {
            const redis = getRedisClient();
            if (redis) {
                // Fire-and-forget: cache username→id with 90-day TTL
                const key = `tg:username:${user.username.toLowerCase()}`;
                redis.set(key, String(user.id), 'EX', 86400 * 90).catch(() => {});
            }
        }
        return next();
    };
}

// Cleanup every 5 minutes
setInterval(cleanupRateLimits, 5 * 60 * 1000);
