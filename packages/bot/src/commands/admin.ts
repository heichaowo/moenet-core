import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { apiRequest } from "../api";
import config from "../config";
import { isAdmin } from "../guards";
import type { BotContext } from "../index";
import { getNodes, getAgentEndpoint } from "../providers/nodes";
import { fetchContacts } from "../services/dn42Registry";
import { DIVIDER } from "../templates";
import { calculatePort, isAsnInput, normalizeAsn } from "./peer/validators";

/**
 * Escape Telegram Markdown v1 special characters in user-supplied text.
 */
function escapeMarkdown(text: string): string {
	return text.replace(/([*_`[])/g, "\\$1");
}

// =============================================================================
// Shared Constants
// =============================================================================

/** Status name → code mapping (user input) */
const STATUS_MAP: Record<string, number> = {
	disabled: 1,
	active: 2,
	enabled: 2,
	pending: 3,
	review: 3,
	queued: 4,
	setup: 4,
	delete: 5,
	problem: 6,
	error: 6,
	teardown: 7,
	rejected: 8,
};

/** Status code → display label with emoji */
const STATUS_LABELS: Record<number, string> = {
	1: "⚫ Disabled",
	2: "🟢 Active",
	3: "🟡 Pending",
	4: "🔵 Queued",
	5: "🗑️ Deleting",
	6: "🔴 Problem",
	7: "⏳ Teardown",
	8: "❌ Rejected",
};

/** Status code → short emoji only */
const STATUS_DOTS: Record<number, string> = {
	1: "⚫",
	2: "🟢",
	3: "🟡",
	4: "🔵",
	5: "🗑️",
	6: "🔴",
	7: "⏳",
	8: "❌",
};

/** Sessions per page in overview */
const OVERVIEW_PAGE_SIZE = 5;
/** Sessions per page in detail view */
const DETAIL_PAGE_SIZE = 5;

/** Full session info matching actual API response */
interface FullSessionInfo {
	uuid: string;
	asn: number;
	router: string;
	routerName?: string;
	status?: number;
	endpoint?: string;
	ipv4?: string;
	ipv6?: string;
	ipv6LinkLocal?: string;
	localIpv4?: string;
	type?: string;
	mtu?: number;
	interface?: string;
	credential?: string;
	contact?: string;
	lastError?: string;
	createdAt?: string;
	updatedAt?: string;
}

export function registerAdminCommands(bot: Bot<BotContext>) {
	/**
	 * /pending - List pending peers with approve/reject buttons
	 */
	bot.command("pending", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.reply("❌ Admin access required.");
			return;
		}

		await showPendingList(ctx);
	});

	// Handle admin:pending callback (from notification)
	bot.callbackQuery("admin:pending", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}

		await ctx.answerCallbackQuery();
		await showPendingList(ctx);
	});

	// Handle approve button
	bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}

		const uuid = ctx.match[1];

		try {
			const result = await apiRequest(
				"/admin",
				"POST",
				{
					action: "approveSession",
					uuid,
				},
				config.apiToken,
			);

			if (result.code !== 0) {
				await ctx.answerCallbackQuery(`❌ ${result.message}`);
				return;
			}

			await ctx.answerCallbackQuery("✅ Approved!");

			// Refresh the list
			await showPendingList(ctx, ctx.callbackQuery.message?.message_id);
		} catch (error) {
			console.error("[Approve] Error:", error);
			await ctx.answerCallbackQuery("❌ Failed");
		}
	});

	// Handle reject button
	bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}

		const uuid = ctx.match[1];

		try {
			const result = await apiRequest(
				"/admin",
				"POST",
				{
					action: "rejectSession",
					uuid,
					reason: "Rejected by admin",
				},
				config.apiToken,
			);

			if (result.code !== 0) {
				await ctx.answerCallbackQuery(`❌ ${result.message}`);
				return;
			}

			await ctx.answerCallbackQuery("✅ Rejected!");

			// Refresh the list
			await showPendingList(ctx, ctx.callbackQuery.message?.message_id);
		} catch (error) {
			console.error("[Reject] Error:", error);
			await ctx.answerCallbackQuery("❌ Failed");
		}
	});

	// Handle refresh button
	bot.callbackQuery("pending:refresh", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}

		await ctx.answerCallbackQuery("Refreshing...");
		await showPendingList(ctx, ctx.callbackQuery.message?.message_id);
	});

	// =========================================================================
	// /migrate - Bulk migrate sessions between nodes
	// =========================================================================

	/**
	 * /migrate - Start bulk migration flow
	 */
	bot.command("migrate", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.reply("❌ Admin access required.");
			return;
		}

		// Fetch all routers
		const result = await apiRequest(
			"/admin",
			"POST",
			{ action: "enumRouters" },
			config.apiToken,
		);
		const routers = result.data?.routers || [];

		if (routers.length < 2) {
			await ctx.reply(
				"❌ Need at least 2 nodes to migrate.\n至少需要 2 个节点才能迁移。",
			);
			return;
		}

		const message =
			`🔄 *Node Migration 节点迁移*\n\n` +
			`Select the *source* node (migrate FROM):\n` +
			`选择*源节点*（从哪个节点迁出）:\n\n`;

		const keyboard = new InlineKeyboard();
		for (const r of routers) {
			const name = r.name || r.uuid;
			const region = r.region || "";
			keyboard
				.text(
					`📍 ${name} ${region ? `(${region})` : ""}`,
					`migrate:from:${r.uuid}`,
				)
				.row();
		}
		keyboard.text("🚫 Cancel 取消", "migrate:cancel");

		await ctx.reply(message, {
			parse_mode: "Markdown",
			reply_markup: keyboard,
		});
	});

	// Handle source node selection
	bot.callbackQuery(/^migrate:from:(.+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}

		const fromRouter = ctx.match[1];
		await ctx.answerCallbackQuery();

		// Fetch routers to show targets (exclude source)
		const result = await apiRequest(
			"/admin",
			"POST",
			{ action: "enumRouters" },
			config.apiToken,
		);
		const routers = (result.data?.routers || []).filter(
			(r: { uuid: string }) => r.uuid !== fromRouter,
		);
		const sourceRouter = (result.data?.routers || []).find(
			(r: { uuid: string }) => r.uuid === fromRouter!,
		);
		const sourceName = sourceRouter?.name || fromRouter!.slice(0, 8);

		const message =
			`🔄 *Migration 迁移*\n\n` +
			`From 源: \`${sourceName}\`\n\n` +
			`Select the *target* node (migrate TO):\n` +
			`选择*目标节点*（迁移到哪个节点）:\n\n`;

		const keyboard = new InlineKeyboard();
		for (const r of routers) {
			const name = r.name || r.uuid;
			const region = r.region || "";
			keyboard
				.text(
					`📍 ${name} ${region ? `(${region})` : ""}`,
					`migrate:to:${fromRouter}:${r.uuid}`,
				)
				.row();
		}
		keyboard.text("🚫 Cancel 取消", "migrate:cancel");

		await ctx.editMessageText(message, {
			parse_mode: "Markdown",
			reply_markup: keyboard,
		});
	});

	// Handle target node selection → dry run preview
	bot.callbackQuery(/^migrate:to:(.+):(.+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}

		const fromRouter = ctx.match[1];
		const toRouter = ctx.match[2];
		await ctx.answerCallbackQuery("Loading preview...");

		// Dry run to preview
		const result = await apiRequest(
			"/admin",
			"POST",
			{
				action: "bulkMigrate",
				fromRouter,
				toRouter,
				dryRun: true,
			},
			config.apiToken,
		);

		if (result.code !== 0) {
			await ctx.editMessageText(`❌ Error: ${result.message}`);
			return;
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const data = result.data as any;
		const fromName = data.fromRouter as string;
		const toName = data.toRouter as string;
		const count = data.count as number;
		const sessions = (data.sessions || []) as Array<{
			asn: number;
			contact: string | null;
		}>;

		if (count === 0) {
			await ctx.editMessageText(
				`✅ No active sessions on \`${fromName}\`.\n` +
					`\`${fromName}\` 上没有活跃的会话。`,
				{ parse_mode: "Markdown" },
			);
			return;
		}

		let message =
			`🔄 *Migration Preview 迁移预览*\n\n` +
			`From 源: \`${fromName}\`\n` +
			`To 目标: \`${toName}\`\n` +
			`Sessions 会话数: *${count}*\n\n`;

		for (const s of sessions.slice(0, 20)) {
			message += `• AS${s.asn}${s.contact ? ` (${escapeMarkdown(s.contact)})` : ""}\n`;
		}
		if (count > 20) {
			message += `\n...+${count - 20} more\n`;
		}

		message +=
			`\n⚠️ *Confirm to execute migration?*\n` +
			`确认执行迁移？所有会话将从 ${fromName} 迁移到 ${toName}。`;

		const keyboard = new InlineKeyboard()
			.text("✅ Confirm 确认迁移", `migrate:exec:${fromRouter}:${toRouter}`)
			.text("🚫 Cancel 取消", "migrate:cancel");

		await ctx.editMessageText(message, {
			parse_mode: "Markdown",
			reply_markup: keyboard,
		});
	});

	// Handle migration execution
	bot.callbackQuery(/^migrate:exec:(.+):(.+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}

		const fromRouter = ctx.match[1];
		const toRouter = ctx.match[2];
		await ctx.answerCallbackQuery("Migrating...");
		await ctx.editMessageText("⏳ Migration in progress...\n正在执行迁移...");

		const result = await apiRequest(
			"/admin",
			"POST",
			{
				action: "bulkMigrate",
				fromRouter,
				toRouter,
				dryRun: false,
			},
			config.apiToken,
		);

		if (result.code !== 0) {
			await ctx.editMessageText(
				`❌ Migration failed: ${result.message}\n迁移失败: ${result.message}`,
			);
			return;
		}

		const {
			fromRouter: fromName,
			toRouter: toName,
			migrated,
			failed,
			results,
		} = result.data as {
			fromRouter: string;
			toRouter: string;
			migrated: number;
			failed: number;
			results: Array<{ asn: number; status: string; error?: string }>;
		};

		let message =
			`✅ *Migration Complete 迁移完成*\n\n` +
			`From 源: \`${fromName}\`\n` +
			`To 目标: \`${toName}\`\n\n` +
			`✅ Migrated 已迁移: *${migrated}*\n`;

		if (failed > 0) {
			message += `❌ Failed 失败: *${failed}*\n\n`;
			message += `*Failures:*\n`;
			for (const r of results.filter((r) => r.status === "error")) {
				message += `• AS${r.asn}: ${escapeMarkdown(r.error || "unknown")}\n`;
			}
		}

		message +=
			`\n⏳ Users will be notified automatically once new sessions are active.\n` +
			`用户将在新会话激活后自动收到通知。`;

		await ctx.editMessageText(message, { parse_mode: "Markdown" });

		// Store pending migration notifications in API (Redis-backed)
		// Will be triggered when agent reports sessions as ENABLED
		if (migrated > 0) {
			const migratedAsns = results
				.filter((r) => r.status === "ok")
				.map((r) => r.asn);

			await apiRequest(
				"/admin",
				"POST",
				{
					action: "storeMigrationNotify",
					asns: migratedAsns,
					fromRouter: fromName,
					toRouter: toName,
					adminChatId: ctx.chat?.id,
				},
				config.apiToken,
			);
		}
	});

	// Handle cancel
	bot.callbackQuery("migrate:cancel", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery("Cancelled");
		await ctx.editMessageText("🚫 Migration cancelled.\n迁移已取消。");
	});

	/**
	 * /sessions [status] [node] - List BGP sessions
	 *
	 * Tier 1: /sessions          → Summary (counts per status + inline buttons)
	 * Tier 1: /sessions active   → Grouped overview by node
	 * Tier 2: /sessions active hk1 → Detail view for specific node
	 */
	bot.command("sessions", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.reply("❌ Admin access required.");
			return;
		}

		const args =
			ctx.match?.trim().toLowerCase().split(/\s+/).filter(Boolean) || [];
		const statusArg = args[0] || "";
		const nodeArg = args[1] || "";

		try {
			if (!statusArg || statusArg === "summary") {
				await renderSessionSummary(ctx);
				return;
			}

			// Validate status filter
			const statusCode =
				statusArg === "all" ? undefined : STATUS_MAP[statusArg];
			if (statusArg !== "all" && statusCode === undefined) {
				await ctx.reply(
					`❌ Unknown status: \`${escapeMarkdown(statusArg)}\`\n` +
						`未知状态: \`${escapeMarkdown(statusArg)}\`\n\n` +
						`Available filters 可用过滤:\n` +
						`\`active\`, \`pending\`, \`disabled\`, \`problem\`, \`rejected\`, \`queued\`, \`teardown\`, \`all\``,
					{ parse_mode: "Markdown" },
				);
				return;
			}

			if (nodeArg) {
				// Tier 2: Detail view for specific node
				await renderSessionDetail(ctx, statusArg, nodeArg, 0);
			} else {
				// Tier 1: Grouped overview
				await renderSessionOverview(ctx, statusArg, 0);
			}
		} catch (error) {
			console.error("[Sessions] Error:", error);
			await ctx.reply("❌ Failed to fetch sessions.\n获取会话失败。");
		}
	});

	// Callback: sessions overview pagination — sl:<filter>:<page>
	bot.callbackQuery(/^sl:([^:]+):(\d+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();
		const filter = ctx.match[1]!;
		const page = Number(ctx.match[2]);
		if (filter === "summary") {
			await renderSessionSummary(ctx, ctx.callbackQuery.message?.message_id);
		} else {
			await renderSessionOverview(
				ctx,
				filter,
				page,
				ctx.callbackQuery.message?.message_id,
			);
		}
	});

	// Callback: session detail view — sd:<filter>:<node>:<page>
	bot.callbackQuery(/^sd:([^:]+):([^:]+):(\d+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();
		const filter = ctx.match[1]!;
		const node = ctx.match[2]!;
		const page = Number(ctx.match[3]);
		await renderSessionDetail(
			ctx,
			filter,
			node,
			page,
			ctx.callbackQuery.message?.message_id,
		);
	});

	// Callback: session action — sa:<uuid>:<action>
	// For destructive actions (Disable=1, Delete=5), show confirmation first.
	// For non-destructive actions (Enable=2), execute immediately.
	bot.callbackQuery(/^sa:([^:]+):(\d+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();

		const uuid = ctx.match[1]!;
		const newStatus = Number(ctx.match[2]);
		const newLabel = STATUS_LABELS[newStatus] || `Status ${newStatus}`;

		// Destructive actions require confirmation
		const destructiveStatuses = [1, 5, 7]; // Disabled, Delete, Teardown
		if (destructiveStatuses.includes(newStatus)) {
			try {
				const result = await apiRequest(
					"/admin",
					"POST",
					{ action: "enumSessions" },
					config.apiToken,
				);
				const session = ((result.data?.sessions || []) as FullSessionInfo[]).find(
					(s) => s.uuid === uuid,
				);

				if (!session) {
					await ctx.editMessageText("❌ Session not found.\n会话未找到。");
					return;
				}

				const currentLabel =
					STATUS_LABELS[session.status ?? 0] || `Status ${session.status}`;
				const node = session.routerName || session.router;

				const warningIcon = newStatus === 5 ? "🗑️" : "⚠️";
				const warningText = newStatus === 5
					? "This will delete the session configuration.\n此操作将删除会话配置。"
					: newStatus === 1
						? "This will disconnect the BGP session and WG tunnel.\n此操作将断开 BGP 会话和 WG 隧道。"
						: "This is a destructive operation.\n此操作不可逆。";

				const confirmMsg =
					`${warningIcon} *Confirm Status Change 确认状态变更*\n${DIVIDER}\n\n` +
					`ASN: \`AS${session.asn}\`\n` +
					`Node 节点: ${escapeMarkdown(node)}\n` +
					`Change 变更: ${currentLabel} → ${newLabel}\n\n` +
					`${warningText}`;

				const confirmKeyboard = new InlineKeyboard();
				confirmKeyboard.text("✅ Confirm 确认", `sac:${uuid}:${newStatus}`);
				confirmKeyboard.text("❌ Cancel 取消", `sax`);

				await ctx.editMessageText(confirmMsg, {
					parse_mode: "Markdown",
					reply_markup: confirmKeyboard,
				});
			} catch (error) {
				console.error("[SessionAction] Confirmation error:", error);
				await ctx.editMessageText("❌ Failed to load session.\n加载会话失败。");
			}
			return;
		}

		// Non-destructive actions execute immediately
		try {
			const result = await apiRequest(
				"/admin",
				"POST",
				{ action: "enumSessions" },
				config.apiToken,
			);
			const session = ((result.data?.sessions || []) as FullSessionInfo[]).find(
				(s) => s.uuid === uuid,
			);

			if (!session) {
				await ctx.editMessageText("❌ Session not found.\n会话未找到。");
				return;
			}

			const currentLabel =
				STATUS_LABELS[session.status ?? 0] || `Status ${session.status}`;
			const node = session.routerName || session.router;

			const updateResult = await apiRequest(
				"/admin",
				"POST",
				{
					action: "updateSession",
					uuid: session.uuid,
					status: newStatus,
				},
				config.apiToken,
			);

			if (updateResult.code !== 0) {
				await ctx.editMessageText(
					`❌ Failed: ${updateResult.message}\n操作失败: ${updateResult.message}`,
				);
				return;
			}

			await ctx.editMessageText(
				`✅ *Status Updated 状态已更新*\n\n` +
					`ASN: \`AS${session.asn}\`\n` +
					`Node 节点: ${escapeMarkdown(node)}\n` +
					`${currentLabel} → ${newLabel}`,
				{ parse_mode: "Markdown" },
			);
		} catch (error) {
			console.error("[SessionAction] Error:", error);
			await ctx.editMessageText("❌ Failed to update status.\n更新状态失败。");
		}
	});

	// Callback: session action confirmed — sac:<uuid>:<status>
	bot.callbackQuery(/^sac:([^:]+):(\d+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery("⏳ Applying...");

		const uuid = ctx.match[1]!;
		const newStatus = Number(ctx.match[2]);
		const newLabel = STATUS_LABELS[newStatus] || `Status ${newStatus}`;

		try {
			const result = await apiRequest(
				"/admin",
				"POST",
				{ action: "enumSessions" },
				config.apiToken,
			);
			const session = ((result.data?.sessions || []) as FullSessionInfo[]).find(
				(s) => s.uuid === uuid,
			);

			if (!session) {
				await ctx.editMessageText("❌ Session not found.\n会话未找到。");
				return;
			}

			const currentLabel =
				STATUS_LABELS[session.status ?? 0] || `Status ${session.status}`;
			const node = session.routerName || session.router;

			const updateResult = await apiRequest(
				"/admin",
				"POST",
				{
					action: "updateSession",
					uuid: session.uuid,
					status: newStatus,
				},
				config.apiToken,
			);

			if (updateResult.code !== 0) {
				await ctx.editMessageText(
					`❌ Failed: ${updateResult.message}\n操作失败: ${updateResult.message}`,
				);
				return;
			}

			await ctx.editMessageText(
				`✅ *Status Updated 状态已更新*\n\n` +
					`ASN: \`AS${session.asn}\`\n` +
					`Node 节点: ${escapeMarkdown(node)}\n` +
					`${currentLabel} → ${newLabel}`,
				{ parse_mode: "Markdown" },
			);
		} catch (error) {
			console.error("[SessionAction] Confirm error:", error);
			await ctx.editMessageText("❌ Failed to update status.\n更新状态失败。");
		}
	});

	// Callback: session action cancelled — sax
	bot.callbackQuery(/^sax$/, async (ctx) => {
		await ctx.answerCallbackQuery();
		await ctx.editMessageText("🚫 Cancelled.\n已取消。");
	});

	/**
	 * /setstatus <ASN> <status> - Change session status
	 * Example: /setstatus 998 enabled
	 */
	bot.command("setstatus", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.reply("❌ Admin access required.");
			return;
		}

		const args = ctx.match?.trim().split(/\s+/) || [];

		if (args.length < 2 || args[0] === "") {
			await ctx.reply(
				`🔧 *Set Session Status 设置会话状态*\n\n` +
					`Usage 用法: \`/setstatus <ASN> <status>\`\n\n` +
					`Example 示例:\n` +
					`\`/setstatus 998 enabled\`\n` +
					`\`/setstatus 1234 disabled\`\n\n` +
					`Valid statuses 有效状态:\n` +
					`disabled, enabled, pending, queued, problem, rejected`,
				{ parse_mode: "Markdown" },
			);
			return;
		}

		const asn = normalizeAsn(args[0]!);
		const statusArg = args[1]!.toLowerCase();
		const newStatus = STATUS_MAP[statusArg] ?? (Number(statusArg) || undefined);

		if (isNaN(asn)) {
			await ctx.reply("❌ Invalid ASN format.\n无效的 ASN 格式。");
			return;
		}

		if (!newStatus || !STATUS_LABELS[newStatus]) {
			await ctx.reply(
				`❌ Invalid status: \`${escapeMarkdown(statusArg)}\`\n` +
					`无效状态: \`${escapeMarkdown(statusArg)}\``,
				{ parse_mode: "Markdown" },
			);
			return;
		}

		try {
			const result = await apiRequest(
				"/admin",
				"POST",
				{
					action: "enumSessions",
				},
				config.apiToken,
			);

			const sessions = (result.data?.sessions || []) as FullSessionInfo[];
			const matches = sessions.filter((s) => Number(s.asn) === asn);

			if (matches.length === 0) {
				await ctx.reply(
					`❌ No sessions found for AS${asn}\n未找到 AS${asn} 的会话`,
				);
				return;
			}

			// Multiple sessions → show picker
			if (matches.length > 1) {
				const keyboard = new InlineKeyboard();
				for (const s of matches) {
					const node = s.routerName || s.router;
					const cur = STATUS_LABELS[s.status ?? 0] || "?";
					keyboard.text(`${node} (${cur})`, `ss:${s.uuid}:${newStatus}`).row();
				}
				keyboard.text("🚫 Cancel 取消", "ss:cancel");

				await ctx.reply(
					`🔧 AS${asn} has ${matches.length} sessions.\n` +
						`Select which one to set to ${STATUS_LABELS[newStatus]}:\n` +
						`AS${asn} 有 ${matches.length} 个会话，选择要修改的：`,
					{ reply_markup: keyboard },
				);
				return;
			}

			// Single session → apply directly
			const session = matches[0]!;
			await applyStatusChange(ctx, session, newStatus);
		} catch (error) {
			console.error("[SetStatus] Error:", error);
			await ctx.reply("❌ Failed to update status.\n更新状态失败。");
		}
	});

	// Handle setstatus picker callback
	bot.callbackQuery(/^ss:cancel$/, async (ctx) => {
		await ctx.answerCallbackQuery();
		await ctx.editMessageText("🚫 Cancelled.\n已取消。");
	});

	bot.callbackQuery(/^ss:([^:]+):(\d+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();

		const uuid = ctx.match[1]!;
		const newStatus = Number(ctx.match[2]);

		// Fetch session info
		const result = await apiRequest(
			"/admin",
			"POST",
			{ action: "enumSessions" },
			config.apiToken,
		);
		const session = ((result.data?.sessions || []) as FullSessionInfo[]).find(
			(s) => s.uuid === uuid,
		);

		if (!session) {
			await ctx.editMessageText("❌ Session not found.\n会话未找到。");
			return;
		}

		await applyStatusChange(ctx, session, newStatus, true);
	});

	/** Apply status change and show result */
	async function applyStatusChange(
		ctx: BotContext,
		session: FullSessionInfo,
		newStatus: number,
		editMessage = false,
	) {
		const currentLabel =
			STATUS_LABELS[session.status ?? 0] || `Status ${session.status}`;
		const newLabel = STATUS_LABELS[newStatus]!;
		const node = session.routerName || session.router;

		const updateResult = await apiRequest(
			"/admin",
			"POST",
			{
				action: "updateSession",
				uuid: session.uuid,
				status: newStatus,
			},
			config.apiToken,
		);

		if (updateResult.code !== 0) {
			const msg = `❌ Failed: ${updateResult.message}\n操作失败: ${updateResult.message}`;
			editMessage ? await ctx.editMessageText(msg) : await ctx.reply(msg);
			return;
		}

		const report =
			`✅ *Status Updated 状态已更新*\n\n` +
			`ASN: \`AS${session.asn}\`\n` +
			`Node 节点: ${escapeMarkdown(node)}\n` +
			`${currentLabel} → ${newLabel}`;

		if (editMessage) {
			await ctx.editMessageText(report, { parse_mode: "Markdown" });
		} else {
			await ctx.reply(report, { parse_mode: "Markdown" });
		}
	}

	/**
	 * /nodes - List all nodes
	 */
	bot.command("nodes", async (ctx) => {
		try {
			const result = await apiRequest(
				"/admin",
				"POST",
				{
					action: "enumRouters",
				},
				config.apiToken,
			);

			if (result.code !== 0) {
				await ctx.reply(`❌ Error: ${result.message}`);
				return;
			}

			const routers = result.data?.routers || [];

			if (routers.length === 0) {
				await ctx.reply("❌ No nodes found.\n没有找到节点。");
				return;
			}

			let message = `📡 *MoeNet Nodes 节点列表 (${routers.length})*\n${DIVIDER}\n\n`;
			routers.forEach((r: RouterInfo) => {
				const status = r.isOpen ? "🟢" : "🔴";
				const capacity = r.maxPeers
					? `${r.sessionCount || 0}/${r.maxPeers}`
					: `${r.sessionCount || 0}/∞`;
				const ipv4 = r.supportsIpv4 ? "✓" : "✗";
				const ipv6 = r.supportsIpv6 ? "✓" : "✗";

				message += `${status} *${escapeMarkdown(r.name)}*`;
				if (r.location) message += ` — ${escapeMarkdown(r.location)}`;
				if (r.provider) message += ` | ${escapeMarkdown(r.provider)}`;
				message += `\n`;
				message += `┃ 👥 ${capacity} peers | IPv4:${ipv4} IPv6:${ipv6}`;
				if (!r.allowCnPeers) message += ` | 🚫CN`;
				message += `\n`;
				if (r.endpoint) {
					message += `┗ 🌐 \`${r.endpoint}\`\n`;
				} else {
					message += `┗ 🌐 —\n`;
				}
				message += `\n`;
			});

			await ctx.reply(message, { parse_mode: "Markdown" });
		} catch (error) {
			console.error("[Nodes] Error:", error);
			await ctx.reply("❌ Failed to fetch nodes.\n获取节点信息失败。");
		}
	});

	// =============================================================================
	// /health — Real-time WG + BGP Health Diagnostics
	// =============================================================================

	/**
	 * /health [node] — Network health diagnostics
	 * No args: overview of all nodes
	 * With node: detailed per-session status for that node
	 */
	bot.command("health", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.reply("❌ Admin access required.");
			return;
		}

		const arg = ctx.match?.trim().toLowerCase();

		try {
			if (arg) {
				// Detail view for a specific node
				await renderHealthDetail(ctx, arg);
			} else {
				// Overview of all nodes
				await renderHealthOverview(ctx);
			}
		} catch (error) {
			console.error("[Health] Error:", error);
			await ctx.reply("❌ Failed to fetch health data.\n获取健康状态失败。");
		}
	});

	// Health overview callback: hov (health overview)
	bot.callbackQuery(/^hov$/, async (ctx) => {
		try {
			await renderHealthOverview(ctx, ctx.callbackQuery.message?.message_id);
			await ctx.answerCallbackQuery();
		} catch (error) {
			console.error("[Health] Overview callback error:", error);
			await ctx.answerCallbackQuery("Error loading health data");
		}
	});

	// Health detail callback: hd:<node>
	bot.callbackQuery(/^hd:(.+)$/, async (ctx) => {
		const node = ctx.match?.[1];
		if (!node) return;
		try {
			await renderHealthDetail(ctx, node, ctx.callbackQuery.message?.message_id);
			await ctx.answerCallbackQuery();
		} catch (error) {
			console.error("[Health] Detail callback error:", error);
			await ctx.answerCallbackQuery("Error loading health data");
		}
	});

	// Health fix callback: hfix:<node>
	bot.callbackQuery(/^hfix:(.+)$/, async (ctx) => {
		const node = ctx.match?.[1];
		if (!node) return;
		try {
			await ctx.answerCallbackQuery("🔧 Fixing...");
			await executeHealthFix(ctx, node);
		} catch (error) {
			console.error("[Health] Fix callback error:", error);
			await ctx.answerCallbackQuery("Fix failed");
		}
	});

	/**
	 * /addpeer - Admin command to directly add peer (bypasses approval)
	 * Usage: /addpeer <ASN> [node] [endpoint:port] [pubkey] [ipv6]
	 * If only ASN provided, starts interactive wizard
	 */
	bot.command("addpeer", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.reply("❌ Admin access required.");
			return;
		}

		const args = ctx.match?.trim().split(/\s+/) || [];

		// No args - show help
		if (args.length === 0 || args[0] === "") {
			await ctx.reply(
				`🔧 *Admin Add Peer 管理员添加 Peer*\n\n` +
					`Usage 用法:\n` +
					`• \`/addpeer <ASN>\` - 交互式向导\n` +
					`• \`/addpeer <ASN> <node> <endpoint:port> <pubkey> <ipv6>\` - 一行命令\n\n` +
					`Example 示例:\n` +
					`\`/addpeer 4242420998\` - 启动向导\n` +
					`\`/addpeer 4242420998 hk-edge tunnel.example.com:51820 PUBKEY fd00::1\`\n\n` +
					`Note: Peer will be created with ACTIVE status (no approval needed)\n` +
					`注意: Peer 将以 ACTIVE 状态创建（无需审批）`,
				{ parse_mode: "Markdown" },
			);
			return;
		}

		const asnStr = args[0] || "";
		const asn = normalizeAsn(asnStr);

		if (isNaN(asn)) {
			await ctx.reply("❌ Invalid ASN format\n无效的 ASN 格式");
			return;
		}

		// Single arg (ASN only) - start interactive wizard
		if (args.length === 1) {
			await ctx.reply(
				`🔧 *Admin Add Peer Wizard*\n` +
					`为 AS${asn} 添加 Peer\n\n` +
					`Starting wizard...`,
				{ parse_mode: "Markdown" },
			);

			// Initialize peerFlow in admin mode
			ctx.session.peerFlow = {
				step: "admin_select_node",
				isAdminMode: true,
				targetAsn: asn,
			};

			// Trigger node selection (same as /peer)
			await startNodeSelection(ctx, asn);
			return;
		}

		// Full command mode - at least 5 args needed
		if (args.length < 5) {
			await ctx.reply(
				`❌ Not enough arguments.\n\n` +
					`Use \`/addpeer ${asn}\` for interactive wizard, or provide all 5 args:\n` +
					`\`/addpeer <ASN> <node> <endpoint:port> <pubkey> <ipv6>\``,
				{ parse_mode: "Markdown" },
			);
			return;
		}
		const node = args[1] || "";
		const endpointPort = args[2] || "";
		const pubkey = args[3] || "";
		const ipv6 = args[4] || "";
		const [endpoint, port] = endpointPort.split(":");

		if (!pubkey || pubkey.length !== 44) {
			await ctx.reply(
				"❌ Invalid WireGuard public key (should be 44 chars base64)\n无效的 WireGuard 公钥",
			);
			return;
		}

		await ctx.reply(
			`⏳ Creating peer...\n正在创建 Peer...\n\n` +
				`ASN: \`AS${asn}\`\n` +
				`Node: \`${node}\`\n` +
				`Endpoint: \`${endpoint}:${port}\``,
			{ parse_mode: "Markdown" },
		);

		try {
			const result = await apiRequest(
				"/admin",
				"POST",
				{
					action: "createSession",
					asn,
					router: node,
					endpoint,
					port: parseInt(port || "51820", 10),
					publicKey: pubkey,
					ipv6,
					status: 2, // ENABLED (bypass approval)
				},
				config.apiToken,
			);

			if (result.code !== 0) {
				await ctx.reply(`❌ Error: ${result.message}`);
				return;
			}

			await ctx.reply(
				`✅ *Peer Created 已创建*\n\n` +
					`ASN: \`AS${asn}\`\n` +
					`Node: \`${node}\`\n` +
					`Status: \`ACTIVE\` (免审核)`,
				{ parse_mode: "Markdown" },
			);
		} catch (error) {
			console.error("[AddPeer] Error:", error);
			await ctx.reply(`❌ Failed to create peer: ${(error as Error).message}`);
		}
	});

	/**
	 * Start node selection for admin wizard
	 * Shares the same logic as /peer but marks as admin mode
	 */
	async function startNodeSelection(ctx: BotContext, asn: number) {
		try {
			const result = await apiRequest(
				"/admin",
				"POST",
				{
					action: "enumRouters",
				},
				config.apiToken,
			);

			if (result.code !== 0 || !result.data?.routers) {
				await ctx.reply("❌ Failed to fetch nodes.");
				ctx.session.peerFlow = undefined;
				return;
			}

			const routers = result.data.routers;

			if (routers.length === 0) {
				await ctx.reply("❌ No available nodes.");
				ctx.session.peerFlow = undefined;
				return;
			}

			// Build node list message with detailed info (dn42-bot style)
			let msgText = "";
			const nodeMap: Record<
				string,
				{
					uuid: string;
					endpoint: string;
					pubkey: string;
					nodeId: number;
					regionCode: number;
					name: string;
				}
			> = {};
			const couldPeer: string[] = [];

			for (const r of routers.sort((a: { name: string }, b: { name: string }) =>
				a.name.localeCompare(b.name),
			)) {
				// Build label: NAME | City | Provider
				const nodeName = r.name.toUpperCase();
				const city = r.location || "";
				const provider = r.provider || "";
				const label = provider
					? `${nodeName} | ${city} | ${provider}`
					: `${nodeName} | ${city}`;

				// Status section - use different icons
				let statusLines = `- ${label}\n`;

				if (r.isOpen) {
					statusLines += `  🟢 Open For Peer\n`;
				} else {
					statusLines += `  🔴 Closed\n`;
				}

				// Capacity
				const current = r.sessionCount || 0;
				const max = r.maxPeers || 0;
				if (max > 0) {
					statusLines += `  👥 Capacity: ${current} / ${max}\n`;
				} else {
					statusLines += `  👥 Capacity: ${current} / Unlimited\n`;
				}

				// IPv4/IPv6 support - only show if not supported
				if (r.supportsIpv4 === false) {
					statusLines += `  ⚠️ IPv4: No\n`;
				}
				if (r.supportsIpv6 === false) {
					statusLines += `  ⚠️ IPv6: No\n`;
				}

				// CN peer restriction
				if (r.allowCnPeers === false) {
					statusLines += `  🚫 Not allowed to peer with Chinese Mainland\n`;
				}

				msgText += statusLines + "\n";

				// Add to selectable list if open and has capacity
				const hasCapacity = max === 0 || current < max;
				if (r.isOpen && hasCapacity) {
					couldPeer.push(label);
					nodeMap[label] = {
						uuid: r.uuid,
						endpoint: r.endpoint || `${r.name}.dn42.moenet.work`,
						pubkey: r.wgPublicKey || "N/A",
						nodeId: r.nodeId || 0,
						regionCode: r.regionCode || 0,
						name: r.name,
					};
				}
			}

			if (couldPeer.length === 0) {
				await ctx.reply(
					`${msgText}\n❌ No available nodes for peering\n当前没有可 Peer 的节点`,
					{ reply_markup: { remove_keyboard: true } },
				);
				ctx.session.peerFlow = undefined;
				return;
			}

			// Save nodeMap to session
			ctx.session.peerFlow = {
				...ctx.session.peerFlow!,
				step: "select_node",
				nodeMap,
			};

			// Send node list
			await ctx.reply(msgText);

			// Build ReplyKeyboard with one row per option
			const keyboard: { text: string }[][] = couldPeer.map((label) => [
				{ text: label },
			]);

			// Send selection prompt with ReplyKeyboard
			await ctx.reply("Which node do you want to choose?\n你想选择哪个节点?", {
				reply_markup: {
					keyboard,
					resize_keyboard: true,
					one_time_keyboard: true,
				},
			});
		} catch (error) {
			console.error("[AddPeer Wizard] Error:", error);
			await ctx.reply("❌ Failed to fetch nodes.");
			ctx.session.peerFlow = undefined;
		}
	}

	/**
	 * Handle ReplyKeyboard node selection for admin addpeer wizard
	 */
	bot.on("message:text", async (ctx, next) => {
		const flow = ctx.session.peerFlow;
		if (!flow || flow.step !== "select_node" || !flow.isAdminMode) {
			return next();
		}

		const text = ctx.message.text.trim();
		const nodeInfo = flow.nodeMap?.[text];

		if (!nodeInfo) {
			// Not a valid node selection, pass to next handler
			return next();
		}

		// Get ASN from flow and calculate port
		const asn = flow.targetAsn || 0;
		const userPort = calculatePort(asn);

		// Update session with selected node
		ctx.session.peerFlow = {
			...flow,
			step: "await_continue",
			routerName: nodeInfo.name || text.split(" | ")[1] || text,
			sessionUuid: nodeInfo.uuid,
			serverEndpoint: nodeInfo.endpoint,
			serverPort: userPort,
			serverPubkey: nodeInfo.pubkey,
			serverLla: `fe80::998:${nodeInfo.regionCode}:${nodeInfo.nodeId}:1`,
		};

		// Confirm selection - use routerName from session
		await ctx.reply(`✅ Selected: ${ctx.session.peerFlow.routerName}`, {
			reply_markup: { remove_keyboard: true },
		});

		// Import and call showServerWgInfo (reads info from ctx.session.peerFlow)
		const { showServerWgInfo } = await import("./peer/ui");
		await showServerWgInfo(ctx);
	});

	/**
	 * /announce <message> - Broadcast announcement with node targeting + dual channel
	 */
	bot.command("announce", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.reply("❌ Admin access required.\n需要管理员权限。");
			return;
		}

		// Fetch routers for node selection (needed for both paths)
		const routerResult = await apiRequest(
			"/admin",
			"POST",
			{ action: "enumRouters" },
			config.apiToken,
		);
		const routers = routerResult.data?.routers || [];

		const message = ctx.match?.trim() || undefined;

		// Init flow with optional pre-filled message
		ctx.session.announceFlow = {
			message,
			routerUuids: routers.map((r: { uuid: string }) => r.uuid),
			routerNames: routers.map((r: { name: string }) => r.name),
		};

		await showAnnounceMenu(ctx);
	});

	/** Build and display the announce main menu */
	async function showAnnounceMenu(ctx: BotContext, editMessage = false) {
		const flow = ctx.session.announceFlow;
		if (!flow) return;

		const msgStatus = flow.message
			? `✅ ${flow.message.length > 40 ? flow.message.slice(0, 40) + "..." : flow.message}`
			: "❌ Not set 未填写";

		const nodeStatus =
			flow.selectedRouters !== undefined
				? flow.selectedRouters.length === 0
					? "🌐 All nodes 全部节点"
					: `📍 ${flow.selectedRouters.length} node(s) 节点`
				: "❌ Not set 未选择";

		const targetInfo = flow.targetCount
			? `\nTargets 用户: 👥 ${flow.targetCount.tg + flow.targetCount.email} (📱TG ${flow.targetCount.tg} + 📧Email ${flow.targetCount.email})`
			: "";

		const text =
			`📢 *Announce 公告*\n${DIVIDER}\n` +
			`Content 内容: ${escapeMarkdown(msgStatus)}\n` +
			`Scope 范围: ${escapeMarkdown(nodeStatus)}` +
			targetInfo;

		const keyboard = new InlineKeyboard()
			.text(
				`📝 ${flow.message ? "Edit" : "Set"} Content ${flow.message ? "修改" : "填写"}内容`,
				"ann:msg",
			)
			.row()
			.text("🌐 All users 全部用户", "ann:all")
			.row();

		if (flow.routerNames.length > 0) {
			keyboard
				.text(
					"📍 Select nodes 选择节点",
					"ann:select:" + "0".repeat(flow.routerNames.length),
				)
				.row();
		}

		// Only show preview if message is filled
		if (flow.message && flow.selectedRouters !== undefined) {
			keyboard.text("✅ Preview & Send 预览发送", "ann:preview").row();
		}

		keyboard.text("🚫 Cancel 取消", "ann:cancel");

		if (editMessage) {
			await ctx.editMessageText(text, {
				parse_mode: "Markdown",
				reply_markup: keyboard,
			});
		} else {
			await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
		}
	}

	// ann:msg → ask for message text
	bot.callbackQuery("ann:msg", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();

		if (!ctx.session.announceFlow) return;
		ctx.session.announceFlow.awaitingMessage = true;

		const keyboard = new InlineKeyboard().text("⬅️ Back 返回", "ann:back");

		await ctx.editMessageText(
			`📢 *Announce — Content 内容*\n${DIVIDER}\n` +
				`Enter announcement message below.\n` +
				`请输入公告内容。`,
			{ parse_mode: "Markdown", reply_markup: keyboard },
		);
	});

	// ann:back → return to announce menu
	bot.callbackQuery("ann:back", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();
		if (!ctx.session.announceFlow) {
			await ctx.editMessageText(
				"❌ Session expired. Run /announce again.\n会话已过期，请重新执行 /announce",
			);
			return;
		}
		ctx.session.announceFlow.awaitingMessage = false;
		await showAnnounceMenu(ctx, true);
	});

	// Handle text input for announce message
	bot.on("message:text", async (ctx, next) => {
		const flow = ctx.session.announceFlow;
		if (!flow?.awaitingMessage) return next();

		const text = ctx.message.text.trim();

		// If a command, cancel flow and pass through
		if (text.startsWith("/")) {
			ctx.session.announceFlow = undefined;
			return next();
		}

		flow.awaitingMessage = false;
		flow.message = text;
		ctx.session.announceFlow = flow;
		await showAnnounceMenu(ctx);
	});

	// Build node selection keyboard from bitmask
	function buildNodeKeyboard(
		routerNames: string[],
		bitmask: string,
	): InlineKeyboard {
		const keyboard = new InlineKeyboard();

		for (let i = 0; i < routerNames.length; i++) {
			const selected = bitmask[i] === "1";
			const label = `${selected ? "☑️" : "☐"} ${routerNames[i]}`;
			// Toggle: flip bit at index i
			const newBitmask =
				bitmask.substring(0, i) +
				(selected ? "0" : "1") +
				bitmask.substring(i + 1);
			keyboard.text(label, `ann:t:${i}:${newBitmask}`);

			// Two per row
			if (i % 2 === 1 || i === routerNames.length - 1) {
				keyboard.row();
			}
		}

		const selectedCount = (bitmask.match(/1/g) || []).length;
		keyboard
			.text(`✅ Done 确认选择 (${selectedCount})`, `ann:done:${bitmask}`)
			.row();
		keyboard.text("🚫 Cancel 取消", "ann:cancel");

		return keyboard;
	}

	// Handle "Select nodes" → show toggle keyboard
	bot.callbackQuery(/^ann:select:(.+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();

		const bitmask = ctx.match[1]!;
		const flow = ctx.session.announceFlow;
		if (!flow) {
			await ctx.editMessageText(
				"❌ Session expired. Run /announce again.\n会话已过期，请重新执行 /announce",
			);
			return;
		}

		const keyboard = buildNodeKeyboard(flow.routerNames, bitmask);

		await ctx.editMessageText(
			`📢 *Select Nodes 选择节点*\n\n` +
				`Message 消息:\n${escapeMarkdown(flow.message || "")}\n\n` +
				`Tap nodes to toggle selection:\n` +
				`点击节点切换选中状态：`,
			{ parse_mode: "Markdown", reply_markup: keyboard },
		);
	});

	// Handle toggle button
	bot.callbackQuery(/^ann:t:(\d+):(.+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		const selectedCount = (ctx.match[2]!.match(/1/g) || []).length;
		await ctx.answerCallbackQuery(`${selectedCount} node(s) selected`);

		const bitmask = ctx.match[2]!;
		const flow = ctx.session.announceFlow;
		if (!flow) {
			await ctx.editMessageText(
				"❌ Session expired. Run /announce again.\n会话已过期，请重新执行 /announce",
			);
			return;
		}

		const keyboard = buildNodeKeyboard(flow.routerNames, bitmask);

		await ctx.editMessageText(
			`📢 *Select Nodes 选择节点*\n\n` +
				`Message 消息:\n${escapeMarkdown(flow.message || "")}\n\n` +
				`Tap nodes to toggle selection:\n` +
				`点击节点切换选中状态：`,
			{ parse_mode: "Markdown", reply_markup: keyboard },
		);
	});

	// Handle "Done" → store selection, go to preview or back to menu
	bot.callbackQuery(/^ann:done:(.+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}

		const bitmask = ctx.match[1]!;
		const flow = ctx.session.announceFlow;
		if (!flow) {
			await ctx.editMessageText(
				"❌ Session expired. Run /announce again.\n会话已过期，请重新执行 /announce",
			);
			return;
		}

		const selectedCount = (bitmask.match(/1/g) || []).length;
		if (selectedCount === 0) {
			await ctx.answerCallbackQuery(
				"⚠️ Select at least 1 node 至少选择 1 个节点",
			);
			return;
		}

		await ctx.answerCallbackQuery(`${selectedCount} node(s) selected`);

		// Resolve selected router UUIDs and store in session
		const selectedRouters = flow.routerUuids.filter(
			(_: string, i: number) => bitmask[i] === "1",
		);
		const targetCount = await fetchTargetCount(selectedRouters);
		ctx.session.announceFlow = { ...flow, selectedRouters, targetCount };

		// If message is filled → go to preview; otherwise → back to menu
		if (flow.message) {
			const selectedNames = flow.routerNames.filter(
				(_: string, i: number) => bitmask[i] === "1",
			);
			await sendAnnouncePreview(
				ctx,
				flow.message,
				selectedRouters,
				selectedNames,
			);
		} else {
			await showAnnounceMenu(ctx, true);
		}
	});

	// Handle "All users" → store selection, go to preview or back to menu
	bot.callbackQuery("ann:all", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();

		const flow = ctx.session.announceFlow;
		if (!flow) {
			await ctx.editMessageText(
				"❌ Session expired. Run /announce again.\n会话已过期，请重新执行 /announce",
			);
			return;
		}

		const targetCount = await fetchTargetCount([]);
		ctx.session.announceFlow = { ...flow, selectedRouters: [], targetCount };

		// If message is filled → go to preview; otherwise → back to menu
		if (flow.message) {
			await sendAnnouncePreview(ctx, flow.message, [], []);
		} else {
			await showAnnounceMenu(ctx, true);
		}
	});

	/** Fetch target user count for given routers (empty = all) */
	async function fetchTargetCount(
		routers: string[],
	): Promise<{ tg: number; email: number }> {
		try {
			const result = await apiRequest(
				"/admin",
				"POST",
				{
					action: "getNotificationTargets",
					...(routers.length > 0 ? { routers } : {}),
				},
				config.apiToken,
			);

			if (result.code === 0) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const data = result.data as any;
				const tg = ((data?.targets || []) as NotificationTarget[]).length;
				const email = (
					(data?.emailFallbacks || []) as Array<{ asn: number; email: string }>
				).length;
				return { tg, email };
			}
		} catch {
			// Non-critical, return zeros
		}
		return { tg: 0, email: 0 };
	}

	// Handle "Preview & Send" from main menu
	bot.callbackQuery("ann:preview", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery("Loading preview... 加载预览...");

		const flow = ctx.session.announceFlow;
		if (!flow?.message || flow.selectedRouters === undefined) {
			await ctx.editMessageText(
				"❌ Missing content or scope.\n缺少内容或范围。",
			);
			return;
		}

		const routers = flow.selectedRouters;
		const routerNames =
			routers.length > 0
				? routers.map((uuid) => {
						const idx = flow.routerUuids.indexOf(uuid);
						return idx !== -1 ? flow.routerNames[idx]! : uuid;
					})
				: [];

		await sendAnnouncePreview(ctx, flow.message, routers, routerNames);
	});

	// Shared: fetch targets → show confirm
	async function sendAnnouncePreview(
		ctx: BotContext,
		message: string,
		routers: string[],
		routerNames: string[],
	) {
		const result = await apiRequest(
			"/admin",
			"POST",
			{
				action: "getNotificationTargets",
				...(routers.length > 0 ? { routers } : {}),
			},
			config.apiToken,
		);

		if (result.code !== 0) {
			await ctx.editMessageText(`❌ Error: ${result.message}`);
			return;
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const data = result.data as any;
		const tgTargets = (data?.targets || []) as NotificationTarget[];
		const emailTargets = (data?.emailFallbacks || []) as Array<{
			asn: number;
			email: string;
		}>;

		const scope =
			routerNames.length > 0
				? `Nodes 节点: ${routerNames.join(", ")}`
				: "All nodes 全部节点";

		let preview =
			`📢 *Announcement Confirm 确认发送*\n\n` +
			`${scope}\n\n` +
			`Message 消息:\n${escapeMarkdown(message)}\n\n` +
			`📱 Telegram: *${tgTargets.length}* users\n` +
			`📧 Email: *${emailTargets.length}* users\n` +
			`👥 Total 总计: *${tgTargets.length + emailTargets.length}* unique users`;

		if (tgTargets.length === 0 && emailTargets.length === 0) {
			preview += `\n\n⚠️ No reachable users found.\n未找到可通知的用户。`;
			await ctx.editMessageText(preview, { parse_mode: "Markdown" });
			return;
		}

		// Store in session, use simple callback_data (64-byte limit)
		const keyboard = new InlineKeyboard()
			.text("✅ Send 发送", "ann:send")
			.text("🚫 Cancel 取消", "ann:cancel");

		await ctx.editMessageText(preview, {
			parse_mode: "Markdown",
			reply_markup: keyboard,
		});
	}

	// Handle send confirm (also used by retry)
	bot.callbackQuery("ann:send", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery("Sending...");

		const flow = ctx.session.announceFlow;
		if (!flow) {
			await ctx.editMessageText("❌ Session expired. Run /announce again.");
			return;
		}

		const routers = flow.selectedRouters || [];

		await ctx.editMessageText("⏳ Sending announcement...\n正在发送公告...");

		// Fetch targets
		const result = await apiRequest(
			"/admin",
			"POST",
			{
				action: "getNotificationTargets",
				...(routers.length > 0 ? { routers } : {}),
			},
			config.apiToken,
		);

		if (result.code !== 0) {
			await ctx.editMessageText(`❌ Failed: ${result.message}`);
			return;
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const data = result.data as any;
		const tgTargets = (data?.targets || []) as NotificationTarget[];
		const emailTargets = (data?.emailFallbacks || []) as Array<{
			asn: number;
			email: string;
		}>;
		const allAsns = (data?.allAsns || []) as number[];

		// Dynamic fallback: for ASNs with no contact at all, fetch from DN42 registry
		const coveredAsns = new Set([
			...tgTargets.map((t) => t.asn),
			...emailTargets.map((t) => t.asn),
		]);
		const unreachableAsns = allAsns.filter((a) => !coveredAsns.has(a));

		if (unreachableAsns.length > 0) {
			// Parallel fetch with 5s timeout per ASN
			const contactResults = await Promise.allSettled(
				unreachableAsns.map(async (asn) => {
					const timeout = new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error("timeout")), 5000),
					);
					const contacts = await Promise.race([fetchContacts(asn), timeout]);
					const email = contacts.find(
						(c) => c.includes("@") && !c.startsWith("@"),
					);
					return email ? { asn, email } : null;
				}),
			);

			for (const result of contactResults) {
				if (result.status === "fulfilled" && result.value) {
					emailTargets.push(result.value);
					// Backfill contact (non-blocking)
					apiRequest(
						"/admin",
						"POST",
						{
							action: "updateSessionContact",
							asn: result.value.asn,
							contact: result.value.email,
						},
						config.apiToken,
					).catch(() => {});
				}
			}
		}

		const sendResult = await executeSend(
			ctx,
			flow.message || "",
			tgTargets,
			emailTargets,
		);
		await showSendReport(ctx, sendResult, flow);
	});

	// Handle retry - only re-send failed items
	bot.callbackQuery("ann:retry", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery("Retrying...");

		const flow = ctx.session.announceFlow;
		if (!flow) {
			await ctx.editMessageText("❌ Session expired. Run /announce again.");
			return;
		}

		const retryTg = (flow.failedTg || []) as NotificationTarget[];
		const retryEmail = (flow.failedEmail || []) as Array<{
			asn: number;
			email: string;
		}>;

		if (retryTg.length === 0 && retryEmail.length === 0) {
			await ctx.editMessageText(
				"✅ No failed items to retry.\n没有需要重试的项。",
			);
			return;
		}

		await ctx.editMessageText("🔄 Retrying failed items...\n正在重试失败项...");

		const sendResult = await executeSend(
			ctx,
			flow.message || "",
			retryTg,
			retryEmail,
		);
		await showSendReport(ctx, sendResult, flow, true);
	});

	/**
	 * Execute the actual send: TG + Email, return categorized results.
	 */
	async function executeSend(
		ctx: BotContext,
		message: string,
		tgTargets: NotificationTarget[],
		emailTargets: Array<{ asn: number; email: string }>,
	) {
		const adminTgId = ctx.from?.id;
		let tgSent = 0;
		const failedTg: NotificationTarget[] = [];
		const totalTg = tgTargets.filter((t) => t.telegramId !== adminTgId).length;

		for (const target of tgTargets) {
			if (target.telegramId === adminTgId) continue;
			try {
				await ctx.api.sendMessage(
					target.telegramId,
					`📢 *MoeNet Announcement 公告*\n\n${escapeMarkdown(message)}`,
					{ parse_mode: "Markdown" },
				);
				tgSent++;
			} catch (error) {
				console.error(`[Announce] TG failed AS${target.asn}:`, error);
				failedTg.push(target);
			}

			// Progress update every 10 messages
			if (
				(tgSent + failedTg.length) % 10 === 0 &&
				tgSent + failedTg.length < totalTg
			) {
				ctx
					.editMessageText(
						`⏳ Sending... 📱 TG ${tgSent + failedTg.length}/${totalTg}\n正在发送...`,
					)
					.catch(() => {}); // Non-blocking, ignore edit errors
			}
		}

		let emailSent = 0;
		const failedEmail: Array<{ asn: number; email: string }> = [];

		if (emailTargets.length > 0) {
			const emailResult = await apiRequest(
				"/admin",
				"POST",
				{
					action: "sendBulkEmail",
					message,
					targets: emailTargets,
				},
				config.apiToken,
			);

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const emailData = emailResult.data as any;
			emailSent = emailData?.sent || 0;
			const emailErrors = (emailData?.errors || []) as Array<{
				asn: number;
				error: string;
			}>;

			// Match failed ASNs back to email targets
			const failedAsnSet = new Set(
				emailErrors.map((e: { asn: number }) => e.asn),
			);
			for (const t of emailTargets) {
				if (failedAsnSet.has(t.asn)) {
					failedEmail.push(t);
				}
			}
		}

		return { tgSent, emailSent, failedTg, failedEmail };
	}

	/**
	 * Show categorized send report with retry button if there are failures.
	 */
	async function showSendReport(
		ctx: BotContext,
		result: {
			tgSent: number;
			emailSent: number;
			failedTg: NotificationTarget[];
			failedEmail: Array<{ asn: number; email: string }>;
		},
		flow: NonNullable<BotContext["session"]["announceFlow"]>,
		isRetry = false,
	) {
		const { tgSent, emailSent, failedTg, failedEmail } = result;
		const totalFailed = failedTg.length + failedEmail.length;
		const prefix = isRetry
			? "🔄 *Retry Report 重试报告*"
			: "📢 *Announcement Report 公告报告*";

		let report =
			`${prefix}\n\n` +
			`📱 TG: ✅ ${tgSent} sent, ❌ ${failedTg.length} failed\n` +
			`📧 Email: ✅ ${emailSent} sent, ❌ ${failedEmail.length} failed\n` +
			`👥 Total reached 总到达: *${tgSent + emailSent}*`;

		// Categorized failure details
		if (totalFailed > 0) {
			// Find ASNs that failed on BOTH channels
			const tgFailedAsns = new Set(failedTg.map((t) => t.asn));
			const emailFailedAsns = new Set(failedEmail.map((t) => t.asn));
			const bothFailed = [...tgFailedAsns].filter((a) =>
				emailFailedAsns.has(a),
			);
			const tgOnlyFailed = failedTg.filter((t) => !emailFailedAsns.has(t.asn));
			const emailOnlyFailed = failedEmail.filter(
				(t) => !tgFailedAsns.has(t.asn),
			);

			report += `\n\n*Failures 失败详情:*`;

			if (bothFailed.length > 0) {
				report += `\n🔴 Both TG+Email 双通道失败:`;
				for (const asn of bothFailed) {
					report += `\n  • AS${asn}`;
				}
			}
			if (tgOnlyFailed.length > 0) {
				report += `\n📱 TG only TG失败:`;
				for (const t of tgOnlyFailed) {
					report += `\n  • AS${t.asn} (id: ${t.telegramId})`;
				}
			}
			if (emailOnlyFailed.length > 0) {
				report += `\n📧 Email only 邮件失败:`;
				for (const t of emailOnlyFailed) {
					report += `\n  • AS${t.asn} (${t.email})`;
				}
			}
		}

		// Store failures in session for retry
		if (totalFailed > 0) {
			ctx.session.announceFlow = { ...flow, failedTg, failedEmail };

			const keyboard = new InlineKeyboard()
				.text(`🔄 Retry ${totalFailed} failed 重试失败项`, "ann:retry")
				.text("✅ Done 完成", "ann:done:dismiss");

			await ctx.editMessageText(report, {
				parse_mode: "Markdown",
				reply_markup: keyboard,
			});
		} else {
			// All succeeded - clean up
			ctx.session.announceFlow = undefined;
			await ctx.editMessageText(report, { parse_mode: "Markdown" });
		}
	}

	// Handle dismiss (after retry or done)
	bot.callbackQuery("ann:done:dismiss", async (ctx) => {
		await ctx.answerCallbackQuery("Done");
		ctx.session.announceFlow = undefined;
		// Remove the retry button but keep the report text
		const text = ctx.callbackQuery.message?.text || "Done";
		await ctx.editMessageText(text);
	});

	// Handle cancel
	bot.callbackQuery("ann:cancel", async (ctx) => {
		await ctx.answerCallbackQuery("Cancelled");
		await ctx.editMessageText("🚫 Announcement cancelled.\n公告已取消。");
		ctx.session.announceFlow = undefined;
	});

	/**
	 * /notify - Send notification to specific ASN users (inline keyboard flow)
	 */
	bot.command("notify", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.reply("❌ Admin access required.\n需要管理员权限。");
			return;
		}

		const args = ctx.match?.trim() || "";

		// Shortcut: /notify <ASN,...> <message> → direct send (keep backward compat)
		if (args) {
			const spaceIdx = args.indexOf(" ");
			if (spaceIdx !== -1) {
				const asnPart = args.slice(0, spaceIdx);
				const message = args.slice(spaceIdx + 1).trim();
				const asns = asnPart
					.split(",")
					.map((s) => normalizeAsn(s.trim()))
					.filter((n) => !isNaN(n));

				if (asns.length > 0 && message) {
					await executeDirectNotify(ctx, asns, message);
					return;
				}
			}

			// Single arg might be ASN → pre-fill targets
			const asns = args
				.split(",")
				.map((s) => normalizeAsn(s.trim()))
				.filter((n) => !isNaN(n));
			if (asns.length > 0) {
				ctx.session.notifyFlow = { asns };
				await showNotifyMenu(ctx);
				return;
			}
		}

		// No args → show main menu
		ctx.session.notifyFlow = {};
		await showNotifyMenu(ctx);
	});

	/** Build and display the notify main menu */
	async function showNotifyMenu(ctx: BotContext, editMessage = false) {
		const flow = ctx.session.notifyFlow;
		if (!flow) return;

		const msgStatus = flow.message
			? `✅ ${flow.message.length > 30 ? flow.message.slice(0, 30) + "..." : flow.message}`
			: "❌ Not set 未填写";
		const asnStatus =
			flow.asns && flow.asns.length > 0
				? `✅ ${flow.asns.map((a) => `AS${a}`).join(", ")}`
				: "❌ Not set 未选择";

		const text =
			`🔔 *Notify 通知*\n${DIVIDER}\n` +
			`Content 内容: ${escapeMarkdown(msgStatus)}\n` +
			`Targets 目标: ${escapeMarkdown(asnStatus)}`;

		const keyboard = new InlineKeyboard()
			.text(
				`📝 ${flow.message ? "Edit" : "Set"} Content ${flow.message ? "修改" : "填写"}内容`,
				"ntf:msg",
			)
			.row()
			.text(
				`👥 ${flow.asns?.length ? "Edit" : "Select"} ASN ${flow.asns?.length ? "修改" : "选择"}目标`,
				"ntf:asn",
			)
			.row();

		// Only show preview if both fields are filled
		if (flow.message && flow.asns && flow.asns.length > 0) {
			keyboard.text("✅ Preview & Send 预览发送", "ntf:preview").row();
		}

		keyboard.text("🚫 Cancel 取消", "ntf:cancel");

		if (editMessage) {
			await ctx.editMessageText(text, {
				parse_mode: "Markdown",
				reply_markup: keyboard,
			});
		} else {
			await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
		}
	}

	// ntf:msg → ask for message text
	bot.callbackQuery("ntf:msg", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();

		if (!ctx.session.notifyFlow) ctx.session.notifyFlow = {};
		ctx.session.notifyFlow.awaitingMessage = true;

		const keyboard = new InlineKeyboard().text("⬅️ Back 返回", "ntf:back");

		await ctx.editMessageText(
			`🔔 *Notify — Content 内容*\n${DIVIDER}\n` +
				`Enter notification message below.\n` +
				`请输入通知内容。`,
			{ parse_mode: "Markdown", reply_markup: keyboard },
		);
	});

	// ntf:asn → ask for ASN input
	bot.callbackQuery("ntf:asn", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();

		if (!ctx.session.notifyFlow) ctx.session.notifyFlow = {};
		ctx.session.notifyFlow.awaitingAsns = true;

		const keyboard = new InlineKeyboard().text("⬅️ Back 返回", "ntf:back");

		await ctx.editMessageText(
			`🔔 *Notify — Targets 目标*\n${DIVIDER}\n` +
				`Enter ASN(s), comma separated.\n` +
				`请输入 ASN，逗号分隔。\n\n` +
				`Example 示例: \`998\`, \`0998,1234\``,
			{ parse_mode: "Markdown", reply_markup: keyboard },
		);
	});

	// ntf:back → return to notify menu
	bot.callbackQuery("ntf:back", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();
		if (!ctx.session.notifyFlow) {
			await ctx.editMessageText(
				"❌ Session expired. Run /notify again.\n会话已过期，请重新执行 /notify",
			);
			return;
		}
		ctx.session.notifyFlow.awaitingMessage = false;
		ctx.session.notifyFlow.awaitingAsns = false;
		await showNotifyMenu(ctx, true);
	});

	// Handle text input for notify flow
	bot.on("message:text", async (ctx, next) => {
		const flow = ctx.session.notifyFlow;
		if (!flow) return next();

		const text = ctx.message.text.trim();

		// If a command, cancel flow and pass through
		if (text.startsWith("/")) {
			ctx.session.notifyFlow = undefined;
			return next();
		}

		// Awaiting message content
		if (flow.awaitingMessage) {
			flow.awaitingMessage = false;
			flow.message = text;
			ctx.session.notifyFlow = flow;
			await showNotifyMenu(ctx);
			return;
		}

		// Awaiting ASN input
		if (flow.awaitingAsns) {
			const asns = text
				.split(",")
				.map((s) => normalizeAsn(s.trim()))
				.filter((n) => !isNaN(n));
			if (asns.length === 0) {
				await ctx.reply(
					`❌ Invalid ASN format. Example: 998, 0998, AS4242420998\n` +
						`无效的 ASN 格式。`,
				);
				return;
			}
			flow.awaitingAsns = false;
			flow.asns = asns;
			ctx.session.notifyFlow = flow;
			await showNotifyMenu(ctx);
			return;
		}

		return next();
	});

	// ntf:preview → show confirmation
	bot.callbackQuery("ntf:preview", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();

		const flow = ctx.session.notifyFlow;
		if (!flow?.message || !flow?.asns?.length) {
			await ctx.editMessageText(
				"❌ Missing content or targets.\n缺少内容或目标。",
			);
			return;
		}

		const asnList = flow.asns.map((a) => `AS${a}`).join(", ");

		const keyboard = new InlineKeyboard()
			.text("✅ Send 发送", "ntf:send")
			.text("🚫 Cancel 取消", "ntf:cancel");

		await ctx.editMessageText(
			`🔔 *Notify Preview 通知预览*\n${DIVIDER}\n\n` +
				`*Targets 目标:* ${escapeMarkdown(asnList)}\n\n` +
				`*Content 内容:*\n${escapeMarkdown(flow.message)}\n\n` +
				`Confirm send?\n确认发送？`,
			{ parse_mode: "Markdown", reply_markup: keyboard },
		);
	});

	// ntf:send → execute send
	bot.callbackQuery("ntf:send", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery("Sending... 发送中...");

		const flow = ctx.session.notifyFlow;
		if (!flow?.message || !flow?.asns?.length) {
			await ctx.editMessageText("❌ Session expired.\n会话已过期。");
			return;
		}

		await ctx.editMessageText("⏳ Sending notifications...\n正在发送通知...");

		await executeDirectNotify(ctx, flow.asns, flow.message);
		ctx.session.notifyFlow = undefined;
	});

	// ntf:cancel → abort
	bot.callbackQuery("ntf:cancel", async (ctx) => {
		ctx.session.notifyFlow = undefined;
		await ctx.answerCallbackQuery();
		await ctx.editMessageText("❌ Cancelled.\n已取消。");
	});

	/**
	 * Execute direct notification to specific ASNs.
	 *
	 * Args:
	 *   ctx: Bot context.
	 *   asns: Target ASN list.
	 *   message: Notification message text.
	 */
	async function executeDirectNotify(
		ctx: BotContext,
		asns: number[],
		message: string,
	) {
		try {
			const result = await apiRequest(
				"/admin",
				"POST",
				{
					action: "getNotificationTargets",
					asns,
				},
				config.apiToken,
			);

			if (result.code !== 0) {
				await ctx.reply(
					`❌ Failed to get targets: ${result.message}\n获取目标失败。`,
				);
				return;
			}

			const targets =
				(result.data as unknown as { targets: NotificationTarget[] })
					?.targets || [];

			if (targets.length === 0) {
				const asnList = asns.map((a) => `AS${a}`).join(", ");
				await ctx.reply(
					`❌ No registered users found for: ${asnList}\n` +
						`未找到这些 ASN 的已注册用户。\n\n` +
						`Users must have logged in via /login to receive notifications.\n` +
						`用户需要通过 /login 登录过才能接收通知。`,
				);
				return;
			}

			let sent = 0;
			let failed = 0;
			const results: string[] = [];

			for (const target of targets) {
				try {
					await ctx.api.sendMessage(
						target.telegramId,
						`🔔 *MoeNet Notification 通知*\n\n${escapeMarkdown(message)}`,
						{ parse_mode: "Markdown" },
					);
					sent++;
					results.push(`✅ AS${target.asn}`);
				} catch (error) {
					console.error(`[Notify] Failed to send to AS${target.asn}:`, error);
					failed++;
					results.push(`❌ AS${target.asn}`);
				}
			}

			// Check for ASNs that had no targets
			const targetedAsns = new Set(targets.map((t) => Number(t.asn)));
			for (const asn of asns) {
				if (!targetedAsns.has(Number(asn))) {
					results.push(`⚠️ AS${asn} (no Telegram ID)`);
				}
			}

			await ctx.reply(
				`🔔 *Notification Report 通知报告*\n\n` +
					`${results.join("\n")}\n\n` +
					`Sent 已发送: ${sent} | Failed 失败: ${failed}`,
				{ parse_mode: "Markdown" },
			);
		} catch (error) {
			console.error("[Notify] Error:", error);
			await ctx.reply("❌ Notification failed.\n通知发送失败。");
		}
	}
}

/**
 * Show pending sessions list with inline buttons
 */
async function showPendingList(ctx: BotContext, editMessageId?: number) {
	try {
		const result = await apiRequest(
			"/admin",
			"POST",
			{
				action: "enumSessions",
				status: 3, // PENDING_REVIEW
			},
			config.apiToken,
		);

		if (result.code !== 0) {
			const msg = `❌ Error: ${result.message}`;
			if (editMessageId) {
				await ctx.api.editMessageText(ctx.chat!.id, editMessageId, msg);
			} else {
				await ctx.reply(msg);
			}
			return;
		}

		const sessions = (result.data?.sessions || []) as FullSessionInfo[];

		if (sessions.length === 0) {
			const msg = "✅ No pending requests.\n没有待审批的请求。";
			if (editMessageId) {
				await ctx.api.editMessageText(ctx.chat!.id, editMessageId, msg);
			} else {
				await ctx.reply(msg);
			}
			return;
		}

		let message = `📋 *Pending Review 待审批 (${sessions.length})*\n${DIVIDER}\n\n`;

		const keyboard = new InlineKeyboard();

		sessions.forEach((s: FullSessionInfo, i: number) => {
			const endpoint = s.endpoint || "—";
			const node = escapeMarkdown(s.routerName || s.router);
			const contact = s.contact ? `\n┃ 📧 ${escapeMarkdown(s.contact)}` : "";
			const created = s.createdAt ? `\n┃ 📅 ${timeAgo(s.createdAt)}` : "";

			message += `*${i + 1}. AS${s.asn}* → ${node}\n`;
			message += `┃ 📡 Endpoint: \`${endpoint}\`${contact}${created}\n`;
			if (s.ipv4) message += `┃ 🔗 IPv4: \`${s.ipv4}\`\n`;
			message += "\n";

			// Add approve/reject buttons for each session
			keyboard
				.text(`✅ Approve ${i + 1}`, `approve:${s.uuid}`)
				.text(`❌ Reject ${i + 1}`, `reject:${s.uuid}`)
				.row();
		});

		// Add refresh button
		keyboard.text("🔄 Refresh 刷新", "pending:refresh");

		if (editMessageId) {
			await ctx.api.editMessageText(ctx.chat!.id, editMessageId, message, {
				parse_mode: "Markdown",
				reply_markup: keyboard,
			});
		} else {
			await ctx.reply(message, {
				parse_mode: "Markdown",
				reply_markup: keyboard,
			});
		}
	} catch (error) {
		console.error("[Pending] Error:", error);
		const msg = "❌ Failed to fetch pending requests.\n获取待审批请求失败。";
		if (editMessageId) {
			await ctx.api.editMessageText(ctx.chat!.id, editMessageId, msg);
		} else {
			await ctx.reply(msg);
		}
	}
}

// Type definitions
interface ApiResponse {
	code: number;
	message: string;
	data?: {
		sessions?: FullSessionInfo[];
		routers?: RouterInfo[];
	};
}

// SessionInfo is now FullSessionInfo (defined at top of file)

interface RouterInfo {
	uuid: string;
	name: string;
	location: string;
	region?: string;
	sessionCount: number;
	isOpen: boolean;
	endpoint?: string;
	wgPublicKey?: string;
	nodeId?: number;
	regionCode?: number;
	maxPeers?: number;
	supportsIpv4?: boolean;
	supportsIpv6?: boolean;
	provider?: string;
	allowCnPeers?: boolean;
}

interface NotificationTarget {
	asn: number;
	telegramId: number;
}

/**
 * Notify migrated users about their session migration.
 * Resolves ASN → telegramId via getNotificationTargets API.
 */
async function notifyMigratedUsers(
	ctx: BotContext,
	fromName: string,
	toName: string,
	migratedResults: Array<{ asn: number }>,
) {
	if (migratedResults.length === 0) return;

	const asns = migratedResults.map((r) => r.asn);

	try {
		// Resolve ASNs to telegram IDs
		const targetsResult = await apiRequest(
			"/admin",
			"POST",
			{
				action: "getNotificationTargets",
				asns,
			},
			config.apiToken,
		);

		if (targetsResult.code !== 0) {
			console.error(
				"[MigrateNotify] Failed to resolve targets:",
				targetsResult.message,
			);
			return;
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const targets = ((targetsResult.data as any)?.targets ||
			[]) as NotificationTarget[];
		let sent = 0;

		for (const target of targets) {
			const message =
				`🔄 *Peer Migration Notice*\n` +
				`Peer 迁移通知\n\n` +
				`Your peer \`AS${target.asn}\` has been migrated:\n` +
				`您的 Peer \`AS${target.asn}\` 已迁移:\n\n` +
				`📍 From 原节点: \`${fromName}\`\n` +
				`📍 To 新节点: \`${toName}\`\n\n` +
				`⚠️ *Action Required:*\n` +
				`Please update your WireGuard Endpoint to the new node's address.\n` +
				`Use \`/info\` to view your updated peer configuration.\n\n` +
				`⚠️ *需要操作:*\n` +
				`请更新您的 WireGuard Endpoint 为新节点地址。\n` +
				`使用 \`/info\` 查看更新后的 Peer 配置。`;

			try {
				await ctx.api.sendMessage(target.telegramId, message, {
					parse_mode: "Markdown",
				});
				sent++;
			} catch (e) {
				console.error(
					`[MigrateNotify] Failed to notify AS${target.asn} (${target.telegramId}):`,
					e,
				);
			}
		}

		if (sent > 0) {
			await ctx.api.sendMessage(
				ctx.chat!.id,
				`📨 Migration notification sent to ${sent}/${asns.length} users.\n` +
					`已向 ${sent}/${asns.length} 个用户发送迁移通知。`,
			);
		}
	} catch (error) {
		console.error("[MigrateNotify] Error:", error);
	}
}

// =============================================================================
// Session Render Helpers
// =============================================================================

/**
 * Fetch sessions from API with optional status filter.
 */
async function fetchSessions(
	filter: string,
): Promise<{ sessions: FullSessionInfo[]; error?: string }> {
	const body: { action: string; status?: number } = { action: "enumSessions" };
	if (filter !== "all") {
		const code = STATUS_MAP[filter];
		if (code !== undefined) body.status = code;
	}

	const result = await apiRequest("/admin", "POST", body, config.apiToken);
	if (result.code !== 0) {
		return { sessions: [], error: result.message };
	}

	const sessions = ((result.data?.sessions || []) as FullSessionInfo[]).sort(
		(a, b) => Number(a.asn) - Number(b.asn),
	);

	return { sessions };
}

/**
 * Group sessions by router node name.
 */
function groupByNode(
	sessions: FullSessionInfo[],
): Map<string, FullSessionInfo[]> {
	const groups = new Map<string, FullSessionInfo[]>();
	for (const s of sessions) {
		const node = s.routerName || s.router;
		if (!groups.has(node)) groups.set(node, []);
		groups.get(node)!.push(s);
	}
	return groups;
}

/** Capitalize first letter */
function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Format relative time */
function timeAgo(dateStr: string): string {
	const diff = Date.now() - new Date(dateStr).getTime();
	if (Number.isNaN(diff)) return "—";
	const mins = Math.floor(diff / 60000);
	if (mins < 60) return `${mins}m ago / ${mins}分钟前`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago / ${hours}小时前`;
	const days = Math.floor(hours / 24);
	return `${days}d ago / ${days}天前`;
}

/**
 * Render: Session Summary (Tier 0)
 * /sessions or /sessions summary
 */
async function renderSessionSummary(ctx: BotContext, editMessageId?: number) {
	const { sessions, error } = await fetchSessions("all");
	if (error) {
		const msg = `❌ Error: ${error}`;
		editMessageId
			? await ctx.api.editMessageText(ctx.chat!.id, editMessageId, msg)
			: await ctx.reply(msg);
		return;
	}

	const counts: Record<number, number> = {};
	for (const s of sessions) {
		const st = s.status ?? 0;
		counts[st] = (counts[st] || 0) + 1;
	}

	let message = `📊 *Session Summary 会话概览*\n${DIVIDER}\n\n`;
	message += `Total 总计: *${sessions.length}*\n\n`;

	for (const [code, label] of Object.entries(STATUS_LABELS)) {
		const count = counts[Number(code)] || 0;
		if (count > 0) {
			message += `${label}: *${count}*\n`;
		}
	}

	message += `\n${DIVIDER}\n`;
	message += `💡 \`/sessions all\` — List all 查看全部\n`;
	message += `💡 \`/sessions active\` — Filter 按状态过滤`;

	const keyboard = new InlineKeyboard();
	// Add quick filter buttons for non-zero statuses
	if ((counts[2] || 0) > 0)
		keyboard.text(`🟢 Active (${counts[2]})`, "sl:active:0");
	if ((counts[3] || 0) > 0)
		keyboard.text(`🟡 Pending (${counts[3]})`, "sl:pending:0");
	if ((counts[6] || 0) > 0)
		keyboard.text(`🔴 Problem (${counts[6]})`, "sl:problem:0");
	keyboard.row();
	if ((counts[1] || 0) > 0)
		keyboard.text(`⚫ Disabled (${counts[1]})`, "sl:disabled:0");
	keyboard.text(`📋 All (${sessions.length})`, "sl:all:0");

	if (editMessageId) {
		await ctx.api.editMessageText(ctx.chat!.id, editMessageId, message, {
			parse_mode: "Markdown",
			reply_markup: keyboard,
		});
	} else {
		await ctx.reply(message, {
			parse_mode: "Markdown",
			reply_markup: keyboard,
		});
	}
}

/**
 * Render: Session Overview grouped by node (Tier 1)
 * /sessions active — shows nodes with session counts, paginated
 */
async function renderSessionOverview(
	ctx: BotContext,
	filter: string,
	page: number,
	editMessageId?: number,
) {
	const { sessions, error } = await fetchSessions(filter);
	if (error) {
		const msg = `❌ Error: ${error}`;
		editMessageId
			? await ctx.api.editMessageText(ctx.chat!.id, editMessageId, msg)
			: await ctx.reply(msg);
		return;
	}

	if (sessions.length === 0) {
		const filterLabel = filter === "all" ? "any status" : filter;
		const msg = `✅ No sessions with status: ${filterLabel}\n没有 ${filterLabel} 状态的会话`;
		editMessageId
			? await ctx.api.editMessageText(ctx.chat!.id, editMessageId, msg)
			: await ctx.reply(msg);
		return;
	}

	const groups = groupByNode(sessions);
	const nodeNames = [...groups.keys()].sort();
	const totalPages = Math.ceil(nodeNames.length / OVERVIEW_PAGE_SIZE);
	const safePage = Math.min(page, totalPages - 1);
	const pageNodes = nodeNames.slice(
		safePage * OVERVIEW_PAGE_SIZE,
		(safePage + 1) * OVERVIEW_PAGE_SIZE,
	);

	// Fetch health data for all visible nodes in parallel (best-effort, 5s cutoff)
	const healthMap = new Map<string, HealthData | null>();
	const healthPromises = pageNodes.map(async (node) => {
		const health = await fetchNodeHealth(node);
		healthMap.set(node, health);
	});
	await Promise.race([
		Promise.allSettled(healthPromises),
		new Promise((r) => setTimeout(r, 5_000)),
	]);

	const filterLabel = filter === "all" ? "All 全部" : capitalize(filter);
	let message = `📋 *Sessions — ${filterLabel} (${sessions.length})*\n${DIVIDER}\n\n`;

	for (const node of pageNodes) {
		const nodeSessions = groups.get(node)!;
		const health = healthMap.get(node);

		// Node header with inline health indicator
		let healthTag = "";
		if (health) {
			const { summary: hs } = health;
			const parts: string[] = [];
			if (hs.established > 0) parts.push(`${hs.established}✅`);
			if (hs.bgp_down > 0) parts.push(`${hs.bgp_down}⚠️`);
			if (hs.wg_down > 0) parts.push(`${hs.wg_down}❌`);
			healthTag = parts.length > 0 ? ` | 🏥 ${parts.join(" ")}` : " | 🏥 —";
		}

		message += `📡 *${escapeMarkdown(node)}* (${nodeSessions.length}${healthTag})\n`;

		// Show up to 5 sessions per node in compact form
		const preview = nodeSessions.slice(0, 5);
		for (let i = 0; i < preview.length; i++) {
			const s = preview[i]!;
			const dot = STATUS_DOTS[s.status ?? 0] || "?";
			const ep = s.endpoint ? `\`${s.endpoint}\`` : "—";
			const prefix =
				i === preview.length - 1 && nodeSessions.length <= 5 ? "└" : "├";
			message += `${prefix} ${dot} \`AS${s.asn}\` ${ep}\n`;
		}
		if (nodeSessions.length > 5) {
			message += `└ _…+${nodeSessions.length - 5} more 更多_\n`;
		}
		message += "\n";
	}

	// Page info
	if (totalPages > 1) {
		message += `\n📄 ${safePage + 1}/${totalPages}`;
	}

	// Build keyboard
	const keyboard = new InlineKeyboard();

	// Node detail buttons + health buttons
	for (const node of pageNodes) {
		keyboard.text(`▶ ${node}`, `sd:${filter}:${node}:0`);
		keyboard.text(`🏥`, `hd:${node}`);
	}
	keyboard.row();

	// Pagination
	if (totalPages > 1) {
		if (safePage > 0)
			keyboard.text("◀ Prev 上页", `sl:${filter}:${safePage - 1}`);
		if (safePage < totalPages - 1)
			keyboard.text("Next 下页 ▶", `sl:${filter}:${safePage + 1}`);
		keyboard.row();
	}

	// Back to summary
	keyboard.text("📊 Summary 概览", "sl:summary:0");

	if (editMessageId) {
		await ctx.api.editMessageText(ctx.chat!.id, editMessageId, message, {
			parse_mode: "Markdown",
			reply_markup: keyboard,
		});
	} else {
		await ctx.reply(message, {
			parse_mode: "Markdown",
			reply_markup: keyboard,
		});
	}
}

/**
 * Render: Session Detail for a specific node (Tier 2)
 * /sessions active hk1 — shows full detail with action buttons
 */
async function renderSessionDetail(
	ctx: BotContext,
	filter: string,
	node: string,
	page: number,
	editMessageId?: number,
) {
	const { sessions, error } = await fetchSessions(filter);
	if (error) {
		const msg = `❌ Error: ${error}`;
		editMessageId
			? await ctx.api.editMessageText(ctx.chat!.id, editMessageId, msg)
			: await ctx.reply(msg);
		return;
	}

	// Filter for this node (case-insensitive match)
	const nodeSessions = sessions.filter(
		(s) => (s.routerName || s.router).toLowerCase() === node.toLowerCase(),
	);

	if (nodeSessions.length === 0) {
		const msg =
			`✅ No sessions on \`${escapeMarkdown(node)}\` with this filter.\n` +
			`\`${escapeMarkdown(node)}\` 上没有符合条件的会话。`;
		editMessageId
			? await ctx.api.editMessageText(ctx.chat!.id, editMessageId, msg, {
					parse_mode: "Markdown",
				})
			: await ctx.reply(msg, { parse_mode: "Markdown" });
		return;
	}

	const totalPages = Math.ceil(nodeSessions.length / DETAIL_PAGE_SIZE);
	const safePage = Math.min(page, totalPages - 1);
	const pageItems = nodeSessions.slice(
		safePage * DETAIL_PAGE_SIZE,
		(safePage + 1) * DETAIL_PAGE_SIZE,
	);

	// Resolve actual node name from first session
	const nodeName = nodeSessions[0]!.routerName || nodeSessions[0]!.router;
	const filterLabel = filter === "all" ? "All 全部" : capitalize(filter);

	let message = `🔍 *${escapeMarkdown(nodeName)} — ${filterLabel} (${nodeSessions.length})*\n${DIVIDER}\n\n`;

	for (const s of pageItems) {
		const dot = STATUS_DOTS[s.status ?? 0] || "?";
		const statusText = STATUS_LABELS[s.status ?? 0] || `Status ${s.status}`;
		const typeName =
			(s.type || "wireguard").toUpperCase() === "WIREGUARD"
				? "WireGuard"
				: s.type || "Unknown";

		message += `${dot} *AS${s.asn}*\n`;
		message += `┃ 🌐 ${typeName} | MTU ${s.mtu || 1420}\n`;
		message += `┃ 📡 Endpoint: \`${s.endpoint || "—"}\`\n`;

		if (s.ipv4 || s.localIpv4) {
			const local = s.localIpv4 ? `${s.localIpv4} → ` : "";
			message += `┃ 🔗 IPv4: \`${local}${s.ipv4 || "—"}\`\n`;
		}
		if (s.ipv6) {
			message += `┃ 🔗 IPv6: \`${s.ipv6}\`\n`;
		}
		if (s.ipv6LinkLocal) {
			message += `┃ 🔗 LL: \`${s.ipv6LinkLocal}\`\n`;
		}
		if (s.lastError) {
			message += `┃ ⚠️ Error: \`${escapeMarkdown(s.lastError.slice(0, 60))}\`\n`;
		}
		if (s.createdAt) {
			message += `┃ 📅 ${timeAgo(s.createdAt)}\n`;
		}

		message += `┗ ${statusText}\n\n`;
	}

	// Page info
	if (totalPages > 1) {
		message += `📄 ${safePage + 1}/${totalPages}`;
	}

	// Build keyboard
	const keyboard = new InlineKeyboard();

	// Action buttons for each session on this page
	let hasActions = false;
	for (const s of pageItems) {
		const shortAsn = String(s.asn).slice(-4);
		if (s.status === 2) {
			// Active → can disable
			keyboard.text(`⚫ Disable ${shortAsn}`, `sa:${s.uuid}:1`);
			hasActions = true;
		} else if (s.status === 1 || s.status === 6) {
			// Disabled/Problem → can enable
			keyboard.text(`🟢 Enable ${shortAsn}`, `sa:${s.uuid}:2`);
			hasActions = true;
		}
	}
	if (hasActions) keyboard.row();

	// Pagination
	if (totalPages > 1) {
		if (safePage > 0)
			keyboard.text("◀ Prev 上页", `sd:${filter}:${node}:${safePage - 1}`);
		if (safePage < totalPages - 1)
			keyboard.text("Next 下页 ▶", `sd:${filter}:${node}:${safePage + 1}`);
		keyboard.row();
	}

	// Back to overview
	keyboard.text("⬅️ Back 返回", `sl:${filter}:0`);

	if (editMessageId) {
		await ctx.api.editMessageText(ctx.chat!.id, editMessageId, message, {
			parse_mode: "Markdown",
			reply_markup: keyboard,
		});
	} else {
		await ctx.reply(message, {
			parse_mode: "Markdown",
			reply_markup: keyboard,
		});
	}
}

// =============================================================================
// Health Command Helpers
// =============================================================================

/** Health API response types */
interface HealthSessionInfo {
	asn: number;
	interface: string;
	wg: {
		exists: boolean;
		up: boolean;
		last_handshake: string;
		handshake_ok: boolean;
		has_link_local: boolean;
		transfer?: { rx: string; tx: string };
	};
	bgp: {
		state: string;
		uptime?: string;
		routes_imported: number;
		routes_exported: number;
	};
}

interface HealthSummary {
	total: number;
	established: number;
	bgp_down: number;
	wg_down: number;
}

interface HealthData {
	node: string;
	timestamp: number;
	sessions: HealthSessionInfo[];
	summary: HealthSummary;
}

interface FixResult {
	node: string;
	addresses_fixed: number;
	bgp_restarted: number;
	details?: Array<{ asn: number; interface: string; action: string; result: string }>;
}

/**
 * Fetch health data from a single agent node.
 */
async function fetchNodeHealth(nodeName: string): Promise<HealthData | null> {
	const endpoint = await getAgentEndpoint(nodeName);
	if (!endpoint) return null;

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10_000);

		const response = await fetch(`${endpoint}/health/sessions`, {
			method: "GET",
			headers: {
				"Authorization": `Bearer ${config.agentToken || ""}`,
			},
			signal: controller.signal,
		});

		clearTimeout(timeout);

		if (!response.ok) return null;
		return (await response.json()) as HealthData;
	} catch {
		return null;
	}
}

/**
 * Execute health fix on a node.
 */
async function fetchHealthFix(nodeName: string): Promise<FixResult | null> {
	const endpoint = await getAgentEndpoint(nodeName);
	if (!endpoint) return null;

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);

		const response = await fetch(`${endpoint}/health/fix`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${config.agentToken || ""}`,
			},
			signal: controller.signal,
		});

		clearTimeout(timeout);

		if (!response.ok) return null;
		return (await response.json()) as FixResult;
	} catch {
		return null;
	}
}

/**
 * Render health overview — all nodes summary.
 */
async function renderHealthOverview(
	ctx: BotContext,
	editMessageId?: number,
): Promise<void> {
	const nodes = await getNodes();
	const nodeNames = Array.from(nodes.keys());

	// Fetch health from all nodes in parallel
	const healthPromises = nodeNames.map(async (name) => ({
		name,
		location: nodes.get(name)?.location || name,
		health: await fetchNodeHealth(name),
	}));

	const results = await Promise.all(healthPromises);

	let message = `🏥 *Network Health*\n${DIVIDER}\n\n`;

	const keyboard = new InlineKeyboard();
	let totalEstablished = 0;
	let totalBgpDown = 0;
	let totalWgDown = 0;
	let totalSessions = 0;

	for (const { name, location, health } of results) {
		if (!health) {
			message += `📡 *${escapeMarkdown(name)}* — ${escapeMarkdown(location)}\n`;
			message += `   ⚫ Agent unreachable\n\n`;
			keyboard.text(`${name} ⚫`, `hd:${name}`).row();
			continue;
		}

		const { summary } = health;
		totalSessions += summary.total;
		totalEstablished += summary.established;
		totalBgpDown += summary.bgp_down;
		totalWgDown += summary.wg_down;

		message += `📡 *${escapeMarkdown(name)}* — ${escapeMarkdown(location)} (${summary.total})\n   `;

		const parts: string[] = [];
		if (summary.established > 0) parts.push(`✅ ${summary.established}`);
		if (summary.bgp_down > 0) parts.push(`⚠️ ${summary.bgp_down} BGP`);
		if (summary.wg_down > 0) parts.push(`❌ ${summary.wg_down} WG`);
		if (parts.length === 0) parts.push("—");

		message += parts.join(" | ");
		message += `\n\n`;

		// Node has issues → show warning indicator
		const indicator = summary.bgp_down > 0 || summary.wg_down > 0 ? "⚠️" : "✅";
		keyboard.text(`${indicator} ${name}`, `hd:${name}`);
	}

	keyboard.row();
	keyboard.text("🔄 Refresh 刷新", "hov");

	// Footer summary
	message += `${DIVIDER}\n`;
	message += `_Total: ${totalSessions} sessions | `;
	message += `✅ ${totalEstablished} | ⚠️ ${totalBgpDown} | ❌ ${totalWgDown}_\n`;
	message += `_${new Date().toISOString().slice(0, 19)}_`;

	if (editMessageId) {
		await ctx.api.editMessageText(ctx.chat!.id, editMessageId, message, {
			parse_mode: "Markdown",
			reply_markup: keyboard,
		});
	} else {
		await ctx.reply(message, {
			parse_mode: "Markdown",
			reply_markup: keyboard,
		});
	}
}

/**
 * Render health detail — per-session status for one node.
 */
async function renderHealthDetail(
	ctx: BotContext,
	nodeName: string,
	editMessageId?: number,
): Promise<void> {
	const health = await fetchNodeHealth(nodeName);

	if (!health) {
		const message = `🏥 *${escapeMarkdown(nodeName)}* — Agent unreachable\n\n⚫ Cannot connect to agent.`;
		if (editMessageId) {
			await ctx.api.editMessageText(ctx.chat!.id, editMessageId, message, {
				parse_mode: "Markdown",
			});
		} else {
			await ctx.reply(message, { parse_mode: "Markdown" });
		}
		return;
	}

	const { sessions, summary } = health;

	// Sort sessions into groups
	const established: HealthSessionInfo[] = [];
	const bgpDown: HealthSessionInfo[] = [];
	const wgDown: HealthSessionInfo[] = [];

	for (const s of sessions) {
		if (!s.wg.exists || !s.wg.up) {
			wgDown.push(s);
		} else if (s.bgp.state === "Established") {
			established.push(s);
		} else {
			bgpDown.push(s);
		}
	}

	// Sort each group by ASN
	const byAsn = (a: HealthSessionInfo, b: HealthSessionInfo) => a.asn - b.asn;
	established.sort(byAsn);
	bgpDown.sort(byAsn);
	wgDown.sort(byAsn);

	let message = `🏥 *${escapeMarkdown(nodeName)}* — ${summary.total} sessions\n${DIVIDER}\n\n`;

	// Established sessions (compact)
	if (established.length > 0) {
		message += `✅ *Established (${established.length}):*\n`;
		for (const s of established) {
			const routes = `${s.bgp.routes_imported}↓ ${s.bgp.routes_exported}↑`;
			message += `├ AS${s.asn} — ${routes}\n`;
		}
		message += `\n`;
	}

	// BGP down but WG OK (the important diagnostic section)
	if (bgpDown.length > 0) {
		message += `⚠️ *BGP Down / WG OK (${bgpDown.length}):*\n`;
		for (const s of bgpDown) {
			const wgIndicator = s.wg.handshake_ok ? "✅" : "⏳";
			const hs = s.wg.last_handshake || "—";
			const ll = s.wg.has_link_local ? "" : " 🚫LL";
			message += `├ 🟡 AS${s.asn} — BGP: ${s.bgp.state} | WG: ${wgIndicator} ${hs}${ll}\n`;
		}
		message += `\n`;
	}

	// WG down
	if (wgDown.length > 0) {
		message += `❌ *WG Down (${wgDown.length}):*\n`;
		for (const s of wgDown) {
			const exists = s.wg.exists ? "DOWN" : "MISSING";
			message += `├ 🔴 AS${s.asn} — WG: ${exists} | BGP: ${s.bgp.state}\n`;
		}
		message += `\n`;
	}

	if (sessions.length === 0) {
		message += `_(no sessions)_\n\n`;
	}

	message += `_${new Date().toISOString().slice(0, 19)}_`;

	// Keyboard
	const keyboard = new InlineKeyboard();
	if (summary.bgp_down > 0 || summary.wg_down > 0) {
		keyboard.text(`🔧 Fix ${nodeName}`, `hfix:${nodeName}`);
	}
	keyboard.text("🔄 Refresh", `hd:${nodeName}`);
	keyboard.row();
	keyboard.text("⬅️ Back 返回", "hov");

	if (editMessageId) {
		await ctx.api.editMessageText(ctx.chat!.id, editMessageId, message, {
			parse_mode: "Markdown",
			reply_markup: keyboard,
		});
	} else {
		await ctx.reply(message, {
			parse_mode: "Markdown",
			reply_markup: keyboard,
		});
	}
}

/**
 * Execute health fix on a node and display results.
 */
async function executeHealthFix(
	ctx: BotContext,
	nodeName: string,
): Promise<void> {
	const result = await fetchHealthFix(nodeName);

	if (!result) {
		await ctx.api.sendMessage(
			ctx.chat!.id,
			`❌ Fix failed: could not reach ${nodeName} agent.`,
		);
		return;
	}

	let message = `🔧 *Fix Results — ${escapeMarkdown(nodeName)}*\n${DIVIDER}\n\n`;
	message += `📍 Addresses fixed: ${result.addresses_fixed}\n`;
	message += `🔄 BGP restarted: ${result.bgp_restarted}\n`;

	if (result.details && result.details.length > 0) {
		message += `\n*Details:*\n`;
		for (const d of result.details) {
			const icon = d.result === "ok" ? "✅" : "❌";
			message += `${icon} AS${d.asn} — ${d.action}: ${d.result}\n`;
		}
	} else if (result.addresses_fixed === 0) {
		message += `\n_No issues found to fix. 没有需要修复的问题。_\n`;
	}

	const keyboard = new InlineKeyboard();
	keyboard.text("🔄 Refresh Health", `hd:${nodeName}`);
	keyboard.text("⬅️ Back", "hov");

	await ctx.api.sendMessage(ctx.chat!.id, message, {
		parse_mode: "Markdown",
		reply_markup: keyboard,
	});
}
