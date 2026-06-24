import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../index';
import config from '../config';
import { getNodes, getAgentEndpoint } from '../providers/nodes';
import { normalizeAsn } from './peer/validators';

const ERROR_NOT_LOGGED_IN = '❌ Please /login first\n请先登录';

/**
 * Call agent API using getAgentEndpoint for node resolution
 */
async function callAgentApi(nodeId: string, method: string, path: string, body?: unknown): Promise<unknown> {
    const endpoint = await getAgentEndpoint(nodeId);
    if (!endpoint) return null;

    try {
        const response = await fetch(`${endpoint}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.agentToken || ''}`,
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(5000),
        });
        return response.json();
    } catch (error) {
        console.error(`[Agent] API call failed: ${error}`);
        return null;
    }
}

// Message templates
const COMMUNITY_STATS = `📊 *Community 统计* @ {node}

*延迟分布 Latency Distribution:*
\`\`\`
Tier 0 (<3ms):   {t0} routes
Tier 1 (<7ms):   {t1} routes
Tier 2 (<20ms):  {t2} routes
Tier 3 (<55ms):  {t3} routes
Tier 4+ (>55ms): {t4} routes
\`\`\`

*区域分布 Region Distribution:*
{regions}

总路由数 Total: {total}`;

const LATENCY_STATS = `📶 *AS{asn} 延迟探测 Latency Probe*

*当前 Current:*
    RTT: {rtt}ms (Tier {tier})
    目标 Target: {target}

*历史统计 History:*
    最小 Min: {min}ms
    平均 Avg: {avg}ms
    最大 Max: {max}ms
    样本 Samples: {samples}`;

const LATENCY_NO_DATA = `📶 *AS{asn} 延迟探测*

暂无探测数据。请等待自动探测或点击下方按钮。
No probe data yet. Wait for auto-probe or click below.`;

export function registerCommunityCommands(bot: Bot<BotContext>) {
    /**
     * /community - Show BGP community statistics
     */
    bot.command('community', async (ctx) => {
        if (!ctx.session.asn) {
            await ctx.reply(ERROR_NOT_LOGGED_IN);
            return;
        }

        // Get nodes from API provider
        const nodesMap = await getNodes();
        const nodeIds = Array.from(nodesMap.keys()).sort();
        if (nodeIds.length === 0) {
            await ctx.reply('❌ No nodes available for community stats.');
            return;
        }

        const nodeId = nodeIds[0]!;
        const nodeName = nodesMap.get(nodeId)?.location || nodeId;

        await ctx.reply(`📊 Fetching community stats from ${nodeName}...`);

        try {
            const stats = await callAgentApi(nodeId, 'GET', '/community') as CommunityStats | null;

            if (!stats) {
                await ctx.reply('❌ Failed to get community stats.\n无法获取 community 统计。');
                return;
            }

            const latency = stats.latency_distribution || {};
            const regions = stats.region_distribution || {};

            const regionsText = Object.entries(regions)
                .slice(0, 5)
                .map(([r, c]) => `    ${r}: ${c}`)
                .join('\n') || '    (无数据 No data)';

            const text = COMMUNITY_STATS
                .replace('{node}', nodeName)
                .replace('{t0}', String(latency[0] || 0))
                .replace('{t1}', String(latency[1] || 0))
                .replace('{t2}', String(latency[2] || 0))
                .replace('{t3}', String(latency[3] || 0))
                .replace('{t4}', String(Object.entries(latency)
                    .filter(([k]) => Number(k) >= 4)
                    .reduce((sum, [, v]) => sum + v, 0)))
                .replace('{regions}', regionsText)
                .replace('{total}', String(stats.total_routes || 0));

            // Node selection keyboard (sorted)
            const keyboard = new InlineKeyboard();
            nodeIds.forEach(n => {
                const name = nodesMap.get(n)?.location || n;
                keyboard.text(n === nodeId ? `✅ ${name}` : name, `community:${n}`);
            });

            await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
        } catch (error) {
            console.error('[Community] Error:', error);
            await ctx.reply(`❌ Error: ${(error as Error).message}`);
        }
    });

    // Handle node selection for community
    bot.callbackQuery(/^community:(.+)$/, async (ctx) => {
        const nodeId = ctx.match?.[1];
        if (!nodeId) return;

        const nodesMap = await getNodes();
        const nodeName = nodesMap.get(nodeId)?.location || nodeId;

        await ctx.answerCallbackQuery('Loading...');

        const stats = await callAgentApi(nodeId, 'GET', '/community') as CommunityStats | null;

        if (!stats) {
            await ctx.answerCallbackQuery('Failed to load stats');
            return;
        }

        const latency = stats.latency_distribution || {};
        const regions = stats.region_distribution || {};

        const regionsText = Object.entries(regions)
            .slice(0, 5)
            .map(([r, c]) => `    ${r}: ${c}`)
            .join('\n') || '    (无数据 No data)';

        const text = COMMUNITY_STATS
            .replace('{node}', nodeName)
            .replace('{t0}', String(latency[0] || 0))
            .replace('{t1}', String(latency[1] || 0))
            .replace('{t2}', String(latency[2] || 0))
            .replace('{t3}', String(latency[3] || 0))
            .replace('{t4}', String(Object.entries(latency)
                .filter(([k]) => Number(k) >= 4)
                .reduce((sum, [, v]) => sum + v, 0)))
            .replace('{regions}', regionsText)
            .replace('{total}', String(stats.total_routes || 0));

        const nodeIds = Array.from(nodesMap.keys()).sort();
        const keyboard = new InlineKeyboard();
        nodeIds.forEach(n => {
            const name = nodesMap.get(n)?.location || n;
            keyboard.text(n === nodeId ? `✅ ${name}` : name, `community:${n}`);
        });

        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    });

    /**
     * /latency [asn] - Show latency probe results
     */
    bot.command('latency', async (ctx) => {
        if (!ctx.session.asn) {
            await ctx.reply(ERROR_NOT_LOGGED_IN);
            return;
        }

        const asnRaw = ctx.match?.trim();
        const asn = asnRaw ? normalizeAsn(asnRaw) : ctx.session.asn;

        if (!asn || isNaN(asn)) {
            await ctx.reply('用法: /latency [ASN]\n例如: /latency 4242421234');
            return;
        }

        await showLatencyStats(ctx, asn);
    });

    // Handle probe now button
    bot.callbackQuery(/^probe_now:(\d+)$/, async (ctx) => {
        const asnStr = ctx.match?.[1];
        if (!asnStr) return;
        const asn = parseInt(asnStr);

        await ctx.answerCallbackQuery('Starting probe...');

        // Get first node from provider
        const nodesMap = await getNodes();
        const nodeIds = Array.from(nodesMap.keys()).sort();
        if (nodeIds.length === 0) {
            await ctx.answerCallbackQuery('No nodes available');
            return;
        }

        const firstNode = nodeIds[0]!;

        const result = await callAgentApi(firstNode, 'POST', '/probe/now', { asn }) as ProbeResult | null;

        if (result?.success) {
            await ctx.answerCallbackQuery(`✅ Probe: ${result.rtt_ms?.toFixed(1)}ms (Tier ${result.latency_tier})`);
            await showLatencyStats(ctx, asn);
        } else {
            await ctx.answerCallbackQuery(`❌ Probe failed: ${result?.error || 'Unknown error'}`);
        }
    });

    // Handle latency selection
    bot.callbackQuery(/^latency:(\d+)$/, async (ctx) => {
        const asnStr = ctx.match?.[1];
        if (!asnStr) return;
        const asn = parseInt(asnStr);
        await ctx.answerCallbackQuery();
        await showLatencyStats(ctx, asn);
    });
}

async function showLatencyStats(ctx: BotContext, asn: number) {
    const nodesMap = await getNodes();
    const nodeIds = Array.from(nodesMap.keys()).sort();
    if (nodeIds.length === 0) {
        await ctx.reply('❌ No nodes available.');
        return;
    }

    const firstNode = nodeIds[0]!;

    const stats = await callAgentApi(firstNode, 'POST', '/probe/stats', { asn }) as ProbeStats | null;

    const keyboard = new InlineKeyboard()
        .text('🔄 立即探测 Probe Now', `probe_now:${asn}`);

    let text: string;
    if (stats?.last_rtt) {
        text = LATENCY_STATS
            .replace('{asn}', String(asn))
            .replace('{rtt}', stats.last_rtt.toFixed(1))
            .replace('{tier}', String(stats.last_tier || 0))
            .replace('{target}', stats.endpoint || 'N/A')
            .replace('{min}', (stats.stats?.min_rtt || 0).toFixed(1))
            .replace('{avg}', (stats.stats?.avg_rtt || 0).toFixed(1))
            .replace('{max}', (stats.stats?.max_rtt || 0).toFixed(1))
            .replace('{samples}', String(stats.stats?.samples || 0));
    } else {
        text = LATENCY_NO_DATA.replace('{asn}', String(asn));
    }

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

// Type definitions
interface CommunityStats {
    latency_distribution: Record<number, number>;
    region_distribution: Record<string, number>;
    total_routes: number;
}

interface ProbeStats {
    last_rtt?: number;
    last_tier?: number;
    endpoint?: string;
    stats?: {
        min_rtt?: number;
        avg_rtt?: number;
        max_rtt?: number;
        samples?: number;
    };
}

interface ProbeResult {
    success: boolean;
    rtt_ms?: number;
    latency_tier?: number;
    error?: string;
}
