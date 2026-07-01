/**
 * Peer Creation Flow Handlers
 *
 * Inline-keyboard callbacks for the peer creation wizard. Selection steps are
 * driven by these callbacks; free-text steps (IPv6 / endpoint / pubkey / manual
 * contact) are handled by the message:text switch in peer.ts, which calls the
 * ui.ts prompt functions to advance.
 */

import type { Bot } from 'grammy';
import type { BotContext } from '../../../index';
import {
    showServerWgInfo,
    promptSessionType,
    promptIpv6,
    promptUlaIpv6,
    promptEndpoint,
    promptPubkey,
    promptPsk,
    promptContact,
    showConfirmation,
} from '../ui';

export function registerCreationHandlers(bot: Bot<BotContext>) {
    // Continue from the server-WG-info screen → session type.
    bot.callbackQuery('peer:continue', async (ctx) => {
        if (!ctx.session.peerFlow) { await ctx.answerCallbackQuery('❌ Expired — run /peer again'); return; }
        await ctx.answerCallbackQuery();
        await promptSessionType(ctx);
    });

    // Session type selection.
    bot.callbackQuery('peer:stype:enh', async (ctx) => {
        const flow = ctx.session.peerFlow;
        if (!flow) { await ctx.answerCallbackQuery('❌ Expired — run /peer again'); return; }
        const asn = flow.isAdminMode ? (flow.targetAsn || 0) : (ctx.session.asn || 0);
        await ctx.answerCallbackQuery();
        ctx.session.peerFlow = { ...flow, sessionType: 'ipv6_only', step: 'input_ipv6' };
        await promptIpv6(ctx, `fe80::${asn % 10000}`);
    });
    bot.callbackQuery('peer:stype:ula', async (ctx) => {
        const flow = ctx.session.peerFlow;
        if (!flow) { await ctx.answerCallbackQuery('❌ Expired — run /peer again'); return; }
        await ctx.answerCallbackQuery();
        ctx.session.peerFlow = { ...flow, sessionType: 'ipv6_ipv4', step: 'input_peer_ipv6_ula' };
        await promptUlaIpv6(ctx);
    });

    /**
     * Node selection from InlineKeyboard (used by /addpeer command).
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

        const asn = flow.targetAsn || ctx.session.asn || 0;
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
        await showServerWgInfo(ctx);
    });

    /**
     * None endpoint (NAT) → public key step.
     */
    bot.callbackQuery('peer:endpoint:none', async (ctx) => {
        const flow = ctx.session.peerFlow;
        if (!flow) { await ctx.answerCallbackQuery('❌ Expired'); return; }
        ctx.session.peerFlow = { ...flow, endpoint: undefined, port: undefined, step: 'input_pubkey' };
        await ctx.answerCallbackQuery();
        await ctx.editMessageText('✅ Endpoint: None (NAT)');
        await promptPubkey(ctx);
    });

    /**
     * MTU selection → PSK step.
     */
    bot.callbackQuery(/^peer:mtu:(\d+)$/, async (ctx) => {
        const mtu = parseInt(ctx.match?.[1] || '1420', 10);
        const flow = ctx.session.peerFlow;
        if (!flow) { await ctx.answerCallbackQuery('❌ Expired'); return; }
        ctx.session.peerFlow = { ...flow, mtu, step: 'input_psk' };
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`✅ MTU: ${mtu}`);
        await promptPsk(ctx);
    });

    /**
     * PSK selection → contact step. (Previously jumped straight to confirm,
     * skipping the contact step — fixed.)
     */
    bot.callbackQuery(/^peer:psk:(auto|none)$/, async (ctx) => {
        const choice = ctx.match?.[1];
        const flow = ctx.session.peerFlow;
        if (!flow) { await ctx.answerCallbackQuery('❌ Expired'); return; }

        if (choice === 'auto') {
            const psk = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
            ctx.session.peerFlow = { ...flow, psk };
            await ctx.answerCallbackQuery();
            await ctx.editMessageText('✅ PSK Generated');
            await ctx.reply(
                `🔑 *PSK Generated*\n已生成 PSK\n\n` +
                `\`${psk}\`\n\n` +
                `⚠️ Save this key! You need to configure it on your side.\n` +
                `请保存此密钥，稍后需要在你这边配置。`,
                { parse_mode: 'Markdown' }
            );
        } else {
            ctx.session.peerFlow = { ...flow, psk: null };
            await ctx.answerCallbackQuery();
            await ctx.editMessageText('✅ No PSK');
        }

        await promptContact(ctx);
    });

    /**
     * Contact selection (from registry list) → confirm.
     */
    bot.callbackQuery(/^peer:ct:(\d+)$/, async (ctx) => {
        const flow = ctx.session.peerFlow;
        if (!flow?.contactOptions) { await ctx.answerCallbackQuery('❌ Expired'); return; }
        const contact = flow.contactOptions[Number(ctx.match[1])];
        if (!contact) { await ctx.answerCallbackQuery('❌ Invalid'); return; }
        await ctx.answerCallbackQuery();
        ctx.session.peerFlow = { ...flow, contact, step: 'confirm' };
        await ctx.editMessageText(`✅ Contact: \`${contact}\``, { parse_mode: 'Markdown' });
        await showConfirmation(ctx);
    });
    bot.callbackQuery('peer:ct:manual', async (ctx) => {
        const flow = ctx.session.peerFlow;
        if (!flow) { await ctx.answerCallbackQuery('❌ Expired'); return; }
        await ctx.answerCallbackQuery();
        ctx.session.peerFlow = { ...flow, step: 'input_contact_manual' };
        await ctx.editMessageText('✏️ Enter your contact (3–200 chars):\n请输入联系方式（3–200 字符）:');
    });
    bot.callbackQuery('peer:ct:skip', async (ctx) => {
        const flow = ctx.session.peerFlow;
        if (!flow) { await ctx.answerCallbackQuery('❌ Expired'); return; }
        await ctx.answerCallbackQuery();
        ctx.session.peerFlow = { ...flow, contact: undefined, step: 'confirm' };
        await ctx.editMessageText('⏩ Contact skipped');
        await showConfirmation(ctx);
    });
}
