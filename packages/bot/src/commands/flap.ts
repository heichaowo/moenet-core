/**
 * Flap Detection Bot Commands
 *
 * /flaps — View recent BGP flap events from Redis
 * Admin-only command.
 */

import type { Bot } from 'grammy';
import type { BotContext } from '../index';
import config from '../config';
import Redis from 'ioredis';

const REDIS_KEY = 'flap:events';
const MAX_DISPLAY = 10;

/**
 * Stored flap event format (matches API handler StoredFlapEvent)
 */
interface StoredFlapEvent {
    type: 'alert' | 'resolved';
    prefix: string;
    totalPathChanges: number;
    rateSec: number;
    firstSeen: number;
    durationMinutes: number | null;
    timestamp: number;
}

/**
 * Format a unix timestamp (ms) to a readable string
 */
function formatTime(timestampMs: number): string {
    const d = new Date(timestampMs);
    return d.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Register flap detection commands
 */
export function registerFlapCommands(bot: Bot<BotContext>) {
    bot.command('flaps', async (ctx) => {
        // Admin check
        const username = ctx.from?.username;
        if (!username || username !== config.adminUsername.replace('@', '')) {
            await ctx.reply('❌ This command is for admins only.\n此命令仅限管理员使用。');
            return;
        }

        let redis: Redis | null = null;
        try {
            redis = new Redis(config.redisUrl, {
                maxRetriesPerRequest: 1,
                connectTimeout: 3000,
            });

            // Get recent events (newest first)
            const rawEvents = await redis.zrevrange(REDIS_KEY, 0, MAX_DISPLAY - 1);

            if (!rawEvents || rawEvents.length === 0) {
                await ctx.reply(
                    '📊 *BGP Flap Events*\nBGP 路由震荡事件\n\n' +
                    'No recent flap events.\n暂无最近的震荡事件。',
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            const events: StoredFlapEvent[] = rawEvents
                .map((raw) => {
                    try {
                        return JSON.parse(raw) as StoredFlapEvent;
                    } catch {
                        return null;
                    }
                })
                .filter((e): e is StoredFlapEvent => e !== null);

            if (events.length === 0) {
                await ctx.reply(
                    '📊 *BGP Flap Events*\nBGP 路由震荡事件\n\n' +
                    'No valid events found.\n未找到有效事件。',
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            let msg = `📊 *BGP Flap Events* (${events.length})\nBGP 路由震荡事件\n\n`;

            for (const event of events) {
                const icon = event.type === 'alert' ? '⚠️' : '✅';
                const typeLabel = event.type === 'alert' ? 'ALERT' : 'RESOLVED';
                const time = formatTime(event.timestamp);
                const duration = event.durationMinutes !== null
                    ? ` | ⏱️ ${event.durationMinutes}min`
                    : '';

                msg += `${icon} \`${typeLabel}\` ${time}\n`;
                msg += `   📍 \`${event.prefix}\``;
                msg += ` | 📊 ${event.rateSec}/s | 🔢 ${event.totalPathChanges}${duration}\n\n`;
            }

            await ctx.reply(msg, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('[Flaps] Redis error:', error);
            await ctx.reply('❌ Failed to fetch flap events. Redis may be unavailable.\n获取震荡事件失败，Redis 可能不可用。');
        } finally {
            if (redis) {
                redis.disconnect();
            }
        }
    });
}
