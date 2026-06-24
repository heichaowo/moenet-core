/**
 * DN42 Registry Validator
 * Validates IP ownership using Burble REST API
 */

const BURBLE_API = 'https://explorer.burble.com/api/registry';

export interface ValidationResult {
    valid: boolean;
    warning?: string;
    owner?: string;
}

interface RegistryObject {
    Attributes: [string, string][];
    Backlinks?: string[];
}

/**
 * Validate if an IP address belongs to a specific ASN
 * 
 * @param asn - The ASN to validate against (e.g., 4242420998)
 * @param ip - The IP address to validate (IPv4 or IPv6)
 * @returns ValidationResult with valid flag and optional warning
 */
export async function validateIpOwnership(asn: number, ip: string): Promise<ValidationResult> {
    try {
        // Determine if IPv4 or IPv6
        const isIPv6 = ip.includes(':');
        const objectType = isIPv6 ? 'inet6num' : 'inetnum';

        // Query the registry
        const response = await fetch(`${BURBLE_API}/${objectType}/${encodeURIComponent(ip)}`);

        if (!response.ok) {
            // Not found in registry
            return {
                valid: false,
                warning: isIPv6
                    ? `⚠️ IPv6 address not found in DN42 registry\nIPv6 地址未在 DN42 注册表中找到`
                    : `⚠️ IPv4 address not found in DN42 registry\nIPv4 地址未在 DN42 注册表中找到`,
            };
        }

        const data = await response.json() as Record<string, RegistryObject>;

        const keys = Object.keys(data);
        if (keys.length === 0) {
            return {
                valid: false,
                warning: `⚠️ Invalid registry response\n注册表响应无效`,
            };
        }
        const key = keys[0]!;
        const obj = data[key];

        if (!obj?.Attributes) {
            return {
                valid: false,
                warning: `⚠️ Invalid registry response\n注册表响应无效`,
            };
        }

        // Find origin ASN from attributes
        const mntBy = obj.Attributes.filter((a: [string, string]) => a[0] === 'mnt-by').map((a: [string, string]) => a[1]);

        // Check if ASN's mntner matches
        const asnMntner = `MNT-${asn}`;
        const asnMntnerAlt = `AS${asn}-MNT`;

        const ownerMatch = mntBy.some((m: string) =>
            m.toUpperCase().includes(asn.toString()) ||
            m.toUpperCase() === asnMntner ||
            m.toUpperCase() === asnMntnerAlt
        );

        if (ownerMatch) {
            return {
                valid: true,
                owner: mntBy.join(', '),
            };
        }

        // If direct match fails, try to lookup via route object
        const routeType = isIPv6 ? 'route6' : 'route';
        const routeResponse = await fetch(`${BURBLE_API}/${routeType}/${encodeURIComponent(ip)}`);

        if (routeResponse.ok) {
            const routeData = await routeResponse.json() as Record<string, RegistryObject>;
            const routeKeys = Object.keys(routeData);
            if (routeKeys.length > 0) {
                const routeKey = routeKeys[0]!;
                const routeObj = routeData[routeKey];

                if (routeObj?.Attributes) {
                    const origin = routeObj.Attributes.find((a: [string, string]) => a[0] === 'origin')?.[1];
                    if (origin?.toUpperCase() === `AS${asn}`) {
                        return {
                            valid: true,
                            owner: origin,
                        };
                    }
                }
            }
        }

        // Ownership not confirmed
        return {
            valid: false,
            warning: `⚠️ IP ownership verification failed. Expected AS${asn}, found: ${mntBy.join(', ') || 'unknown'}\n` +
                `IP 所有权验证失败。期望 AS${asn}，实际: ${mntBy.join(', ') || '未知'}`,
            owner: mntBy.join(', '),
        };
    } catch (error) {
        console.error('[DN42Validator] Error:', error);
        return {
            valid: false,
            warning: `⚠️ Failed to validate IP ownership (API error)\n验证 IP 所有权失败 (API 错误)`,
        };
    }
}

/**
 * Calculate our Link-Local address for a node
 * 
 * @param regionCode - Region code (e.g., 101, 203, 302)
 * @param nodeId - Node ID
 * @returns Link-local address in format fe80::998:{region}:{node}:1
 */
export function calculateOurLLA(regionCode: number, nodeId: number): string {
    return `fe80::998:${regionCode}:${nodeId}:1`;
}

/**
 * Calculate suggested peer Link-Local address based on ASN
 * 
 * @param asn - Peer's ASN
 * @returns Suggested link-local address (fe80::{asn%10000})
 */
export function suggestPeerLLA(asn: number): string {
    if (asn >= 4242420000 && asn <= 4242429999) {
        return `fe80::${asn % 10000}`;
    } else if (asn >= 4201270000 && asn <= 4201279999) {
        return `fe80::${asn % 10000}`;
    }
    return `fe80::${asn % 10000}`;
}

/**
 * Validate if an IP is a valid link-local address
 */
export function isLinkLocal(ip: string): boolean {
    return ip.toLowerCase().startsWith('fe80:');
}

/**
 * Validate if an IP is a valid DN42 ULA address
 */
export function isDN42ULA(ip: string): boolean {
    const lower = ip.toLowerCase();
    return lower.startsWith('fd') || lower.startsWith('fc');
}

/**
 * Validate if an IP is a valid DN42 IPv4 address
 */
export function isDN42IPv4(ip: string): boolean {
    // DN42: 172.20.0.0/14, 10.127.0.0/16
    // ARDC: 44.0.0.0/8
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) return false;

    const a = parts[0];
    const b = parts[1];
    if (a === undefined || b === undefined) return false;

    // 172.20-23.x.x (172.20.0.0/14)
    if (a === 172 && b >= 20 && b <= 23) return true;
    // 10.127.x.x (10.127.0.0/16)
    if (a === 10 && b === 127) return true;
    // 44.x.x.x (44.0.0.0/8)
    if (a === 44) return true;

    return false;
}
