import type { Bot } from 'grammy';
import type { BotContext } from '../index';
import config from '../config';
import { apiRequest } from '../api';
import { isAdmin } from '../guards';

// Generate random token (replaces nanoid)
function generateToken(length = 24): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < length; i++) {
        result += chars[randomValues[i]! % chars.length];
    }
    return result;
}

// Node creation wizard state
interface NodeWizardState {
    step: 'name' | 'hostname' | 'ipv4' | 'ipv6' | 'role' | 'region' | 'location' | 'provider' | 'bandwidth' | 'max_peers' | 'allow_cn' | 'confirm';
    data: Partial<NodeData>;
}

interface NodeData {
    name: string;
    hostname: string;
    ipv4: string | null;
    ipv6: string | null;
    role: 'rr' | 'client';
    region: string;
    location: string;
    provider: string;
    bandwidth: string;
    maxPeers: number;
    allowCnPeers: boolean;
}

export function registerNodeCommands(bot: Bot<BotContext>) {
    /**
     * /addnode - Interactive node creation wizard
     */
    bot.command('addnode', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.reply('❌ Admin access required.');
            return;
        }

        // Start wizard
        ctx.session.nodeWizard = {
            step: 'name',
            data: {},
        };

        await ctx.reply(
            '🖥️ *Add New Node 添加新节点*\n\n' +
            '_Use /cancel at any step to cancel / 任意步骤输入 /cancel 可取消_\n\n' +
            'Step 1/11: Enter node name (e.g., `ch1`):\n' +
            '请输入节点名称:',
            { parse_mode: 'Markdown' }
        );
    });

    /**
     * Handle text messages for wizard flow
     */
    bot.on('message:text', async (ctx, next) => {
        const wizard = ctx.session.nodeWizard as NodeWizardState | undefined;
        if (!wizard) {
            return next();
        }

        const text = ctx.message.text.trim();

        // Handle /cancel at any step
        if (text === '/cancel') {
            ctx.session.nodeWizard = undefined;
            await ctx.reply('🚫 Node creation cancelled.\n已取消节点创建。');
            return;
        }

        switch (wizard.step) {
            case 'name':
                wizard.data.name = text;
                wizard.step = 'hostname';
                await ctx.reply(
                    'Step 2/11: Enter hostname (e.g., `lax1.edge.moenet.work`):\n请输入主机名:',
                    { parse_mode: 'Markdown' }
                );
                break;

            case 'hostname':
                wizard.data.hostname = text;
                wizard.step = 'ipv4';
                await ctx.reply(
                    'Step 3/11: Enter public IPv4 (or `skip` if no IPv4):\n请输入公网 IPv4 (或输入 `skip` 跳过):',
                    { parse_mode: 'Markdown' }
                );
                break;

            case 'ipv4':
                wizard.data.ipv4 = text.toLowerCase() === 'skip' ? null : text;
                wizard.step = 'ipv6';
                await ctx.reply(
                    'Step 4/11: Enter public IPv6 (or `skip` if no IPv6):\n请输入公网 IPv6 (或输入 `skip` 跳过):',
                    { parse_mode: 'Markdown' }
                );
                break;

            case 'ipv6':
                wizard.data.ipv6 = text.toLowerCase() === 'skip' ? null : text;

                // Validate at least one IP
                if (!wizard.data.ipv4 && !wizard.data.ipv6) {
                    await ctx.reply('❌ At least one IP (IPv4 or IPv6) is required.\n至少需要一个 IP 地址。');
                    wizard.step = 'ipv4';
                    return;
                }

                wizard.step = 'role';
                await ctx.reply(
                    'Step 5/11: Enter role (`rr` or `client`):\n请输入角色 (`rr` 或 `client`):',
                    { parse_mode: 'Markdown' }
                );
                break;

            case 'role':
                if (text !== 'rr' && text !== 'client') {
                    await ctx.reply('❌ Invalid role. Must be `rr` or `client`.\n无效角色。必须为 `rr` 或 `client`。');
                    return;
                }
                wizard.data.role = text as 'rr' | 'client';
                wizard.step = 'region';
                await ctx.reply(
                    'Step 6/11: Enter region (e.g., `US`, `EU`, `AP`):\n请输入区域:',
                    { parse_mode: 'Markdown' }
                );
                break;

            case 'region':
                wizard.data.region = text;
                wizard.step = 'location';
                await ctx.reply(
                    'Step 7/11: Enter location (e.g., `Los Angeles`):\n请输入位置:',
                    { parse_mode: 'Markdown' }
                );
                break;

            case 'location':
                wizard.data.location = text;
                wizard.step = 'provider';
                await ctx.reply(
                    'Step 8/11: Enter provider (e.g., `RackNerd`, `BuyVM`):\n请输入提供商:',
                    { parse_mode: 'Markdown' }
                );
                break;

            case 'provider':
                wizard.data.provider = text;
                wizard.step = 'bandwidth';
                await ctx.reply(
                    'Step 9/11: Enter bandwidth (e.g., `1G`, `10G`):\n请输入带宽:',
                    { parse_mode: 'Markdown' }
                );
                break;

            case 'bandwidth':
                wizard.data.bandwidth = text;
                wizard.step = 'max_peers';
                await ctx.reply(
                    'Step 10/11: Enter max peers (e.g., `50`):\n请输入最大 Peer 数:',
                    { parse_mode: 'Markdown' }
                );
                break;

            case 'max_peers':
                const maxPeers = parseInt(text, 10);
                if (isNaN(maxPeers) || maxPeers < 1) {
                    await ctx.reply('❌ Invalid number. Please enter a positive integer.\n请输入正整数。');
                    return;
                }
                wizard.data.maxPeers = maxPeers;
                wizard.step = 'allow_cn';
                await ctx.reply(
                    'Step 11/11: Allow China peers? (`yes` or `no`):\n是否允许中国大陆 Peer? (`yes` 或 `no`):',
                    { parse_mode: 'Markdown' }
                );
                break;

            case 'allow_cn':
                if (text.toLowerCase() !== 'yes' && text.toLowerCase() !== 'no') {
                    await ctx.reply('❌ Please enter `yes` or `no`.\n请输入 `yes` 或 `no`。');
                    return;
                }
                wizard.data.allowCnPeers = text.toLowerCase() === 'yes';

                // Show confirmation summary
                wizard.step = 'confirm';
                const data = wizard.data;
                await ctx.reply(
                    `📋 *Confirm Node Creation 确认创建节点*\n\n` +
                    `🏷️ Name: \`${data.name}\`\n` +
                    `🌐 Hostname: \`${data.hostname}\`\n` +
                    `📍 Public IP: \`${data.ipv4 || 'N/A'}\` / \`${data.ipv6 || 'N/A'}\`\n` +
                    `👤 Role: \`${data.role}\`\n` +
                    `🗺️ Region: \`${data.region}\`\n` +
                    `📌 Location: \`${data.location}\`\n` +
                    `🏢 Provider: \`${data.provider}\`\n` +
                    `📶 Bandwidth: \`${data.bandwidth}\`\n` +
                    `👥 Max Peers: \`${data.maxPeers}\`\n` +
                    `🇨🇳 Allow CN: \`${data.allowCnPeers ? 'Yes' : 'No'}\`\n\n` +
                    `_Type \`yes\` to confirm or /cancel to abort_\n` +
                    `_输入 \`yes\` 确认创建，或 /cancel 取消_`,
                    { parse_mode: 'Markdown' }
                );
                break;

            case 'confirm':
                if (text.toLowerCase() !== 'yes') {
                    await ctx.reply('❌ Please type `yes` to confirm or /cancel to abort.\n请输入 `yes` 确认或 /cancel 取消。');
                    return;
                }

                // Create node
                await createNode(ctx, wizard.data as NodeData);
                ctx.session.nodeWizard = undefined;
                break;
        }
    });

    /**
     * /bootstrap <name> - Get bootstrap command for a node
     */
    bot.command('bootstrap', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.reply('❌ Admin access required.');
            return;
        }

        const args = ctx.match?.trim().split(/\s+/) || [];
        const name = args[0];

        if (!name) {
            await ctx.reply(
                '📋 *Usage:*\n' +
                '`/bootstrap <node-name>` - Get install command\n' +
                '`/bootstrap <node-name> --refresh` - Regenerate token',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const refresh = args.includes('--refresh');

        try {
            let token: string | undefined;

            if (refresh) {
                // Generate new token
                token = generateToken(24);
                const result = await apiRequest('/admin', 'POST', {
                    action: 'updateRouter',
                    name,
                    updates: { bootstrapToken: token },
                }, config.apiToken);

                if (result.code !== 0) {
                    await ctx.reply(`❌ Error: ${result.message}`);
                    return;
                }
            } else {
                // Get existing token
                const result = await apiRequest('/admin', 'POST', {
                    action: 'getRouter',
                    name,
                }, config.apiToken);

                if (result.code !== 0) {
                    await ctx.reply(`❌ Error: ${result.message}`);
                    return;
                }

                token = result.data?.router?.bootstrapToken;

                if (!token) {
                    // Generate new token if none exists
                    token = generateToken(24);
                    await apiRequest('/admin', 'POST', {
                        action: 'updateRouter',
                        name,
                        updates: { bootstrapToken: token },
                    }, config.apiToken);
                }
            }

            const coreUrl = config.coreUrl || 'https://api.moenet.work';

            await ctx.reply(
                `🚀 *Bootstrap Command for ${name}*\n\n` +
                '```bash\n' +
                `curl -sL ${coreUrl}/bootstrap/${token} | bash\n` +
                '```\n\n' +
                `Token: \`${token}\`${refresh ? ' (refreshed)' : ''}`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('[Bootstrap] Error:', error);
            await ctx.reply(`❌ Failed: ${(error as Error).message}`);
        }
    });

    /**
     * /delnode <name> - Delete a node
     */
    bot.command('delnode', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.reply('❌ Admin access required.');
            return;
        }

        const name = ctx.match?.trim();

        if (!name) {
            await ctx.reply('📋 *Usage:* `/delnode <node-name>`', { parse_mode: 'Markdown' });
            return;
        }

        try {
            const result = await apiRequest('/admin', 'POST', {
                action: 'deleteRouter',
                name,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.reply(`❌ Error: ${result.message}`);
                return;
            }

            await ctx.reply(`✅ Node \`${name}\` deleted.`, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('[DelNode] Error:', error);
            await ctx.reply(`❌ Failed: ${(error as Error).message}`);
        }
    });
}

/**
 * Create node via API and return bootstrap command
 */
async function createNode(ctx: BotContext, data: NodeData) {
    try {
        const bootstrapToken = generateToken(24);

        const result = await apiRequest('/admin', 'POST', {
            action: 'createRouter',
            ...data,
            bootstrapToken,
        }, config.apiToken);

        if (result.code !== 0) {
            await ctx.reply(`❌ Error: ${result.message}`);
            return;
        }

        const nodeId = result.data?.router?.nodeId || 'N/A';
        const coreUrl = config.coreUrl || 'https://api.moenet.work';

        await ctx.reply(
            `✅ *Node Created 节点已创建*\n\n` +
            `Name: \`${data.name}\`\n` +
            `Node ID: \`${nodeId}\`\n` +
            `Role: \`${data.role}\`\n` +
            `Region: \`${data.region}\`\n` +
            `Location: \`${data.location}\`\n\n` +
            `🚀 *Bootstrap Command:*\n` +
            '```bash\n' +
            `curl -sL ${coreUrl}/bootstrap/${bootstrapToken} | bash\n` +
            '```',
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        console.error('[CreateNode] Error:', error);
        await ctx.reply(`❌ Failed: ${(error as Error).message}`);
    }
}

// Type definitions
interface ApiResponse {
    code: number;
    message: string;
    data?: {
        router?: {
            nodeId?: number;
            bootstrapToken?: string;
        };
    };
}
