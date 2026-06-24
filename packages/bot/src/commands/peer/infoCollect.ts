/**
 * Info Collect Module
 *
 * @deprecated This module is no longer used by the active peer wizard flow.
 * The active implementation is the switch-case state machine in peer.ts,
 * which uses ui.ts prompt functions and validators.ts for validation.
 * This module is retained as a reference for the original Python-mirrored
 * architecture and may be removed in a future cleanup.
 *
 * Original: moenet-dn42-control-plane/src/bot/commands/info_collect.py
 *
 * Design:
 * - Uses ReplyKeyboard for selection menus (stays at bottom during long flows)
 * - Each step returns { nextStep, message } or null to pause flow
 * - stepManage() coordinates the flow transitions
 */

import type { BotContext } from '../../index';
import config from '../../config';
import {
    calculatePort,
    isValidIPv6,
    isValidWgPubkey,
    isValidDN42IPv4,
    isValidMTU,
    isValidPort,
} from './validators';
import { isChinaIP, resolveEndpoint } from '../../providers/chinaIp';
import type { APIResponse, RouterData } from './types';

// ============== Types ==============

export interface PeerInfo {
    ASN?: number;
    Region?: string;
    Channel?: 'IPv6 & IPv4' | 'IPv6 only' | 'IPv4 only';
    'MP-BGP'?: boolean;
    'MP-BGP-Type'?: 'IPv6' | 'IPv4';
    ENH?: boolean;
    IPv6?: string;
    IPv4?: string;
    'Request-LinkLocal'?: string;
    'Local-IPv6'?: string;
    'Local-IPv4'?: string;
    Clearnet?: string | null;
    Port?: number | null;
    MTU?: number;
    PublicKey?: string;
    PSK?: string | null;
    Contact?: string;
    nodeMap?: Record<string, string>;
    _mode?: 'peer' | 'addpeer' | 'modify';
    _wgEndpoint?: string;
    _wgPubkey?: string;
    _wgLla?: string;
}

export interface StepResult {
    nextStep: string;
    peerInfo: PeerInfo;
}

// ============== API Helper ==============

async function apiRequest(endpoint: string, method = 'POST', body?: unknown): Promise<APIResponse> {
    const response = await fetch(`${config.apiUrl}${endpoint}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': config.apiToken ? `Bearer ${config.apiToken}` : '',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    return response.json() as Promise<APIResponse>;
}

// ============== Step Functions ==============

/**
 * Show available nodes for selection (pre_region)
 */
export async function preRegion(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult | null> {
    try {
        const result = await apiRequest('/admin', 'POST', { action: 'enumRouters' });

        if (result.code !== 0 || !result.data?.routers) {
            await ctx.reply(
                '❌ 当前没有可用节点 / No available nodes',
                { reply_markup: { remove_keyboard: true } }
            );
            return null;
        }

        const routers = result.data.routers;
        let msgText = '';
        peerInfo.nodeMap = {};
        const couldPeer: string[] = [];

        for (const n of routers) {
            // Build label: NAME | City | Provider
            const nodeName = n.name?.toUpperCase() || 'UNKNOWN';
            const city = n.location || '';
            const provider = n.provider || '';
            const label = provider ? `${nodeName} | ${city} | ${provider}` : `${nodeName} | ${city}`;

            // Status section - use different icons
            let statusLines = `- ${label}\n`;

            if (n.isOpen) {
                statusLines += `  🟢 Open For Peer\n`;
            } else {
                statusLines += `  🔴 Closed\n`;
            }

            // Capacity
            const current = n.sessionCount || n.currentPeers || 0;
            const max = n.maxPeers || 0;
            if (max > 0) {
                statusLines += `  � Capacity: ${current} / ${max}\n`;
            } else {
                statusLines += `  👥 Capacity: ${current} / Unlimited\n`;
            }

            // IPv4/IPv6 support - only show if not supported
            if (n.supportsIpv4 === false) {
                statusLines += `  ⚠️ IPv4: No\n`;
            }
            if (n.supportsIpv6 === false) {
                statusLines += `  ⚠️ IPv6: No\n`;
            }

            // CN peer restriction
            if (n.allowCnPeers === false) {
                statusLines += `  🚫 Not allowed to peer with Chinese Mainland\n`;
            }

            msgText += statusLines + '\n';

            // Add to selectable list if open and has capacity
            const hasCapacity = max === 0 || current < max;
            if (n.isOpen && hasCapacity) {
                couldPeer.push(label);
                peerInfo.nodeMap[label] = n.name;
            }
        }

        if (couldPeer.length === 0) {
            await ctx.reply(
                `${msgText}\n❌ 当前没有可 Peer 的节点 / No available nodes for peering`,
                { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
            );
            return null;
        }

        // Auto-select if only one option
        if (couldPeer.length === 1) {
            await ctx.reply(
                `${msgText}\n只有一个可选节点，自动选择 \`${couldPeer[0]}\`\n` +
                'Only one available node, auto-selected.',
                { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
            );
            return await postRegion(ctx, peerInfo, couldPeer[0] ?? '');
        }

        // Send node list
        await ctx.reply(msgText);

        // Build ReplyKeyboard for selection
        const keyboard: { text: string }[][] = couldPeer.map(label => [{ text: label }]);

        await ctx.reply(
            'Which node do you want to choose?\n你想选择哪个节点?',
            {
                reply_markup: {
                    keyboard,
                    resize_keyboard: true,
                    one_time_keyboard: true,
                }
            }
        );

        return { nextStep: 'post_region', peerInfo };
    } catch (error) {
        console.error('[preRegion] Error:', error);
        await ctx.reply('❌ Failed to fetch nodes');
        return null;
    }
}

/**
 * Handle node selection (post_region)
 */
export async function postRegion(
    ctx: BotContext,
    peerInfo: PeerInfo,
    chosen?: string
): Promise<StepResult | null> {
    const text = chosen || ctx.message?.text?.trim() || '';

    if (!peerInfo.nodeMap || !peerInfo.nodeMap[text]) {
        // Invalid selection - show keyboard again
        const labels = Object.keys(peerInfo.nodeMap || {});
        const keyboard: { text: string }[][] = labels.map(label => [{ text: label }]);

        await ctx.reply(
            '❌ 无效选择，请重试 / Invalid selection, try again:',
            {
                reply_markup: {
                    keyboard,
                    resize_keyboard: true,
                }
            }
        );
        return { nextStep: 'post_region', peerInfo };
    }

    const nodeName = peerInfo.nodeMap[text];
    peerInfo.Region = nodeName;

    // Fetch node info for WG details
    try {
        const result = await apiRequest('/admin', 'POST', { action: 'enumRouters' });
        const routers = result.data?.routers || [];
        const nodeInfo = routers.find((r: RouterData) => r.name === nodeName);

        if (!nodeInfo) {
            // Node not found, continue to next step
            return { nextStep: 'pre_session_type', peerInfo };
        }

        // Calculate user's WireGuard port based on ASN
        const asn = peerInfo.ASN || 0;
        const userPort = calculatePort(asn);

        // Build WG info display
        const endpoint = nodeInfo.endpoint || nodeName;
        const pubkey = nodeInfo.wgPublicKey || 'N/A';
        const nodeId = nodeInfo.nodeId || 0;
        const regionCode = nodeInfo.regionCode || 0;
        const ourLla = `fe80::998:${regionCode}:${nodeId}:1`;

        peerInfo._wgEndpoint = `${endpoint}:${userPort}`;
        peerInfo._wgPubkey = pubkey;
        peerInfo._wgLla = ourLla;

        // Show server WG info with InlineKeyboard for copy/continue
        const infoText =
            `🔧 *Server WireGuard Info / 服务器 WireGuard 信息*\n\n` +
            `📍 Node: ${nodeName}\n` +
            `🌐 Endpoint: \`${endpoint}:${userPort}\`\n` +
            `🔑 PublicKey: \`${pubkey}\`\n` +
            `📶 Our LLA: \`${ourLla}\`\n\n` +
            `请使用以上信息配置你的 WireGuard\n` +
            `Use above info to configure your WireGuard`;

        const { InlineKeyboard } = await import('grammy');
        const keyboard = new InlineKeyboard()
            .text('Continue ➡️ 继续', 'peer:continue_to_session');

        await ctx.reply(infoText, { parse_mode: 'Markdown', reply_markup: keyboard });

        // Pause flow - will be resumed by callback handler
        return null;
    } catch (error) {
        console.error('[postRegion] Error fetching node info:', error);
        return { nextStep: 'pre_session_type', peerInfo };
    }
}

/**
 * Ask for session type (pre_session_type)
 */
export async function preSessionType(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    await ctx.reply(
        '传输哪些路由? / What routes do you want to transmit?\n\n' +
        '• `IPv6 & IPv4` - 需提供两种地址 (除非支持 MP-BGP + ENH)\n' +
        '• `IPv6 only` - 仅需 IPv6 地址\n' +
        '• `IPv4 only` - 仅需 IPv4 地址',
        {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [
                    [{ text: 'IPv6 & IPv4' }, { text: 'IPv6 only' }, { text: 'IPv4 only' }],
                ],
                resize_keyboard: true,
                one_time_keyboard: true,
            }
        }
    );
    return { nextStep: 'post_session_type', peerInfo };
}

/**
 * Handle session type selection (post_session_type)
 */
export async function postSessionType(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    const text = (ctx.message?.text || '').trim().toLowerCase();

    if (text.includes('ipv6') && text.includes('ipv4')) {
        peerInfo.Channel = 'IPv6 & IPv4';
        return await preMpbgp(ctx, peerInfo);
    } else if (text === 'ipv6 only' || text === 'ipv6') {
        peerInfo.Channel = 'IPv6 only';
        peerInfo['MP-BGP'] = false;
        peerInfo.ENH = false;
        return await preIpv6(ctx, peerInfo);
    } else if (text === 'ipv4 only' || text === 'ipv4') {
        peerInfo.Channel = 'IPv4 only';
        peerInfo['MP-BGP'] = false;
        peerInfo.ENH = false;
        peerInfo.IPv6 = 'Not enabled';
        return await preIpv4(ctx, peerInfo);
    } else {
        // Invalid input - show keyboard again
        await ctx.reply(
            '❌ 无效输入，请重试 / Invalid input, try again:',
            {
                reply_markup: {
                    keyboard: [
                        [{ text: 'IPv6 & IPv4' }, { text: 'IPv6 only' }, { text: 'IPv4 only' }],
                    ],
                    resize_keyboard: true,
                }
            }
        );
        return { nextStep: 'post_session_type', peerInfo };
    }
}

/**
 * Ask for MP-BGP support (pre_mpbgp)
 */
export async function preMpbgp(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    await ctx.reply(
        'Do you support Multi-Protocol BGP?\n你支持多协议 BGP 吗？',
        {
            reply_markup: {
                keyboard: [[{ text: 'Yes' }, { text: 'No' }]],
                resize_keyboard: true,
                one_time_keyboard: true,
            }
        }
    );
    return { nextStep: 'post_mpbgp', peerInfo };
}

/**
 * Handle MP-BGP selection (post_mpbgp)
 */
export async function postMpbgp(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    const text = (ctx.message?.text || '').trim().toLowerCase();

    if (text === 'yes') {
        peerInfo['MP-BGP'] = true;
        return await preMpbgpType(ctx, peerInfo);
    } else if (text === 'no') {
        peerInfo['MP-BGP'] = false;
        peerInfo.ENH = false;
        if (peerInfo.Channel === 'IPv6 & IPv4') {
            await ctx.reply(
                '⚠️ 不支持 MP-BGP 时需要同时提供 IPv6 和 IPv4 地址\n' +
                'Without MP-BGP, both IPv6 and IPv4 addresses are required',
                { reply_markup: { remove_keyboard: true } }
            );
        }
        return await preIpv6(ctx, peerInfo);
    } else {
        await ctx.reply(
            '❌ 无效输入，请输入 Yes 或 No:',
            {
                reply_markup: {
                    keyboard: [[{ text: 'Yes' }, { text: 'No' }]],
                    resize_keyboard: true,
                }
            }
        );
        return { nextStep: 'post_mpbgp', peerInfo };
    }
}

/**
 * Ask which address type to use for MP-BGP session (pre_mpbgp_type)
 */
export async function preMpbgpType(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    await ctx.reply(
        'What address do you want to use to establish an MP-BGP session with me?\n' +
        '你想使用什么地址与我建立多协议 BGP 会话？',
        {
            reply_markup: {
                keyboard: [[{ text: 'IPv6' }, { text: 'IPv4' }]],
                resize_keyboard: true,
                one_time_keyboard: true,
            }
        }
    );
    return { nextStep: 'post_mpbgp_type', peerInfo };
}

/**
 * Handle MP-BGP type selection (post_mpbgp_type)
 */
export async function postMpbgpType(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    const text = (ctx.message?.text || '').trim().toLowerCase();

    if (text === 'ipv6') {
        peerInfo['MP-BGP-Type'] = 'IPv6';
        return await preEnh(ctx, peerInfo);
    } else if (text === 'ipv4') {
        peerInfo['MP-BGP-Type'] = 'IPv4';
        peerInfo.ENH = false;
        if (peerInfo.Channel === 'IPv6 & IPv4') {
            await ctx.reply(
                '⚠️ 使用 IPv4 建立会话时需要同时提供 IPv6 和 IPv4 地址\n' +
                'Using IPv4 session requires both IPv6 and IPv4 addresses',
                { reply_markup: { remove_keyboard: true } }
            );
        }
        return await preIpv6(ctx, peerInfo);
    } else {
        await ctx.reply(
            '❌ 无效输入，请选择 IPv6 或 IPv4:',
            {
                reply_markup: {
                    keyboard: [[{ text: 'IPv6' }, { text: 'IPv4' }]],
                    resize_keyboard: true,
                }
            }
        );
        return { nextStep: 'post_mpbgp_type', peerInfo };
    }
}

/**
 * Ask for Extended Next Hop support (pre_enh)
 */
export async function preEnh(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    await ctx.reply(
        'Do you support Extended Next Hop?\n你支持扩展的下一跳吗？',
        {
            reply_markup: {
                keyboard: [[{ text: 'Yes' }, { text: 'No' }]],
                resize_keyboard: true,
                one_time_keyboard: true,
            }
        }
    );
    return { nextStep: 'post_enh', peerInfo };
}

/**
 * Handle ENH selection (post_enh)
 */
export async function postEnh(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    const text = (ctx.message?.text || '').trim().toLowerCase();

    if (text === 'yes') {
        peerInfo.ENH = true;
        peerInfo.IPv4 = 'Not required (ENH)';
        return await preIpv6(ctx, peerInfo);
    } else if (text === 'no') {
        peerInfo.ENH = false;
        if (peerInfo.Channel === 'IPv6 & IPv4') {
            await ctx.reply(
                '⚠️ 不支持 ENH 时需要同时提供 IPv6 和 IPv4 地址\n' +
                'Without ENH, both IPv6 and IPv4 addresses are required',
                { reply_markup: { remove_keyboard: true } }
            );
        }
        return await preIpv6(ctx, peerInfo);
    } else {
        await ctx.reply(
            '❌ 无效输入，请输入 Yes 或 No:',
            {
                reply_markup: {
                    keyboard: [[{ text: 'Yes' }, { text: 'No' }]],
                    resize_keyboard: true,
                }
            }
        );
        return { nextStep: 'post_enh', peerInfo };
    }
}

/**
 * Ask for DN42 IPv6 address (pre_ipv6)
 */
export async function preIpv6(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    const suggestions: string[] = [];
    const asn = peerInfo.ASN || 0;

    // Smart suggestion: fe80::ASN%10000
    if (asn >= 4242420000 && asn <= 4242429999) {
        suggestions.push(`fe80::${asn % 10000}`);
    }

    // If already has value, add as suggestion
    if (peerInfo.IPv6 && !['Not enabled', 'Not required'].includes(peerInfo.IPv6)) {
        if (!suggestions.includes(peerInfo.IPv6)) {
            suggestions.unshift(peerInfo.IPv6);
        }
    }

    const keyboard: { text: string }[][] = suggestions.slice(0, 3).map(s => [{ text: s }]);

    await ctx.reply(
        'Input your IPv6 address for BGP peering.\n' +
        '请输入你用于 BGP 对等的 IPv6 地址。\n\n' +
        'Supported types / 支持的类型:\n' +
        '• `fe80::/64` Link-Local - Bird 用户首选\n' +
        '• `fc00::/7` ULA - 其他 BGP 客户端首选\n' +
        '• GUA (公网 IPv6) - 也支持',
        {
            parse_mode: 'Markdown',
            reply_markup: keyboard.length > 0
                ? { keyboard, resize_keyboard: true, one_time_keyboard: true }
                : { remove_keyboard: true }
        }
    );
    return { nextStep: 'post_ipv6', peerInfo };
}

/**
 * Validate and store DN42 IPv6 address (post_ipv6)
 */
export async function postIpv6(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult | null> {
    let text = (ctx.message?.text || '').trim();

    // Remove prefix if present
    if (text.includes('/')) {
        text = text.split('/')[0] ?? '';
    }

    if (!isValidIPv6(text)) {
        await ctx.reply(
            '❌ 无效的 IPv6 地址\nInvalid IPv6 address',
            { reply_markup: { remove_keyboard: true } }
        );
        return { nextStep: 'post_ipv6', peerInfo };
    }

    peerInfo.IPv6 = text;

    // Route based on IPv6 type
    if (text.toLowerCase().startsWith('fe80:')) {
        // Link-Local: ask for our LLA
        return await preRequestLinklocal(ctx, peerInfo);
    } else {
        // GUA/ULA: ask for our IPv6 address
        peerInfo['Request-LinkLocal'] = 'Not required (non-LLA)';
        return await preLocalIpv6(ctx, peerInfo);
    }
}

/**
 * Ask for server-side Link-Local address (pre_request_linklocal)
 */
export async function preRequestLinklocal(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    const ourLinklocal = peerInfo._wgLla || 'fe80::998';

    await ctx.reply(
        'Link-Local address detected. You can enter the address required on my side as needed.\n' +
        '检测到 Link-Local 地址。你可以按需输入所需的我这边的地址。\n\n' +
        'Make modifications only if you know exactly what it is and are convinced it\'s needed, ' +
        'otherwise please directly select the option below.\n' +
        '仅在你明确知道这是什么并且确信有必要时再做出修改，否则请直接选择下方的选项。',
        {
            reply_markup: {
                keyboard: [[{ text: ourLinklocal }]],
                resize_keyboard: true,
                one_time_keyboard: true,
            }
        }
    );
    return { nextStep: 'post_request_linklocal', peerInfo };
}

/**
 * Validate and store server-side Link-Local address (post_request_linklocal)
 */
export async function postRequestLinklocal(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult | null> {
    let text = (ctx.message?.text || '').trim();

    // Remove prefix if present
    if (text.includes('/')) {
        text = text.split('/')[0] ?? '';
    }

    // Validate Link-Local
    if (!isValidIPv6(text) || !text.toLowerCase().startsWith('fe80:')) {
        const ourLinklocal = peerInfo._wgLla || 'fe80::998';
        await ctx.reply(
            '❌ Invalid Link-Local address\n无效的 Link-Local 地址\n\nMust be in fe80::/64 range',
            {
                reply_markup: {
                    keyboard: [[{ text: ourLinklocal }]],
                    resize_keyboard: true,
                }
            }
        );
        return { nextStep: 'post_request_linklocal', peerInfo };
    }

    peerInfo['Request-LinkLocal'] = text;
    peerInfo['Local-IPv6'] = text;

    // If IPv6 & IPv4 channel and not using ENH, need IPv4
    if (peerInfo.Channel === 'IPv6 & IPv4' && !peerInfo.ENH) {
        return await preIpv4(ctx, peerInfo);
    }

    return await preClearnet(ctx, peerInfo);
}

/**
 * Ask for our IPv6 address when peer uses GUA/ULA (pre_local_ipv6)
 */
export async function preLocalIpv6(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    // Suggest ULA if peer uses ULA
    const peerIpv6 = peerInfo.IPv6 || '';
    let suggested = '';
    if (peerIpv6.toLowerCase().startsWith('fc') || peerIpv6.toLowerCase().startsWith('fd')) {
        suggested = 'fd00:4242:7777::998';
    }

    await ctx.reply(
        'Input our IPv6 address for BGP peering.\n请输入我方用于 BGP 对等的 IPv6 地址。',
        {
            parse_mode: 'Markdown',
            reply_markup: suggested
                ? { keyboard: [[{ text: suggested }]], resize_keyboard: true, one_time_keyboard: true }
                : { remove_keyboard: true }
        }
    );
    return { nextStep: 'post_local_ipv6', peerInfo };
}

/**
 * Validate and store our IPv6 address (post_local_ipv6)
 */
export async function postLocalIpv6(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult | null> {
    let text = (ctx.message?.text || '').trim();

    if (text.includes('/')) {
        text = text.split('/')[0] ?? '';
    }

    if (!isValidIPv6(text)) {
        await ctx.reply(
            '❌ 无效的 IPv6 地址\nInvalid IPv6 address',
            { reply_markup: { remove_keyboard: true } }
        );
        return { nextStep: 'post_local_ipv6', peerInfo };
    }

    peerInfo['Local-IPv6'] = text;

    // If IPv6 & IPv4 channel and not using ENH, need IPv4
    if (peerInfo.Channel === 'IPv6 & IPv4' && !peerInfo.ENH) {
        return await preIpv4(ctx, peerInfo);
    }

    return await preClearnet(ctx, peerInfo);
}

/**
 * Ask for DN42 IPv4 address (pre_ipv4)
 */
export async function preIpv4(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    const keyboard: { text: string }[][] = [];

    if (peerInfo.IPv4 && !['Not enabled', 'Not required (ENH)'].includes(peerInfo.IPv4)) {
        keyboard.push([{ text: peerInfo.IPv4 }]);
    }
    keyboard.push([{ text: 'None' }]);

    await ctx.reply(
        'Input your IPv4 address for BGP peering.\n' +
        '请输入你用于 BGP 对等的 IPv4 地址。\n\n' +
        'Supported ranges / 支持的范围:\n' +
        '• `172.20.0.0/14` (DN42)\n' +
        '• `10.127.0.0/16` (DN42)\n' +
        '• `44.0.0.0/8` (ARDC/AMPRNet)\n\n' +
        '输入 `None` 跳过 / Enter `None` to skip',
        {
            parse_mode: 'Markdown',
            reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: true }
        }
    );
    return { nextStep: 'post_ipv4', peerInfo };
}

/**
 * Validate and store DN42 IPv4 address (post_ipv4)
 */
export async function postIpv4(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult | null> {
    let text = (ctx.message?.text || '').trim();

    if (text.toLowerCase() === 'none') {
        peerInfo.IPv4 = 'Not enabled';
        return await preClearnet(ctx, peerInfo);
    }

    if (text.includes('/')) {
        text = text.split('/')[0] ?? '';
    }

    if (!isValidDN42IPv4(text)) {
        await ctx.reply(
            '❌ 无效的 DN42 IPv4 地址\nInvalid DN42 IPv4 address\n\n' +
            '支持的范围 / Valid ranges:\n' +
            '• `172.20.0.0/14` (DN42)\n' +
            '• `10.127.0.0/16` (DN42)\n' +
            '• `44.0.0.0/8` (ARDC/AMPRNet)',
            { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
        );
        return { nextStep: 'post_ipv4', peerInfo };
    }

    peerInfo.IPv4 = text;
    return await preLocalIpv4(ctx, peerInfo);
}

/**
 * Ask for our IPv4 address (pre_local_ipv4)
 */
export async function preLocalIpv4(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    // Suggest adjacent IP
    const peerIpv4 = peerInfo.IPv4 || '';
    let suggested = '';
    try {
        const parts = peerIpv4.split('.').map(Number);
        if (parts.length === 4 && parts.every(n => !isNaN(n))) {
            const lastOctet = parts?.[3] ?? 0;
            parts[3] = lastOctet % 2 === 0 ? lastOctet + 1 : lastOctet - 1;
            suggested = parts.join('.');
        }
    } catch {
        // Ignore
    }

    await ctx.reply(
        'Input our IPv4 address for BGP peering.\n请输入我方用于 BGP 对等的 IPv4 地址。',
        {
            parse_mode: 'Markdown',
            reply_markup: suggested
                ? { keyboard: [[{ text: suggested }]], resize_keyboard: true, one_time_keyboard: true }
                : { remove_keyboard: true }
        }
    );
    return { nextStep: 'post_local_ipv4', peerInfo };
}

/**
 * Validate and store our IPv4 address (post_local_ipv4)
 */
export async function postLocalIpv4(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult | null> {
    let text = (ctx.message?.text || '').trim();

    if (text.includes('/')) {
        text = text.split('/')[0] ?? '';
    }

    if (!isValidDN42IPv4(text)) {
        await ctx.reply(
            '❌ 无效的 DN42 IPv4 地址\nInvalid DN42 IPv4 address',
            { reply_markup: { remove_keyboard: true } }
        );
        return { nextStep: 'post_local_ipv4', peerInfo };
    }

    peerInfo['Local-IPv4'] = text;
    return await preClearnet(ctx, peerInfo);
}

/**
 * Ask for clearnet endpoint (pre_clearnet)
 */
export async function preClearnet(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    const keyboard: { text: string }[][] = [];

    if (peerInfo.Clearnet) {
        keyboard.push([{ text: peerInfo.Clearnet }]);
    }
    keyboard.push([{ text: 'None' }]);

    await ctx.reply(
        '请输入你用于 WireGuard 隧道的公网地址\n' +
        'Input your clearnet address for WireGuard tunnel\n\n' +
        '可以使用 IPv4 或 IPv6 建立隧道\n' +
        'You can use IPv4 or IPv6\n\n' +
        '如果没有公网地址或在 NAT 后，请输入 None\n' +
        'If no clearnet or behind NAT, enter None',
        {
            reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: true }
        }
    );
    return { nextStep: 'post_clearnet', peerInfo };
}

/**
 * Validate clearnet address (post_clearnet)
 */
export async function postClearnet(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult | null> {
    let text = (ctx.message?.text || '').trim();

    if (text.toLowerCase() === 'none') {
        peerInfo.Clearnet = null;
        peerInfo.Port = null;
        return await prePubkey(ctx, peerInfo);
    }

    // Check if port is included
    let detectedPort: number | undefined;

    // IPv6 with port: [2001:db8::1]:51820
    if (text.startsWith('[') && text.includes(']:')) {
        const bracketEnd = text.lastIndexOf(']');
        if (bracketEnd > 0 && text.length > bracketEnd + 2) {
            const portStr = text.substring(bracketEnd + 2);
            if (/^\d+$/.test(portStr)) {
                detectedPort = parseInt(portStr, 10);
                text = text.substring(1, bracketEnd);
            }
        }
    }
    // Only one colon = IPv4:port or domain:port
    else if (text.includes(':') && (text.match(/:/g) || []).length === 1) {
        const parts = text.split(':');
        if (parts.length === 2 && /^\d+$/.test(parts[1] || '')) {
            detectedPort = parseInt(parts[1] || '0', 10);
            text = parts[0] || '';
        }
    }

    // Resolve and validate
    const resolved = await resolveEndpoint(text);
    if (!resolved) {
        await ctx.reply(
            '❌ 无法解析或验证该地址\nCannot resolve or validate address\n\n' +
            '请检查地址是否正确，或重新输入',
            { reply_markup: { remove_keyboard: true } }
        );
        return { nextStep: 'post_clearnet', peerInfo };
    }

    // Check for China IP
    if (await isChinaIP(resolved)) {
        await ctx.reply(
            '⚠️ 检测到中国大陆 IP 地址\n' +
            'China Mainland IP detected - some nodes may not allow this\n\n' +
            '部分节点可能不允许中国 IP peer'
        );
    }

    peerInfo.Clearnet = text;

    if (detectedPort) {
        peerInfo.Port = detectedPort;
        return await prePubkey(ctx, peerInfo);
    }

    return await prePort(ctx, peerInfo);
}

/**
 * Ask for WireGuard port (pre_port)
 */
export async function prePort(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    const keyboard: { text: string }[][] = [];

    if (peerInfo.Port) {
        keyboard.push([{ text: String(peerInfo.Port) }]);
    }

    await ctx.reply(
        '请输入你用于 WireGuard 隧道的端口\nInput your port for WireGuard tunnel:',
        {
            reply_markup: keyboard.length > 0
                ? { keyboard, resize_keyboard: true }
                : { remove_keyboard: true }
        }
    );
    return { nextStep: 'post_port', peerInfo };
}

/**
 * Validate and store port (post_port)
 */
export async function postPort(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult | null> {
    const text = (ctx.message?.text || '').trim();
    const port = parseInt(text, 10);

    if (!isValidPort(port)) {
        await ctx.reply(
            '❌ 无效端口，请输入 1-65535 之间的数字',
            { reply_markup: { remove_keyboard: true } }
        );
        return { nextStep: 'post_port', peerInfo };
    }

    peerInfo.Port = port;
    return await preMtu(ctx, peerInfo);
}

/**
 * Ask for WireGuard MTU (pre_mtu)
 */
export async function preMtu(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    await ctx.reply(
        '请选择或输入 WireGuard MTU\n' +
        'Select or input WireGuard MTU\n\n' +
        '• `1420` - 默认值 / Default\n' +
        '• `1400` - 适用于某些 VPS / For some VPS\n' +
        '• `1380` - 如果有 VXLAN 等封装 / Extra encapsulation\n' +
        '• `1280` - IPv6 最小值 / IPv6 minimum',
        {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [
                    [{ text: '1420' }, { text: '1400' }],
                    [{ text: '1380' }, { text: '1280' }],
                ],
                resize_keyboard: true,
                one_time_keyboard: true,
            }
        }
    );
    return { nextStep: 'post_mtu', peerInfo };
}

/**
 * Validate and store MTU (post_mtu)
 */
export async function postMtu(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult | null> {
    const text = (ctx.message?.text || '').trim();
    const mtu = parseInt(text, 10);

    if (!isValidMTU(mtu)) {
        await ctx.reply(
            '❌ 无效 MTU，请输入 1280-1500 之间的数字\n' +
            'Invalid MTU, enter a number between 1280-1500',
            {
                reply_markup: {
                    keyboard: [
                        [{ text: '1420' }, { text: '1400' }],
                    ],
                    resize_keyboard: true,
                }
            }
        );
        return { nextStep: 'post_mtu', peerInfo };
    }

    peerInfo.MTU = mtu;
    return await prePubkey(ctx, peerInfo);
}

/**
 * Ask for WireGuard public key (pre_pubkey)
 */
export async function prePubkey(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    const keyboard: { text: string }[][] = [];

    if (peerInfo.PublicKey) {
        keyboard.push([{ text: peerInfo.PublicKey }]);
    }

    await ctx.reply(
        '请输入你的 WireGuard 公钥\nInput your WireGuard public key:',
        {
            reply_markup: keyboard.length > 0
                ? { keyboard, resize_keyboard: true, one_time_keyboard: true }
                : { remove_keyboard: true }
        }
    );
    return { nextStep: 'post_pubkey', peerInfo };
}

/**
 * Validate and store public key (post_pubkey)
 */
export async function postPubkey(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult | null> {
    const text = (ctx.message?.text || '').trim();

    if (!isValidWgPubkey(text)) {
        await ctx.reply(
            '❌ 无效的 WireGuard 公钥\nInvalid WireGuard public key\n\n' +
            '公钥应为 44 字符，以 = 结尾\n' +
            'Public key should be 44 characters ending with =',
            { reply_markup: { remove_keyboard: true } }
        );
        return { nextStep: 'post_pubkey', peerInfo };
    }

    peerInfo.PublicKey = text;
    return await prePsk(ctx, peerInfo);
}

/**
 * Ask for PSK preference (pre_psk)
 */
export async function prePsk(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    await ctx.reply(
        '是否使用 Pre-Shared Key (PSK) 增加安全性?\n' +
        'Use Pre-Shared Key (PSK) for extra security?\n\n' +
        '• 点击 `🔄 Auto Generate` 自动生成\n' +
        '• 点击 `❌ No PSK` 不使用\n' +
        '• 或直接输入你的 PSK (44字符 base64)',
        {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [
                    [{ text: '🔄 Auto Generate' }, { text: '❌ No PSK' }],
                ],
                resize_keyboard: true,
                one_time_keyboard: true,
            }
        }
    );
    return { nextStep: 'post_psk', peerInfo };
}

/**
 * Handle PSK selection (post_psk)
 */
export async function postPsk(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult | null> {
    const text = (ctx.message?.text || '').trim();

    // No PSK
    if (text === '❌ No PSK' || text.toLowerCase() === 'no') {
        peerInfo.PSK = null;
        return await preContact(ctx, peerInfo);
    }

    // Auto generate
    if (text === '🔄 Auto Generate' || text.toLowerCase() === 'yes' || text.toLowerCase() === 'auto') {
        // Generate random 32-byte key as base64
        const randomBytes = new Uint8Array(32);
        crypto.getRandomValues(randomBytes);
        const psk = btoa(String.fromCharCode(...randomBytes));

        peerInfo.PSK = psk;
        await ctx.reply(
            `🔑 PSK 已生成 / PSK Generated:\n\`${psk}\`\n\n⚠️ 请保存此密钥，稍后需要在你这边配置`,
            { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
        );
        return await preContact(ctx, peerInfo);
    }

    // User provided PSK - validate format
    if (text.length === 44 && text.endsWith('=')) {
        peerInfo.PSK = text;
        await ctx.reply(
            `🔑 PSK 已设置 / PSK Set:\n\`${text}\``,
            { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
        );
        return await preContact(ctx, peerInfo);
    }

    // Invalid PSK format
    await ctx.reply(
        '❌ 无效的 PSK 格式 / Invalid PSK format\n\n' +
        'PSK 应为 44 字符的 base64 字符串，以 `=` 结尾\n' +
        'PSK should be 44 char base64 string ending with `=`\n\n' +
        '请重新输入或选择其他选项:',
        {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [
                    [{ text: '🔄 Auto Generate' }, { text: '❌ No PSK' }],
                ],
                resize_keyboard: true,
            }
        }
    );
    return { nextStep: 'post_psk', peerInfo };
}

/**
 * Ask for contact information (pre_contact)
 */
export async function preContact(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    const suggestions: string[] = [];

    if (peerInfo.Contact) {
        suggestions.push(peerInfo.Contact);
    }

    // Could also fetch from DN42 registry here (future enhancement)

    const keyboard: { text: string }[][] = suggestions.slice(0, 4).map(s => [{ text: s }]);

    const asn = peerInfo.ASN || '';
    await ctx.reply(
        `请输入对方的联系方式 (AS${asn} 的 Telegram 或 Email)\n` +
        `Input peer's contact (Telegram or Email for AS${asn}):`,
        {
            reply_markup: keyboard.length > 0
                ? { keyboard, resize_keyboard: true, one_time_keyboard: true }
                : { remove_keyboard: true }
        }
    );
    return { nextStep: 'post_contact', peerInfo };
}

/**
 * Store contact information (post_contact)
 */
export async function postContact(ctx: BotContext, peerInfo: PeerInfo): Promise<StepResult> {
    const text = (ctx.message?.text || '').trim();

    if (!text) {
        await ctx.reply(
            '❌ 联系方式不能为空',
            { reply_markup: { remove_keyboard: true } }
        );
        return { nextStep: 'post_contact', peerInfo };
    }

    peerInfo.Contact = text;
    return { nextStep: 'pre_confirm', peerInfo };
}

// ============== Step Manager ==============

/**
 * Step function mapping
 */
export const STEP_FUNCTIONS: Record<string, (ctx: BotContext, peerInfo: PeerInfo) => Promise<StepResult | null>> = {
    'pre_region': preRegion,
    'post_region': postRegion,
    'pre_session_type': preSessionType,
    'post_session_type': postSessionType,
    'pre_mpbgp': preMpbgp,
    'post_mpbgp': postMpbgp,
    'pre_mpbgp_type': preMpbgpType,
    'post_mpbgp_type': postMpbgpType,
    'pre_enh': preEnh,
    'post_enh': postEnh,
    'pre_ipv6': preIpv6,
    'post_ipv6': postIpv6,
    'pre_request_linklocal': preRequestLinklocal,
    'post_request_linklocal': postRequestLinklocal,
    'pre_local_ipv6': preLocalIpv6,
    'post_local_ipv6': postLocalIpv6,
    'pre_ipv4': preIpv4,
    'post_ipv4': postIpv4,
    'pre_local_ipv4': preLocalIpv4,
    'post_local_ipv4': postLocalIpv4,
    'pre_clearnet': preClearnet,
    'post_clearnet': postClearnet,
    'pre_port': prePort,
    'post_port': postPort,
    'pre_mtu': preMtu,
    'post_mtu': postMtu,
    'pre_pubkey': prePubkey,
    'post_pubkey': postPubkey,
    'pre_psk': prePsk,
    'post_psk': postPsk,
    'pre_contact': preContact,
    'post_contact': postContact,
};

/**
 * Execute a step and return the next step
 */
export async function executeStep(
    ctx: BotContext,
    step: string,
    peerInfo: PeerInfo
): Promise<StepResult | null> {
    const stepFn = STEP_FUNCTIONS[step];
    if (!stepFn) {
        console.error(`[infoCollect] Unknown step: ${step}`);
        return null;
    }

    return await stepFn(ctx, peerInfo);
}
