import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { apiRequest } from "../api";
import config from "../config";
import { isAdmin } from "../guards";
import type { BotContext } from "../index";
import { STATUS_LABELS } from "../peeringStatus";

// Generate random token (replaces nanoid) — used by the Add wizard.
function generateToken(length = 24): string {
	const chars =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let result = "";
	const randomValues = new Uint8Array(length);
	crypto.getRandomValues(randomValues);
	for (let i = 0; i < length; i++) {
		result += chars[randomValues[i]! % chars.length];
	}
	return result;
}

// Node creation wizard state
interface NodeWizardState {
	step:
		| "name"
		| "hostname"
		| "ipv4"
		| "ipv6"
		| "role"
		| "region"
		| "location"
		| "provider"
		| "bandwidth"
		| "max_peers"
		| "allow_cn"
		| "confirm";
	data: Partial<NodeData>;
}

interface NodeData {
	name: string;
	hostname: string;
	ipv4: string | null;
	ipv6: string | null;
	role: "rr" | "client";
	region: string;
	location: string;
	provider: string;
	bandwidth: string;
	maxPeers: number;
	allowCnPeers: boolean;
}

/** A router row as returned by the `enumRouters` admin action. */
interface RouterRow {
	uuid: string;
	name: string;
	location?: string;
	provider?: string;
	nodeType?: string;
	regionCode?: number;
	maxPeers?: number;
	sessionCount?: number;
	supportsIpv4?: boolean;
	supportsIpv6?: boolean;
	allowCnPeers?: boolean;
	endpoint?: string;
	publicIp?: string;
	publicIpv6?: string;
	lastSeen?: string | null;
	isOpen?: boolean;
	bootstrapToken?: string | null;
}

const CONTINENTS: Record<number, string> = {
	1: "AS",
	2: "NA",
	3: "EU",
	4: "OC",
	5: "OC",
};

/** Human region label from a numeric region code (e.g. 101 → "AS · 101"). */
function regionLabel(regionCode?: number): string {
	if (!regionCode) return "—";
	return `${CONTINENTS[Math.floor(regionCode / 100)] ?? "?"} · ${regionCode}`;
}

/** Online dot from last-seen recency: 🟢 <5m, 🟡 <30m, 🔴 older, ⚫ never. */
function onlineDot(lastSeen?: string | null): string {
	if (!lastSeen) return "⚫";
	const age = Date.now() - new Date(lastSeen).getTime();
	if (Number.isNaN(age)) return "⚫";
	if (age < 5 * 60_000) return "🟢";
	if (age < 30 * 60_000) return "🟡";
	return "🔴";
}

function lastSeenText(lastSeen?: string | null): string {
	if (!lastSeen) return "never";
	const age = Date.now() - new Date(lastSeen).getTime();
	if (Number.isNaN(age)) return "unknown";
	const m = Math.floor(age / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

/** Wrap a dynamic value as inline code, neutralising backticks. */
const code = (s: unknown) => `\`${String(s ?? "—").replace(/`/g, "'")}\``;

async function fetchNodes(): Promise<RouterRow[]> {
	const result = await apiRequest(
		"/admin",
		"POST",
		{ action: "enumRouters" },
		config.apiToken,
	);
	if (result.code !== 0 || !Array.isArray(result.data?.routers)) return [];
	return (result.data.routers as RouterRow[])
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function registerNodeCommands(bot: Bot<BotContext>) {
	/**
	 * /node — unified node command.
	 * Everyone: browse the node list + details. Admin: add / edit / delete /
	 * bootstrap / maintenance / view peers.
	 */
	bot.command("node", async (ctx) => {
		await showNodeList(ctx);
	});

	// Back to the list (refresh).
	bot.callbackQuery("node:list", async (ctx) => {
		await ctx.answerCallbackQuery();
		await showNodeList(ctx, ctx.callbackQuery.message?.message_id);
	});

	// Close (dismiss the node UI).
	bot.callbackQuery("node:close", async (ctx) => {
		await ctx.answerCallbackQuery();
		try {
			await ctx.deleteMessage();
		} catch {
			/* already gone */
		}
	});

	// View a node's detail card.
	bot.callbackQuery(/^node:v:(.+)$/, async (ctx) => {
		await ctx.answerCallbackQuery();
		await showNodeDetail(
			ctx,
			ctx.match[1]!,
			ctx.callbackQuery.message?.message_id,
		);
	});

	// ---- Admin: add wizard ----
	bot.callbackQuery("node:add", async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();
		ctx.session.nodeWizard = { step: "name", data: {} };
		await ctx.reply(
			"🖥️ *Add New Node 添加新节点*\n\n" +
				"_Use /cancel at any step to cancel / 任意步骤输入 /cancel 可取消_\n\n" +
				"Step 1/11: Enter node name (e.g., `ch1`):\n请输入节点名称:",
			{ parse_mode: "Markdown" },
		);
	});

	// ---- Admin: edit menu ----
	bot.callbackQuery(/^node:e:(.+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();
		await showEditMenu(
			ctx,
			ctx.match[1]!,
			ctx.callbackQuery.message?.message_id,
		);
	});

	// Toggle a boolean field.
	bot.callbackQuery(
		/^node:t:(.+):(allowCnPeers|supportsIpv4|supportsIpv6)$/,
		async (ctx) => {
			if (!isAdmin(ctx)) {
				await ctx.answerCallbackQuery("❌ Admin only");
				return;
			}
			const name = ctx.match[1]!;
			const field = ctx.match[2]! as
				| "allowCnPeers"
				| "supportsIpv4"
				| "supportsIpv6";

			const nodes = await fetchNodes();
			const node = nodes.find((n) => n.name === name);
			if (!node) {
				await ctx.answerCallbackQuery("❌ Not found");
				return;
			}

			const next = !(node[field] ?? true);
			const res = await apiRequest(
				"/admin",
				"POST",
				{
					action: "updateRouter",
					name,
					updates: { [field]: next },
				},
				config.apiToken,
			);
			if (res.code !== 0) {
				await ctx.answerCallbackQuery(`❌ ${res.message}`);
				return;
			}

			await ctx.answerCallbackQuery(`${field} → ${next ? "on" : "off"}`);
			await showEditMenu(ctx, name, ctx.callbackQuery.message?.message_id);
		},
	);

	// Prompt for a text/number field edit.
	bot.callbackQuery(
		/^node:et:(.+):(location|provider|maxPeers)$/,
		async (ctx) => {
			if (!isAdmin(ctx)) {
				await ctx.answerCallbackQuery("❌ Admin only");
				return;
			}
			const name = ctx.match[1]!;
			const field = ctx.match[2]! as "location" | "provider" | "maxPeers";
			ctx.session.nodeEdit = { name, field };
			await ctx.answerCallbackQuery();
			await ctx.reply(
				`✏️ Send the new *${field}* for \`${name}\` (/cancel to abort):`,
				{ parse_mode: "Markdown" },
			);
		},
	);

	// ---- Admin: peers on a node ----
	bot.callbackQuery(/^node:p:(.+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();
		await showNodePeers(
			ctx,
			ctx.match[1]!,
			ctx.callbackQuery.message?.message_id,
		);
	});

	// ---- Admin: bootstrap token ----
	bot.callbackQuery(/^node:b:(.+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();
		await showBootstrap(
			ctx,
			ctx.match[1]!,
			false,
			ctx.callbackQuery.message?.message_id,
		);
	});
	bot.callbackQuery(/^node:br:(.+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery("🔄 Regenerating...");
		await showBootstrap(
			ctx,
			ctx.match[1]!,
			true,
			ctx.callbackQuery.message?.message_id,
		);
	});

	// ---- Admin: delete (confirm → execute) ----
	bot.callbackQuery(/^node:d:(.+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery();
		const name = ctx.match[1]!;
		const nodes = await fetchNodes();
		const node = nodes.find((n) => n.name === name);
		const count = node?.sessionCount ?? 0;
		const keyboard = new InlineKeyboard()
			.text("🗑 Confirm Delete", `node:dc:${name}`)
			.text("🔙 Cancel", `node:v:${name}`);
		await ctx.editMessageText(
			`⚠️ *Delete node ${code(name)}?*\n\n` +
				`This permanently removes the node **and its ${count} session(s)**. ` +
				`This cannot be undone.\n\n` +
				`将永久删除该节点及其 ${count} 个会话，不可撤销。`,
			{ parse_mode: "Markdown", reply_markup: keyboard },
		);
	});
	bot.callbackQuery(/^node:dc:(.+)$/, async (ctx) => {
		if (!isAdmin(ctx)) {
			await ctx.answerCallbackQuery("❌ Admin only");
			return;
		}
		await ctx.answerCallbackQuery("⏳ Deleting...");
		const name = ctx.match[1]!;
		const res = await apiRequest(
			"/admin",
			"POST",
			{ action: "deleteRouter", name },
			config.apiToken,
		);
		if (res.code !== 0) {
			await ctx.editMessageText(
				`❌ Failed to delete ${code(name)}: ${res.message}`,
				{ parse_mode: "Markdown" },
			);
			return;
		}
		const n = (res.data as { sessionsDeleted?: number })?.sessionsDeleted ?? 0;
		await ctx.editMessageText(
			`✅ Node ${code(name)} deleted (${n} session(s) removed).`,
			{
				parse_mode: "Markdown",
				reply_markup: new InlineKeyboard().text("🔙 Nodes", "node:list"),
			},
		);
	});

	/**
	 * Wizard + inline-edit text input. Runs before other message:text handlers;
	 * yields via next() when neither an add-wizard nor a field edit is active.
	 */
	bot.on("message:text", async (ctx, next) => {
		// Inline field edit (from the /node edit menu).
		const edit = ctx.session.nodeEdit;
		if (edit) {
			const text = ctx.message.text.trim();
			if (text === "/cancel") {
				ctx.session.nodeEdit = undefined;
				await ctx.reply("🚫 Edit cancelled.");
				return;
			}
			let value: string | number = text;
			if (edit.field === "maxPeers") {
				const n = parseInt(text, 10);
				if (Number.isNaN(n) || n < 1) {
					await ctx.reply("❌ Enter a positive integer, or /cancel.");
					return;
				}
				value = n;
			}
			const res = await apiRequest(
				"/admin",
				"POST",
				{
					action: "updateRouter",
					name: edit.name,
					updates: { [edit.field]: value },
				},
				config.apiToken,
			);
			const name = edit.name;
			ctx.session.nodeEdit = undefined;
			if (res.code !== 0) {
				await ctx.reply(`❌ Update failed: ${res.message}`);
				return;
			}
			await ctx.reply(`✅ ${edit.field} updated.`);
			await showEditMenu(ctx, name);
			return;
		}

		const wizard = ctx.session.nodeWizard as NodeWizardState | undefined;
		if (!wizard) {
			return next();
		}

		const text = ctx.message.text.trim();

		if (text === "/cancel") {
			ctx.session.nodeWizard = undefined;
			await ctx.reply("🚫 Node creation cancelled.\n已取消节点创建。");
			return;
		}

		switch (wizard.step) {
			case "name":
				wizard.data.name = text;
				wizard.step = "hostname";
				await ctx.reply(
					"Step 2/11: Enter hostname (e.g., `lax1.edge.moenet.work`):\n请输入主机名:",
					{ parse_mode: "Markdown" },
				);
				break;
			case "hostname":
				wizard.data.hostname = text;
				wizard.step = "ipv4";
				await ctx.reply(
					"Step 3/11: Enter public IPv4 (or `skip` if no IPv4):\n请输入公网 IPv4 (或输入 `skip` 跳过):",
					{ parse_mode: "Markdown" },
				);
				break;
			case "ipv4":
				wizard.data.ipv4 = text.toLowerCase() === "skip" ? null : text;
				wizard.step = "ipv6";
				await ctx.reply(
					"Step 4/11: Enter public IPv6 (or `skip` if no IPv6):\n请输入公网 IPv6 (或输入 `skip` 跳过):",
					{ parse_mode: "Markdown" },
				);
				break;
			case "ipv6":
				wizard.data.ipv6 = text.toLowerCase() === "skip" ? null : text;
				if (!wizard.data.ipv4 && !wizard.data.ipv6) {
					await ctx.reply(
						"❌ At least one IP (IPv4 or IPv6) is required.\n至少需要一个 IP 地址。",
					);
					wizard.step = "ipv4";
					return;
				}
				wizard.step = "role";
				await ctx.reply(
					"Step 5/11: Enter role (`rr` or `client`):\n请输入角色 (`rr` 或 `client`):",
					{ parse_mode: "Markdown" },
				);
				break;
			case "role":
				if (text !== "rr" && text !== "client") {
					await ctx.reply(
						"❌ Invalid role. Must be `rr` or `client`.\n无效角色。必须为 `rr` 或 `client`。",
					);
					return;
				}
				wizard.data.role = text as "rr" | "client";
				wizard.step = "region";
				await ctx.reply(
					"Step 6/11: Enter region (e.g., `US`, `EU`, `AP`):\n请输入区域:",
					{ parse_mode: "Markdown" },
				);
				break;
			case "region":
				wizard.data.region = text;
				wizard.step = "location";
				await ctx.reply(
					"Step 7/11: Enter location (e.g., `Los Angeles`):\n请输入位置:",
					{ parse_mode: "Markdown" },
				);
				break;
			case "location":
				wizard.data.location = text;
				wizard.step = "provider";
				await ctx.reply(
					"Step 8/11: Enter provider (e.g., `RackNerd`, `BuyVM`):\n请输入提供商:",
					{ parse_mode: "Markdown" },
				);
				break;
			case "provider":
				wizard.data.provider = text;
				wizard.step = "bandwidth";
				await ctx.reply(
					"Step 9/11: Enter bandwidth (e.g., `1G`, `10G`):\n请输入带宽:",
					{ parse_mode: "Markdown" },
				);
				break;
			case "bandwidth":
				wizard.data.bandwidth = text;
				wizard.step = "max_peers";
				await ctx.reply(
					"Step 10/11: Enter max peers (e.g., `50`):\n请输入最大 Peer 数:",
					{ parse_mode: "Markdown" },
				);
				break;
			case "max_peers": {
				const maxPeers = parseInt(text, 10);
				if (Number.isNaN(maxPeers) || maxPeers < 1) {
					await ctx.reply(
						"❌ Invalid number. Please enter a positive integer.\n请输入正整数。",
					);
					return;
				}
				wizard.data.maxPeers = maxPeers;
				wizard.step = "allow_cn";
				await ctx.reply(
					"Step 11/11: Allow China peers? (`yes` or `no`):\n是否允许中国大陆 Peer? (`yes` 或 `no`):",
					{ parse_mode: "Markdown" },
				);
				break;
			}
			case "allow_cn": {
				if (text.toLowerCase() !== "yes" && text.toLowerCase() !== "no") {
					await ctx.reply(
						"❌ Please enter `yes` or `no`.\n请输入 `yes` 或 `no`。",
					);
					return;
				}
				wizard.data.allowCnPeers = text.toLowerCase() === "yes";
				wizard.step = "confirm";
				const data = wizard.data;
				await ctx.reply(
					`📋 *Confirm Node Creation 确认创建节点*\n\n` +
						`🏷️ Name: ${code(data.name)}\n` +
						`🌐 Hostname: ${code(data.hostname)}\n` +
						`📍 Public IP: ${code(data.ipv4 || "N/A")} / ${code(data.ipv6 || "N/A")}\n` +
						`👤 Role: ${code(data.role)}\n` +
						`🗺️ Region: ${code(data.region)}\n` +
						`📌 Location: ${code(data.location)}\n` +
						`🏢 Provider: ${code(data.provider)}\n` +
						`📶 Bandwidth: ${code(data.bandwidth)}\n` +
						`👥 Max Peers: ${code(data.maxPeers)}\n` +
						`🇨🇳 Allow CN: ${code(data.allowCnPeers ? "Yes" : "No")}\n\n` +
						`_Type \`yes\` to confirm or /cancel to abort_`,
					{ parse_mode: "Markdown" },
				);
				break;
			}
			case "confirm":
				if (text.toLowerCase() !== "yes") {
					await ctx.reply(
						"❌ Please type `yes` to confirm or /cancel to abort.\n请输入 `yes` 确认或 /cancel 取消。",
					);
					return;
				}
				await createNode(ctx, wizard.data as NodeData);
				ctx.session.nodeWizard = undefined;
				break;
		}
	});
}

/** Render the node list with an inline button per node. */
async function showNodeList(ctx: BotContext, editMessageId?: number) {
	const nodes = await fetchNodes();
	const admin = isAdmin(ctx);

	if (nodes.length === 0) {
		const msg = "❌ No nodes available.\n当前没有节点。";
		if (editMessageId)
			await ctx.api.editMessageText(ctx.chat!.id, editMessageId, msg);
		else await ctx.reply(msg);
		return;
	}

	let text = `🛰 *MoeNet Nodes 节点列表* (${nodes.length})\n\n`;
	const keyboard = new InlineKeyboard();
	nodes.forEach((n, i) => {
		const cap = n.maxPeers
			? `${n.sessionCount ?? 0}/${n.maxPeers}`
			: `${n.sessionCount ?? 0}`;
		text += `${onlineDot(n.lastSeen)} *${n.name}* — ${regionLabel(n.regionCode)} · 👥 ${cap}\n`;
		keyboard.text(`${onlineDot(n.lastSeen)} ${n.name}`, `node:v:${n.name}`);
		if (i % 2 === 1) keyboard.row();
	});
	keyboard.row();
	if (admin) keyboard.text("➕ Add Node", "node:add");
	keyboard.text("🔄 Refresh", "node:list").text("❌ Close", "node:close");

	if (editMessageId) {
		try {
			await ctx.api.editMessageText(ctx.chat!.id, editMessageId, text, {
				parse_mode: "Markdown",
				reply_markup: keyboard,
			});
		} catch (e) {
			if (!(e instanceof Error && e.message.includes("not modified"))) throw e;
		}
	} else {
		await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
	}
}

/** Render a node's detail card. */
async function showNodeDetail(
	ctx: BotContext,
	name: string,
	editMessageId?: number,
) {
	const nodes = await fetchNodes();
	const n = nodes.find((r) => r.name === name);
	if (!n) {
		await ctx.reply("❌ Node not found.");
		return;
	}
	const admin = isAdmin(ctx);

	const text =
		`${onlineDot(n.lastSeen)} *${n.name}* — ${n.lastSeen ? `seen ${lastSeenText(n.lastSeen)}` : "never seen"}\n` +
		`────────\n` +
		`🗺 Region: ${code(regionLabel(n.regionCode))}\n` +
		`📍 Location: ${code(n.location || "—")}\n` +
		`🏢 Provider: ${code(n.provider || "—")}\n` +
		`👤 Type: ${code(n.nodeType || "client")}\n` +
		`👥 Peers: ${code(`${n.sessionCount ?? 0} / ${n.maxPeers ?? "∞"}`)}\n` +
		`🌐 IPv4 ${n.supportsIpv4 === false ? "❌" : "✅"} · IPv6 ${n.supportsIpv6 === false ? "❌" : "✅"}\n` +
		`🇨🇳 CN peers: ${n.allowCnPeers === false ? "🚫 rejected" : "✅ allowed"}\n` +
		`📡 Endpoint: ${code(n.endpoint || `${n.name}.dn42.moenet.work`)}`;

	const keyboard = new InlineKeyboard()
		.text("🤝 Peer here", `peer:here:${n.name}`)
		.row();
	if (admin) {
		keyboard
			.text("✏️ Edit", `node:e:${n.name}`)
			.text("📋 Peers", `node:p:${n.name}`)
			.row()
			.text("🔧 Maintenance", `main:node:${n.name}`)
			.text("🔑 Bootstrap", `node:b:${n.name}`)
			.row()
			.text("🗑 Delete", `node:d:${n.name}`)
			.row();
	}
	keyboard.text("🔙 Nodes", "node:list");

	if (editMessageId) {
		try {
			await ctx.api.editMessageText(ctx.chat!.id, editMessageId, text, {
				parse_mode: "Markdown",
				reply_markup: keyboard,
			});
		} catch (e) {
			if (!(e instanceof Error && e.message.includes("not modified"))) throw e;
		}
	} else {
		await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
	}
}

/** Render the admin edit menu for a node. */
async function showEditMenu(
	ctx: BotContext,
	name: string,
	editMessageId?: number,
) {
	const nodes = await fetchNodes();
	const n = nodes.find((r) => r.name === name);
	if (!n) {
		await ctx.reply("❌ Node not found.");
		return;
	}

	const onoff = (b?: boolean) => (b === false ? "❌" : "✅");
	const text =
		`✏️ *Edit ${n.name}*\n\n` +
		`Tap a toggle to flip it, or a field to set a new value.`;
	const keyboard = new InlineKeyboard()
		.text(
			`🇨🇳 Allow CN: ${onoff(n.allowCnPeers)}`,
			`node:t:${name}:allowCnPeers`,
		)
		.row()
		.text(`IPv4: ${onoff(n.supportsIpv4)}`, `node:t:${name}:supportsIpv4`)
		.text(`IPv6: ${onoff(n.supportsIpv6)}`, `node:t:${name}:supportsIpv6`)
		.row()
		.text(`📍 Location: ${n.location || "—"}`, `node:et:${name}:location`)
		.row()
		.text(`🏢 Provider: ${n.provider || "—"}`, `node:et:${name}:provider`)
		.row()
		.text(`👥 Max Peers: ${n.maxPeers ?? "—"}`, `node:et:${name}:maxPeers`)
		.row()
		.text("🔙 Back", `node:v:${name}`);

	if (editMessageId) {
		try {
			await ctx.api.editMessageText(ctx.chat!.id, editMessageId, text, {
				parse_mode: "Markdown",
				reply_markup: keyboard,
			});
		} catch (e) {
			if (!(e instanceof Error && e.message.includes("not modified"))) throw e;
		}
	} else {
		await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
	}
}

/** List the BGP sessions on a node. */
async function showNodePeers(
	ctx: BotContext,
	name: string,
	editMessageId?: number,
) {
	const res = await apiRequest(
		"/admin",
		"POST",
		{ action: "enumSessions" },
		config.apiToken,
	);
	const sessions = (
		Array.isArray(res.data?.sessions) ? res.data.sessions : []
	) as Array<{
		asn: number;
		status: number;
		routerName?: string;
	}>;
	const onNode = sessions.filter((s) => s.routerName === name);

	let text = `📋 *Peers on ${name}* (${onNode.length})\n\n`;
	if (onNode.length === 0) {
		text += "_No sessions on this node._";
	} else {
		for (const s of onNode.sort((a, b) => a.asn - b.asn)) {
			text += `• \`AS${s.asn}\` — ${STATUS_LABELS[s.status] ?? s.status}\n`;
		}
	}
	const keyboard = new InlineKeyboard().text("🔙 Back", `node:v:${name}`);
	if (editMessageId) {
		try {
			await ctx.api.editMessageText(ctx.chat!.id, editMessageId, text, {
				parse_mode: "Markdown",
				reply_markup: keyboard,
			});
		} catch (e) {
			if (!(e instanceof Error && e.message.includes("not modified"))) throw e;
		}
	} else {
		await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
	}
}

/** Show (and optionally regenerate) a node's bootstrap command. */
async function showBootstrap(
	ctx: BotContext,
	name: string,
	refresh: boolean,
	editMessageId?: number,
) {
	let token: string | undefined;

	if (refresh) {
		const res = await apiRequest(
			"/admin",
			"POST",
			{ action: "regenerateBootstrapToken", name },
			config.apiToken,
		);
		if (res.code !== 0) {
			await ctx.reply(`❌ ${res.message}`);
			return;
		}
		token = (res.data as { token?: string })?.token;
	} else {
		const res = await apiRequest(
			"/admin",
			"POST",
			{ action: "getRouter", name },
			config.apiToken,
		);
		token =
			(res.data as { router?: { bootstrapToken?: string } })?.router
				?.bootstrapToken ?? undefined;
		if (!token) {
			const gen = await apiRequest(
				"/admin",
				"POST",
				{ action: "regenerateBootstrapToken", name },
				config.apiToken,
			);
			token = (gen.data as { token?: string })?.token;
		}
	}

	const coreUrl = config.coreUrl || "https://api.moenet.work";
	const text =
		`🚀 *Bootstrap — ${name}*${refresh ? " (refreshed)" : ""}\n\n` +
		"```bash\n" +
		`curl -sL ${coreUrl}/bootstrap/${token} | bash\n` +
		"```\n" +
		`Token: ${code(token)}`;
	const keyboard = new InlineKeyboard()
		.text("🔄 Refresh Token", `node:br:${name}`)
		.text("🔙 Back", `node:v:${name}`);

	if (editMessageId) {
		try {
			await ctx.api.editMessageText(ctx.chat!.id, editMessageId, text, {
				parse_mode: "Markdown",
				reply_markup: keyboard,
			});
		} catch (e) {
			if (!(e instanceof Error && e.message.includes("not modified"))) throw e;
		}
	} else {
		await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
	}
}

/**
 * Create node via API and show the bootstrap command.
 */
async function createNode(ctx: BotContext, data: NodeData) {
	try {
		const bootstrapToken = generateToken(24);
		const result = await apiRequest(
			"/admin",
			"POST",
			{
				action: "createRouter",
				...data,
				bootstrapToken,
			},
			config.apiToken,
		);

		if (result.code !== 0) {
			await ctx.reply(`❌ Error: ${result.message}`);
			return;
		}

		const nodeId =
			(result.data as { router?: { nodeId?: number } })?.router?.nodeId ??
			"N/A";
		const coreUrl = config.coreUrl || "https://api.moenet.work";

		await ctx.reply(
			`✅ *Node Created 节点已创建*\n\n` +
				`Name: ${code(data.name)}\n` +
				`Node ID: ${code(nodeId)}\n` +
				`Role: ${code(data.role)}\n` +
				`Region: ${code(data.region)}\n` +
				`Location: ${code(data.location)}\n\n` +
				`🚀 *Bootstrap Command:*\n` +
				"```bash\n" +
				`curl -sL ${coreUrl}/bootstrap/${bootstrapToken} | bash\n` +
				"```",
			{
				parse_mode: "Markdown",
				reply_markup: new InlineKeyboard().text("🔙 Nodes", "node:list"),
			},
		);
	} catch (error) {
		console.error("[CreateNode] Error:", error);
		await ctx.reply(`❌ Failed: ${(error as Error).message}`);
	}
}
