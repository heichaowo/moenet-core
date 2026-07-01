import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// Mock Redis before importing rateLimiter
const mockRedis = {
    zremrangebyscore: mock(() => Promise.resolve(0)),
    zcard: mock(() => Promise.resolve(0)),
    zadd: mock(() => Promise.resolve(1)),
    pexpire: mock(() => Promise.resolve(1)),
    pipeline: mock(() => ({
        zremrangebyscore: mock(function (this: unknown) { return this; }),
        zcard: mock(function (this: unknown) { return this; }),
        zadd: mock(function (this: unknown) { return this; }),
        pexpire: mock(function (this: unknown) { return this; }),
        exec: mock(() => Promise.resolve([
            [null, 0],  // zremrangebyscore result
            [null, 5],  // zcard result (5 requests in window)
            [null, 1],  // zadd result
            [null, 1],  // pexpire result
        ])),
    })),
};

mock.module('../../src/db/redisContext', () => ({
    getRedis: () => mockRedis,
}));

describe('Rate Limiter Middleware', () => {
    beforeEach(() => {
        // Reset mock state
        process.env.STANDALONE = 'false';
    });

    test('should add rate limit headers', async () => {
        const { rateLimiter } = await import('../../src/middleware/rateLimiter');
        const app = new Hono();
        app.use('*', rateLimiter());
        app.get('/auth', (c) => c.json({ ok: true }));

        const res = await app.request('/auth');

        expect(res.status).toBe(200);
        expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
        expect(res.headers.get('X-RateLimit-Remaining')).toBeDefined();
    });

    test('should skip health endpoint', async () => {
        const { rateLimiter } = await import('../../src/middleware/rateLimiter');
        const app = new Hono();
        app.use('*', rateLimiter());
        app.get('/health', (c) => c.json({ status: 'ok' }));

        const res = await app.request('/health');

        expect(res.status).toBe(200);
        // Health endpoint should not have rate limit headers
        expect(res.headers.get('X-RateLimit-Limit')).toBeNull();
    });

    test('should skip rate limiting in standalone mode', async () => {
        process.env.STANDALONE = 'true';

        const { rateLimiter } = await import('../../src/middleware/rateLimiter');
        const app = new Hono();
        app.use('*', rateLimiter());
        app.get('/auth', (c) => c.json({ ok: true }));

        const res = await app.request('/auth');

        expect(res.status).toBe(200);
    });

    test('should use different limits for agent routes', async () => {
        const { rateLimiter } = await import('../../src/middleware/rateLimiter');
        const app = new Hono();
        app.use('*', rateLimiter());
        app.get('/api/v1/agent/:router/sessions', (c) => c.json({ ok: true }));

        const res = await app.request('/api/v1/agent/hk-edge/sessions');

        expect(res.status).toBe(200);
        expect(res.headers.get('X-RateLimit-Limit')).toBe('300');
    });
});
