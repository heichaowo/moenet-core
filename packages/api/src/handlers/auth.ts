import type { Context } from "hono";
import { sign, verify } from "hono/jwt";
import * as openpgp from "openpgp";
import { logger } from "../common/logger";
import { makeResponse, ResponseCode, success } from "../common/response";
import config from "../config";
import { getEmailProvider } from "../providers/email";
import { getWhoisProvider } from "../providers/whois";
import {
	type AuthChallengeInput,
	type AuthQueryInput,
	AuthRequestBodySchema,
	type AuthRequestInput,
} from "../schemas/auth";
import { isValidationError, validateBody } from "../schemas/validate";

/**
 * Supported authentication methods.
 *
 * PASSWORD intentionally omitted — DN42 registry does not use
 * password-based auth (CRYPT-PW / bcrypt-pw).  Can be re-added
 * when a local-credential store is implemented.
 */
enum AuthType {
	PGP_CLEAR_SIGN = 1,
	SSH = 2,
	EMAIL = 3,
}

interface AuthMethod {
	id: number;
	type: AuthType;
	data?: string;
}

interface AuthState {
	asn: string;
	person: string;
	availableAuthMethods: AuthMethod[];
	code?: string;
	authMethod?: AuthMethod;
}

/**
 * Auth Handler - Multi-step authentication flow
 *
 * Flow:
 * 1. query - Returns available auth methods for ASN
 * 2. request - Sends challenge (email code or GPG message)
 * 3. challenge - Verifies response and returns JWT token
 */
export default async function authHandler(c: Context): Promise<Response> {
	const parsed = await validateBody(c, AuthRequestBodySchema);
	if (isValidationError(parsed)) return parsed;

	switch (parsed.action) {
		case "query":
			return await query(c, parsed as AuthQueryInput);
		case "request":
			return await request(c, parsed as AuthRequestInput);
		case "challenge":
			return await challenge(c, parsed as AuthChallengeInput);
	}
}

/**
 * Step 1: Query available auth methods for ASN
 */
async function query(c: Context, body: AuthQueryInput): Promise<Response> {
	const asn = body.asn; // Already validated and transformed to number

	// Query WHOIS for auth methods
	const whois = getWhoisProvider();
	const authInfo = await whois.getAuthMethods(asn);

	// Build available auth methods list
	const availableAuthMethods: AuthMethod[] = [];
	let id = 0;

	// Add PGP fingerprints
	for (const fp of authInfo.pgpFingerprints) {
		availableAuthMethods.push({
			id: id++,
			type: AuthType.PGP_CLEAR_SIGN,
			data: fp,
		});
	}

	// Add emails — only when email provider is configured
	const emailProvider = getEmailProvider();
	if (emailProvider.isEnabled()) {
		for (const email of authInfo.emails) {
			availableAuthMethods.push({
				id: id++,
				type: AuthType.EMAIL,
				data: email,
			});
		}
	}

	// Add SSH keys
	for (const ssh of authInfo.sshKeys) {
		availableAuthMethods.push({ id: id++, type: AuthType.SSH, data: ssh });
	}

	const person = authInfo.person || `AS${asn}`;

	// Sign the auth state
	const authState = await sign(
		{ asn, person, availableAuthMethods },
		config.auth.jwtSecret,
		"HS256",
	);

	return success(c, {
		person,
		mntBy: authInfo.mntBy || `AS${asn}-MNT`,
		authState,
		availableAuthMethods: availableAuthMethods.map((m) => ({
			id: m.id,
			type: m.type,
			value: m.data,
			name:
				m.type === AuthType.PGP_CLEAR_SIGN
					? `PGP: ${m.data?.substring(0, 16)}...`
					: m.type === AuthType.EMAIL
						? m.data
						: m.type === AuthType.SSH
							? "SSH Key"
							: "Unknown",
		})),
	});
}

/**
 * Step 2: Request authentication challenge
 */
async function request(
	c: Context,
	body: { authState?: string; authMethod?: number },
): Promise<Response> {
	const { authState: stateToken, authMethod: methodId } = body;

	if (!stateToken || methodId === undefined) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing authState or authMethod",
		);
	}

	// Verify and decode auth state
	let state: AuthState;
	try {
		state = (await verify(
			stateToken,
			config.auth.jwtSecret,
			"HS256",
		)) as unknown as AuthState;
	} catch {
		return makeResponse(
			c,
			ResponseCode.UNAUTHORIZED,
			undefined,
			"Invalid auth state",
		);
	}

	// Find selected auth method
	const authMethod = state.availableAuthMethods.find((m) => m.id === methodId);
	if (!authMethod) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Invalid auth method",
		);
	}

	// Generate random challenge code
	const code = generateRandomCode();

	// Create new auth state with selected method and code
	const newState = await sign(
		{
			asn: state.asn,
			person: state.person,
			authMethod,
			code,
		},
		config.auth.jwtSecret,
		"HS256",
	);

	// Return challenge based on auth type
	let authChallenge = "";
	if (authMethod.type === AuthType.PGP_CLEAR_SIGN) {
		authChallenge = code; // User signs this message with their PGP key
	} else if (authMethod.type === AuthType.EMAIL) {
		// Send verification code email
		const emailProvider = getEmailProvider();
		const result = await emailProvider.sendVerificationCode(
			authMethod.data!,
			typeof state.asn === "string"
				? Number(state.asn)
				: (state.asn as unknown as number),
			code,
		);
		if (!result.success) {
			logger.error("Failed to send verification email", undefined, {
				to: authMethod.data,
				asn: state.asn,
				error: result.error,
			});
			return makeResponse(
				c,
				ResponseCode.INTERNAL_ERROR,
				undefined,
				`Failed to send verification email: ${result.error}`,
			);
		}
		authChallenge = "Check your email";
	}

	return success(c, {
		authState: newState,
		authChallenge,
	});
}

/**
 * Step 3: Verify challenge response
 */
async function challenge(
	c: Context,
	body: { authState?: string; data?: unknown },
): Promise<Response> {
	const { authState: stateToken, data } = body;

	if (!stateToken || !data) {
		return makeResponse(
			c,
			ResponseCode.VALIDATION_ERROR,
			undefined,
			"Missing authState or data",
		);
	}

	// Verify and decode auth state
	let state: AuthState & { code: string; authMethod: AuthMethod };
	try {
		state = (await verify(
			stateToken,
			config.auth.jwtSecret,
			"HS256",
		)) as unknown as typeof state;
	} catch {
		return makeResponse(
			c,
			ResponseCode.UNAUTHORIZED,
			undefined,
			"Invalid auth state",
		);
	}

	const { authMethod, code, asn, person } = state;
	let authResult = false;

	if (authMethod.type === AuthType.PGP_CLEAR_SIGN) {
		authResult = await verifyPgpSignature(data, code, authMethod.data, asn);
	} else if (authMethod.type === AuthType.EMAIL) {
		// Expect: string (the code from email)
		if (typeof data === "string" && data.trim() === code) {
			authResult = true;
		}
	}

	if (!authResult) {
		return success(c, { authResult: false, token: "" });
	}

	// Generate JWT token for authenticated user
	const token = await sign(
		{ asn, person, iat: Math.floor(Date.now() / 1000) },
		config.auth.jwtSecret,
		"HS256",
	);

	return success(c, { authResult: true, token });
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Verify PGP cleartext signature against challenge code and registry fingerprint.
 *
 * @param data - Submitted PGP data ({ publicKey, signedMessage })
 * @param code - Expected challenge code
 * @param registryFingerprint - Fingerprint from DN42 registry mntner `auth` field
 * @param asn - ASN for logging context
 * @returns Whether the signature is valid and key fingerprint matches
 */
async function verifyPgpSignature(
	data: unknown,
	code: string,
	registryFingerprint: string | undefined,
	asn: string,
): Promise<boolean> {
	const pgpData = data as { publicKey?: string; signedMessage?: string };

	if (!pgpData.publicKey || !pgpData.signedMessage) {
		logger.warn("PGP verification: missing publicKey or signedMessage", {
			asn,
		});
		return false;
	}

	try {
		// Parse the submitted public key
		const publicKey = await openpgp.readKey({ armoredKey: pgpData.publicKey });

		// Parse the cleartext signed message
		const message = await openpgp.readCleartextMessage({
			cleartextMessage: pgpData.signedMessage,
		});

		// Cryptographically verify the signature
		const verification = await openpgp.verify({
			message,
			verificationKeys: publicKey,
		});

		const sig = verification.signatures[0];
		if (!sig) {
			logger.warn("PGP verification: no signatures found", { asn });
			return false;
		}
		await sig.verified; // Throws on invalid signature

		// Verify the signed text matches the challenge code
		const signedText = message.getText().trim();
		if (signedText !== code) {
			logger.warn(
				"PGP verification: signed text does not match challenge code",
				{
					asn,
					expected: code,
					got: signedText,
				},
			);
			return false;
		}

		// Verify key fingerprint matches the one registered in DN42
		const keyFingerprint = publicKey.getFingerprint().toUpperCase();
		const expectedFp = (registryFingerprint || "")
			.toUpperCase()
			.replace(/\s/g, "");

		if (!expectedFp) {
			logger.warn(
				"PGP verification: no registry fingerprint to match against",
				{ asn },
			);
			return false;
		}

		// Support full fingerprint match, or long key ID (≥16 chars) suffix match
		const fpMatch =
			keyFingerprint === expectedFp ||
			(expectedFp.length >= 16 && keyFingerprint.endsWith(expectedFp));
		if (!fpMatch) {
			logger.warn("PGP verification: fingerprint mismatch", {
				asn,
				keyFingerprint,
				registryFingerprint: expectedFp,
			});
			return false;
		}

		logger.info("PGP verification successful", {
			asn,
			fingerprint: keyFingerprint,
		});
		return true;
	} catch (err) {
		logger.warn("PGP verification failed", {
			asn,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

/**
 * Generate random 6-character code
 */
function generateRandomCode(): string {
	return Math.random().toString(36).substring(2, 8).toUpperCase();
}
