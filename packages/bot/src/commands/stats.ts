/**
 * DN42 Bot — Statistics Commands
 *
 * Commands:
 *   /rank              — DN42 global ranking (from iedon MAP)
 *   /stats [asn]       — Network statistics or ASN info
 *   /peerlist [asn]    — Peer list (iedon global or MoeNet local)
 *
 * Data sources:
 *   - iedon MAP API (api.iedon.com/dn42) for DN42-wide data
 *   - MoeNet Core API for local network data
 */

import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../index';
import config from '../config';
import { apiRequest } from '../api';
import { getRanking, getAsnInfo, getNetworkStats } from '../services/iedonApi';
import type { RankingEntry } from '../services/iedonApi';
import { normalizeAsn, isAsnInput } from './peer/validators';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 10;
const LOCAL_ASN = config.localAsn;

// ---------------------------------------------------------------------------
// Ranking Helpers
// ---------------------------------------------------------------------------

function formatRankPage(ranking: RankingEntry[], page: number): string {
    const totalPages = Math.ceil(ranking.length / PAGE_SIZE);
    const start = (page - 1) * PAGE_SIZE;
    const items = ranking.slice(start, start + PAGE_SIZE);

    const lines: string[] = [];
    for (const item of items) {
        let medal = '';
        if (item.rank === 1) medal = '🥇 ';
        else if (item.rank === 2) medal = '🥈 ';
        else if (item.rank === 3) medal = '🥉 ';

        const name = item.name.length > 16 ? `${item.name.slice(0, 16)}…` : item.name;
        const highlight = item.asn === LOCAL_ASN ? ' ⭐' : '';
        lines.push(`${medal}\`${String(item.rank).padStart(3)}\` AS${item.asn} | ${name} | ${item.index}${highlight}`);
    }

    return (
        `🏆 *DN42 Global Ranking*\nDN42 全网排名\n\n` +
        `${lines.join('\n')}\n\n` +
        `_第 ${page}/${totalPages} 页 · 共 ${ranking.length} 个 AS_`
    );
}

function getPaginationKeyboard(page: number, total: number): InlineKeyboard {
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const keyboard = new InlineKeyboard();

    if (page > 1) {
        keyboard.text('⬅️', `rank:${page - 1}`);
    }
    keyboard.text(`${page}/${totalPages}`, 'noop');
    if (page < totalPages) {
        keyboard.text('➡️', `rank:${page + 1}`);
    }

    return keyboard;
}

// ---------------------------------------------------------------------------
// Command Registration
// ---------------------------------------------------------------------------

export function registerStatsCommands(bot: Bot<BotContext>) {
    /**
     * /rank — DN42 global ranking from iedon MAP
     */
    bot.command('rank', async (ctx) => {
        try {
            const ranking = await getRanking();

            if (ranking.length === 0) {
                await ctx.reply('❌ Failed to fetch DN42 ranking.\n无法获取 DN42 排名数据。');
                return;
            }

            const text = formatRankPage(ranking, 1);
            const keyboard = getPaginationKeyboard(1, ranking.length);

            await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
        } catch (error) {
            console.error('[Rank] Error:', error);
            await ctx.reply('❌ Failed to fetch rankings.\n获取排名失败。');
        }
    });

    // Handle ranking pagination
    bot.callbackQuery(/^rank:(\d+)$/, async (ctx) => {
        const pageStr = ctx.match?.[1];
        if (!pageStr) return;
        const page = Number.parseInt(pageStr, 10);

        try {
            const ranking = await getRanking();
            if (ranking.length === 0) {
                await ctx.answerCallbackQuery('Failed to load ranking');
                return;
            }

            const text = formatRankPage(ranking, page);
            const keyboard = getPaginationKeyboard(page, ranking.length);

            await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
            await ctx.answerCallbackQuery();
        } catch (error) {
            console.error('[Rank] Pagination error:', error);
            await ctx.answerCallbackQuery('Error loading page');
        }
    });

    // Swallow the noop callback from pagination "page/total" button
    bot.callbackQuery('noop', async (ctx) => {
        await ctx.answerCallbackQuery();
    });

    /**
     * /stats [asn] — Network statistics
     *
     * No arguments: DN42 global stats + MoeNet local stats
     * With ASN:     ASN info from iedon MAP
     */
    bot.command('stats', async (ctx) => {
        const arg = ctx.match?.trim();

        if (arg && isAsnInput(arg)) {
            // ASN-specific stats
            await showAsnStats(ctx, normalizeAsn(arg));
            return;
        }

        // Global + local stats
        try {
            const [dn42Stats, localResult] = await Promise.all([
                getNetworkStats(),
                apiRequest('/admin', 'POST', { action: 'getStats' }, config.apiToken),
            ]);

            let message = `📊 *DN42 Network Statistics*\nDN42 全网统计\n\n`;
            message += `🌐 *DN42 全网 (iedon MAP):*\n`;
            message += `    AS 总数: ${dn42Stats.totalAsns}\n`;
            message += `    链路数: ${dn42Stats.totalLinks}\n`;
            message += `    平均 Peer: ${dn42Stats.avgPeers}\n\n`;

            // Local MoeNet stats
            const local = localResult.data?.stats;
            if (local) {
                message += `🏠 *MoeNet 本地:*\n`;
                message += `    节点: ${local.totalNodes} (${local.activeNodes} active)\n`;
                message += `    Peers: ${local.activePeers} active / ${local.totalPeers} total\n`;
                message += `    待审: ${local.pendingPeers}\n\n`;
            } else {
                // Fallback: try enumRouters
                const routerResult = await apiRequest('/admin', 'POST', { action: 'enumRouters' }, config.apiToken);
                const routers = (routerResult.data?.routers ?? []) as Array<{ name: string; location: string; sessionCount: number; isOpen: boolean }>;
                const totalPeers = routers.reduce((sum: number, r) => sum + r.sessionCount, 0);
                const activeNodes = routers.filter((r) => r.isOpen).length;

                message += `🏠 *MoeNet 本地:*\n`;
                message += `    节点: ${routers.length} (${activeNodes} open)\n`;
                message += `    Peers: ${totalPeers}\n\n`;
            }

            message += `_${new Date().toISOString().slice(0, 19)}_`;

            await ctx.reply(message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('[Stats] Error:', error);
            await ctx.reply('❌ Failed to fetch statistics.\n获取统计信息失败。');
        }
    });

    /**
     * /peerlist [asn] — Peer list
     *
     * With ASN:  Show DN42 peers from iedon MAP
     * No args:   Show user's MoeNet peers (requires login)
     */
    bot.command('peerlist', async (ctx) => {
        const arg = ctx.match?.trim();

        if (arg && isAsnInput(arg)) {
            // DN42 global peer list from iedon
            await showIedonPeerList(ctx, normalizeAsn(arg));
            return;
        }

        // MoeNet local peer list (admin or user)
        const username = ctx.from?.username?.toLowerCase();
        const adminUsername = config.adminUsername?.toLowerCase().replace('@', '');
        const isAdmin = username === adminUsername || ctx.session.isAdmin === true;

        try {
            if (isAdmin) {
                const result = await apiRequest('/admin', 'POST', { action: 'enumSessions' }, config.apiToken);

                if (result.code !== 0) {
                    await ctx.reply(`❌ Error: ${result.message}`);
                    return;
                }

                const sessions = (result.data?.sessions ?? []).slice(0, 30);

                if (sessions.length === 0) {
                    await ctx.reply('📋 No peers in system.\n系统中没有 Peer');
                    return;
                }

                let message = `📋 *All Peers (Admin View)*\n所有 Peer（管理员视图）\n\n`;
                for (const s of sessions) {
                    const statusIcon = s.status === 1 ? '✅' : s.status === 3 ? '⏳' : '❌';
                    message += `${statusIcon} \`AS${s.asn}\` @ ${s.router}\n`;
                }
                message += `\n_共 ${sessions.length} 个 Peer_`;

                await ctx.reply(message, { parse_mode: 'Markdown' });
            } else {
                if (!ctx.session.asn) {
                    await ctx.reply('❌ Please /login first.\n请先登录');
                    return;
                }

                const result = await apiRequest('/session', 'POST', {
                    action: 'list',
                    asn: ctx.session.asn,
                });

                if (result.code !== 0) {
                    await ctx.reply(`❌ Error: ${result.message}`);
                    return;
                }

                const sessions = result.data?.sessions ?? [];

                if (sessions.length === 0) {
                    await ctx.reply('📋 You have no peers.\n你没有 Peer 连接');
                    return;
                }

                let message = `👥 *Your Peers (${sessions.length})*\n\n`;
                sessions.forEach((s: { status: number; router: string }, i: number) => {
                    const statusIcon = s.status === 1 ? '🟢' : s.status === 3 ? '⏳' : '🔴';
                    message += `${i + 1}. ${statusIcon} ${s.router}\n`;
                });

                await ctx.reply(message, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('[Peerlist] Error:', error);
            await ctx.reply('❌ Failed to fetch peer list.\n获取 Peer 列表失败。');
        }
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Show ASN-specific info from iedon MAP.
 */
async function showAsnStats(ctx: BotContext, asn: number) {
    try {
        const info = await getAsnInfo(asn);

        if (!info) {
            await ctx.reply(`❌ AS${asn} not found in DN42 MAP.\n在 DN42 MAP 中未找到 AS${asn}`);
            return;
        }

        const message =
            `📊 *AS${asn} Statistics*\n\n` +
            `📛 Name: ${info.name}\n` +
            `👥 Peers: ${info.peerCount}\n` +
            `📈 Centrality: ${info.centrality}\n` +
            `📍 Closeness: ${info.closeness}\n` +
            `🔗 Betweenness: ${info.betweenness}\n\n` +
            `_Source: iedon MAP_`;

        await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(`[Stats] ASN ${asn} error:`, error);
        await ctx.reply('❌ Failed to fetch ASN info.\n获取 ASN 信息失败。');
    }
}

/**
 * Show DN42-wide peer list for an ASN from iedon MAP.
 */
async function showIedonPeerList(ctx: BotContext, asn: number) {
    try {
        const info = await getAsnInfo(asn);

        if (!info || info.peers.length === 0) {
            await ctx.reply(`❌ No peer data for AS${asn}.\n未找到 AS${asn} 的 Peer 列表`);
            return;
        }

        const peers = info.peers.slice(0, 20);
        const peerList = peers.map((p) => `• \`AS${p}\``).join('\n');

        const message =
            `👥 *AS${asn} Peer List*\n` +
            `${info.name} — ${info.peerCount} peers\n\n` +
            `${peerList}\n\n` +
            (info.peers.length > 20 ? `_…and ${info.peers.length - 20} more_\n\n` : '') +
            `_Source: iedon MAP_`;

        await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(`[Peerlist] ASN ${asn} error:`, error);
        await ctx.reply('❌ Failed to fetch peer list.\n获取 Peer 列表失败。');
    }
}
