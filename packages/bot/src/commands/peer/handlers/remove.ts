/**
 * Peer Remove Flow Handlers
 * 
 * Handles remove:select, remove:confirm, remove:cancel, and restart callbacks.
 */

import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../../../index';
import config from '../../../config';
import { apiRequest } from '../api';

/**
 * Register all remove flow callback handlers
 */
export function registerRemoveHandlers(bot: Bot<BotContext>) {
    /**
     * Handle remove selection — generate random code for safe deletion
     */
    bot.callbackQuery(/^remove:select:(.+)$/, async (ctx) => {
        const uuid = ctx.match?.[1];
        if (!uuid) return;

        await ctx.answerCallbackQuery();

        // Generate 4-char random hex confirmation code
        const bytes = new Uint8Array(2);
        crypto.getRandomValues(bytes);
        const removeCode = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

        // Set session step with code
        ctx.session.peerFlow = {
            step: 'remove_confirm',
            sessionUuid: uuid,
            removeCode,
        };

        const cancelKeyboard = new InlineKeyboard()
            .text('❌ Cancel 取消', 'remove:cancel');

        await ctx.editMessageText(
            `⚠️ *Confirm Deletion*\n确认删除\n\n` +
            `Are you sure you want to remove this peer?\n` +
            `确定要删除此 Peer 吗?\n\n` +
            `Session: \`${uuid.slice(0, 8)}...\`\n\n` +
            `⚠️ Type \`${removeCode}\` to confirm deletion.\n` +
            `请输入 \`${removeCode}\` 确认删除。`,
            { parse_mode: 'Markdown', reply_markup: cancelKeyboard }
        );
    });

    /**
     * Handle remove confirmation
     */
    bot.callbackQuery(/^remove:confirm:(.+)$/, async (ctx) => {
        const uuid = ctx.match?.[1];
        if (!uuid) return;

        await ctx.answerCallbackQuery('Removing...');

        try {
            const result = await apiRequest('/admin', 'POST', {
                action: 'deleteSession',
                uuid,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.editMessageText(`❌ Failed to remove: ${result.message}`);
            } else {
                await ctx.editMessageText('✅ Peer removed successfully!\n成功删除 Peer!');
            }
        } catch (error) {
            console.error('[Remove] Error:', error);
            await ctx.editMessageText('❌ Failed to remove peer.');
        }

        // Always clear flow state after processing
        ctx.session.peerFlow = undefined;
    });

    /**
     * Handle remove cancel
     */
    bot.callbackQuery('remove:cancel', async (ctx) => {
        await ctx.answerCallbackQuery('Cancelled');
        await ctx.editMessageText('🚫 Remove cancelled.\n已取消删除');
    });

    /**
     * Handle restart callback
     */
    bot.callbackQuery(/^restart:(\d+):([^:]+):(.+)$/, async (ctx) => {
        const asn = parseInt(ctx.match?.[1] || '0', 10);
        const router = ctx.match?.[2];
        const uuid = ctx.match?.[3];
        if (!asn || !router || !uuid) return;

        await ctx.answerCallbackQuery('Restarting...');
        await ctx.editMessageText('⏳ Restarting WireGuard and BGP...\n正在重启 WireGuard 和 BGP...');

        try {
            const { getAgentEndpoint } = await import('../../../providers/nodes');
            const endpoint = await getAgentEndpoint(router);

            if (!endpoint) {
                await ctx.reply(`❌ Cannot reach agent for ${router}`);
                return;
            }

            const peerName = `dn42_${asn}`;
            const response = await fetch(`${endpoint}/restart`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.agentToken || ''}`,
                },
                body: JSON.stringify({ peer_name: peerName }),
            });

            if (response.ok) {
                await ctx.reply(
                    `✅ *Restart Complete*\n重启完成\n\n` +
                    `📍 Node: \`${router}\`\n` +
                    `🆔 ASN: \`AS${asn}\`\n\n` +
                    `WireGuard and BGP have been restarted.\n` +
                    `WireGuard 和 BGP 已重启。`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                const error = await response.text();
                await ctx.reply(`❌ Restart failed: ${error}`);
            }
        } catch (error) {
            console.error('[Restart] Error:', error);
            await ctx.reply('❌ Restart failed.');
        }
    });
}
