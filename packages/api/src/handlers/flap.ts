/**
 * Flap Detection API Handler
 *
 * Receives FlapAlerted webhook events and sends Telegram notifications.
 * Stores events in Redis for history (bot /flaps command).
 *
 * Endpoints:
 * - POST /api/v1/flap/alert    — Flap event started
 * - POST /api/v1/flap/resolved — Flap event ended
 *
 * Auth: Agent API key (Bearer token)
 */

import type { Context } from "hono";
import { logger } from "../common/logger";
import { makeResponse, ResponseCode, success } from "../common/response";
import config from "../config";
import { getRedis } from "../db/redisContext";
import type { StoredFlapEvent } from "../schemas/flap";
import { FlapEventSchema } from "../schemas/flap";
import { isValidationError, validateBody } from "../schemas/validate";

const REDIS_KEY = "flap:events";
const MAX_EVENTS = 50;
const EVENT_TTL_SECONDS = 86400; // 24 hours

const log = logger.child({ handler: "flap" });

/**
 * Verify agent API key (Bearer token)
 */
function verifyApiKey(c: Context): boolean {
	const header = c.req.header("Authorization");
	if (!header) return false;

	const token = header.split("Bearer ")[1];
	if (!token) return false;

	return token === config.auth.agentApiKey;
}

/**
 * Send a Telegram message to the admin chat via Bot API
 */
async function sendTelegramNotification(text: string): Promise<void> {
	const { botToken, adminChatId } = config.telegram;
	if (!botToken || !adminChatId) {
		log.warn(
			"Telegram notification skipped: botToken or adminChatId not configured",
		);
		return;
	}

	const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: adminChatId,
				text,
				parse_mode: "Markdown",
			}),
		});

		if (!resp.ok) {
			const body = await resp.text();
			log.error("Telegram API error", undefined, {
				status: resp.status,
				body,
			});
		}
	} catch (err) {
		log.error(
			"Failed to send Telegram notification",
			err instanceof Error ? err : undefined,
		);
	}
}

/**
 * Store flap event in Redis sorted set
 */
async function storeEvent(event: StoredFlapEvent): Promise<void> {
	try {
		const redis = getRedis();
		const score = event.timestamp;
		const member = JSON.stringify(event);

		await redis.zadd(REDIS_KEY, score, member);

		// Trim to keep only the latest MAX_EVENTS (atomic, no count check needed)
		await redis.zremrangebyrank(REDIS_KEY, 0, -(MAX_EVENTS + 1));

		// Refresh TTL
		await redis.expire(REDIS_KEY, EVENT_TTL_SECONDS);
	} catch (err) {
		log.error(
			"Failed to store flap event in Redis",
			err instanceof Error ? err : undefined,
		);
	}
}

/**
 * Flap Detection API Handler
 */
export default async function flapHandler(c: Context): Promise<Response> {
	// Auth check
	if (!verifyApiKey(c)) {
		return makeResponse(c, ResponseCode.UNAUTHORIZED);
	}

	// Validate body
	const parsed = await validateBody(c, FlapEventSchema);
	if (isValidationError(parsed)) return parsed;

	const path = c.req.path;
	const isAlert = path.endsWith("/alert");
	const isResolved = path.endsWith("/resolved");

	if (!isAlert && !isResolved) {
		return makeResponse(
			c,
			ResponseCode.NOT_FOUND,
			undefined,
			"Unknown flap action",
		);
	}

	const { Prefix, TotalPathChanges, RateSec, FirstSeen } = parsed;
	const now = Date.now();

	// Compute duration for resolved events
	let durationMinutes: number | null = null;
	if (isResolved && FirstSeen > 0) {
		const firstSeenMs = FirstSeen < 1e12 ? FirstSeen * 1000 : FirstSeen;
		durationMinutes = Math.round((now - firstSeenMs) / 60000);
	}

	const eventType = isAlert ? "alert" : "resolved";

	log.info(`Flap ${eventType}: ${Prefix}`, {
		prefix: Prefix,
		rateSec: RateSec,
		totalPathChanges: TotalPathChanges,
		durationMinutes,
	});

	// Store in Redis
	const storedEvent: StoredFlapEvent = {
		type: eventType,
		prefix: Prefix,
		totalPathChanges: TotalPathChanges,
		rateSec: RateSec,
		firstSeen: FirstSeen,
		durationMinutes,
		timestamp: now,
	};
	await storeEvent(storedEvent);

	// Send Telegram notification
	if (isAlert) {
		const msg =
			"⚠️ *Route Flap Detected*\n路由震荡检测\n\n" +
			`📍 Prefix: \`${Prefix}\`\n` +
			`📊 Rate: ${RateSec}/sec\n` +
			`🔢 Total changes: ${TotalPathChanges}`;
		await sendTelegramNotification(msg);
	} else {
		const durationText =
			durationMinutes !== null ? `${durationMinutes} min` : "unknown";
		const msg =
			"✅ *Route Flap Resolved*\n路由震荡已恢复\n\n" +
			`📍 Prefix: \`${Prefix}\`\n` +
			`⏱️ Duration: ${durationText}\n` +
			`🔢 Total changes: ${TotalPathChanges}`;
		await sendTelegramNotification(msg);
	}

	return success(c, {
		action: isAlert ? "alert_sent" : "resolved_sent",
	});
}
