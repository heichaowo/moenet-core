/**
 * Tests for DN42 Registry Service
 *
 * Mock fetch() to avoid real API calls during tests.
 */
import { describe, expect, it, mock, beforeEach } from 'bun:test';
import {
    getAsnType,
    normalizeMntName,
    checkAsnExists,
    getAsnInfo,
    getMntDisplayText,
    fetchContacts,
    lookupWhois,
    getWhoisAttr,
    getAllWhoisAttr,
    formatWhoisResult,
} from '../../src/services/dn42Registry';
import type { WhoisResult, AsnType } from '../../src/services/dn42Registry';

// ---------------------------------------------------------------------------
// Pure function tests (no API, no mocks needed)
// ---------------------------------------------------------------------------

describe('getAsnType', () => {
    it('should classify standard DN42 ASNs', () => {
        expect(getAsnType(4242420000)).toBe('dn42');
        expect(getAsnType(4242420998)).toBe('dn42');
        expect(getAsnType(4242429999)).toBe('dn42');
    });

    it('should classify NeoNetwork ASNs', () => {
        expect(getAsnType(4201270000)).toBe('neonetwork');
        expect(getAsnType(4201279999)).toBe('neonetwork');
    });

    it('should classify DN42 legacy ASNs', () => {
        expect(getAsnType(64512)).toBe('dn42_legacy');
        expect(getAsnType(65534)).toBe('dn42_legacy');
        expect(getAsnType(4200000000)).toBe('dn42_legacy');
    });

    it('should classify public ASNs', () => {
        expect(getAsnType(13335)).toBe('public');
        expect(getAsnType(1)).toBe('public');
        expect(getAsnType(64511)).toBe('public');
    });

    it('should not include upper bound 4242430000 in dn42 range', () => {
        expect(getAsnType(4242430000)).toBe('dn42_legacy');
    });
});

describe('normalizeMntName', () => {
    it('should strip -MNT suffix', () => {
        expect(normalizeMntName('MOENET-MNT')).toBe('MOENET');
    });

    it('should strip MNT- prefix', () => {
        expect(normalizeMntName('MNT-MOENET')).toBe('MOENET');
    });

    it('should strip -DN42 suffix', () => {
        expect(normalizeMntName('EXAMPLE-DN42')).toBe('EXAMPLE');
    });

    it('should strip AS prefix', () => {
        expect(normalizeMntName('AS4242420998')).toBe('4242420998');
    });

    it('should strip combined AS prefix + -MNT suffix', () => {
        expect(normalizeMntName('AS4242420998-MNT')).toBe('4242420998');
    });

    it('should return unchanged if no known affixes', () => {
        expect(normalizeMntName('SOMETHING')).toBe('SOMETHING');
    });
});

// ---------------------------------------------------------------------------
// WhoisResult utility tests
// ---------------------------------------------------------------------------

describe('getWhoisAttr / getAllWhoisAttr / formatWhoisResult', () => {
    const sample: WhoisResult = {
        Attributes: [
            ['as-name', 'MOENET-AS'],
            ['mnt-by', 'MOENET-MNT'],
            ['admin-c', 'HEICHA-DN42'],
            ['tech-c', 'HEICHA-DN42'],
            ['descr', 'MoeNet DN42 Network'],
        ],
    };

    it('getWhoisAttr should return first matching value', () => {
        expect(getWhoisAttr(sample, 'as-name')).toBe('MOENET-AS');
    });

    it('getWhoisAttr should return undefined for missing key', () => {
        expect(getWhoisAttr(sample, 'e-mail')).toBeUndefined();
    });

    it('getAllWhoisAttr should return all matching values', () => {
        const result = getAllWhoisAttr(sample, 'admin-c');
        expect(result).toEqual(['HEICHA-DN42']);
    });

    it('getAllWhoisAttr should return empty array for missing key', () => {
        expect(getAllWhoisAttr(sample, 'nonexistent')).toEqual([]);
    });

    it('formatWhoisResult should format as key: value lines', () => {
        const formatted = formatWhoisResult(sample);
        expect(formatted).toContain('as-name: MOENET-AS');
        expect(formatted).toContain('mnt-by: MOENET-MNT');
        expect(formatted.split('\n').length).toBe(5);
    });
});

// ---------------------------------------------------------------------------
// API-dependent tests (mock fetch)
// ---------------------------------------------------------------------------

/**
 * Helper: build a Burble-style API response for a given object type and key.
 */
function burbleResponse(objectType: string, objectKey: string, attrs: [string, string][]): Response {
    const body: Record<string, WhoisResult> = {
        [`${objectType}/${objectKey}`]: { Attributes: attrs },
    };
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function notFoundResponse(): Response {
    return new Response('Not Found', { status: 404 });
}

describe('checkAsnExists', () => {
    it('should return true when ASN exists', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = mock(() =>
            Promise.resolve(burbleResponse('aut-num', 'AS4242420998', [
                ['as-name', 'MOENET-AS'],
                ['mnt-by', 'MOENET-MNT'],
            ]))
        ) as unknown as typeof fetch;

        try {
            const result = await checkAsnExists(4242420998);
            expect(result).toBe(true);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('should return false when ASN does not exist', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = mock(() =>
            Promise.resolve(notFoundResponse())
        ) as unknown as typeof fetch;

        try {
            const result = await checkAsnExists(9999999999);
            expect(result).toBe(false);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe('getAsnInfo', () => {
    it('should return structured ASN info', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = mock(() =>
            Promise.resolve(burbleResponse('aut-num', 'AS4242420998', [
                ['as-name', 'MOENET-AS'],
                ['mnt-by', '[MOENET-MNT](mntner/MOENET-MNT)'],
                ['admin-c', '[HEICHA-DN42](person/HEICHA-DN42)'],
                ['tech-c', '[HEICHA-DN42](person/HEICHA-DN42)'],
                ['descr', 'MoeNet DN42 Network'],
            ]))
        ) as unknown as typeof fetch;

        try {
            const info = await getAsnInfo(4242420998);
            expect(info).not.toBeNull();
            expect(info?.asName).toBe('MOENET-AS');
            expect(info?.mntBy).toBe('MOENET-MNT');
            expect(info?.adminC).toEqual(['HEICHA-DN42']);
            expect(info?.techC).toEqual(['HEICHA-DN42']);
            expect(info?.descr).toBe('MoeNet DN42 Network');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('should return null for non-existent ASN', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = mock(() =>
            Promise.resolve(notFoundResponse())
        ) as unknown as typeof fetch;

        try {
            const info = await getAsnInfo(9999999999);
            expect(info).toBeNull();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe('getMntDisplayText', () => {
    it('should return "MOENET AS4242420998" format', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = mock(() =>
            Promise.resolve(burbleResponse('aut-num', 'AS4242420998', [
                ['mnt-by', '[MOENET-MNT](mntner/MOENET-MNT)'],
            ]))
        ) as unknown as typeof fetch;

        try {
            const text = await getMntDisplayText(4242420998);
            expect(text).toBe('MOENET AS4242420998');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('should return plain "ASxxx" when ASN not found', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = mock(() =>
            Promise.resolve(notFoundResponse())
        ) as unknown as typeof fetch;

        try {
            const text = await getMntDisplayText(9999999999);
            expect(text).toBe('AS9999999999');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe('fetchContacts (enhanced)', () => {
    it('should collect contacts from admin-c, tech-c, and mntner', async () => {
        const originalFetch = globalThis.fetch;

        // Track requests to return appropriate responses
        globalThis.fetch = mock((url: string | URL | Request) => {
            const urlStr = typeof url === 'string' ? url : url.toString();

            // ASN record
            if (urlStr.includes('aut-num/AS4242420998')) {
                return Promise.resolve(burbleResponse('aut-num', 'AS4242420998', [
                    ['admin-c', '[HEICHA-DN42](person/HEICHA-DN42)'],
                    ['tech-c', '[TECH-DN42](person/TECH-DN42)'],
                    ['mnt-by', '[MOENET-MNT](mntner/MOENET-MNT)'],
                ]));
            }
            // admin-c person record
            if (urlStr.includes('person/HEICHA-DN42')) {
                return Promise.resolve(burbleResponse('person', 'HEICHA-DN42', [
                    ['person', 'HeiCha'],
                    ['e-mail', 'admin@moenet.work'],
                    ['contact', 'telegram:@HeiCha'],
                ]));
            }
            // tech-c person record
            if (urlStr.includes('person/TECH-DN42')) {
                return Promise.resolve(burbleResponse('person', 'TECH-DN42', [
                    ['person', 'Tech Contact'],
                    ['e-mail', 'tech@moenet.work'],
                    ['abuse-mailbox', 'abuse@moenet.work'],
                ]));
            }
            // mntner record
            if (urlStr.includes('mntner/MOENET-MNT')) {
                return Promise.resolve(burbleResponse('mntner', 'MOENET-MNT', [
                    ['e-mail', 'mnt@moenet.work'],
                ]));
            }
            return Promise.resolve(notFoundResponse());
        }) as unknown as typeof fetch;

        try {
            const contacts = await fetchContacts(4242420998);
            // Should include: admin email, telegram, tech email, abuse-mailbox, mntner email
            expect(contacts).toContain('admin@moenet.work');
            expect(contacts).toContain('telegram:@HeiCha');
            expect(contacts).toContain('tech@moenet.work');
            expect(contacts).toContain('abuse@moenet.work');
            expect(contacts).toContain('mnt@moenet.work');
            expect(contacts.length).toBe(5);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('should return empty array for non-existent ASN', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = mock(() =>
            Promise.resolve(notFoundResponse())
        ) as unknown as typeof fetch;

        try {
            const contacts = await fetchContacts(9999999999);
            expect(contacts).toEqual([]);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('should deduplicate contacts', async () => {
        const originalFetch = globalThis.fetch;

        globalThis.fetch = mock((url: string | URL | Request) => {
            const urlStr = typeof url === 'string' ? url : url.toString();

            if (urlStr.includes('aut-num/AS4242420998')) {
                return Promise.resolve(burbleResponse('aut-num', 'AS4242420998', [
                    ['admin-c', '[SAME-DN42](person/SAME-DN42)'],
                    ['tech-c', '[SAME-DN42](person/SAME-DN42)'],
                    ['mnt-by', '[MOENET-MNT](mntner/MOENET-MNT)'],
                ]));
            }
            if (urlStr.includes('person/SAME-DN42')) {
                return Promise.resolve(burbleResponse('person', 'SAME-DN42', [
                    ['e-mail', 'same@moenet.work'],
                ]));
            }
            if (urlStr.includes('mntner/MOENET-MNT')) {
                return Promise.resolve(burbleResponse('mntner', 'MOENET-MNT', [
                    ['e-mail', 'same@moenet.work'],
                ]));
            }
            return Promise.resolve(notFoundResponse());
        }) as unknown as typeof fetch;

        try {
            const contacts = await fetchContacts(4242420998);
            // admin-c and tech-c point to same person, mntner has same email
            // Should deduplicate to 1
            expect(contacts).toEqual(['same@moenet.work']);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
