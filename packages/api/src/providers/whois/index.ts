/**
 * WHOIS Provider using Burble Explorer REST API
 *
 * Uses https://explorer.burble.com/api/registry/ to query DN42 registry.
 * This works without DN42 network connectivity.
 */
export class WhoisProvider {
	private baseUrl: string;

	constructor(baseUrl = "https://explorer.burble.com/api/registry") {
		this.baseUrl = baseUrl;
	}

	/**
	 * Lookup a DN42 object (ASN, maintainer, person, etc.)
	 */
	async lookup(query: string): Promise<RegistryObject | null> {
		try {
			// Determine object type from query
			const objectType = this.detectObjectType(query);
			const objectKey = this.formatObjectKey(query, objectType);

			const response = await fetch(
				`${this.baseUrl}/${objectType}/${objectKey}`,
			);

			if (!response.ok) {
				console.error(`[WHOIS] API returned ${response.status} for ${query}`);
				return null;
			}

			const data = (await response.json()) as Record<string, unknown>;
			const key = `${objectType}/${objectKey}`;

			return (data[key] as RegistryObject) || null;
		} catch (error) {
			console.error(`[WHOIS] Error looking up ${query}:`, error);
			return null;
		}
	}

	/**
	 * Query ASN and extract authentication methods
	 */
	async getAuthMethods(asn: number): Promise<AuthMethods> {
		const result: AuthMethods = {
			person: "",
			mntBy: "",
			pgpFingerprints: [],
			emails: [],
			sshKeys: [],
		};

		try {
			// Query ASN object
			const asnData = await this.lookup(`AS${asn}`);
			if (!asnData) return result;

			// Get description for person name
			result.person = this.getAttr(asnData, "as-name") || `AS${asn}`;

			// Get admin-c and mnt-by references
			const adminC = this.extractRef(this.getAttr(asnData, "admin-c"));
			const mntBy = this.extractRef(this.getAttr(asnData, "mnt-by"));
			if (mntBy) result.mntBy = mntBy;

			// Look up maintainer for auth info
			if (mntBy) {
				await this.extractAuthFromMntner(mntBy, result);
			}

			// Look up person for contact info
			if (adminC) {
				await this.extractContactFromPerson(adminC, result);
			}
		} catch (error) {
			console.error(`[WHOIS] Error getting auth methods for AS${asn}:`, error);
		}

		return result;
	}

	/**
	 * Extract auth methods from maintainer
	 */
	private async extractAuthFromMntner(
		mntner: string,
		result: AuthMethods,
	): Promise<void> {
		const data = await this.lookup(mntner);
		if (!data) return;

		// Get all auth entries
		const authAttrs = this.getAllAttrs(data, "auth");

		for (const auth of authAttrs) {
			if (auth.startsWith("ssh-")) {
				result.sshKeys.push(auth);
			} else if (auth.startsWith("pgp-fingerprint ")) {
				result.pgpFingerprints.push(auth.replace("pgp-fingerprint ", ""));
			} else if (auth.startsWith("PGPKEY-")) {
				result.pgpFingerprints.push(auth.replace("PGPKEY-", ""));
			}
		}
	}

	/**
	 * Extract contact info from person
	 */
	private async extractContactFromPerson(
		person: string,
		result: AuthMethods,
	): Promise<void> {
		const data = await this.lookup(person);
		if (!data) return;

		// Get person name
		const personName = this.getAttr(data, "person");
		if (personName) result.person = personName;

		// Get emails
		const email = this.getAttr(data, "e-mail");
		if (email) result.emails.push(email.toLowerCase());

		// Get contact (might contain email or telegram)
		const contact = this.getAttr(data, "contact");
		if (contact) {
			const emailMatch = contact.match(/[\w.-]+@[\w.-]+\.\w+/);
			if (emailMatch) {
				result.emails.push(emailMatch[0].toLowerCase());
			}
		}
	}

	/**
	 * Detect object type from query
	 */
	private detectObjectType(query: string): string {
		const q = query.toUpperCase();
		if (q.startsWith("AS") && /^\d+$/.test(q.substring(2))) return "aut-num";
		if (q.endsWith("-MNT")) return "mntner";
		if (q.endsWith("-DN42")) return "person";
		if (q.includes("/")) return q.includes(":") ? "route6" : "route";
		if (q.includes(":")) return "inet6num";
		if (/^\d+\.\d+\.\d+\.\d+/.test(q)) return "inetnum";
		return "mntner"; // Default
	}

	/**
	 * Format object key for API
	 */
	private formatObjectKey(query: string, type: string): string {
		if (type === "aut-num") {
			return query.toUpperCase();
		}
		return query;
	}

	/**
	 * Extract reference from markdown link format "[NAME](type/NAME)"
	 */
	private extractRef(value: string | undefined): string | undefined {
		if (!value) return undefined;

		const match = value.match(/\[([^\]]+)\]/);
		return match ? match[1] : value;
	}

	/**
	 * Get single attribute value
	 */
	private getAttr(obj: RegistryObject, key: string): string | undefined {
		const attr = obj.Attributes?.find((a) => a[0] === key);
		return attr ? attr[1] : undefined;
	}

	/**
	 * Get all attribute values for a key
	 */
	private getAllAttrs(obj: RegistryObject, key: string): string[] {
		return obj.Attributes?.filter((a) => a[0] === key).map((a) => a[1]) || [];
	}
}

interface RegistryObject {
	Attributes: [string, string][];
	Backlinks?: string[];
}

export interface AuthMethods {
	person: string;
	mntBy: string;
	pgpFingerprints: string[];
	emails: string[];
	sshKeys: string[];
}

// Singleton instance
let whoisProvider: WhoisProvider | null = null;

export function getWhoisProvider(): WhoisProvider {
	if (!whoisProvider) {
		whoisProvider = new WhoisProvider();
	}
	return whoisProvider;
}
