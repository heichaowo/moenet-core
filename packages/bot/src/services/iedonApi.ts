/**
 * Iedon Map Service — DN42 Network Statistics
 *
 * Fetches DN42 network statistics from the iedon MAP service.
 * API docs: https://iedon.net/post/4
 *
 * Endpoints:
 *   - /ranking  → Plain text global ranking
 *   - /asn/{asn} → JSON node info for a specific ASN
 *
 * Ported from: moenet-dn42-control-plane/src/integrations/iedon.py
 */

import { z } from 'zod';
import config from '../config';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const AsnInfoResponseSchema = z.object({
    asn: z.number().optional(),
    name: z.string().optional(),
    asName: z.string().optional(),
    peers: z.union([z.array(z.number()), z.record(z.string(), z.unknown())]).optional(),
    neighbors: z.union([z.array(z.number()), z.record(z.string(), z.unknown())]).optional(),
    peer_count: z.number().optional(),
    peerCount: z.number().optional(),
    centrality: z.number().optional(),
    closeness: z.number().optional(),
    betweenness: z.number().optional(),
    whois: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RankingEntry {
    rank: number;
    asn: number;
    name: string;
    index: number;
}

export interface AsnInfo {
    asn: number;
    name: string;
    peerCount: number;
    peers: number[];
    centrality: number;
    closeness: number;
    betweenness: number;
    whois?: string;
}

export interface NetworkStats {
    totalAsns: number;
    totalLinks: number;
    avgPeers: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface CacheEntry<T> {
    data: T;
    timestamp: number;
}

let rankingCache: CacheEntry<RankingEntry[]> | null = null;
const asnCache = new Map<number, CacheEntry<AsnInfo>>();

function isCacheValid<T>(entry: CacheEntry<T> | null | undefined): entry is CacheEntry<T> {
    if (!entry) return false;
    return Date.now() - entry.timestamp < CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Ranking Parser
// ---------------------------------------------------------------------------

/**
 * Parse the iedon ranking plain text response.
 *
 * Format:
 *   MAP.DN42 Global Rank
 *   Last update: Sun, 12 Apr 2026 23:44:05 GMT
 *   Rank   ASN         Desc                            Index
 *   1      4242423914  KIOUBIT-DN42                    10000
 *   ...
 */
function parseRankingText(text: string): RankingEntry[] {
    const result: RankingEntry[] = [];
    const lines = text.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (
            !trimmed ||
            trimmed.includes('Global Rank') ||
            trimmed.includes('Last update') ||
            (trimmed.includes('Rank') && trimmed.includes('ASN'))
        ) {
            continue;
        }

        const parts = trimmed.split(/\s+/);
        if (parts.length < 4) continue;

        const rankStr = parts[0];
        const asnStr = parts[1];
        if (!rankStr || !asnStr) continue;
        if (!/^\d+$/.test(rankStr) || !/^\d+$/.test(asnStr)) continue;

        const lastPart = parts[parts.length - 1];
        if (!lastPart) continue;

        const rank = Number.parseInt(rankStr, 10);
        const asn = Number.parseInt(asnStr, 10);
        const name = parts[2] ?? 'Unknown';
        const index = /^\d+$/.test(lastPart) ? Number.parseInt(lastPart, 10) : 0;

        result.push({ rank, asn, name, index });
    }

    return result;
}

// ---------------------------------------------------------------------------
// API Functions
// ---------------------------------------------------------------------------

/**
 * Get DN42 global ranking from iedon MAP service.
 *
 * Returns entries sorted by composite centrality index.
 * Results are cached for 15 minutes.
 */
export async function getRanking(forceRefresh = false): Promise<RankingEntry[]> {
    // Check cache
    if (!forceRefresh && isCacheValid(rankingCache)) {
        return rankingCache.data;
    }

    try {
        const response = await fetch(`${config.iedonApiBase}/ranking`, {
            signal: AbortSignal.timeout(15_000),
        });

        if (response.ok) {
            const text = await response.text();
            const ranking = parseRankingText(text);
            rankingCache = { data: ranking, timestamp: Date.now() };
            return ranking;
        }

        console.error(`[iedon] Ranking API returned ${response.status}`);
    } catch (error) {
        console.error(`[iedon] Failed to fetch ranking: ${error}`);
    }

    // Return stale cache if available
    return rankingCache?.data ?? [];
}

/**
 * Get detailed info for a specific ASN from iedon MAP service.
 *
 * Returns peer list, centrality metrics, and optional whois data.
 * Results are cached per-ASN for 15 minutes.
 */
export async function getAsnInfo(asn: number): Promise<AsnInfo | null> {
    // Check cache
    const cached = asnCache.get(asn);
    const staleData = cached?.data ?? null;
    if (isCacheValid(cached)) {
        return cached.data;
    }

    try {
        const response = await fetch(`${config.iedonApiBase}/asn/${asn}`, {
            signal: AbortSignal.timeout(15_000),
        });

        if (response.ok) {
            const raw: unknown = await response.json();
            const parsed = AsnInfoResponseSchema.safeParse(raw);

            if (!parsed.success) {
                console.error(`[iedon] Invalid ASN response for ${asn}: ${parsed.error.message}`);
                return staleData;
            }

            const data = parsed.data;

            // Normalize peers — API may return array or object
            let peers: number[] = [];
            const peersRaw = data.peers ?? data.neighbors;
            if (Array.isArray(peersRaw)) {
                peers = peersRaw.filter((p): p is number => typeof p === 'number');
            } else if (peersRaw && typeof peersRaw === 'object') {
                peers = Object.keys(peersRaw)
                    .map((k) => Number.parseInt(k, 10))
                    .filter((n) => !Number.isNaN(n));
            }

            const info: AsnInfo = {
                asn,
                name: data.name ?? data.asName ?? 'Unknown',
                peerCount: peers.length || data.peer_count || data.peerCount || 0,
                peers: peers.slice(0, 50),
                centrality: data.centrality ?? 0,
                closeness: data.closeness ?? 0,
                betweenness: data.betweenness ?? 0,
                whois: data.whois,
            };

            asnCache.set(asn, { data: info, timestamp: Date.now() });
            return info;
        }

        if (response.status === 404) {
            return null;
        }

        console.error(`[iedon] ASN API returned ${response.status} for ${asn}`);
    } catch (error) {
        console.error(`[iedon] Failed to fetch ASN ${asn}: ${error}`);
    }

    // Return stale cache if available
    return staleData;
}

/**
 * Get overall DN42 network statistics derived from ranking data.
 *
 * Computes total ASN count, estimated link count, and average peers.
 */
export async function getNetworkStats(): Promise<NetworkStats> {
    const ranking = await getRanking();

    if (ranking.length > 0) {
        const totalAsns = ranking.length;
        // Approximate peer count from index (index ~= centrality * 10000, rough peer estimate = index / 100)
        const totalPeers = ranking.reduce((sum, entry) => sum + Math.floor(entry.index / 100), 0);
        const avgPeers = totalPeers / totalAsns;

        return {
            totalAsns,
            totalLinks: Math.floor(totalPeers / 2),
            avgPeers: Math.round(avgPeers * 100) / 100,
        };
    }

    return { totalAsns: 0, totalLinks: 0, avgPeers: 0 };
}
