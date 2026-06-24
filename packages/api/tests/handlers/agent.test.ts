import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';

// Mock the database context before importing handlers
const mockBgpSessions = {
    findAll: mock(() => Promise.resolve([] as unknown[])),
    findOne: mock(() => Promise.resolve(null)),
    create: mock(() => Promise.resolve({ get: () => ({}) })),
    update: mock(() => Promise.resolve([1])),
};

const mockRouters = {
    findOne: mock(() => Promise.resolve({
        get: (key: string) => {
            const data: Record<string, unknown> = {
                uuid: 'test-router-uuid',
                name: 'test-router',
            };
            return data[key];
        },
    })),
    findAll: mock(() => Promise.resolve([])),
};

mock.module('../../src/db/dbContext', () => ({
    getModels: () => ({
        bgpSessions: mockBgpSessions,
        routers: mockRouters,
        users: {},
        settings: {},
        auditLogs: { create: mock(() => Promise.resolve()) },
    }),
}));

// Mock bcrypt helper
mock.module('../../src/common/helpers', () => ({
    bcryptCompare: mock(async (expected: string, token: string) => {
        return token === 'valid-token';
    }),
    timingSafeCompare: (a: string, b: string) => a === b,
    generateUUID: () => 'test-uuid-12345',
    getInterfaceName: (asn: number) => `dn42_${asn}`,
    getListenPort: (asn: number) => 20000 + (asn % 10000),
}));

// Mock config
mock.module('../../src/config', () => ({
    default: {
        auth: {
            agentApiKey: 'test-key',
            jwtSecret: 'test-secret',
        },
    },
}));

describe('Agent Handler', () => {
    beforeEach(() => {
        // Reset mocks
        mockBgpSessions.findAll.mockClear();
        mockBgpSessions.update.mockClear();
        mockRouters.findOne.mockClear();
    });

    test('should reject requests without auth header', async () => {
        const { default: agentHandler } = await import('../../src/handlers/agent');
        const app = new Hono();
        app.get('/agent/:router/:action', agentHandler);

        const res = await app.request('/agent/test-router/sessions');

        expect(res.status).toBe(401);
    });

    test('should reject requests with invalid token', async () => {
        const { default: agentHandler } = await import('../../src/handlers/agent');
        const app = new Hono();
        app.get('/agent/:router/:action', agentHandler);

        const res = await app.request('/agent/test-router/sessions', {
            headers: { Authorization: 'Bearer invalid-token' },
        });

        expect(res.status).toBe(401);
    });

    test('should return sessions for valid request', async () => {
        mockBgpSessions.findAll.mockImplementation(() => Promise.resolve([
            {
                get: () => ({
                    uuid: 'session-1',
                    asn: 4242420001,
                    status: 2,
                    ipv4: '172.22.1.1',
                    ipv6: null,
                    ipv6LinkLocal: 'fe80::1',
                    type: 'wireguard',
                    extensions: null,
                    interface: 'dn42_420001',
                    endpoint: '1.2.3.4:51820',
                    credential: 'pubkey123',
                    data: null,
                    mtu: 1420,
                    policy: 1,
                    lastError: null,
                }),
            },
        ]));

        const { default: agentHandler } = await import('../../src/handlers/agent');
        const app = new Hono();
        app.get('/agent/:router/:action', agentHandler);

        const res = await app.request('/agent/test-router/sessions', {
            headers: { Authorization: 'Bearer test-key' },
        });

        expect(res.status).toBe(200);
        const body = await res.json() as { code: number; data: { bgpSessions: unknown } };
        expect(body.code).toBe(0);
        expect(body.data.bgpSessions).toBeDefined();
    });

    test('should handle modify action', async () => {
        const { default: agentHandler } = await import('../../src/handlers/agent');
        const app = new Hono();
        app.post('/agent/:router/:action', agentHandler);

        const res = await app.request('/agent/test-router/modify', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer test-key',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                uuid: 'session-uuid',
                status: 2,
            }),
        });

        expect(res.status).toBe(200);
    });

    test('should reject modify with missing uuid', async () => {
        const { default: agentHandler } = await import('../../src/handlers/agent');
        const app = new Hono();
        app.post('/agent/:router/:action', agentHandler);

        const res = await app.request('/agent/test-router/modify', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer test-key',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ status: 2 }),
        });

        expect(res.status).toBe(422);
    });

    test('should return 404 for unknown action', async () => {
        const { default: agentHandler } = await import('../../src/handlers/agent');
        const app = new Hono();
        app.get('/agent/:router/:action', agentHandler);

        const res = await app.request('/agent/test-router/unknown-action', {
            headers: { Authorization: 'Bearer test-key' },
        });

        expect(res.status).toBe(404);
    });
});

describe('Agent Heartbeat Handler', () => {
    test('should accept heartbeat with meshPublicKey', async () => {
        const mockRoutersUpdate = mock(() => Promise.resolve([1]));
        mock.module('../../src/db/dbContext', () => ({
            getModels: () => ({
                routers: {
                    findOne: mock(() => Promise.resolve({ get: () => 'test-router' })),
                    update: mockRoutersUpdate,
                },
                bgpSessions: { findAll: mock(() => Promise.resolve([])) },
                auditLogs: { create: mock(() => Promise.resolve()) },
            }),
        }));

        const { default: agentHandler } = await import('../../src/handlers/agent');
        const app = new Hono();
        app.post('/api/v1/agent/heartbeat', agentHandler);

        const res = await app.request('/api/v1/agent/heartbeat', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer test-key',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                node_id: 'test-router',
                agent_version: 'v2.1.0',
                status: {
                    version: 'v2.1.0',
                    loadAvg: '0.50 0.40 0.30',
                    uptime: 86400,
                    meshPublicKey: 'test-public-key-12345',
                },
            }),
        });

        expect(res.status).toBe(200);
    });

    test('should reject heartbeat without node_id', async () => {
        const { default: agentHandler } = await import('../../src/handlers/agent');
        const app = new Hono();
        app.post('/api/v1/agent/heartbeat', agentHandler);

        const res = await app.request('/api/v1/agent/heartbeat', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer test-key',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                status: { version: 'v2.1.0' },
            }),
        });

        expect(res.status).toBe(422);
    });
});

describe('Agent Config Handler', () => {
    test('should return agent config for valid router', async () => {
        mock.module('../../src/db/dbContext', () => ({
            getModels: () => ({
                routers: {
                    findOne: mock(() => Promise.resolve({
                        get: (key: string) => {
                            const data: Record<string, unknown> = {
                                name: 'test-router',
                                nodeId: 1,
                                region: 'ap',
                                location: 'Tokyo',
                                provider: 'TestProvider',
                                dn42Loopback4: '172.22.188.1',
                                dn42Loopback6: 'fd00::1',
                            };
                            return data[key];
                        },
                    })),
                },
                bgpSessions: { findAll: mock(() => Promise.resolve([])) },
                auditLogs: { create: mock(() => Promise.resolve()) },
            }),
        }));

        const { default: agentHandler } = await import('../../src/handlers/agent');
        const app = new Hono();
        app.get('/agent/:router/:action', agentHandler);

        const res = await app.request('/agent/test-router/config', {
            headers: { Authorization: 'Bearer test-key' },
        });

        expect(res.status).toBe(200);
        const body = await res.json() as { code: number; data: { node: { name: string }; wireguard: unknown } };
        expect(body.code).toBe(0);
        expect(body.data.node).toBeDefined();
        expect(body.data.node.name).toBe('test-router');
        expect(body.data.wireguard).toBeDefined();
    });
});

describe('Agent Mesh Handler', () => {
    test('should return mesh peers list', async () => {
        mock.module('../../src/db/dbContext', () => ({
            getModels: () => ({
                routers: {
                    findOne: mock(() => Promise.resolve({
                        get: (key: string) => {
                            if (key === 'name') return 'test-router';
                            if (key === 'nodeId') return 1;
                            return null;
                        },
                    })),
                    findAll: mock(() => Promise.resolve([
                        {
                            get: (key: string) => {
                                const data: Record<string, unknown> = {
                                    name: 'peer-1',
                                    nodeId: 2,
                                    publicIp: '1.2.3.4',
                                    meshPublicKey: 'peer1-pubkey',
                                    region: 'ap',
                                };
                                return data[key];
                            },
                        },
                        {
                            get: (key: string) => {
                                const data: Record<string, unknown> = {
                                    name: 'peer-2',
                                    nodeId: 3,
                                    publicIp: '5.6.7.8',
                                    meshPublicKey: 'peer2-pubkey',
                                    region: 'us',
                                };
                                return data[key];
                            },
                        },
                    ])),
                },
                bgpSessions: { findAll: mock(() => Promise.resolve([])) },
                auditLogs: { create: mock(() => Promise.resolve()) },
            }),
        }));

        const { default: agentHandler } = await import('../../src/handlers/agent');
        const app = new Hono();
        app.get('/agent/:router/:action', agentHandler);

        const res = await app.request('/agent/test-router/mesh', {
            headers: { Authorization: 'Bearer test-key' },
        });

        expect(res.status).toBe(200);
        const body = await res.json() as { code: number; data: { self: unknown; peers: unknown[] } };
        expect(body.code).toBe(0);
        expect(body.data.self).toBeDefined();
        expect(body.data.peers).toBeDefined();
        expect(Array.isArray(body.data.peers)).toBe(true);
    });
});

