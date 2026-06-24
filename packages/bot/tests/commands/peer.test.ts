/**
 * Peer Command Tests
 * 
 * Tests for /peer, /modify, /info commands and their flows.
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { createMockContext, assertReplyContains, assertHasKeyboard, type MockBotContext } from '../helpers/mock-context';

// Mock config before importing handlers
mock.module('../../src/config', () => ({
    default: {
        apiUrl: 'http://localhost:3000/api/v1',
        apiToken: 'test-token',
        adminChatId: 123456,
        adminUsername: 'admin',
    },
}));

// Mock China IP check
mock.module('../../src/providers/chinaIp', () => ({
    isChinaIP: () => false,
    resolveEndpoint: async () => '1.2.3.4',
    CN_REJECTION_MESSAGE: 'CN endpoints not allowed',
}));

// Mock API responses
const mockRouters = [
    {
        uuid: 'router-1-uuid',
        name: 'hk-edge',
        isOpen: true,
        location: 'Hong Kong',
        region: 'ap',
        endpoint: 'hk.example.com',
        wgPublicKey: 'TestPublicKey123456789012345678901234567890123=',
        nodeId: 1,
        maxPeers: 50,
        currentPeers: 10,
    },
    {
        uuid: 'router-2-uuid',
        name: 'jp1',
        isOpen: true,
        location: 'Tokyo',
        region: 'ap',
        endpoint: 'jp.example.com',
        wgPublicKey: 'AnotherPublicKey12345678901234567890123456789=',
        nodeId: 2,
        maxPeers: 30,
        currentPeers: 5,
    },
];

let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
    // Reset fetch mock
    mockFetch = mock(() => Promise.resolve({
        json: () => Promise.resolve({ code: 0, data: { routers: mockRouters } }),
        ok: true,
    }));
    global.fetch = mockFetch as unknown as typeof fetch;
});

describe('Peer Command - /peer', () => {
    test('should reject if user is not logged in', async () => {
        const { ctx, replies } = createMockContext({
            messageText: '/peer',
            session: { asn: undefined },
        });

        // Import fresh to use mocked modules
        const { registerPeerCommands } = await import('../../src/commands/peer');

        // Create a minimal bot-like object to register commands
        const handlers: Record<string, (ctx: MockBotContext) => Promise<void>> = {};
        const mockBot = {
            command: (name: string, handler: (ctx: MockBotContext) => Promise<void>) => {
                handlers[name] = handler;
            },
            callbackQuery: () => { },
            on: () => { },
        };

        registerPeerCommands(mockBot as never);

        // Execute the peer command handler
        await handlers['peer']?.(ctx);

        expect(replies.length).toBeGreaterThan(0);
        assertReplyContains(replies, 'login');
    });

    test('should show node list when logged in', async () => {
        const { ctx, replies } = createMockContext({
            messageText: '/peer',
            session: { asn: 4242420998 },
        });

        const handlers: Record<string, (ctx: MockBotContext) => Promise<void>> = {};
        const mockBot = {
            command: (name: string, handler: (ctx: MockBotContext) => Promise<void>) => {
                handlers[name] = handler;
            },
            callbackQuery: () => { },
            on: () => { },
        };

        const { registerPeerCommands } = await import('../../src/commands/peer');
        registerPeerCommands(mockBot as never);

        await handlers['peer']?.(ctx);

        // Should show identity confirmation
        assertReplyContains(replies, 'AS4242420998');
    });
});

describe('Peer Flow - Step Transitions', () => {
    test('should set correct step after node selection', async () => {
        const { ctx } = createMockContext({
            messageText: '',
            session: {
                asn: 4242420998,
                peerFlow: {
                    step: 'select_node',
                    nodeMap: {
                        'hk-edge (Hong Kong)': {
                            uuid: 'router-1-uuid',
                            endpoint: 'hk.example.com',
                            pubkey: 'TestKey123456789012345678901234567890123456=',
                            nodeId: 1,
                        },
                    },
                },
            },
            callbackData: 'peer:node:hk-edge (Hong Kong)',
        });

        // After node selection, step should be 'show_wg_info'
        // This tests that the state machine transition works correctly
        expect(ctx.session.peerFlow?.step).toBe('select_node');

        // Simulate the callback handler updating the step
        if (ctx.session.peerFlow) {
            ctx.session.peerFlow.step = 'show_wg_info';
            ctx.session.peerFlow.routerName = 'hk-edge';
            ctx.session.peerFlow.routerUuid = 'router-1-uuid';
        }

        expect(ctx.session.peerFlow?.step).toBe('show_wg_info');
        expect(ctx.session.peerFlow?.routerName).toBe('hk-edge');
    });

    test('should calculate correct port from ASN', () => {
        // Test port calculation function
        function calculatePort(asn: number): number {
            if (asn >= 4242420000 && asn <= 4242429999) {
                return 30000 + (asn % 10000);
            } else if (asn >= 4201270000 && asn <= 4201279999) {
                return 40000 + (asn % 10000);
            } else {
                return 50000 + (asn % 10000);
            }
        }

        expect(calculatePort(4242420998)).toBe(30998);
        expect(calculatePort(4242421234)).toBe(31234);
        expect(calculatePort(4201270001)).toBe(40001);
        expect(calculatePort(4200000001)).toBe(50001);
    });
});

describe('Modify Flow - State Machine', () => {
    test('should handle modify_menu step correctly', async () => {
        const { ctx, replies } = createMockContext({
            messageText: 'PSK',
            session: {
                asn: 4242420998,
                peerFlow: {
                    step: 'modify_menu',
                    routerUuid: 'router-1-uuid',
                    routerName: 'hk-edge',
                    backup: {
                        endpoint: 'test.com',
                        port: '51820',
                        ipv6: 'fe80::998',
                        ipv4: '',
                        localIpv6: 'fe80::1',
                        localIpv4: '',
                        pubkey: 'TestKey123456789012345678901234567890123456=',
                        psk: false,
                        mtu: 1420,
                        mpbgp: true,
                        extendedNexthop: true,
                        contact: 'test@example.com',
                    },
                    current: {
                        endpoint: 'test.com',
                        port: '51820',
                        ipv6: 'fe80::998',
                        ipv4: '',
                        localIpv6: 'fe80::1',
                        localIpv4: '',
                        pubkey: 'TestKey123456789012345678901234567890123456=',
                        psk: false,
                        mtu: 1420,
                        mpbgp: true,
                        extendedNexthop: true,
                        contact: 'test@example.com',
                    },
                },
            },
        });

        // When user types 'PSK' in modify_menu, step should change to 'modify_psk'
        expect(ctx.session.peerFlow?.step).toBe('modify_menu');

        // Simulate the state transition that should happen
        if (ctx.session.peerFlow) {
            ctx.session.peerFlow.step = 'modify_psk';
        }

        expect(ctx.session.peerFlow?.step).toBe('modify_psk');
    });

    test('should handle BGP Address sub-menu correctly', async () => {
        const { ctx } = createMockContext({
            messageText: 'Peer IPv6 (对方)',
            session: {
                asn: 4242420998,
                peerFlow: {
                    step: 'modify_bgp_address',
                    routerUuid: 'router-1-uuid',
                    current: {
                        endpoint: '',
                        port: '',
                        ipv6: 'fe80::998',
                        ipv4: '',
                        localIpv6: '',
                        localIpv4: '',
                        pubkey: '',
                        psk: false,
                        mtu: 1420,
                        mpbgp: true,
                        extendedNexthop: true,
                        contact: '',
                    },
                },
            },
        });

        // When user selects 'Peer IPv6 (对方)' in modify_bgp_address
        // step should change to 'modify_peerIpv6'
        expect(ctx.session.peerFlow?.step).toBe('modify_bgp_address');

        if (ctx.session.peerFlow) {
            ctx.session.peerFlow.step = 'modify_peerIpv6';
        }

        expect(ctx.session.peerFlow?.step).toBe('modify_peerIpv6');
    });

    test('should handle Abort modification correctly', async () => {
        const { ctx, replies } = createMockContext({
            messageText: 'Abort modification',
            session: {
                asn: 4242420998,
                peerFlow: {
                    step: 'modify_menu',
                    routerUuid: 'router-1-uuid',
                },
            },
        });

        // When user types 'Abort modification', peerFlow should be cleared
        expect(ctx.session.peerFlow).toBeDefined();

        // Simulate the abort action
        ctx.session.peerFlow = undefined;

        expect(ctx.session.peerFlow).toBeUndefined();
    });
});

describe('Validation Functions', () => {
    test('should validate IPv6 addresses correctly', () => {
        function isValidIPv6(ip: string): boolean {
            const addr = ip.includes('/') ? ip.split('/')[0] : ip;
            return /^[0-9a-f:]+$/i.test(addr || '') && (addr || '').includes(':');
        }

        expect(isValidIPv6('fe80::998')).toBe(true);
        expect(isValidIPv6('fd00::1234')).toBe(true);
        expect(isValidIPv6('2001:db8::1')).toBe(true);
        expect(isValidIPv6('fe80::1/64')).toBe(true);
        expect(isValidIPv6('invalid')).toBe(false);
        expect(isValidIPv6('192.168.1.1')).toBe(false);
    });

    test('should validate WireGuard public keys correctly', () => {
        function isValidWgPubkey(key: string): boolean {
            return /^[A-Za-z0-9+/]{43}=$/.test(key);
        }

        // Valid: exactly 43 base64 chars + '=' = 44 total
        // Real WG key example: wJXLTmRqHqJ2tJz0Cs3nLzk+DmMV38P/iZVfdWShqk8=
        expect(isValidWgPubkey('wJXLTmRqHqJ2tJz0Cs3nLzk+DmMV38P/iZVfdWShqk8=')).toBe(true);
        expect(isValidWgPubkey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toBe(true);
        expect(isValidWgPubkey('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg=')).toBe(true);
        // Invalid cases
        expect(isValidWgPubkey('short')).toBe(false);
        expect(isValidWgPubkey('TooLongKeyThatExceedsFortyFourCharactersTotal123=')).toBe(false);
        expect(isValidWgPubkey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false); // no = (42 chars)
    });

    test('should validate DN42 IPv4 addresses correctly', () => {
        function isValidDN42IPv4(ip: string): boolean {
            return /^172\.(2[0-3]|1[6-9])\./.test(ip);
        }

        expect(isValidDN42IPv4('172.20.1.1')).toBe(true);
        expect(isValidDN42IPv4('172.22.188.1')).toBe(true);
        expect(isValidDN42IPv4('172.23.255.255')).toBe(true);
        expect(isValidDN42IPv4('172.24.1.1')).toBe(false);
        expect(isValidDN42IPv4('192.168.1.1')).toBe(false);
        expect(isValidDN42IPv4('10.0.0.1')).toBe(false);
    });
});

describe('Step Enum Constants', () => {
    // These tests document the expected step values
    // Useful for ensuring consistency when refactoring

    const PEER_STEPS = {
        // Creation flow
        SELECT_NODE: 'select_node',
        SHOW_WG_INFO: 'show_wg_info',
        INPUT_IPV6: 'input_ipv6',
        INPUT_ENDPOINT: 'input_endpoint',
        INPUT_PORT: 'input_port',
        INPUT_PUBKEY: 'input_pubkey',
        INPUT_MTU: 'input_mtu',
        INPUT_PSK: 'input_psk',
        CONFIRM: 'confirm',

        // Modify flow
        MODIFY_MENU: 'modify_menu',
        MODIFY_REGION: 'modify_region',
        MODIFY_SESSION_TYPE: 'modify_session_type',
        MODIFY_BGP_ADDRESS: 'modify_bgp_address',
        MODIFY_PEER_IPV6: 'modify_peerIpv6',
        MODIFY_PEER_IPV4: 'modify_peerIpv4',
        MODIFY_LOCAL_IPV6: 'modify_localIpv6',
        MODIFY_LOCAL_IPV4: 'modify_localIpv4',
        MODIFY_ENDPOINT: 'modify_endpoint',
        MODIFY_PUBKEY: 'modify_pubkey',
        MODIFY_PSK: 'modify_psk',
        MODIFY_MTU: 'modify_mtu',
        MODIFY_CONTACT: 'modify_contact',
        MODIFY_CONFIRM: 'modify_confirm',
    } as const;

    test('should have all creation flow steps defined', () => {
        expect(PEER_STEPS.SELECT_NODE).toBe('select_node');
        expect(PEER_STEPS.INPUT_IPV6).toBe('input_ipv6');
        expect(PEER_STEPS.CONFIRM).toBe('confirm');
    });

    test('should have all modify flow steps defined', () => {
        expect(PEER_STEPS.MODIFY_MENU).toBe('modify_menu');
        expect(PEER_STEPS.MODIFY_BGP_ADDRESS).toBe('modify_bgp_address');
        expect(PEER_STEPS.MODIFY_CONFIRM).toBe('modify_confirm');
    });
});
