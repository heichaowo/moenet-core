import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../index';
import config from '../config';
import { getNodes, getAgentEndpoint } from '../providers/nodes';
import { lookupWhois, formatWhoisResult, getWhoisAttr, fetchContacts } from '../services/dn42Registry';
import { normalizeAsn, isAsnInput } from './peer/validators';

/**
 * Execute tool on agent node(s)
 */
async function executeOnAgent(
    command: string,
    target: string,
    nodeId: string
): Promise<string> {
    const nodes = await getNodes();
    const nodeIds = nodeId === 'all'
        ? Array.from(nodes.keys())
        : [nodeId];

    if (nodeIds.length === 0) {
        return await runLocalCommand(command, target);
    }

    // Run requests in parallel with per-request timeout to avoid webhook timeout
    const PER_REQUEST_TIMEOUT = 15_000; // 15s per agent request
    const OVERALL_TIMEOUT = 25_000; // 25s overall to stay within Telegram webhook limits

    const promises = nodeIds.map(async (id): Promise<string | null> => {
        const node = nodes.get(id);
        if (!node) return null;

        const endpoint = await getAgentEndpoint(id);
        if (!endpoint) {
            return `❌ ${id}: No agent endpoint`;
        }

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT);

            const response = await fetch(`${endpoint}/${command}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.agentToken || ''}`,
                },
                body: JSON.stringify({ target }),
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (response.ok) {
                const data = await response.json() as { result?: string };
                const nodeName = node.location || id;
                return `📍 *${nodeName}*\n\`\`\`\n${data.result || 'No output'}\n\`\`\``;
            } else {
                return `❌ ${id}: HTTP ${response.status}`;
            }
        } catch (error) {
            const msg = (error as Error).name === 'AbortError'
                ? 'Request timed out'
                : (error as Error).message.slice(0, 50);
            return `❌ ${id}: ${msg}`;
        }
    });

    // Race all requests against the overall timeout
    const settled = await Promise.race([
        Promise.allSettled(promises),
        new Promise<PromiseSettledResult<string | null>[]>((resolve) =>
            setTimeout(() => resolve(promises.map(() => ({
                status: 'rejected' as const,
                reason: new Error('Overall timeout'),
            }))), OVERALL_TIMEOUT)
        ),
    ]);

    const results: string[] = [];
    for (const result of settled) {
        if (result.status === 'fulfilled' && result.value) {
            results.push(result.value);
        }
    }

    return results.join('\n\n') || 'No results';
}

/**
 * Run command locally (fallback)
 */
async function runLocalCommand(command: string, target: string): Promise<string> {
    // Security: Validate target to prevent injection
    if (/[;&|`$(){}[\]<>\\"']/.test(target)) {
        return 'Invalid target: contains forbidden characters';
    }

    // Additional validation: must look like a valid hostname/IP
    const validTarget = /^[a-zA-Z0-9][a-zA-Z0-9.\-:]+$/.test(target);
    if (!validTarget) {
        return 'Invalid target format';
    }

    const cmdMap: Record<string, string[]> = {
        ping: ['ping', '-c', '4', target],
        trace: ['traceroute', '-m', '20', target],
        tcping: ['nc', '-zv', target.split(':')[0] ?? target, target.split(':')[1] ?? '80'],
        route: ['birdc', 'show', 'route', 'for', target, 'all'],
        path: ['birdc', 'show', 'route', 'for', target, 'all'],
    };

    const args = cmdMap[command];
    if (!args) return 'Unknown command';

    // Use Bun.spawn (no shell) — consistent with runSpawnCommand
    const result = await runSpawnCommand(args, 30000);

    // For path command, filter output
    if (command === 'path') {
        const lines = result.split('\n');
        const filtered = lines.filter(line =>
            line.includes('BGP.as_path') || line.includes('via')
        );
        return filtered.join('\n') || 'No AS path found';
    }

    return result;
}

/**
 * Run a command with explicit args array using Bun.spawn (no shell interpretation).
 * Used for whois/dig which need multi-argument invocations.
 */
async function runSpawnCommand(args: string[], timeoutMs = 10000): Promise<string> {
    try {
        const proc = Bun.spawn(args, {
            stdout: 'pipe',
            stderr: 'pipe',
        });

        const timeout = setTimeout(() => proc.kill(), timeoutMs);

        // Read stdout and stderr in parallel to avoid deadlock
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);

        clearTimeout(timeout);
        await proc.exited; // Prevent zombie processes

        return stdout || stderr || 'No output';
    } catch (error) {
        return `Error: ${(error as Error).message}`;
    }
}

/**
 * Validate user-supplied argument to prevent flag injection.
 * Rejects args starting with '-' that could pass flags to whois/dig.
 */
function sanitizeCommandArg(arg: string): string | null {
    if (!arg || arg.startsWith('-')) return null;
    return arg;
}

/**
 * Build node selection keyboard (async - loads from API)
 */
async function buildNodeKeyboard(command: string, target: string, currentNode = 'all'): Promise<InlineKeyboard> {
    const keyboard = new InlineKeyboard();
    const nodes = await getNodes();

    // Hide 'All' button for trace and lg (too slow/verbose for all nodes)
    const hideAll = command === 'trace' || command === 'lg';
    if (!hideAll) {
        const allLabel = currentNode === 'all' ? '✅ 全部' : '全部';
        keyboard.text(allLabel, `tool:${command}:${target}:all`);
    }

    // Node buttons - sorted alphabetically by nodeId for consistent ordering
    const sortedEntries = Array.from(nodes.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    let count = hideAll ? 0 : 1;
    for (const [nodeId, node] of sortedEntries) {
        const displayName = node.location ? `${nodeId} ${node.location}` : nodeId;
        const label = currentNode === nodeId ? `✅ ${displayName}` : displayName;
        keyboard.text(label, `tool:${command}:${target}:${nodeId}`);

        count++;
        if (count % 3 === 0) keyboard.row();
    }

    return keyboard;
}

export function registerToolsCommands(bot: Bot<BotContext>) {
    // Handle node selection callbacks
    bot.callbackQuery(/^tool:(\w+):([^:]+):(\w+)$/, async (ctx) => {
        const match = ctx.match;
        const command = match?.[1];
        const target = match?.[2];
        const node = match?.[3];

        if (!command || !target || !node) return;

        await ctx.answerCallbackQuery();

        // Show loading indicator immediately so user knows the click registered
        const nodes = await getNodes();
        const nodeInfo = nodes.get(node);
        const nodeName = nodeInfo ? `${node} ${nodeInfo.location}` : node;
        const loadingText = node === 'all'
            ? `⏳ Running ${command} to \`${target}\` on all nodes...`
            : `⏳ Running ${command} to \`${target}\` on *${nodeName}*...`;

        try {
            await ctx.editMessageText(loadingText, { parse_mode: 'Markdown' });
        } catch { /* ignore edit errors */ }

        let result: string;
        if (command === 'lg') {
            // LG = combined route + path
            const [routeResult, pathResult] = await Promise.all([
                executeOnAgent('route', target, node),
                executeOnAgent('path', target, node),
            ]);
            result = `🔍 *Looking Glass: \`${target}\`*\n\n` +
                `📡 *Route Info:*\n${routeResult}\n\n` +
                `🛤 *AS Path:*\n${pathResult}`;
        } else {
            result = await executeOnAgent(command, target, node);
        }
        const keyboard = await buildNodeKeyboard(command, target, node);

        await ctx.editMessageText(result.slice(0, 4000), {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
        });
    });

    /**
     * /ping <target> - Ping with node selection
     */
    bot.command('ping', async (ctx) => {
        const args = ctx.match?.trim().split(/\s+/) || [];
        const target = args[0];
        const node = args[1] || 'all';

        if (!target) {
            await ctx.reply('用法: /ping <IP/域名> [节点]');
            return;
        }

        if (!/^[\w.-]+$/.test(target)) {
            await ctx.reply('❌ Invalid target');
            return;
        }

        const keyboard = await buildNodeKeyboard('ping', target, node);
        const result = await executeOnAgent('ping', target, node);

        await ctx.reply(result.slice(0, 4000), {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
        });
    });

    /**
     * /tcping <target> [port] - TCP Ping
     */
    bot.command('tcping', async (ctx) => {
        const args = ctx.match?.trim().split(/\s+/) || [];
        const target = args[0];
        const port = args[1] || '80';

        if (!target) {
            await ctx.reply('用法: /tcping <IP/域名> [端口]');
            return;
        }

        if (!/^[\w.-]+$/.test(target)) {
            await ctx.reply('❌ Invalid target');
            return;
        }

        const targetWithPort = `${target}:${port}`;
        const keyboard = await buildNodeKeyboard('tcping', targetWithPort, 'all');
        const result = await executeOnAgent('tcping', targetWithPort, 'all');

        await ctx.reply(result.slice(0, 4000), {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
        });
    });

    /**
     * /trace <target> - Traceroute with node selection
     */
    bot.command('trace', async (ctx) => {
        const args = ctx.match?.trim().split(/\s+/) || [];
        const target = args[0];
        const node = args[1];

        if (!target) {
            await ctx.reply('用法: /trace <IP/域名> [节点]');
            return;
        }

        if (!/^[\w.-]+$/.test(target)) {
            await ctx.reply('❌ Invalid target');
            return;
        }

        if (!node) {
            // Show node selection keyboard first to avoid running traceroute on all nodes
            // (which would exceed Telegram's webhook timeout)
            const keyboard = await buildNodeKeyboard('trace', target);
            await ctx.reply(`🔍 Select a node to trace route to \`${target}\`:`, {
                parse_mode: 'Markdown',
                reply_markup: keyboard,
            });
            return;
        }

        await ctx.reply(`🔍 Tracing route to ${target}...`);

        const keyboard = await buildNodeKeyboard('trace', target, node);
        const result = await executeOnAgent('trace', target, node);

        await ctx.reply(result.slice(0, 4000), {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
        });
    });

    /**
     * /route <target> - BIRD route lookup
     */
    bot.command('route', async (ctx) => {
        const args = ctx.match?.trim().split(/\s+/) || [];
        const target = args[0];
        const node = args[1] || 'all';

        if (!target) {
            await ctx.reply('用法: /route <IP/CIDR> [节点]');
            return;
        }

        if (!/^[\w.:/-]+$/.test(target)) {
            await ctx.reply('❌ Invalid target');
            return;
        }

        const keyboard = await buildNodeKeyboard('route', target, node);
        const result = await executeOnAgent('route', target, node);

        await ctx.reply(result.slice(0, 4000), {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
        });
    });

    /**
     * /lg <target> - Looking glass (combined route + AS path on single node)
     */
    bot.command('lg', async (ctx) => {
        const args = ctx.match?.trim().split(/\s+/) || [];
        const target = args[0];
        const node = args[1];

        if (!target) {
            await ctx.reply('用法: /lg <IP/CIDR> [节点]\n例如: /lg 172.22.188.0/27\n\n综合查询：路由 + AS 路径');
            return;
        }

        if (!/^[\w.:/-]+$/.test(target)) {
            await ctx.reply('❌ Invalid target');
            return;
        }

        if (!node) {
            // Show node selection first (lg is too heavy for all nodes)
            const keyboard = await buildNodeKeyboard('lg', target);
            await ctx.reply(`🔍 Select a node to query \`${target}\`:`, {
                parse_mode: 'Markdown',
                reply_markup: keyboard,
            });
            return;
        }

        // Run route and path queries in parallel on the selected node
        const [routeResult, pathResult] = await Promise.all([
            executeOnAgent('route', target, node),
            executeOnAgent('path', target, node),
        ]);

        const combined = `🔍 *Looking Glass: \`${target}\`*\n\n` +
            `📡 *Route Info:*\n${routeResult}\n\n` +
            `🛤 *AS Path:*\n${pathResult}`;

        const keyboard = await buildNodeKeyboard('lg', target, node);

        await ctx.reply(combined.slice(0, 4000), {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
        });
    });

    /**
     * /path <target> - AS-Path lookup
     */
    bot.command('path', async (ctx) => {
        const args = ctx.match?.trim().split(/\s+/) || [];
        const target = args[0];
        const node = args[1] || 'all';

        if (!target) {
            await ctx.reply('用法: /path <IP/CIDR> [节点]');
            return;
        }

        if (!/^[\w.:/-]+$/.test(target)) {
            await ctx.reply('❌ Invalid target');
            return;
        }

        const keyboard = await buildNodeKeyboard('path', target, node);
        const result = await executeOnAgent('path', target, node);

        await ctx.reply(result.slice(0, 4000), {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
        });
    });

    /**
     * /whois <query> - WHOIS lookup using Burble REST API
     */
    bot.command('whois', async (ctx) => {
        const query = ctx.match?.trim();

        if (!query) {
            await ctx.reply('用法: /whois <ASN/IP/name>\n例如: /whois 998, AS4242420998, 172.23.0.80');
            return;
        }

        try {
            const result = await lookupWhois(query);
            if (result) {
                const formatted = formatWhoisResult(result);
                if (formatted.length > 3900) {
                    await ctx.reply(`📋 *WHOIS: ${query}*\n\n\`\`\`\n${formatted.slice(0, 3900)}\n... (truncated)\n\`\`\``, { parse_mode: 'Markdown' });
                } else {
                    await ctx.reply(`📋 *WHOIS: ${query}*\n\n\`\`\`\n${formatted}\n\`\`\``, { parse_mode: 'Markdown' });
                }
            } else {
                await ctx.reply(`❌ 未找到: ${query}`);
            }
        } catch {
            // Fallback to local whois using spawn (avoids runLocalCommand validation issues)
            const safeQuery = sanitizeCommandArg(query);
            if (!safeQuery) {
                await ctx.reply('❌ 无效查询（不允许 - 开头的参数）');
                return;
            }
            const args = safeQuery.toUpperCase().startsWith('AS')
                ? ['whois', '-h', 'whois.dn42', safeQuery]
                : ['whois', safeQuery];
            const result = await runSpawnCommand(args);
            await ctx.reply(`\`\`\`\n${result.slice(0, 4000)}\n\`\`\``, { parse_mode: 'Markdown' });
        }
    });

    /**
     * /dig <domain> [type] - DNS lookup
     */
    bot.command('dig', async (ctx) => {
        const args = ctx.match?.trim().split(/\s+/) || [];
        const domain = sanitizeCommandArg(args[0] || '');
        const recordType = args[1]?.toUpperCase() || 'A';

        if (!domain) {
            await ctx.reply('用法: /dig <域名> [类型]\n例如: /dig moenet.dn42 AAAA\n（不允许 - 开头的参数）');
            return;
        }

        const validTypes = ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SOA', 'PTR'];
        if (!validTypes.includes(recordType)) {
            await ctx.reply(`❌ 不支持的记录类型: ${recordType}\n支持: ${validTypes.join(', ')}`);
            return;
        }

        // Query DN42 DNS using spawn (runLocalCommand rejects multi-arg targets)
        const result = await runSpawnCommand(['dig', '@172.20.0.53', domain, recordType, '+short']);

        await ctx.reply(
            `🔍 *DNS Query*\n\n` +
            `Domain: \`${domain}\`\n` +
            `Type: \`${recordType}\`\n` +
            `Server: \`anycast.baka.dn42\`\n\n` +
            `\`\`\`\n${result || 'No records found'}\n\`\`\``,
            { parse_mode: 'Markdown' }
        );
    });

    /**
     * /findnoc <ASN> - Find NOC contacts using Burble REST API
     */
    bot.command('findnoc', async (ctx) => {
        const query = ctx.match?.trim();

        if (!query || !isAsnInput(query)) {
            await ctx.reply('用法: /findnoc <ASN>\n例如: /findnoc 998, 0998, AS4242420998');
            return;
        }

        const asn = normalizeAsn(query);

        try {
            // Use shared fetchContacts which handles all admin-c entries
            const contacts = await fetchContacts(asn);

            if (contacts.length > 0) {
                await ctx.reply(
                    `📞 *NOC Contacts for AS${asn}*\n\n\`\`\`\n${contacts.join('\n')}\n\`\`\``,
                    { parse_mode: 'Markdown' }
                );
            } else {
                // Fallback to local whois
                const result = await runSpawnCommand(['whois', '-h', 'whois.dn42', `AS${asn}`]);
                const lines = result.split('\n');
                const localContacts: string[] = [];
                for (const line of lines) {
                    if (line.match(/^(admin-c|tech-c|e-mail|contact|person):/i)) {
                        localContacts.push(line.trim());
                    }
                }
                if (localContacts.length > 0) {
                    await ctx.reply(
                        `📞 *NOC Contacts for AS${asn}*\n\n\`\`\`\n${localContacts.join('\n')}\n\`\`\``,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    await ctx.reply(
                        `ℹ️ No contact info found 未找到联系信息\n` +
                        `Try /whois AS${asn} for full record\n` +
                        `尝试 /whois AS${asn} 查看完整记录`
                    );
                }
            }
        } catch {
            await ctx.reply(`❌ Failed to lookup AS${asn}`);
        }
    });
}
