/**
 * Bot Configuration
 */
export default {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',

    // API endpoint for moenet-core
    apiUrl: process.env.API_URL || 'http://localhost:3000',
    apiToken: process.env.API_TOKEN || '',
    coreUrl: process.env.CORE_URL || 'https://api.moenet.work',

    // Admin settings
    adminUsername: process.env.TELEGRAM_ADMIN_USERNAME || '',
    adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || '',
    localAsn: Number(process.env.LOCAL_ASN) || 4242420998,

    // Agent settings
    agentPort: Number(process.env.AGENT_PORT) || 24368,
    agentToken: process.env.AGENT_TOKEN || '',
    agentHosts: JSON.parse(process.env.AGENT_HOSTS || '{}') as Record<string, string>,
    nodeNames: JSON.parse(process.env.NODE_NAMES || '{}') as Record<string, string>,

    // Webhook settings
    webhookDomain: process.env.WEBHOOK_DOMAIN || '',
    webhookSecret: process.env.WEBHOOK_SECRET || '',
    webhookPort: Number(process.env.WEBHOOK_PORT) || 8443,

    // Redis for session persistence
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

    // Rate limiting (requests per window)
    rateLimit: {
        maxRequests: Number(process.env.RATE_LIMIT_MAX) || 20,
        windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
    },

    // External services
    iedonApiBase: process.env.IEDON_API_BASE || 'https://api.iedon.com/dn42',

    // Contact info
    telegramContact: process.env.TELEGRAM_CONTACT || '@heicha',
};
