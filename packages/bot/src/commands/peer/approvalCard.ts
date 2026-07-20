/**
 * Approval decision card
 *
 * Builds the admin "New Peer Request" notification by running the verification
 * checks that already exist (DN42 registry whois, IP ownership, CN geolocation)
 * and surfacing each result, so the admin can approve with context instead of
 * bare facts. All checks run in parallel with a timeout so a slow upstream can't
 * hang the notification.
 */

import { isChinaIP, resolveEndpoint } from "../../providers/chinaIp";
import { getWhoisAttr, lookupWhois } from "../../services/dn42Registry";
import { isLinkLocal, validateIpOwnership } from "../../services/dn42Validator";

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

/** IPv4/IPv6 ranges that can never be a valid public WireGuard endpoint. */
function isReservedIp(ip: string): boolean {
	if (ip.includes(":")) {
		const s = ip.toLowerCase();
		if (s === "::1" || s === "::") return true;
		if (/^fe[89ab]/.test(s)) return true; // fe80::/10 link-local
		if (/^f[cd]/.test(s)) return true; // fc00::/7 ULA
		if (s.startsWith("2001:db8")) return true; // documentation
		if (s.startsWith("ff")) return true; // multicast
		return false;
	}
	const o = ip.split(".").map(Number);
	if (o.length !== 4 || o.some((n) => Number.isNaN(n))) return false;
	const [a, b, c] = o as [number, number, number, number];
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true; // link-local
	if (a === 172 && b >= 16 && b <= 31) return true; // private
	if (a === 192 && b === 168) return true; // private
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
	if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
	if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
	if (a >= 224) return true; // multicast / reserved
	return false;
}

/** Obvious placeholder endpoints people paste instead of their real one. */
const PLACEHOLDER_HOSTS = new Set([
	"example.com",
	"example.net",
	"example.org",
	"example.edu",
	"localhost",
	"google.com",
	"www.google.com",
	"baidu.com",
	"1.2.3.4",
	"1.1.1.1",
	"8.8.8.8",
	"8.8.4.4",
	"0.0.0.0",
	"test.com",
	"test",
	"invalid",
	"changeme",
	"your.endpoint",
	"endpoint",
]);

/** Reason string if the endpoint is obviously not a real clearnet WG endpoint
 *  (placeholder host, reserved/private IP, or unresolvable), else null. */
function endpointIssue(host: string, resolvedIp: string | null): string | null {
	const h = host.trim().toLowerCase();
	if (PLACEHOLDER_HOSTS.has(h)) return "placeholder / not a real endpoint";
	if (!resolvedIp) return "does not resolve";
	if (isReservedIp(resolvedIp)) return "reserved/private IP";
	return null;
}

/**
 * Synchronous endpoint sanity for creation-time rejection (no DNS): rejects
 * placeholder hosts and literal reserved/private IPs. Domain names are left to
 * the approval-time resolve check. Returns a reason string or null.
 */
export function endpointSyncIssue(host: string): string | null {
	const h = host.trim().toLowerCase();
	if (!h) return null;
	if (PLACEHOLDER_HOSTS.has(h)) return "a placeholder / not a real endpoint";
	const isLiteralIp = /^[0-9.]+$/.test(h) || h.includes(":");
	if (isLiteralIp && isReservedIp(h)) return "a reserved/private IP";
	return null;
}

/**
 * Result of evaluating a peer request.
 * - `card`: the rendered admin notification (Markdown).
 * - `autoApprove`: true when no *hard blocker* is present, so the request can
 *   skip manual review (lenient policy — see below).
 * - `reasons`: human-readable hard-blocker descriptions (empty when autoApprove).
 */
export interface PeerEvaluation {
	card: string;
	autoApprove: boolean;
	reasons: string[];
}

export async function buildApprovalCard(
	input: ApprovalCardInput,
): Promise<string> {
	return (await evaluatePeerRequest(input)).card;
}

/**
 * Evaluate a peer request: render the decision card AND decide whether it can be
 * auto-approved under the lenient policy.
 *
 * Hard blockers (→ manual review): the peer's declared IPv6 is not provably in
 * their DN42 registry pool (anti-spoofing — this is the one thing we must verify,
 * and a timeout counts as unverified), or a resolvable endpoint geolocates to CN
 * on a node that rejects CN peers. Everything else — registry-not-found, NAT
 * (no endpoint to check), non-standard method, unresolved endpoint — is a soft
 * warning that still auto-approves; NAT peers are backstopped by the runtime
 * CN/region enforcement that disables them if they connect from a bad IP.
 *
 * Any unexpected failure fails safe to manual review.
 */
export async function evaluatePeerRequest(
	input: ApprovalCardInput,
): Promise<PeerEvaluation> {
	try {
		return await evaluate(input);
	} catch (e) {
		// Never let a verification failure block/garble the admin notification —
		// and never auto-approve on an error path.
		console.error("[ApprovalCard] evaluation failed, using fallback:", e);
		return {
			card:
				`🔔 *New Peer Request* — ${code(`AS${input.asn}`)}\n` +
				`📍 Node: ${code(input.routerName ?? "?")}\n` +
				`_Verification checks unavailable — use /pending to review._`,
			autoApprove: false,
			reasons: ["verification checks unavailable"],
		};
	}
}

async function evaluate(input: ApprovalCardInput): Promise<PeerEvaluation> {
	const { asn } = input;

	// Only ULA/GUA addresses are registry-verifiable. Link-local (fe80::) can't
	// be — it's not in anyone's registry pool — and it's the normal case for the
	// recommended MP-BGP+ENH+LLA method, so we don't check (or flag) it.
	const checkPeer = !!input.ipv6 && !isLinkLocal(input.ipv6);
	const checkLocal = !!input.localIpv6 && !isLinkLocal(input.localIpv6);

	const [whois, peerOwn, localOwn, endpointIp] = await Promise.all([
		withTimeout(lookupWhois(`AS${asn}`), 5000, null),
		checkPeer
			? withTimeout(validateIpOwnership(asn, input.ipv6 as string), 5000, {
					valid: false,
					warning: "timeout",
				})
			: Promise.resolve(null),
		checkLocal
			? withTimeout(validateIpOwnership(asn, input.localIpv6 as string), 5000, {
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

	// Show the actual addresses so the admin can eyeball them. Link-local shows
	// no ownership verdict (can't be checked); ULA/GUA shows in-pool / NOT-in-pool.
	if (input.ipv6) {
		lines.push(
			checkPeer
				? `🌐 Peer IPv6: ${code(input.ipv6)} — ${peerOwn?.valid ? "✅ in AS pool" : "⚠️ NOT in AS pool"}`
				: `🌐 Peer IPv6: ${code(input.ipv6)} _(link-local — ownership n/a)_`,
		);
	}
	if (input.localIpv6) {
		lines.push(
			checkLocal
				? `🌐 Local IPv6: ${code(input.localIpv6)} — ${localOwn?.valid ? "✅ in AS pool" : "⚠️ NOT in AS pool"}`
				: `🌐 Local IPv6: ${code(input.localIpv6)} _(link-local)_`,
		);
	}

	// Endpoint + sanity + CN + region
	const epIssue = input.endpoint
		? endpointIssue(input.endpoint, endpointIp)
		: null;
	if (input.endpoint) {
		lines.push(
			`📡 Endpoint: ${code(`${input.endpoint}:${input.port ?? "?"}`)}`,
		);
		if (epIssue) {
			lines.push(`🚫 Endpoint: ⚠️ ${epIssue} — not a usable endpoint`);
		} else if (endpointIp) {
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

	// --- Lenient auto-approve decision ---
	// Hard blocker 1: the peer's declared IPv6 must be provably in their DN42
	// registry pool. A missing check (no ipv6) or a failed/timed-out one counts
	// as unverified — we do not auto-approve on faith.
	const reasons: string[] = [];
	// Only ULA/GUA can be verified; a link-local peer IPv6 is never a blocker.
	if (checkPeer && (!peerOwn || !peerOwn.valid)) {
		reasons.push("peer ULA/GUA IPv6 not in AS pool");
	}
	if (checkLocal && (!localOwn || !localOwn.valid)) {
		reasons.push("local ULA/GUA IPv6 not in AS pool");
	}
	// Hard blocker 2: an obviously bogus endpoint (placeholder like google.com /
	// 1.2.3.4, a reserved/private IP, or one that doesn't resolve). These can't be
	// a real WireGuard endpoint, so send them to manual review instead of
	// auto-approving.
	if (epIssue) {
		reasons.push(`endpoint invalid (${epIssue})`);
	}
	// Hard blocker 3: a resolvable endpoint that geolocates to CN on a node that
	// rejects CN peers. (NAT peers have no endpoint here — handled at runtime.)
	if (endpointIp && isChinaIP(endpointIp) && input.nodeAllowCn === false) {
		reasons.push("endpoint is a CN IP on a node that rejects CN peers");
	}
	const autoApprove = reasons.length === 0;

	lines.push("");
	lines.push(
		autoApprove
			? "🟢 _All hard checks passed — eligible for auto-approve_"
			: `🟡 _Needs review: ${reasons.join("; ")}_`,
	);
	return { card: lines.join("\n"), autoApprove, reasons };
}
