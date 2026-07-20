import { describe, expect, it, mock, afterEach } from 'bun:test';

// Store original fetch so we can restore it
const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('apiRequest — non-JSON response resilience', () => {
    it('resolves to { code: -1, message } when the response body is not valid JSON', async () => {
        // Mock fetch to return a Response whose .json() rejects (simulates a
        // proxy error page, empty body, or HTML error that a missing-await bug
        // previously let escape the try/catch and kill bot callback handlers).
        globalThis.fetch = mock(async () => ({
            json: async () => {
                throw new SyntaxError('Unexpected token < in JSON');
            },
        })) as unknown as typeof fetch;

        // Dynamically import AFTER patching fetch so the module picks up the mock.
        // Use a cache-busting import to bypass Bun's module cache when tests run
        // in the same process across multiple describe blocks.
        const { apiRequest } = await import('../src/api');

        const result = await apiRequest('/admin', 'POST', { action: 'ping' });

        expect(result.code).toBe(-1);
        expect(typeof result.message).toBe('string');
        expect(result.message!.length).toBeGreaterThan(0);
    });

    it('returns the parsed APIResponse on a valid JSON body', async () => {
        const fakeResponse: { code: number; message: string; data?: Record<string, unknown> } = {
            code: 0,
            message: 'ok',
        };

        globalThis.fetch = mock(async () => ({
            json: async () => fakeResponse,
        })) as unknown as typeof fetch;

        const { apiRequest } = await import('../src/api');

        const result = await apiRequest('/admin', 'GET');

        expect(result.code).toBe(0);
        expect(result.message).toBe('ok');
    });
});
