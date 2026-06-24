/**
 * Maintenance Commands - Node maintenance mode management
 * 
 * /main - Show nodes with maintenance status and quick toggle buttons
 */

import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../index';
import config from '../config';
import { isAdmin } from '../guards';
import { getNodes, getNode, type RouterInfo } from '../providers/nodes';

/**
 * Call agent API
 */
async function agentRequest(node: RouterInfo, path: string, method = 'GET'): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> {
    try {
        const host = node.ipv4 || node.ipv6;
        if (!host) {
            return { success: false, error: 'No IP address' };
        }

        const url = `http://${host}:${config.agentPort}${path}`;
        const response = await fetch(url, {
            method,
            headers: {
                'Authorization': `Bearer ${config.agentToken}`,
                'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(3000),
        });

        if (!response.ok) {
            return { success: false, error: `HTTP ${response.status}` };
        }

        const data = await response.json() as Record<string, unknown>;
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export function registerMaintenanceCommands(bot: Bot<BotContext>) {
    /**
     * /main - Show maintenance control panel
     */
    bot.command('main', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.reply('❌ Admin access required.');
            return;
        }

        await showMaintenancePanel(ctx);
    });

    /**
     * Callback: Show node details
     */
    bot.callbackQuery(/^main:node:(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.answerCallbackQuery('❌ Admin only');
            return;
        }

        const nodeId = ctx.match[1];
        if (nodeId) {
            await showNodeStatus(ctx, nodeId);
        }
    });

    /**
     * Callback: Toggle maintenance mode
     */
    bot.callbackQuery(/^main:(start|stop):(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.answerCallbackQuery('❌ Admin only');
            return;
        }

        const action = ctx.match[1];
        const nodeId = ctx.match[2];

        if (!nodeId) {
            await ctx.answerCallbackQuery('❌ Invalid node');
            return;
        }

        await ctx.answerCallbackQuery(`⏳ ${action === 'start' ? 'Entering' : 'Exiting'} maintenance...`);

        const node = await getNode(nodeId);

        if (!node) {
            await ctx.editMessageText('❌ Node not found');
            return;
        }

        const result = await agentRequest(node, `/maintenance/${action}`, 'POST');

        if (result.success) {
            const icon = action === 'start' ? '🔧' : '✅';
            await ctx.editMessageText(
                `${icon} *${node.name}*\n\n` +
                `Maintenance mode / 维护模式: ${action === 'start' ? 'ON 🔴 开启' : 'OFF 🟢 关闭'}\n\n` +
                `${action === 'start' ? 'BGP sessions gracefully shutdown.\nBGP 会话已优雅关闭。' : 'Node back online.\n节点已恢复上线。'}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: new InlineKeyboard()
                        .text('🔄 Refresh', `main:node:${nodeId}`)
                        .text('◀️ Back', 'main:back')
                }
            );
        } else {
            await ctx.editMessageText(
                `❌ Failed to ${action} maintenance\n\nError: ${result.error}`,
                {
                    reply_markup: new InlineKeyboard()
                        .text('🔄 Retry', `main:${action}:${nodeId}`)
                        .text('◀️ Back', 'main:back')
                }
            );
        }
    });

    /**
     * Callback: Back to main panel
     */
    bot.callbackQuery('main:back', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.answerCallbackQuery('❌ Admin only');
            return;
        }

        await ctx.answerCallbackQuery();
        await showMaintenancePanel(ctx, ctx.msgId);
    });

    /**
     * Callback: Refresh panel
     */
    bot.callbackQuery('main:refresh', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.answerCallbackQuery('❌ Admin only');
            return;
        }

        await ctx.answerCallbackQuery('🔄 Refreshing...');
        await showMaintenancePanel(ctx, ctx.msgId);
    });
}

/**
 * Show maintenance control panel with all nodes
 */
async function showMaintenancePanel(ctx: BotContext, editMessageId?: number) {
    const nodesMap = await getNodes();
    const nodes = Array.from(nodesMap.values()).sort((a, b) => a.name.localeCompare(b.name));

    if (nodes.length === 0) {
        const msg = '❌ No nodes available';
        if (editMessageId) {
            await ctx.api.editMessageText(ctx.chat!.id, editMessageId, msg);
        } else {
            await ctx.reply(msg);
        }
        return;
    }

    // Get status for each node in parallel (to avoid webhook timeout)
    const nodeStatuses = await Promise.all(
        nodes.map(async (node) => {
            const result = await agentRequest(node, '/status');
            if (result.success && result.data) {
                return {
                    node,
                    online: result.data.status === 'ok',
                    maintenance: result.data.maintenance_mode === true,
                };
            } else {
                return {
                    node,
                    online: false,
                    maintenance: false,
                };
            }
        })
    );

    // Build message
    let message = '🔧 *Maintenance Control*\n维护模式控制\n\n';

    const keyboard = new InlineKeyboard();

    for (const status of nodeStatuses) {
        let icon: string;
        let statusText: string;

        if (!status.online) {
            icon = '⚫';
            statusText = 'Offline';
        } else if (status.maintenance) {
            icon = '🔴';
            statusText = 'Maintenance';
        } else {
            icon = '🟢';
            statusText = 'Online';
        }

        message += `${icon} *${status.node.name}* - ${statusText}\n`;
        message += `   📍 ${status.node.location || 'Unknown'}\n`;

        keyboard.text(`${icon} ${status.node.name}`, `main:node:${status.node.name}`);
        keyboard.row();
    }

    message += '\nClick a node to manage maintenance mode.';

    keyboard.text('🔄 Refresh', 'main:refresh');

    if (editMessageId) {
        try {
            await ctx.api.editMessageText(ctx.chat!.id, editMessageId, message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard,
            });
        } catch (error) {
            // Ignore "message is not modified" error
            if (!(error instanceof Error && error.message.includes('not modified'))) {
                throw error;
            }
        }
    } else {
        await ctx.reply(message, {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
        });
    }
}

/**
 * Show individual node status with toggle button
 */
async function showNodeStatus(ctx: BotContext, nodeId: string) {
    await ctx.answerCallbackQuery();

    const node = await getNode(nodeId);

    if (!node) {
        await ctx.editMessageText('❌ Node not found');
        return;
    }

    const result = await agentRequest(node, '/status');

    if (!result.success) {
        await ctx.editMessageText(
            `❌ *${node.name}* is offline\n\n` +
            `📍 ${node.location || 'Unknown'}\n` +
            `🌐 ${node.ipv4 || 'N/A'}\n\n` +
            `Error: ${result.error}`,
            {
                parse_mode: 'Markdown',
                reply_markup: new InlineKeyboard()
                    .text('🔄 Retry', `main:node:${nodeId}`)
                    .text('◀️ Back', 'main:back')
            }
        );
        return;
    }

    const isMaintenance = result.data?.maintenance_mode === true;
    const uptime = result.data?.uptime as number | undefined;
    const peerCount = result.data?.peer_count as number | undefined;

    let message = isMaintenance
        ? `🔴 *${node.name}* - Maintenance Mode 维护模式\n\n`
        : `🟢 *${node.name}* - Online 在线\n\n`;

    message += `📍 Location: ${node.location || 'Unknown'}\n`;
    message += `🌐 IP: ${node.ipv4 || 'N/A'}\n`;

    if (uptime !== undefined) {
        const hours = Math.floor(uptime / 3600);
        const mins = Math.floor((uptime % 3600) / 60);
        message += `⏱️ Uptime: ${hours}h ${mins}m\n`;
    }

    if (peerCount !== undefined) {
        message += `👥 Peers: ${peerCount}\n`;
    }

    message += '\n';

    const keyboard = new InlineKeyboard();

    if (isMaintenance) {
        message += '⚠️ BGP sessions are gracefully shutdown.\n⚠️ BGP 会话已优雅关闭。';
        keyboard.text('✅ Exit Maintenance 退出维护', `main:stop:${nodeId}`);
    } else {
        message += '✅ Node is accepting traffic.\n✅ 节点正在接受流量。';
        keyboard.text('🔧 Enter Maintenance 进入维护', `main:start:${nodeId}`);
    }

    keyboard.row();
    keyboard.text('🔄 Refresh', `main:node:${nodeId}`);
    keyboard.text('◀️ Back', 'main:back');

    await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
    });
}
