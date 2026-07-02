/**
 * Telegram MTProto Username Resolver
 *
 * Resolves @username → numeric Telegram ID using the MTProto API
 * (contacts.resolveUsername). This is more reliable than the Bot API's
 * getChat because it works for any public user, even if they have
 * never interacted with the bot.
 *
 * Gracefully disabled when TG_API_ID / TG_API_HASH are not configured.
 */

import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { logger } from "../common/logger";
import config from "../config";

let client: TelegramClient | null = null;
let initPromise: Promise<TelegramClient | null> | null = null;
let initFailed = false;

/**
 * Lazily initialize the MTProto client using the bot token.
 * Returns null when not configured or when initialization fails.
 */
async function getClient(): Promise<TelegramClient | null> {
	if (initFailed) return null;

	const { apiId, apiHash, botToken } = config.telegram;
	if (!apiId || !apiHash || !botToken) {
		return null; // Graceful degradation — MTProto not configured
	}

	if (client?.connected) return client;

	if (initPromise) return initPromise;

	initPromise = (async () => {
		try {
			const c = new TelegramClient(
				new StringSession(""), // Stateless for bot — no session persistence needed
				apiId,
				apiHash,
				{
					connectionRetries: 3,
					baseLogger: undefined, // Suppress gramjs internal logging
				},
			);
			await c.start({ botAuthToken: botToken });
			logger.info("MTProto username resolver initialized");
			client = c;
			return c;
		} catch (err) {
			logger.error(
				"MTProto initialization failed — falling back to Redis-only resolution",
				err instanceof Error ? err : undefined,
			);
			initFailed = true;
			initPromise = null;
			return null;
		}
	})();

	return initPromise;
}

/**
 * Resolve a Telegram @username to a numeric user ID via MTProto API.
 *
 * @param username - The username to resolve (without the @ prefix).
 * @returns The numeric Telegram user ID, or null if not found / not configured.
 */
export async function resolveUsername(
	username: string,
): Promise<number | null> {
	try {
		const c = await getClient();
		if (!c) return null;

		const result = await c.invoke(
			new Api.contacts.ResolveUsername({ username }),
		);

		const user = result.users[0];
		if (user && "id" in user) {
			const id = Number(user.id); // bigInt → number
			logger.info("MTProto resolved username", { username, telegramId: id });
			return id;
		}

		return null;
	} catch (err) {
		// Common: USERNAME_NOT_OCCUPIED, FLOOD_WAIT_X
		const errMsg = String(err);
		if (errMsg.includes("USERNAME_NOT_OCCUPIED")) {
			logger.warn("MTProto: username not found", { username });
		} else if (errMsg.includes("FLOOD_WAIT")) {
			logger.warn("MTProto: rate limited", { username, error: errMsg });
		} else {
			logger.warn("MTProto resolveUsername failed", {
				username,
				error: errMsg,
			});
		}
		return null;
	}
}

/**
 * Check if the MTProto resolver is available (configured).
 */
export function isResolverAvailable(): boolean {
	const { apiId, apiHash, botToken } = config.telegram;
	return !!(apiId && apiHash && botToken) && !initFailed;
}
