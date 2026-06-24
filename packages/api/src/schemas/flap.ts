/**
 * Flap Detection API Validation Schemas
 *
 * Zod schemas for FlapAlerted webhook payloads.
 * FlapAlerted sends the same FlapEvent struct to both start (alert) and end (resolved) webhooks.
 *
 * Reference: https://github.com/Kioubit/FlapAlerted/blob/master/analyze/eventTypes.go
 */

import { z } from "zod";

/**
 * FlapAlerted FlapEvent payload (same struct for both alert and resolved)
 *
 * Go struct fields (PascalCase, no json tags):
 * - Prefix: netip.Prefix (string)
 * - TotalPathChanges: uint64
 * - RateSec: int
 * - RateSecHistory: []int
 * - FirstSeen: int64 (unix timestamp)
 * - PathHistory: PathTrackerSummary (complex nested object)
 */
export const FlapEventSchema = z.object({
	Prefix: z.string().min(1, "Prefix is required"),
	TotalPathChanges: z.number().int().nonnegative().optional().default(0),
	RateSec: z.number().optional().default(0),
	RateSecHistory: z.array(z.number()).optional().default([]),
	FirstSeen: z.number().int().optional().default(0),
	PathHistory: z.unknown().optional(),
});

export type FlapEventInput = z.infer<typeof FlapEventSchema>;

/**
 * Stored flap event (enriched with metadata for Redis)
 */
export interface StoredFlapEvent {
	type: "alert" | "resolved";
	prefix: string;
	totalPathChanges: number;
	rateSec: number;
	firstSeen: number;
	durationMinutes: number | null;
	timestamp: number;
}
