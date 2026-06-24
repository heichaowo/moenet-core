import Redis from "ioredis";
import config from "../config";

let redis: Redis | null = null;

export async function initRedis(): Promise<void> {
	redis = new Redis({
		host: config.redis.host,
		port: config.redis.port,
		password: config.redis.password,
		maxRetriesPerRequest: 3,
	});

	// Test connection
	await redis.ping();
}

export function getRedis(): Redis {
	if (!redis) {
		throw new Error("Redis not initialized. Call initRedis() first.");
	}
	return redis;
}

// Helper functions for common Redis operations
export async function cacheSet(
	key: string,
	value: unknown,
	ttlSeconds = 300,
): Promise<void> {
	const r = getRedis();
	await r.setex(key, ttlSeconds, JSON.stringify(value));
}

export async function cacheGet<T>(key: string): Promise<T | null> {
	const r = getRedis();
	const data = await r.get(key);
	return data ? JSON.parse(data) : null;
}

export async function cacheDel(key: string): Promise<void> {
	const r = getRedis();
	await r.del(key);
}
