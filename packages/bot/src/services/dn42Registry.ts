/**
 * DN42 Registry Service
 *
 * Shared functions for querying the Burble DN42 Explorer REST API.
 * Used by tools commands (/whois, /findnoc) and peer creation flow.
 *
 * Replaces the legacy Python local_registry.py (git clone based)
 * with a pure REST API approach via Burble Explorer.
 */

const BURBLE_API = 'https://explorer.burble.com/api/registry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WhoisResult {
    Attributes: [string, string][];
    Backlinks?: string[];
}

/** Structured ASN information from the DN42 registry. */
export interface AsnInfo {
    asn: number;
    asName: string;
    mntBy: string;
    adminC: string[];
    techC: string[];
    descr: string;
}

/** ASN type classification. */
export type AsnType = 'dn42' | 'neonetwork' | 'dn42_legacy' | 'public';

// ---------------------------------------------------------------------------
// Low-level: Burble REST API helpers
// ---------------------------------------------------------------------------

/**
 * Extract a handle from Burble's markdown link format.
 *
 * Burble returns references as "[NAME](type/NAME)".
 * This extracts the plain handle.
 */
function extractHandle(raw: string): string {
    const match = raw.match(/\[([^\]]+)\]/);
    return match?.[1] ?? raw;
}

/**
 * Lookup WHOIS using Burble REST API.
 *
 * Detects object type from the query string and fetches
 * the corresponding record from the registry.
 */
export async function lookupWhois(query: string): Promise<WhoisResult | null> {
    const q = query.toUpperCase();
    let objectType = 'mntner';
    if (q.startsWith('AS') && /^\d+$/.test(q.substring(2))) objectType = 'aut-num';
    else if (q.endsWith('-MNT')) objectType = 'mntner';
    else if (q.endsWith('-DN42')) objectType = 'person';
    else if (q.includes('/')) objectType = q.includes(':') ? 'route6' : 'route';
    else if (q.includes(':')) objectType = 'inet6num';
    else if (/^\d+\.\d+\.\d+\.\d+/.test(q)) objectType = 'inetnum';

    const objectKey = objectType === 'aut-num' ? query.toUpperCase() : query;

    try {
        const response = await fetch(`${BURBLE_API}/${objectType}/${objectKey}`);
        if (!response.ok) return null;

        const data = await response.json() as Record<string, WhoisResult>;
        const key = `${objectType}/${objectKey}`;
        return data[key] || null;
    } catch {
        return null;
    }
}

/**
 * Format WHOIS result as text.
 */
export function formatWhoisResult(data: WhoisResult): string {
    if (!data.Attributes) return 'No data';
    return data.Attributes.map(([key, value]) => `${key}: ${value}`).join('\n');
}

/**
 * Get a single attribute value from a WHOIS result.
 */
export function getWhoisAttr(data: WhoisResult, key: string): string | undefined {
    const attr = data.Attributes?.find(a => a[0] === key);
    return attr ? attr[1] : undefined;
}

/**
 * Get all attribute values for a given key from a WHOIS result.
 */
export function getAllWhoisAttr(data: WhoisResult, key: string): string[] {
    if (!data.Attributes) return [];
    return data.Attributes.filter(a => a[0] === key).map(a => a[1]);
}

// ---------------------------------------------------------------------------
// ASN classification & utilities (pure logic, no API calls)
// ---------------------------------------------------------------------------

/**
 * Determine the type/range of an ASN.
 *
 * Returns:
 *   - `'dn42'`        — 4242420000–4242429999
 *   - `'neonetwork'`  — 4201270000–4201279999
 *   - `'dn42_legacy'` — 64512–65534 or 4200000000–4294999999 (other private)
 *   - `'public'`      — everything else
 */
export function getAsnType(asn: number): AsnType {
    if (asn >= 4242420000 && asn < 4242430000) return 'dn42';
    if (asn >= 4201270000 && asn < 4201280000) return 'neonetwork';
    if ((asn >= 64512 && asn <= 65534) || (asn >= 4200000000 && asn < 4295000000)) return 'dn42_legacy';
    return 'public';
}

/**
 * Normalize a maintainer/admin-c name by removing common prefixes and suffixes.
 *
 * Strips: MNT-, AS-, -DN42, -MNT, -AS suffixes/prefixes.
 * Example: "MOENET-MNT" → "MOENET", "AS4242420998-MNT" → "4242420998"
 */
export function normalizeMntName(raw: string): string {
    let name = raw;
    for (const suffix of ['-MNT', '-DN42', '-AS']) {
        if (name.endsWith(suffix)) {
            name = name.slice(0, -suffix.length);
        }
    }
    for (const prefix of ['MNT-', 'AS-', 'AS']) {
        if (name.startsWith(prefix)) {
            name = name.slice(prefix.length);
        }
    }
    return name;
}

// ---------------------------------------------------------------------------
// High-level: ASN queries (use Burble REST API)
// ---------------------------------------------------------------------------

/**
 * Check if an ASN exists in the DN42 registry.
 *
 * Args:
 *     asn: The ASN number (without AS prefix).
 *
 * Returns:
 *     true if the ASN record exists in the registry.
 */
export async function checkAsnExists(asn: number): Promise<boolean> {
    const data = await lookupWhois(`AS${asn}`);
    return data !== null;
}

/**
 * Get structured ASN information from the registry.
 *
 * Args:
 *     asn: The ASN number (without AS prefix).
 *
 * Returns:
 *     AsnInfo object if found, null otherwise.
 */
export async function getAsnInfo(asn: number): Promise<AsnInfo | null> {
    const data = await lookupWhois(`AS${asn}`);
    if (!data) return null;

    const mntBy = getWhoisAttr(data, 'mnt-by');
    if (!mntBy) return null;

    return {
        asn,
        asName: getWhoisAttr(data, 'as-name') ?? '',
        mntBy: extractHandle(mntBy),
        adminC: getAllWhoisAttr(data, 'admin-c').map(extractHandle),
        techC: getAllWhoisAttr(data, 'tech-c').map(extractHandle),
        descr: getWhoisAttr(data, 'descr') ?? '',
    };
}

/**
 * Get display text for an ASN with its maintainer name.
 *
 * Examples:
 *   - AS4242420998 with mnt-by MOENET-MNT → "MOENET AS4242420998"
 *   - Unknown mnt-by → "AS4242420998"
 *
 * Args:
 *     asn: The ASN number.
 *
 * Returns:
 *     Human-readable display text.
 */
export async function getMntDisplayText(asn: number): Promise<string> {
    const data = await lookupWhois(`AS${asn}`);
    if (!data) return `AS${asn}`;

    const mntBy = getWhoisAttr(data, 'mnt-by');
    if (!mntBy) return `AS${asn}`;

    const normalized = normalizeMntName(extractHandle(mntBy));
    if (normalized === String(asn)) return `AS${asn}`;

    return `${normalized} AS${asn}`;
}

// ---------------------------------------------------------------------------
// Contact lookup (enhanced — replaces legacy get_emails recursive logic)
// ---------------------------------------------------------------------------

/**
 * Fetch contact information for a DN42 ASN.
 *
 * Queries the Burble registry for the ASN record and recursively
 * collects contact info from:
 *   1. admin-c person records (e-mail, contact, abuse-mailbox)
 *   2. tech-c person records (e-mail, contact, abuse-mailbox)
 *   3. Nested sub-contacts (admin-c/tech-c within person/role records)
 *   4. mntner e-mail
 *
 * Depth is capped at 3 to avoid excessive API calls.
 *
 * Args:
 *     asn: The ASN number (without AS prefix).
 *
 * Returns:
 *     Deduplicated array of contact strings.
 *     Empty array if no contacts found or API fails.
 */
export async function fetchContacts(asn: number): Promise<string[]> {
    try {
        const asnData = await lookupWhois(`AS${asn}`);
        if (!asnData) return [];

        const contacts: string[] = [];
        const visited = new Set<string>();

        /** Add a contact string if not already present. */
        const addContact = (value: string) => {
            if (value && !contacts.includes(value)) {
                contacts.push(value);
            }
        };

        /**
         * Recursively extract contacts from a person/role record.
         * Follows nested admin-c/tech-c references up to maxDepth.
         */
        const extractFromPerson = async (handle: string, depth: number) => {
            if (visited.has(handle) || depth > 3) return;
            visited.add(handle);

            const personData = await lookupWhois(handle);
            if (!personData) return;

            // Collect all contact-related fields
            for (const email of getAllWhoisAttr(personData, 'e-mail')) {
                addContact(email);
            }
            for (const contact of getAllWhoisAttr(personData, 'contact')) {
                addContact(contact);
            }
            for (const abuse of getAllWhoisAttr(personData, 'abuse-mailbox')) {
                addContact(abuse);
            }

            // Follow nested admin-c / tech-c references
            const subRefs = [
                ...getAllWhoisAttr(personData, 'admin-c'),
                ...getAllWhoisAttr(personData, 'tech-c'),
            ];
            for (const ref of subRefs) {
                await extractFromPerson(extractHandle(ref), depth + 1);
            }
        };

        // 1. Process admin-c references
        for (const adminC of getAllWhoisAttr(asnData, 'admin-c')) {
            await extractFromPerson(extractHandle(adminC), 0);
        }

        // 2. Process tech-c references
        for (const techC of getAllWhoisAttr(asnData, 'tech-c')) {
            await extractFromPerson(extractHandle(techC), 0);
        }

        // 3. Check mntner for e-mail
        const mntBy = getWhoisAttr(asnData, 'mnt-by');
        if (mntBy) {
            const mntHandle = extractHandle(mntBy);
            if (!visited.has(mntHandle)) {
                const mntData = await lookupWhois(mntHandle);
                if (mntData) {
                    for (const email of getAllWhoisAttr(mntData, 'e-mail')) {
                        addContact(email);
                    }
                }
            }
        }

        return contacts;
    } catch {
        return [];
    }
}
