/**
 * Peer Confirmation Flow Handlers
 * 
 * Handles peer:confirm and peer:cancel callbacks.
 */

import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../../../index';
import config from '../../../config';
import { apiRequest } from '../api';
import { buildApprovalCard } from '../approvalCard';

/**
 * Register confirmation flow callback handlers
 */
export function registerConfirmHandlers(bot: Bot<BotContext>) {
    /**
     * Handle confirm callback
     */
    bot.callbackQuery('peer:confirm', async (ctx) => {
        const flow = ctx.session.peerFlow;
        const asn = flow?.isAdminMode ? flow.targetAsn : ctx.session.asn;
        if (!flow || !asn) return;

        await ctx.answerCallbackQuery('Creating peer...');
        await ctx.editMessageText('⏳ Creating peer...\n正在创建 Peer...');

        try {
            const action = 'createSession';
            const result = await apiRequest('/admin', 'POST', {
                action,
                asn,
                router: flow.sessionUuid,
                ipv6: flow.ipv6,
                endpoint: flow.endpoint && flow.port ? `${flow.endpoint}:${flow.port}` : undefined,
                publicKey: flow.publicKey,
                mtu: flow.mtu || 1420,
                psk: flow.psk,
                contact: flow.contact || undefined,
                status: flow.isAdminMode ? 1 : undefined,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.reply(`❌ Failed to create peer: ${result.message}\n创建 Peer 失败: ${result.message}`);
                ctx.session.peerFlow = undefined;
                return;
            }

            const sessionUuid = result.data?.uuid || '';

            const statusText = flow.isAdminMode
                ? `✅ Status: ACTIVE (免审核 No approval needed)`
                : `⏳ Status: Pending Review\n等待管理员审核`;

            const successText =
                `🎉 *Peer Created Successfully!*\n成功创建 Peer!\n\n` +
                `📍 Node: \`${flow.routerName}\`\n` +
                `🆔 ASN: \`AS${asn}\`\n\n` +
                `*Your WireGuard Config:*\n` +
                `\`\`\`\n` +
                `[Peer]\n` +
                `PublicKey = ${flow.serverPubkey}\n` +
                `Endpoint = ${flow.serverEndpoint}:${flow.serverPort}\n` +
                `AllowedIPs = 172.20.0.0/14, 172.31.0.0/16, fd00::/8, fe80::/64\n` +
                `\`\`\`\n\n` +
                statusText;

            await ctx.reply(successText, { parse_mode: 'Markdown' });

            // Notify admin if not in admin mode (with retry for reliability)
            if (!flow.isAdminMode && config.adminChatId) {
                // Decision card: run the registry / IP-ownership / CN checks and
                // surface each so the admin has context, not just bare facts.
                const adminNotification = await buildApprovalCard({
                    asn,
                    routerName: flow.routerName,
                    nodeAllowCn: flow.allowCnPeers,
                    ipv6: flow.ipv6,
                    localIpv6: flow.localIpv6,
                    endpoint: flow.endpoint,
                    port: flow.port,
                    publicKey: flow.publicKey,
                    contact: flow.contact,
                    sessionType: flow.sessionType,
                });

                const keyboard = new InlineKeyboard()
                    .text('✅ Approve', `approve:${sessionUuid}`)
                    .text('❌ Reject', `reject:${sessionUuid}`)
                    .row()
                    .text('📋 All Pending', 'admin:pending');

                // Retry up to 3 times with backoff
                let notified = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        await ctx.api.sendMessage(config.adminChatId, adminNotification, {
                            parse_mode: 'Markdown',
                            reply_markup: keyboard,
                        });
                        notified = true;
                        break; // Success
                    } catch (e) {
                        console.error(`[Notify Admin] Attempt ${attempt}/3 failed:`, e);
                        if (attempt < 3) {
                            await new Promise(r => setTimeout(r, attempt * 2000));
                        }
                    }
                }
                if (!notified) {
                    console.error(`[Notify Admin] Gave up notifying admin about AS${asn} peer request after 3 attempts`);
                }
            } else if (!flow.isAdminMode) {
                console.warn(`[Notify Admin] New peer request from AS${asn} but TELEGRAM_ADMIN_CHAT_ID is not set — admin will NOT be notified.`);
            }

            ctx.session.peerFlow = undefined;
        } catch (error) {
            console.error('[Peer] Create error:', error);
            await ctx.reply('❌ Failed to create peer.\n创建 Peer 失败。');
            ctx.session.peerFlow = undefined;
        }
    });

    /**
     * Handle cancel callback
     */
    bot.callbackQuery('peer:cancel', async (ctx) => {
        ctx.session.peerFlow = undefined;
        await ctx.answerCallbackQuery('Cancelled');
        await ctx.editMessageText('🚫 Peer creation cancelled.\n已取消 Peer 创建');
    });
}
