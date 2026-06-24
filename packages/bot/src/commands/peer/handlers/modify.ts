/**
 * Peer Modify Flow Handlers
 * 
 * Handles all callbacks for the peer modification flow.
 */

import type { Bot } from 'grammy';
import type { BotContext } from '../../../index';
import config from '../../../config';
import { apiRequest, submitModifyChanges } from '../api';

/**
 * Show modify menu helper type - will be passed from peer.ts
 */
type ShowModifyMenuFn = (ctx: BotContext, isFirstTime?: boolean) => Promise<void>;

/**
 * Register all modify flow callback handlers
 * Note: showModifyMenu is still passed because it's defined in peer.ts and complex to extract
 */
export function registerModifyHandlers(
    bot: Bot<BotContext>,
    showModifyMenu: ShowModifyMenuFn
) {
    /**
     * Handle info:status callback
     */
    bot.callbackQuery('info:status', async (ctx) => {
        await ctx.answerCallbackQuery('Use /status command');
        await ctx.reply('Use /status to check WG/BGP status\n使用 /status 查看状态');
    });

    /**
     * Handle info:modify callback
     */
    bot.callbackQuery('info:modify', async (ctx) => {
        await ctx.answerCallbackQuery('Use /modify command');
        await ctx.reply('Use /modify to modify a peer\n使用 /modify 修改 Peer');
    });

    /**
     * Handle modify cancel
     */
    bot.callbackQuery('modify:cancel', async (ctx) => {
        ctx.session.peerFlow = undefined;
        await ctx.answerCallbackQuery('Cancelled');
        await ctx.editMessageText('🚫 Modify cancelled.\n已取消修改');
    });

    /**
     * Handle modify submit - submit all pending modifications
     */
    bot.callbackQuery('modify:submit', async (ctx) => {
        const flow = ctx.session.peerFlow;

        if (!flow?.sessionUuid || !flow?.current || !flow?.backup) {
            ctx.session.peerFlow = undefined;
            await ctx.answerCallbackQuery('Error: No session data');
            await ctx.editMessageText('❌ Error: No session data');
            return;
        }

        await ctx.answerCallbackQuery('Submitting changes...');
        await ctx.editMessageText('⏳ Submitting changes...\n正在提交更改...');

        try {
            const result = await submitModifyChanges(flow);

            if (!result.success) {
                await ctx.reply(`❌ ${result.message}`, { reply_markup: { remove_keyboard: true } });
                ctx.session.peerFlow = undefined;
                return;
            }

            if (result.migrated) {
                await ctx.reply(
                    `✅ *Changes submitted & migration initiated!*\n` +
                    `修改已提交，迁移已启动！\n\n` +
                    `From: \`${flow.routerName}\` → To: \`${flow.pendingMigration!.nodeName}\`\n\n` +
                    `Peer will be automatically recreated on the new node.\n` +
                    `Peer 将在新节点上自动重建。\n\n` +
                    `⏳ Please wait a few minutes for changes to apply.\n` +
                    `请等待几分钟让更改生效。`,
                    { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
                );
            } else {
                await ctx.reply(
                    `✅ Modification submitted successfully!\n` +
                    `修改已成功提交！\n\n` +
                    `Node: \`${flow.routerName}\`\n` +
                    `Changes will be applied within a few minutes.\n` +
                    `更改将在几分钟内生效。`,
                    { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
                );
            }
        } catch (error) {
            console.error('[modify:submit] Error:', error);
            await ctx.reply(`❌ Failed to submit changes: ${error instanceof Error ? error.message : 'Unknown error'}`, { reply_markup: { remove_keyboard: true } });
        }

        ctx.session.peerFlow = undefined;
    });

    /**
     * Handle modify:back - dismiss the inline keyboard
     */
    bot.callbackQuery('modify:back', async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.deleteMessage();
    });

    /**
     * Handle PSK modify callbacks
     */
    bot.callbackQuery(/^modify:psk:(.+):(generate|disable)$/, async (ctx) => {
        const uuid = ctx.match?.[1];
        const action = ctx.match?.[2];
        if (!uuid || !action) return;

        await ctx.answerCallbackQuery('Updating PSK...');

        try {
            const pskValue = action === 'generate'
                ? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
                : null;

            const result = await apiRequest('/admin', 'POST', {
                action: 'updateSession',
                uuid,
                psk: pskValue,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.editMessageText(`❌ Failed: ${result.message}`);
                return;
            }

            // Update current state
            if (ctx.session.peerFlow?.current) {
                ctx.session.peerFlow.current.psk = pskValue !== null;
            }

            if (action === 'generate') {
                await ctx.editMessageText(
                    `✅ *PSK Generated*\nPSK 已生成\n\n` +
                    `\`${pskValue}\`\n\n` +
                    `⚠️ Save this key and configure it on your side.\n` +
                    `请保存此密钥并在你这边配置。`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                await ctx.editMessageText('✅ PSK disabled\nPSK 已禁用');
            }

            await showModifyMenu(ctx);
        } catch (error) {
            console.error('[Modify PSK] Error:', error);
            await ctx.editMessageText('❌ Update failed');
        }
    });

    /**
     * Handle session type modify callbacks
     */
    bot.callbackQuery(/^modify:sessionType:(.+):(.+)$/, async (ctx) => {
        const uuid = ctx.match?.[1];
        const newType = ctx.match?.[2];
        if (!uuid || !newType) return;

        await ctx.answerCallbackQuery('Updating session type...');

        try {
            // Map session type to extensions
            let extensions = '';
            switch (newType) {
                case 'mpbgp_enh':
                    extensions = 'mp_bgp,extended_nexthop';
                    break;
                case 'mpbgp':
                    extensions = 'mp_bgp';
                    break;
                case 'separate':
                    extensions = '';
                    break;
            }

            const result = await apiRequest('/admin', 'POST', {
                action: 'updateSession',
                uuid,
                extensions,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.editMessageText(`❌ Failed: ${result.message}`);
                return;
            }

            await ctx.editMessageText('✅ Session type updated\n会话类型已更新');
            await showModifyMenu(ctx);
        } catch (error) {
            console.error('[Modify SessionType] Error:', error);
            await ctx.editMessageText('❌ Update failed');
        }
    });

    /**
     * Handle MTU modify callbacks
     */
    bot.callbackQuery(/^modify:mtu:(.+):(\d+)$/, async (ctx) => {
        const uuid = ctx.match?.[1];
        const mtu = parseInt(ctx.match?.[2] || '1420', 10);
        if (!uuid) return;

        await ctx.answerCallbackQuery('Updating MTU...');

        try {
            const result = await apiRequest('/admin', 'POST', {
                action: 'updateSession',
                uuid,
                mtu,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.editMessageText(`❌ Failed: ${result.message}`);
                return;
            }

            // Update current state
            if (ctx.session.peerFlow?.current) {
                ctx.session.peerFlow.current.mtu = mtu;
            }

            await ctx.editMessageText(`✅ MTU updated to ${mtu}\nMTU 已更新为 ${mtu}`);
            await showModifyMenu(ctx);
        } catch (error) {
            console.error('[Modify MTU] Error:', error);
            await ctx.editMessageText('❌ Update failed');
        }
    });

    /**
     * Handle Region migration callbacks
     */
    bot.callbackQuery(/^modify:region:(.+):(.+)$/, async (ctx) => {
        const sessionUuid = ctx.match?.[1];
        const newNodeUuid = ctx.match?.[2];
        if (!sessionUuid || !newNodeUuid) return;

        await ctx.answerCallbackQuery('Migrating peer...');

        try {
            const result = await apiRequest('/admin', 'POST', {
                action: 'migrate',
                uuid: sessionUuid,
                newRouter: newNodeUuid,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.editMessageText(`❌ Migration failed: ${result.message}`);
                return;
            }

            await ctx.editMessageText(
                `✅ *Peer Migration Initiated*\nPeer 迁移已启动\n\n` +
                `Your peer will be recreated on the new node.\n` +
                `Peer 将在新节点上重建。\n\n` +
                `⚠️ Please wait a few minutes for changes to apply.\n` +
                `请等待几分钟让更改生效。`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('[Modify Region] Error:', error);
            await ctx.editMessageText('❌ Migration failed');
        }
    });
}
