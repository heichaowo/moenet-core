/**
 * Peer Command Validators
 *
 * Centralized validation functions for peer-related inputs.
 */

/**
 * Normalize ASN input with shorthand expansion.
 *
 * Supports multiple input formats:
 *   - Full ASN: "4242420998" → 4242420998
 *   - With prefix: "AS4242420998" → 4242420998
 *   - Shorthand (≤4 digits): "0998" or "998" → 4242420998
 *   - Shorthand with prefix: "AS998" → 4242420998
 *
 * Args:
 *   input: Raw ASN string from user input.
 *
 * Returns:
 *   Parsed ASN as number. Returns NaN for invalid input.
 */
export function normalizeAsn(input: string): number {
    const stripped = input.trim().replace(/^AS/i, '');

    if (!/^\d+$/.test(stripped)) {
        return NaN;
    }

    const num = parseInt(stripped, 10);

    // Shorthand: 1-4 digits → prefix with 424242
    if (stripped.length <= 4) {
        return 4242420000 + num;
    }

    return num;
}

/**
 * Check if input looks like an ASN (digits only, with optional AS prefix).
 *
 * This is a lightweight format check — does NOT validate range.
 * Use normalizeAsn() to parse and expand the value.
 *
 * Args:
 *   input: Raw input string to check.
 *
 * Returns:
 *   true if input matches ASN format (optional "AS" prefix + digits).
 */
export function isAsnInput(input: string): boolean {
    return /^(AS)?\d+$/i.test(input.trim());
}

/**
 * Validate IPv6 address (Link-Local or ULA)
 */
export function isValidIPv6(ip: string): boolean {
    const addr = ip.includes('/') ? ip.split('/')[0] : ip;
    return /^[0-9a-f:]+$/i.test(addr || '') && (addr || '').includes(':');
}

/**
 * Validate strict DN42 IPv6 (fe80:: or fd/fc)
 */
export function isValidDN42IPv6(ip: string): boolean {
    return /^(fe80:|fd[0-9a-f]{2}:|fc[0-9a-f]{2}:)/i.test(ip.trim());
}

/**
 * Validate WireGuard public key
 */
export function isValidWgPubkey(key: string): boolean {
    return /^[A-Za-z0-9+/]{43}=$/.test(key);
}

/**
 * Validate DN42 IPv4 address (172.20.0.0/14 range)
 */
export function isValidDN42IPv4(ip: string): boolean {
    return /^172\.(2[0-3]|1[6-9])\./.test(ip);
}

/**
 * Validate MTU value
 */
export function isValidMTU(mtu: number): boolean {
    return !isNaN(mtu) && mtu >= 1280 && mtu <= 1500;
}

/**
 * Validate port number
 */
export function isValidPort(port: number): boolean {
    return !isNaN(port) && port >= 1 && port <= 65535;
}

/**
 * Validate contact info length
 */
export function isValidContact(contact: string): boolean {
    const trimmed = contact.trim();
    return trimmed.length >= 3 && trimmed.length <= 200;
}

/**
 * Parse MTU from text (handles "1420 (Default)" format)
 */
export function parseMTU(text: string): number | null {
    const match = text.match(/^(\d+)/);
    if (match && match[1]) {
        const mtu = parseInt(match[1], 10);
        return isValidMTU(mtu) ? mtu : null;
    }
    return null;
}

/**
 * Parse endpoint with optional port
 * Returns { host, port } or null if "none"
 */
export function parseEndpoint(text: string): { host: string; port?: number } | null {
    if (text.toLowerCase() === 'none') {
        return null;
    }

    let endpoint = text;
    let port: number | undefined;

    // IPv4:port or domain:port
    if (text.includes(':') && !text.includes('::')) {
        const parts = text.split(':');
        const lastPart = parts.pop();
        if (lastPart && /^\d+$/.test(lastPart)) {
            port = parseInt(lastPart, 10);
            endpoint = parts.join(':');
        }
        // [IPv6]:port format
    } else if (text.startsWith('[') && text.includes(']:')) {
        const match = text.match(/^\[(.+)\]:(\d+)$/);
        if (match && match[1] && match[2]) {
            endpoint = match[1];
            port = parseInt(match[2], 10);
        }
    }

    return { host: endpoint, port };
}

/**
 * Calculate user's WG port based on ASN
 */
export function calculatePort(asn: number): number {
    if (asn >= 4242420000 && asn <= 4242429999) {
        return 30000 + (asn % 10000);
    } else if (asn >= 4201270000 && asn <= 4201279999) {
        return 40000 + (asn % 10000);
    } else {
        return 50000 + (asn % 10000);
    }
}

/**
 * Parse node name from selection text (format: "📍 nodeName (location)")
 */
export function parseNodeSelection(text: string): string | null {
    const match = text.match(/📍\s*(.+?)\s*\(/);
    return match && match[1] ? match[1].trim() : null;
}
