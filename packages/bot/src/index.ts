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
    /** Announce flow: message + router UUID order for bitmask */
    announceFlow?: {
        message?: string;
        routerUuids: string[];
        routerNames: string[];
        /** Router UUIDs selected for targeted announce. Empty = all. */
        selectedRouters?: string[];
        /** Cached target user count for menu display */
        targetCount?: { tg: number; email: number };
        /** Failed TG targets for retry */
        failedTg?: Array<{ asn: number; telegramId: number }>;
        /** Failed email targets for retry */
        failedEmail?: Array<{ asn: number; email: string }>;
        /** Awaiting message text input */
        awaitingMessage?: boolean;
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
        { command: 'peer', description: 'Create peer 建立连接' },
        { command: 'peers', description: 'List peers 连接列表' },
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
            { command: 'nodes', description: 'Node list 节点列表' },
            { command: 'addnode', description: 'Add router 添加节点' },
            { command: 'addpeer', description: 'Admin add peer 管理加连接' },
            { command: 'migrate', description: 'Bulk migrate 批量迁移' },
            { command: 'announce', description: 'Broadcast message 全员公告' },
            { command: 'notify', description: 'Notify users 定向通知' },
            { command: 'block', description: 'Block ASN 封禁' },
            { command: 'unblock', description: 'Unblock ASN 解封' },
            { command: 'main', description: 'Maintenance mode 维护模式' },
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
            }>;

            if (ready.length === 0) return;

            // Resolve ASNs to telegram IDs
            const asns = ready.map(r => r.asn);
            const targetsResult = await apiRequest('/admin', 'POST', {
                action: 'getNotificationTargets',
                asns,
            }, config.apiToken);

            if (targetsResult.code !== 0) return;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const targets = ((targetsResult.data as any)?.targets || []) as Array<{ asn: number; telegramId: number }>;
            const targetMap = new Map(targets.map(t => [t.asn, t.telegramId]));

            let sent = 0;
            for (const item of ready) {
                const telegramId = targetMap.get(item.asn);
                if (!telegramId) continue;

                const endpointLine = item.serverEndpoint
                    ? `🖥️ New Endpoint 新地址: \`${item.serverEndpoint}\`\n`
                    : '';

                const message =
                    `🔄 *Peer Migration Complete*\n` +
                    `Peer 迁移完成\n\n` +
                    `Your peer \`AS${item.asn}\` has been successfully migrated:\n` +
                    `您的 Peer \`AS${item.asn}\` 已成功迁移:\n\n` +
                    `📍 From 原节点: \`${item.fromRouter}\`\n` +
                    `📍 To 新节点: \`${item.toRouter}\`\n` +
                    `${endpointLine}\n` +
                    `⚠️ *Action Required 需要操作:*\n` +
                    `Please update your WireGuard Endpoint.\n` +
                    `请更新 WireGuard Endpoint。\n` +
                    `Use \`/info\` to view your full config.\n` +
                    `使用 \`/info\` 查看完整配置。`;

                try {
                    await bot.api.sendMessage(telegramId, message, { parse_mode: 'Markdown' });
                    sent++;
                } catch (e) {
                    console.error(`[MigrateNotify] Failed to notify AS${item.asn}:`, e);
                }
            }

            if (sent > 0) {
                console.log(`[MigrateNotify] Sent ${sent} migration notification(s)`);

                // Notify admin about completed notifications
                const adminChatId = ready[0]?.adminChatId || config.adminChatId;
                if (adminChatId) {
                    await bot.api.sendMessage(
                        adminChatId,
                        `✅ Migration notification sent to ${sent}/${ready.length} user(s).\n` +
                        `迁移通知已发送给 ${sent}/${ready.length} 个用户。`
                    );
                }
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
