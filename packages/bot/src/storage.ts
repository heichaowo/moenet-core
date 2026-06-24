/**
 * Redis Session Storage for grammY
 */
import type { StorageAdapter } from 'grammy';
import Redis from 'ioredis';
import config from './config';

let redisClient: Redis | null = null;

/**
 * Get or create Redis client
 */
export function getRedisClient(): Redis | null {
    // Enable Redis when URL is explicitly set (not the default localhost)
    const redisUrl = config.redisUrl;
    if (!redisUrl || redisUrl === 'redis://localhost:6379') {
        return null;
    }

    if (!redisClient) {
        try {
            redisClient = new Redis(config.redisUrl, {
                maxRetriesPerRequest: 3,
                lazyConnect: true,
            });

            redisClient.on('error', (err) => {
                console.error('[Redis] Connection error:', err.message);
            });

            redisClient.on('connect', () => {
                console.log('[Redis] Connected');
            });
        } catch (error) {
            console.error('[Redis] Failed to create client:', error);
            return null;
        }
    }

    return redisClient;
}

/**
 * Redis storage adapter for grammY sessions
 */
export function createRedisStorage<T>(prefix = 'bot:session:'): StorageAdapter<T> | null {
    const client = getRedisClient();

    if (!client) {
        console.log('[Session] Using in-memory storage');
        return null;
    }

    console.log('[Session] Using Redis storage');

    return {
        async read(key: string): Promise<T | undefined> {
            try {
                const data = await client.get(`${prefix}${key}`);
                if (data) {
                    return JSON.parse(data) as T;
                }
                return undefined;
            } catch (error) {
                console.error('[Redis] Read error:', error);
                return undefined;
            }
        },

        async write(key: string, value: T): Promise<void> {
            try {
                await client.set(
                    `${prefix}${key}`,
                    JSON.stringify(value),
                    'EX',
                    86400 * 30 // 30 days TTL
                );
            } catch (error) {
                console.error('[Redis] Write error:', error);
            }
        },

        async delete(key: string): Promise<void> {
            try {
                await client.del(`${prefix}${key}`);
            } catch (error) {
                console.error('[Redis] Delete error:', error);
            }
        },
    };
}

/**
 * Close Redis connection gracefully
 */
export async function closeRedis(): Promise<void> {
    if (redisClient) {
        await redisClient.quit();
        redisClient = null;
    }
}
