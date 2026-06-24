/**
 * Peer Creation Flow Handlers
 * 
 * Handles InlineKeyboard callbacks that supplement the primary ReplyKeyboard wizard flow.
 * The main wizard uses ReplyKeyboard (text handlers in peer.ts), while these callbacks
 * handle quick-select options and legacy compatibility.
 */

import type { Bot } from 'grammy';
import type { BotContext } from '../../../index';
import {
    promptEndpoint,
    promptPubkey,
    promptPsk,
    showConfirmation,
} from '../ui';

/**
 * Register creation flow InlineKeyboard callback handlers.
 * 
 * NOTE: Primary wizard flow uses ReplyKeyboard with text handlers in peer.ts.
 * These callbacks handle quick-select buttons and fallback compatibility.
 */
export function registerCreationHandlers(bot: Bot<BotContext>) {
    /**
     * Handle node selection from InlineKeyboard (used by /addpeer command)
     */
    bot.callbackQuery(/^peer:node:(.+)$/, async (ctx) => {
        const nodeName = ctx.match?.[1];
        const flow = ctx.session.peerFlow;
        if (!nodeName || !flow?.nodeMap) return;

        const nodeInfo = flow.nodeMap[nodeName];
        if (!nodeInfo) {
            await ctx.answerCallbackQuery({ text: 'Invalid node' });
            return;
        }

        // Get ASN from peerFlow.targetAsn (/addpeer) or ctx.session.asn (/peer)
        const asn = flow.targetAsn || ctx.session.asn || 0;
        // Calculate port based on ASN
        let userPort: number;
        if (asn >= 4242420000 && asn <= 4242429999) {
            userPort = 30000 + (asn % 10000);
        } else if (asn >= 4201270000 && asn <= 4201279999) {
            userPort = 40000 + (asn % 10000);
        } else {
            userPort = 50000 + (asn % 10000);
        }

        ctx.session.peerFlow = {
            ...flow,
            step: 'await_continue',
            routerName: nodeName,
            sessionUuid: nodeInfo.uuid,
            serverEndpoint: `${nodeName}.dn42.moenet.work`,
            serverPort: userPort,
            serverPubkey: nodeInfo.pubkey,
            serverLla: `fe80::998:${nodeInfo.regionCode}:${nodeInfo.nodeId}:1`,
        };

        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`✅ Selected: ${nodeName}`);

        // Import and call showServerWgInfo
        const { showServerWgInfo } = await import('../ui');
        await showServerWgInfo(ctx);
    });

    /**
     * Handle IPv6 quick select from InlineKeyboard suggestion button
     * (User can also type IPv6 directly, handled in peer.ts text handler)
     */
    bot.callbackQuery(/^peer:ipv6:(.+)$/, async (ctx) => {
        const ipv6 = ctx.match?.[1];
        if (!ipv6 || !ctx.session.peerFlow) return;

        ctx.session.peerFlow.ipv6 = ipv6;
        ctx.session.peerFlow.step = 'input_endpoint';

        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`✅ IPv6: \`${ipv6}\``, { parse_mode: 'Markdown' });
        await promptEndpoint(ctx);
    });

    /**
     * Handle None endpoint from legacy InlineKeyboard
     * (Primary handler is text matching "None (NAT)" in peer.ts)
     */
    bot.callbackQuery('peer:endpoint:none', async (ctx) => {
        if (!ctx.session.peerFlow) return;

        ctx.session.peerFlow.endpoint = undefined;
        ctx.session.peerFlow.port = undefined;
        ctx.session.peerFlow.step = 'input_pubkey';

        await ctx.answerCallbackQuery();
        await ctx.editMessageText('✅ Endpoint: None (NAT)');
        await promptPubkey(ctx);
    });

    /**
     * Handle MTU selection callback from legacy InlineKeyboard
     * (Primary handler is text matching in peer.ts input_mtu case)
     */
    bot.callbackQuery(/^peer:mtu:(\d+)$/, async (ctx) => {
        const mtu = parseInt(ctx.match?.[1] || '1420', 10);
        if (!ctx.session.peerFlow) return;

        ctx.session.peerFlow.mtu = mtu;
        ctx.session.peerFlow.step = 'input_psk';

        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`✅ MTU: ${mtu}`);
        await promptPsk(ctx);
    });

    /**
     * Handle PSK selection callback from legacy InlineKeyboard
     * (Primary handler is text matching in peer.ts input_psk case)
     */
    bot.callbackQuery(/^peer:psk:(auto|none)$/, async (ctx) => {
        const choice = ctx.match?.[1];
        if (!ctx.session.peerFlow) return;

        if (choice === 'auto') {
            const psk = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
            ctx.session.peerFlow.psk = psk;
            await ctx.answerCallbackQuery();
            await ctx.editMessageText(`✅ PSK Generated`);
            await ctx.reply(
                `🔑 *PSK Generated*\n已生成 PSK\n\n` +
                `\`${psk}\`\n\n` +
                `⚠️ Save this key! You need to configure it on your side.\n` +
                `请保存此密钥，稍后需要在你这边配置。`,
                { parse_mode: 'Markdown' }
            );
        } else {
            ctx.session.peerFlow.psk = null;
            await ctx.answerCallbackQuery();
            await ctx.editMessageText('✅ No PSK');
        }

        ctx.session.peerFlow.step = 'confirm';
        await showConfirmation(ctx);
    });
}
