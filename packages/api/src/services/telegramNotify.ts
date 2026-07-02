/**
 * Admin Telegram notification (API-side)
 *
 * The API process can message the admin directly via the Bot API HTTP endpoint,
 * without routing through the bot process. Used for out-of-band alerts the agent
 * triggers (e.g. a NAT peer that connects from a disallowed region). Best-effort:
 * a delivery failure is logged and swallowed so it never breaks the caller.
 */

import config from "../config";

export async function notifyAdmin(text: string): Promise<void> {
	const { botToken, adminChatId } = config.telegram;
	if (!botToken || !adminChatId) {
		console.warn("[notifyAdmin] Telegram not configured; alert skipped");
		return;
	}

	try {
		const resp = await fetch(
			`https://api.telegram.org/bot${botToken}/sendMessage`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chat_id: adminChatId,
					text,
					parse_mode: "Markdown",
				}),
			},
		);
		if (!resp.ok) {
			console.error(
				`[notifyAdmin] Telegram API ${resp.status}: ${await resp.text()}`,
			);
		}
	} catch (err) {
		console.error("[notifyAdmin] failed to send:", err);
	}
}
