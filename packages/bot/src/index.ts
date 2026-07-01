import { Bot, Context, session, type SessionFlavor, webhookCallback } from 'grammy';
import { Hono } from 'hono';
import { registerCommands } from './commands';
import config from './config';
import { rateLimitMiddleware, metricsMiddleware, autoRegisterMiddleware, usernameCacheMiddleware, getMetricsSummary } from './middleware';
import { createRedisStorage } from './storage';

/**
 * Session data for user state
 */
interface SessionData {
    asn?: number;
    person?: string;
    isAdmin?: boolean;
    awaitingAsn?: boolean;
    peerFlow?: {
        step: string;
        isAdminMode?: boolean;
        targetAsn?: number;
        routerName?: string;
        sessionUuid?: string;
        serverEndpoint?: string;
        serverPort?: number;
        serverPubkey?: string;
        serverLla?: string;
        sessionType?: 'ipv6_only' | 'ipv6_ipv4';
        ipv6?: string;
        localIpv6?: string;
        ipv4?: string;
        localIpv4?: string;
        endpoint?: string;
        port?: number;
        publicKey?: string;
        mtu?: number;
        psk?: string | null;
        contact?: string;
        nodeMap?: Record<string, { uuid: string; endpoint: string; pubkey: string; nodeId: number; regionCode: number; name?: string; allowCnPeers?: boolean }>;
        // For modify flow - diff tracking (dn42-bot style)
        asn?: number;
        // Per-node China IP restriction (from selected router)
        allowCnPeers?: boolean;
        // Random hex code for /remove confirmation
        removeCode?: string;
        // Pending migration (deferred until confirm)
        pendingMigration?: { nodeUuid: string; nodeName: string };
        backup?: {
            endpoint: string;
            port: string;
            ipv6: string;
            ipv4: string;
            localIpv6: string;
            localIpv4: string;
            pubkey: string;
            psk: boolean;
            mtu: number;
            mpbgp: boolean;
            extendedNexthop: boolean;
            contact: string;
        };
        current?: {
            endpoint: string;
            port: string;
            ipv6: string;
            ipv4: string;
            localIpv6: string;
            localIpv4: string;
            pubkey: string;
            psk: boolean;
            mtu: number;
            mpbgp: boolean;
            extendedNexthop: boolean;
            contact: string;
        };
    };
    nodeWizard?: {
        step: 'name' | 'hostname' | 'ipv4' | 'ipv6' | 'role' | 'region' | 'location' | 'provider' | 'bandwidth' | 'max_peers' | 'allow_cn' | 'confirm';
        data: Record<string, unknown>;
    };
    /** Awaiting a text value for an admin edit of a node field (via /node). */
    nodeEdit?: {
        name: string;
        field: 'location' | 'provider' | 'maxPeers';
    };
    /** Awaiting a typed value for a /modify field (inline flow, immediate submit). */
    modifyInput?: {
        uuid: string;
        field: 'endpoint' | 'pubkey' | 'contact' | 'peerIpv6' | 'peerIpv4' | 'localIpv6' | 'localIpv4';
    };
    /** Announce flow: message + router UUID order for bitmask */
    announceFlow?: {
        message?: string;
        routerUuids: string[];
        routerNames: string[];
        /** Router UUIDs selected for targeted announce. Empty = all. */
        selectedRouters?: string[];
        /** Cached target user count for menu display */
        targetCount?: { tg: number; email: number; both: number; total: number };
        /** Failed delivery results for retry */
        failedResults?: Array<{
            asn: number;
            tg: "sent" | "failed" | "no_channel";
            email: "sent" | "failed" | "no_channel";
            telegramId?: number;
            emailAddr?: string;
        }>;
        /** Awaiting message text input */
        awaitingMessage?: boolean;
    };
    /** Migrate flow: router list + selected source/target indices.
     *  UUIDs are kept here (not in callback_data) because two 36-char UUIDs
     *  exceed Telegram's 64-byte callback_data limit. */
    migrateFlow?: {
        routers: Array<{ uuid: string; name: string; region?: string }>;
        fromIdx?: number;
        toIdx?: number;
    };
    /** Notify flow: message + ASN targets for inline keyboard interaction */
    notifyFlow?: {
        message?: string;
        asns?: number[];
        /** Awaiting message text input */
        awaitingMessage?: boolean;
        /** Awaiting ASN text input */
        awaitingAsns?: boolean;
    };
    /** Admin /info: awaiting ASN input */
    awaitingInfoAsn?: boolean;
    /** Set to true after telegramId has been registered to DB for this session */
    _registered?: boolean;
}

export type BotContext = Context & SessionFlavor<SessionData>;

/**
 * Create and configure the Telegram bot
 */
export function createBot(): Bot<BotContext> {
    const bot = new Bot<BotContext>(config.telegramToken);

    // Session middleware - use Redis if available, else in-memory
    const redisStorage = createRedisStorage<SessionData>();
    bot.use(session({
        initial: (): SessionData => ({}),
        storage: redisStorage || undefined,
    }));

    // Rate limiting middleware
    bot.use(rateLimitMiddleware());

    // Cache username→id mapping for notification resolution
    bot.use(usernameCacheMiddleware());

    // Auto-register middleware — backfills (asn, telegramId) for existing users
    bot.use(autoRegisterMiddleware(config.apiUrl, config.apiToken));

    // Metrics collection middleware
    bot.use(metricsMiddleware());

    // Error handler
    bot.catch((err) => {
        console.error('[Bot] Error:', err);
    });

    registerCommands(bot);
    return bot;
}

/**
 * Set bot commands menu
 */
async function setBotCommands(bot: Bot<BotContext>) {
    // Public commands visible to all users
    await bot.api.setMyCommands([
        { command: 'start', description: 'Start / Help 开始' },
        { command: 'help', description: 'Show commands 帮助' },
        { command: 'login', description: 'Login with ASN 登录' },
        { command: 'logout', description: 'Logout 登出' },
        { command: 'whoami', description: 'Show current session 当前登录' },
        { command: 'peer', description: 'My peers / manage 我的连接' },
        { command: 'peers', description: 'List peers 连接列表' },
        { command: 'node', description: 'Nodes 节点列表' },
        { command: 'info', description: 'Peer status 连接状态' },
        { command: 'modify', description: 'Modify peer 修改连接' },
        { command: 'remove', description: 'Remove peer 删除连接' },
        { command: 'status', description: 'WG/BGP status 状态' },
        { command: 'restart', description: 'Restart peer 重启连接' },
        { command: 'ping', description: 'Ping test 网络测试' },
        { command: 'tcping', description: 'TCP ping test TCP测试' },
        { command: 'trace', description: 'Traceroute 路由追踪' },
        { command: 'route', description: 'Route lookup 路由查询' },
        { command: 'lg', description: 'Looking glass 路由镜像' },
        { command: 'path', description: 'AS path query AS路径' },
        { command: 'whois', description: 'WHOIS lookup 信息查询' },
        { command: 'dig', description: 'DNS lookup DNS查询' },
        { command: 'findnoc', description: 'Find NOC contacts 查联系' },
        { command: 'community', description: 'BGP communities 社区标记' },
        { command: 'latency', description: 'Latency probe 延迟探测' },
        { command: 'flaps', description: 'Route flap history 路由抖动' },
        { command: 'stats', description: 'Network stats 网络统计' },
        { command: 'rank', description: 'Peer rankings 排行榜' },
        { command: 'peerlist', description: 'All peers list 全部用户' },
        { command: 'cancel', description: 'Cancel operation 取消操作' },
    ]);

    // Admin-only commands (visible only in admin chat)
    if (config.adminChatId) {
        await bot.api.setMyCommands([
            { command: 'pending', description: 'Pending reviews 待审核' },
            { command: 'sessions', description: 'All sessions 所有会话' },
            { command: 'addpeer', description: 'Admin add peer 管理加连接' },
            { command: 'migrate', description: 'Bulk migrate 批量迁移' },
            { command: 'announce', description: 'Broadcast message 全员公告' },
            { command: 'notify', description: 'Notify users 定向通知' },
            { command: 'block', description: 'Block ASN 封禁' },
            { command: 'unblock', description: 'Unblock ASN 解封' },
        ], { scope: { type: 'chat', chat_id: Number(config.adminChatId) } });
    }
}

/**
 * Main entry point
 */
async function main() {
    if (!config.telegramToken) {
        console.error('❌ TELEGRAM_BOT_TOKEN not configured');
        process.exit(1);
    }

    if (!config.webhookDomain) {
        console.error('❌ WEBHOOK_DOMAIN not configured');
        process.exit(1);
    }

    const bot = createBot();
    await setBotCommands(bot);

    const port = config.webhookPort;
    // Use a hash of the token for the webhook path to avoid exposing the raw token in access logs
    const { createHash } = await import('crypto');
    const webhookPath = `/webhook/${createHash('sha256').update(config.telegramToken).digest('hex').slice(0, 16)}`;
    const webhookUrl = `https://${config.webhookDomain}${webhookPath}`;

    // Create Hono app for webhook and metrics
    const app = new Hono();

    // Health check endpoint
    app.get('/health', (c) => c.json({ status: 'ok' }));

    // Metrics endpoint
    app.get('/metrics', (c) => c.json(getMetricsSummary()));

    // Webhook endpoint
    const handleUpdate = webhookCallback(bot, 'hono', {
        secretToken: config.webhookSecret,
    });
    app.post(webhookPath, handleUpdate);

    // Set webhook
    await bot.api.setWebhook(webhookUrl, {
        secret_token: config.webhookSecret,
        drop_pending_updates: true,
    });

    console.log(`🤖 MoeNet DN42 Bot (Webhook)`);
    console.log(`🔗 Webhook: ${webhookUrl}`);
    console.log(`📊 Metrics: http://localhost:${port}/metrics`);
    console.log(`🚀 Starting server on port ${port}...`);

    Bun.serve({
        port,
        fetch: app.fetch,
    });

    console.log(`✅ Bot running on port ${port}`);

    // Check for unprocessed pending requests after startup
    await notifyPendingOnStartup(bot);

    // Start periodic migration notification checker
    startMigrationNotifyChecker(bot);
}

/**
 * On startup, check for pending peer requests that may have been missed
 * (e.g. during Telegram outage or bot restart) and notify admin.
 */
async function notifyPendingOnStartup(bot: Bot<BotContext>) {
    if (!config.adminChatId || !config.apiUrl) return;

    try {
        const { apiRequest } = await import('./commands/peer/api');
        const result = await apiRequest('/admin', 'POST', {
            action: 'enumSessions',
            status: 3, // PENDING_REVIEW
        }, config.apiToken);

        const sessions = result.data?.sessions || [];
        if (sessions.length === 0) return;

        const { InlineKeyboard } = await import('grammy');

        let message = `🔔 *Startup: ${sessions.length} pending request(s)*\n` +
            `启动检查: 有 ${sessions.length} 个待审核请求\n\n`;

        const keyboard = new InlineKeyboard();

        for (const s of sessions.slice(0, 10)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const session = s as any;
            message += `• AS${session.asn} → ${session.routerName || session.router}\n`;
            keyboard
                .text(`✅ AS${session.asn}`, `approve:${session.uuid}`)
                .text(`❌`, `reject:${session.uuid}`)
                .row();
        }

        if (sessions.length > 10) {
            message += `\n...and ${sessions.length - 10} more`;
        }

        keyboard.text('📋 All Pending', 'admin:pending');

        await bot.api.sendMessage(config.adminChatId, message, {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
        });

        console.log(`[Startup] Notified admin about ${sessions.length} pending request(s)`);
    } catch (error) {
        console.error('[Startup] Failed to check pending requests:', error);
    }
}

/**
 * Periodically check for migrated sessions that have reached ENABLED status
 * and send notifications to affected users.
 */
function startMigrationNotifyChecker(bot: Bot<BotContext>) {
    if (!config.apiUrl) return;

    const CHECK_INTERVAL = 60_000; // 60 seconds

    const intervalId = setInterval(async () => {
        try {
            const { apiRequest } = await import('./commands/peer/api');

            const result = await apiRequest('/admin', 'POST', {
                action: 'checkMigrationNotify',
            }, config.apiToken);

            if (result.code !== 0) return;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const data = result.data as any;
            const ready = (data?.ready || []) as Array<{
                asn: number;
                fromRouter: string;
                toRouter: string;
                adminChatId?: number;
                serverEndpoint: string | null;
                attempts: number;
            }>;

            if (ready.length === 0) return;

            // Resolve ASNs to delivery channels (Telegram + email).
            const asns = ready.map(r => r.asn);
            const targetsResult = await apiRequest('/admin', 'POST', {
                action: 'getNotificationTargets',
                asns,
            }, config.apiToken);

            if (targetsResult.code !== 0) return;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const targets = ((targetsResult.data as any)?.targets || []) as Array<{ asn: number; telegramId?: number; emails?: string[] }>;
            const targetMap = new Map(targets.map(t => [t.asn, t]));

            const MAX_ATTEMPTS = 5;
            // Terminal outcomes only (delivered / gave-up / no-channel) are reported
            // and acked; transient failures under the retry cap stay queued and are
            // retried on the next tick (checkMigrationNotify no longer consumes on
            // read). This is the fix for silently-lost notifications.
            type Status = 'tg' | 'email' | 'no_channel' | 'gaveup';
            const terminal: Array<{ asn: number; status: Status; error?: string }> = [];
            const ackAsns: number[] = [];
            let retrying = 0;

            for (const item of ready) {
                const target = targetMap.get(item.asn);
                const hasChannel = !!(target?.telegramId || target?.emails?.length);
                let delivered: 'tg' | 'email' | null = null;
                let error: string | undefined;

                // 1. Telegram (primary)
                if (target?.telegramId) {
                    const endpointLine = item.serverEndpoint
                        ? `🖥️ New Endpoint 新地址: \`${item.serverEndpoint}\`\n`
                        : '';
                    const message =
                        `🔄 *Peer Migration Complete*\nPeer 迁移完成\n\n` +
                        `Your peer \`AS${item.asn}\` has been successfully migrated:\n` +
                        `您的 Peer \`AS${item.asn}\` 已成功迁移:\n\n` +
                        `📍 From 原节点: \`${item.fromRouter}\`\n` +
                        `📍 To 新节点: \`${item.toRouter}\`\n` +
                        `${endpointLine}\n` +
                        `⚠️ *Action Required 需要操作:*\n` +
                        `Please update your WireGuard Endpoint.\n请更新 WireGuard Endpoint。\n` +
                        `Use \`/info\` to view your full config.\n使用 \`/info\` 查看完整配置。`;
                    try {
                        await bot.api.sendMessage(target.telegramId, message, { parse_mode: 'Markdown' });
                        delivered = 'tg';
                    } catch (e) {
                        error = e instanceof Error ? e.message : String(e);
                        console.error(`[MigrateNotify] TG send failed AS${item.asn}:`, e);
                    }
                }

                // 2. Email (fallback when no TG or TG failed)
                if (!delivered && target?.emails?.length) {
                    try {
                        const er = await apiRequest('/admin', 'POST', {
                            action: 'sendMigrationEmail',
                            email: target.emails[0],
                            asn: item.asn,
                            fromRouter: item.fromRouter,
                            toRouter: item.toRouter,
                            serverEndpoint: item.serverEndpoint,
                        }, config.apiToken);
                        if (er.code === 0) delivered = 'email';
                        else error = er.message || 'email send failed';
                    } catch (e) {
                        error = e instanceof Error ? e.message : String(e);
                    }
                }

                // 3. Classify and decide whether to ack (consume) the queue entry.
                if (delivered) {
                    terminal.push({ asn: item.asn, status: delivered });
                    ackAsns.push(item.asn);
                } else if (!hasChannel) {
                    terminal.push({ asn: item.asn, status: 'no_channel' });
                    ackAsns.push(item.asn); // can never deliver — give up
                } else if (item.attempts >= MAX_ATTEMPTS) {
                    terminal.push({ asn: item.asn, status: 'gaveup', error });
                    ackAsns.push(item.asn);
                } else {
                    retrying++; // leave queued for next tick
                }
            }

            // Consume the finished entries (two-phase: ack only what's done).
            if (ackAsns.length > 0) {
                await apiRequest('/admin', 'POST', { action: 'ackMigrationNotify', asns: ackAsns }, config.apiToken);
            }
            console.log(`[MigrateNotify] terminal=${terminal.length} (acked ${ackAsns.length}), retrying=${retrying}`);

            // Report only terminal outcomes — retrying items stay quiet until they
            // resolve, so the admin isn't spammed every 60s.
            const adminChatId = ready[0]?.adminChatId || config.adminChatId;
            if (adminChatId && terminal.length > 0) {
                const list = (s: Status) => terminal.filter(o => o.status === s).map(o => `\`AS${o.asn}\``).join(' ');
                const tg = terminal.filter(o => o.status === 'tg');
                const em = terminal.filter(o => o.status === 'email');
                const nc = terminal.filter(o => o.status === 'no_channel');
                const gu = terminal.filter(o => o.status === 'gaveup');

                let summary =
                    `📬 *Migration Notifications 迁移通知结果*\n\n` +
                    `✅ TG: *${tg.length}*  ·  📧 Email: *${em.length}*  ·  ⚠️ No channel: *${nc.length}*  ·  ❌ Gave up: *${gu.length}*\n`;
                if (tg.length) summary += `\n✅ Telegram: ${list('tg')}\n`;
                if (em.length) summary += `\n📧 Email fallback 邮件: ${list('email')}\n`;
                if (nc.length) summary += `\n⚠️ *No channel (no TG & no email) 无渠道:*\n${list('no_channel')}\n`;
                if (gu.length) {
                    summary += `\n❌ *Gave up after ${MAX_ATTEMPTS} tries 放弃:*\n`;
                    for (const o of gu) summary += `   • \`AS${o.asn}\`: \`${(o.error || 'unknown').replace(/`/g, "'")}\`\n`;
                }
                if (retrying > 0) summary += `\n🔁 _${retrying} still retrying…_\n`;
                if (nc.length || gu.length) {
                    summary += `\n⚠️ _Above users were NOT reached — follow up manually via /notify._\n` +
                        `_以上用户未送达，请用 /notify 手动跟进。_`;
                }
                await bot.api.sendMessage(adminChatId, summary, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            // Silently ignore — just a background check
            console.error('[MigrateNotify] Check error:', error);
        }
    }, CHECK_INTERVAL);

    console.log(`[MigrateNotify] Checker started (interval: ${CHECK_INTERVAL / 1000}s)`);

    return intervalId;
}

main();

// Graceful shutdown
const shutdown = () => {
    console.log('🛑 Shutting down...');
    process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
