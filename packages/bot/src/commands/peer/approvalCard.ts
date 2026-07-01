/**
 * Approval decision card
 *
 * Builds the admin "New Peer Request" notification by running the verification
 * checks that already exist (DN42 registry whois, IP ownership, CN geolocation)
 * and surfacing each result, so the admin can approve with context instead of
 * bare facts. All checks run in parallel with a timeout so a slow upstream can't
 * hang the notification.
 */

import { lookupWhois, getWhoisAttr } from "../../services/dn42Registry";
import { validateIpOwnership } from "../../services/dn42Validator";
import { isChinaIP, resolveEndpoint } from "../../providers/chinaIp";

export interface ApprovalCardInput {
	asn: number;
	routerName?: string;
	/** Node's allowCnPeers flag (false = node rejects CN peers). */
	nodeAllowCn?: boolean;
	ipv6?: string; // peer-side IPv6
	localIpv6?: string; // our-side IPv6 (must also be in their pool)
	endpoint?: string; // host only; undefined/empty = NAT peer
	port?: number;
	publicKey?: string;
	contact?: string;
	sessionType?: "ipv6_only" | "ipv6_ipv4";
}

/** Unwrap a `[text](url)` Markdown link to just `text` (the registry service
 *  pre-formats some whois attrs as links, which we don't want in the card). */
const plain = (s: string): string => s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

/** Wrap a dynamic value as inline code (safe from Markdown parsing). */
const code = (s: unknown): string =>
	`\`${plain(String(s ?? "")).replace(/`/g, "'")}\``;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
	]);
}

export async function buildApprovalCard(
	input: ApprovalCardInput,
): Promise<string> {
	try {
		return await buildCard(input);
	} catch (e) {
		// Never let a verification failure block/garble the admin notification.
		console.error("[ApprovalCard] build failed, using fallback:", e);
		return (
			`🔔 *New Peer Request* — ${code(`AS${input.asn}`)}\n` +
			`📍 Node: ${code(input.routerName ?? "?")}\n` +
			`_Verification checks unavailable — use /pending to review._`
		);
	}
}

async function buildCard(input: ApprovalCardInput): Promise<string> {
	const { asn } = input;

	const [whois, peerOwn, localOwn, endpointIp] = await Promise.all([
		withTimeout(lookupWhois(`AS${asn}`), 5000, null),
		input.ipv6
			? withTimeout(validateIpOwnership(asn, input.ipv6), 5000, {
					valid: false,
					warning: "timeout",
				})
			: Promise.resolve(null),
		input.localIpv6
			? withTimeout(validateIpOwnership(asn, input.localIpv6), 5000, {
					valid: false,
					warning: "timeout",
				})
			: Promise.resolve(null),
		input.endpoint
			? withTimeout(resolveEndpoint(input.endpoint), 5000, null)
			: Promise.resolve(null),
	]);

	const lines: string[] = [];
	lines.push(`🔔 *New Peer Request* — ${code(`AS${asn}`)}`);
	if (input.contact) lines.push(`📞 ${code(input.contact)}`);
	lines.push(`📍 Node: ${code(input.routerName ?? "?")}`);
	lines.push("");

	// Registry
	if (whois) {
		const asName = getWhoisAttr(whois, "as-name") ?? "?";
		const mnt = getWhoisAttr(whois, "mnt-by") ?? "?";
		lines.push(`📖 Registry: ✅ ${code(asName)} (mnt ${code(mnt)})`);
	} else {
		lines.push(`📖 Registry: ⚠️ AS${asn} not found in DN42 registry`);
	}

	// IP ownership (peer + our-side, both must be in their pool)
	const ownOk =
		(!peerOwn || peerOwn.valid) && (!localOwn || localOwn.valid);
	const ownBits: string[] = [];
	if (peerOwn) ownBits.push(`peer ${peerOwn.valid ? "✅" : "⚠️"}`);
	if (localOwn) ownBits.push(`local ${localOwn.valid ? "✅" : "⚠️"}`);
	lines.push(
		`🔑 IP ownership: ${ownOk ? "✅" : "⚠️"} ${ownBits.join(" · ") || "n/a"}`,
	);

	// Endpoint + CN + region
	if (input.endpoint) {
		lines.push(
			`📡 Endpoint: ${code(`${input.endpoint}:${input.port ?? "?"}`)}`,
		);
		if (endpointIp) {
			const cn = isChinaIP(endpointIp);
			if (cn && input.nodeAllowCn === false) {
				lines.push(
					`🇨🇳 CN check: ⚠️ ${code(endpointIp)} is CN — this node does NOT accept CN peers`,
				);
			} else if (cn) {
				lines.push(`🇨🇳 CN check: ⚠️ ${code(endpointIp)} is CN (node allows CN)`);
			} else {
				lines.push(`🌏 Geo: ${code(endpointIp)} (non-CN) — verify same-region`);
			}
		} else {
			lines.push("🌏 Geo: ⚠️ could not resolve endpoint");
		}
	} else {
		lines.push("📡 Endpoint: ⚠️ NAT — peer initiates; their IP unknown here");
		lines.push(
			"🇨🇳 CN/region: ⏳ verified at connect time (agent learns the source IP)",
		);
	}

	// Peering method
	const method = !input.endpoint
		? "⚠️ NAT (non-standard)"
		: input.sessionType === "ipv6_ipv4"
			? "⚠️ separate IPv4+IPv6 (non-standard)"
			: "✅ MP-BGP + ENH + LLA (recommended)";
	lines.push(`⚙️ Method: ${method}`);

	if (input.publicKey) lines.push(`🔑 PubKey: ${code(input.publicKey)}`);

	lines.push("");
	lines.push("_Use /pending to review all_");
	return lines.join("\n");
}
