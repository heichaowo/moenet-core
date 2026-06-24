import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../index';
import config from '../config';
import { apiRequest } from '../api';
import { isAdmin } from '../guards';
import { normalizeAsn } from './peer/validators';


export function registerBlockCommands(bot: Bot<BotContext>) {
    /**
     * /block [asn] [reason] - Block an ASN or show blocklist
     */
    bot.command('block', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.reply('❌ Admin access required.');
            return;
        }

        const args = ctx.match?.trim().split(/\s+/) || [];

        if (!args[0]) {
            // No args — show blocklist
            await showBlocklist(ctx);
            return;
        }

        // Block new ASN
        const asnNumber = normalizeAsn(args[0]);
        if (isNaN(asnNumber)) {
            await ctx.reply('❌ Invalid ASN format.');
            return;
        }

        const reason = args.slice(1).join(' ') || undefined;

        try {
            const result = await apiRequest('/admin', 'POST', {
                action: 'blockAsn',
                asn: asnNumber,
                reason,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.reply(`❌ Error: ${result.message}`);
                return;
            }

            const reasonText = reason ? `\nReason: ${reason}` : '';
            await ctx.reply(
                `🚫 *AS${asnNumber} Blocked*\nASN 已加入黑名单${reasonText}`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('[Block] Error:', error);
            await ctx.reply('❌ Failed to block ASN.');
        }
    });

    /**
     * /blocked - Show blocklist (alias)
     */
    bot.command('blocked', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.reply('❌ Admin access required.');
            return;
        }
        await showBlocklist(ctx);
    });

    /**
     * /unblock <asn> - Unblock an ASN
     */
    bot.command('unblock', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.reply('❌ Admin access required.');
            return;
        }

        const asnStr = ctx.match?.trim();
        if (!asnStr) {
            await ctx.reply(
                '📋 *Usage 用法:*\n`/unblock <ASN>` — unblock an ASN\n\n' +
                'Or use /block to see the blocklist with inline unblock buttons.\n' +
                '或使用 /block 查看黑名单（带解封按钮）',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const asn = normalizeAsn(asnStr);
        if (isNaN(asn)) {
            await ctx.reply('❌ Invalid ASN format.');
            return;
        }

        try {
            const result = await apiRequest('/admin', 'POST', {
                action: 'unblockAsn',
                asn,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.reply(`❌ Error: ${result.message}`);
                return;
            }

            await ctx.reply(
                `✅ *AS${asn} Unblocked*\nASN 已从黑名单移除`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('[Unblock] Error:', error);
            await ctx.reply('❌ Failed to unblock ASN.');
        }
    });

    // Handle unblock button
    bot.callbackQuery(/^unblock:(\d+)$/, async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.answerCallbackQuery('❌ Admin only');
            return;
        }

        const asnStr = ctx.match?.[1];
        if (!asnStr) return;
        const asn = parseInt(asnStr, 10);

        try {
            const result = await apiRequest('/admin', 'POST', {
                action: 'unblockAsn',
                asn,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.answerCallbackQuery(`❌ ${result.message}`);
                return;
            }

            await ctx.answerCallbackQuery(`✅ AS${asn} Unblocked`);

            // Refresh list
            await showBlocklist(ctx, ctx.callbackQuery.message?.message_id);
        } catch (error) {
            console.error('[Unblock] Error:', error);
            await ctx.answerCallbackQuery('❌ Failed');
        }
    });

    // Handle refresh button
    bot.callbackQuery('blocklist:refresh', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.answerCallbackQuery('❌ Admin only');
            return;
        }

        await ctx.answerCallbackQuery('Refreshing...');
        await showBlocklist(ctx, ctx.callbackQuery.message?.message_id);
    });
}

/**
 * Show blocklist with unblock buttons
 */
async function showBlocklist(ctx: BotContext, editMessageId?: number) {
    try {
        const result = await apiRequest('/admin', 'POST', {
            action: 'enumBlocklist',
        }, config.apiToken);

        if (result.code !== 0) {
            const msg = `❌ Error: ${result.message}`;
            if (editMessageId) {
                await ctx.api.editMessageText(ctx.chat!.id, editMessageId, msg);
            } else {
                await ctx.reply(msg);
            }
            return;
        }

        const blocklist = result.data?.blocklist || [];

        if (blocklist.length === 0) {
            const msg = '✅ Blocklist is empty.\n黑名单为空';
            if (editMessageId) {
                await ctx.api.editMessageText(ctx.chat!.id, editMessageId, msg);
            } else {
                await ctx.reply(msg);
            }
            return;
        }

        let message = `🚫 *Blocklist (${blocklist.length})*\n黑名单\n\n`;

        const keyboard = new InlineKeyboard();

        blocklist.forEach((b: BlockedAsn, i: number) => {
            const reason = b.reason ? ` - ${b.reason}` : '';
            message += `${i + 1}. AS${b.asn}${reason}\n`;

            keyboard.text(`🔓 ${i + 1}`, `unblock:${b.asn}`);
            if ((i + 1) % 4 === 0) keyboard.row();
        });

        keyboard.row().text('🔄 Refresh', 'blocklist:refresh');

        message += '\n_Click 🔓 to unblock_';

        if (editMessageId) {
            await ctx.api.editMessageText(ctx.chat!.id, editMessageId, message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard,
            });
        } else {
            await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard });
        }
    } catch (error) {
        console.error('[Blocklist] Error:', error);
        const msg = '❌ Failed to fetch blocklist.';
        if (editMessageId) {
            await ctx.api.editMessageText(ctx.chat!.id, editMessageId, msg);
        } else {
            await ctx.reply(msg);
        }
    }
}

// Type definitions
interface ApiResponse {
    code: number;
    message: string;
    data?: {
        blocklist?: BlockedAsn[];
    };
}

interface BlockedAsn {
    asn: number;
    reason?: string;
    blockedAt?: string;
}
