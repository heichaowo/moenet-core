import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../index';
import config from '../config';
import { apiRequest } from '../api';
import { isChinaIP, resolveEndpoint, CN_REJECTION_MESSAGE } from '../providers/chinaIp';
import { validateIpOwnership, isLinkLocal, isDN42ULA, isDN42IPv4 } from '../services/dn42Validator';
import { DIVIDER } from '../templates';
import { PeeringStatus, STATUS_LABELS } from '../peeringStatus';
import { isAdmin } from '../guards';
import { showLatencyStats } from './community';
import { evaluatePeerRequest, endpointSyncIssue } from './peer/approvalCard';

// Import from new peer module
import {
    // Types
    type APIResponse,
    type PeerState,
    // Step constants
    PEER_CREATE_STEPS,
    PEER_MODIFY_STEPS,
    MODIFY_MENU_OPTIONS,
    BGP_ADDRESS_OPTIONS,
    // Validators 
    isValidIPv6,
    isValidWgPubkey,
    isValidDN42IPv4,
    isValidMTU,
    isValidPort,
    calculatePort,
    normalizeAsn,
    isAsnInput,
    parseMTU,
    parseEndpoint,
    // Helpers
    getFlowWithCurrent,
    truncatePubkey,
    // UI helpers
    showServerWgInfo,
    promptSessionType,
    promptIpv6,
    promptUlaIpv6,
    promptEndpoint,
    promptPubkey,
    promptMtu,
    promptPsk,
    showConfirmation,
    promptContact,
    // Handlers
    registerCreationHandlers,
    registerConfirmHandlers,
    registerModifyHandlers,
    registerRemoveHandlers,
    // API
    submitModifyChanges,
} from './peer/index';

/**
 * Show modify menu with ReplyKeyboard (dn42-bot style)
 * This helper is called after each modification to return to the main menu
 */
async function showModifyMenu(ctx: BotContext, isFirstTime = false) {
    const flow = ctx.session.peerFlow;
    if (!flow || !flow.current) return;

    const current = flow.current;
    const channel = current.mpbgp ? 'IPv6 & IPv4' : 'IPv6 only';
    const mpbgpText = current.mpbgp ? (current.extendedNexthop ? 'IPv6 (ENH)' : 'IPv6') : 'Not supported';

    const currentInfo =
        `\`\`\`${isFirstTime ? 'CurrentInfo' : 'ModifiedInfo'}\n` +
        `Region:\n` +
        `    ${flow.routerName || 'Unknown'}${flow.pendingMigration ? ` → ${flow.pendingMigration.nodeName}` : ''}\n` +
        `Basic:\n` +
        `    ASN:         ${flow.asn || ''}\n` +
        `    Channel:     ${channel}\n` +
        `    MP-BGP:      ${mpbgpText}\n` +
        `    Peer IPv6:   ${current.ipv6 || 'Not set'}\n` +
        `    Peer IPv4:   ${current.ipv4 || 'Not set'}\n` +
        `    Local IPv6:  ${current.localIpv6 || 'Not set'}\n` +
        `    Local IPv4:  ${current.localIpv4 || 'Not set'}\n` +
        `Tunnel:\n` +
        `    Endpoint:    ${current.endpoint ? (current.port ? `${current.endpoint}:${current.port}` : current.endpoint) : 'Not set'}\n` +
        `    PublicKey:   ${current.pubkey ? current.pubkey.slice(0, 20) + '...' : 'Not set'}\n` +
        `    PSK:         ${current.psk ? 'Enabled' : 'Not enabled'}\n` +
        `    MTU:         ${current.mtu || 1420}\n` +
        `Contact:\n` +
        `    ${current.contact || 'Not set'}\n` +
        `\`\`\``;

    const headerText = isFirstTime
        ? 'Current information is as follows\n当前信息如下'
        : 'You have modified the following information\n已修改以下信息';

    // Set step back to modify_menu
    ctx.session.peerFlow = { ...flow, step: 'modify_menu' };

    // Fully inline menu. Each item edits immediately (see modify:m:* handlers in
    // peer/handlers/modify.ts) — no batch Finish/Abort. "✅ Done" closes the flow.
    const keyboard = new InlineKeyboard()
        .text('📍 Region', 'modify:m:region')
        .text('🔀 Session Type', 'modify:m:stype')
        .row()
        .text('🌐 BGP Address', 'modify:m:bgp')
        .text('📡 Endpoint', 'modify:m:endpoint')
        .row()
        .text('🔑 PublicKey', 'modify:m:pubkey')
        .text('🔐 PSK', 'modify:m:psk')
        .row()
        .text('📏 MTU', 'modify:m:mtu')
        .text('📇 Contact', 'modify:m:contact')
        .row()
        .text('✅ Done 完成', 'modify:m:done');

    await ctx.reply(
        `🔧 *Modify Peer*\n修改 Peer\n\n` +
        `${headerText}\n\n` +
        currentInfo + `\n\n` +
        `Tap an item to edit — changes apply immediately.\n` +
        `点击一项即可编辑，改动立即生效。`,
        {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
        }
    );
}



/** Status dot for a peering session status. */
function peerDot(status: number): string {
    if (status === PeeringStatus.ENABLED) return '🟢';
    if (status === PeeringStatus.PENDING_REVIEW || status === PeeringStatus.QUEUED_FOR_SETUP) return '⏳';
    if (status === PeeringStatus.PROBLEM) return '🔴';
    return '⚪';
}

/** Render a user's peer list as an inline keyboard (unified /peer entry). */
async function showPeerList(ctx: BotContext, asn: number, adminMode: boolean, editId?: number) {
    const result = await apiRequest('/admin', 'POST', { action: 'enumSessions', asn }, config.apiToken);
    if (result.code !== 0) { await ctx.reply(`❌ ${result.message}`); return; }
    const sessions = (result.data?.sessions || []) as Array<{ uuid: string; router: string; routerName?: string; status: number }>;

    let text = `🔗 *Peers — AS${asn}* (${sessions.length})\n\n`;
    const kb = new InlineKeyboard();
    if (sessions.length === 0) {
        text += '_No peers yet. Tap ➕ to create one._\n还没有 Peer，点 ➕ 新建。';
    } else {
        for (const s of sessions) {
            text += `${peerDot(s.status)} \`${s.routerName || s.router}\` — ${STATUS_LABELS[s.status] || s.status}\n`;
            kb.text(`${peerDot(s.status)} ${s.routerName || s.router}`, `peer:v:${s.uuid}`).row();
        }
    }
    if (!adminMode) kb.text('➕ New Peer', 'peer:new');
    kb.text('🔄 Refresh', adminMode ? `peer:la:${asn}` : 'peer:list');

    if (editId) {
        try { await ctx.api.editMessageText(ctx.chat!.id, editId, text, { parse_mode: 'Markdown', reply_markup: kb }); }
        catch (e) { if (!(e instanceof Error && e.message.includes('not modified'))) throw e; }
    } else {
        await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
    }
}

/** Render a single peer's detail card with action buttons (reuses modify/remove). */
async function showPeerDetail(ctx: BotContext, uuid: string, editId?: number) {
    const result = await apiRequest('/admin', 'POST', { action: 'getSession', uuid }, config.apiToken);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = result.data?.session as any;
    if (result.code !== 0 || !s) { await ctx.reply('❌ Peer not found.\n找不到该 Peer。'); return; }
    if (!isAdmin(ctx) && Number(s.asn) !== ctx.session.asn) {
        const msg = '❌ This peer does not belong to you.\n这不是你的 Peer。';
        if (editId) await ctx.api.editMessageText(ctx.chat!.id, editId, msg); else await ctx.reply(msg);
        return;
    }

    let pubkey = '', hasPsk = false;
    if (s.credential) {
        try {
            const c = typeof s.credential === 'string' ? JSON.parse(s.credential) : s.credential;
            pubkey = c.pubkey || c.public_key || '';
            hasPsk = !!(c.preshared_key || c.psk);
        } catch { /* ignore */ }
    }
    const rawExt = s.extensions;
    const extStr = Array.isArray(rawExt) ? rawExt.join(',') : (rawExt || '');
    const channel = extStr.includes('mp_bgp') || extStr.includes('mpbgp') ? 'IPv6 & IPv4' : 'IPv6 only';
    const routerLabel = s.routerName || s.router;

    const text =
        `🔗 *Peer on ${routerLabel}*\n` +
        `────────\n` +
        `🆔 ASN: \`AS${s.asn}\`\n` +
        `${peerDot(s.status)} Status: ${STATUS_LABELS[s.status] || s.status}\n` +
        `🔀 Channel: ${channel}\n` +
        `🌐 Peer IPv6: \`${s.ipv6 || '—'}\`\n` +
        `📡 Endpoint: \`${s.endpoint || '—'}\`\n` +
        `🖥 Server: \`${s.serverEndpoint || '—'}\`\n` +
        `📏 MTU: \`${s.mtu || 1420}\`  ·  🔐 PSK: ${hasPsk ? 'on' : 'off'}\n` +
        `🔑 PubKey: \`${pubkey ? pubkey.slice(0, 20) + '…' : '—'}\`\n` +
        `📇 Contact: \`${s.contact || '—'}\`` +
        (s.lastError ? `\n⚠️ Note: \`${s.lastError}\`` : '');

    const kb = new InlineKeyboard()
        .text('✏️ Modify', `modify:peer:${uuid}`)
        .text('🗑 Delete', `remove:select:${uuid}`)
        .row()
        .text('📊 Status', `peer:st:${uuid}`)
        .text('🔄 Restart', `peer:rs:${uuid}`)
        .row()
        .text('⏱ Latency', `peer:lat:${s.asn}`)
        .text('🔙 Peers', 'peer:list');

    const render = (pm?: 'Markdown') =>
        editId
            ? ctx.api.editMessageText(ctx.chat!.id, editId, text, { parse_mode: pm, reply_markup: kb })
            : ctx.reply(text, { parse_mode: pm, reply_markup: kb });
    try {
        await render('Markdown');
    } catch (e) {
        if (e instanceof Error && e.message.includes('not modified')) return;
        // A peer field (endpoint/contact/lastError/pubkey) can contain characters
        // that break Markdown parsing (400 "can't parse entities"), which would
        // otherwise make the whole detail card silently fail — the symptom admins
        // hit browsing arbitrary network peers. Fall back to plain text.
        await render(undefined);
    }
}

/** Admin peer-management panel (admins have no peers of their own). */
async function showAdminPeerPanel(ctx: BotContext, editId?: number) {
    const text =
        `🛠 *Peer Admin 面板*\n\n` +
        `Manage all peers across the network.\n管理全网 peer:`;
    const kb = new InlineKeyboard()
        .text('📋 All sessions 所有会话', 'peer:all').row()
        .text('➕ Add peer 添加', 'peer:adminadd').row()
        .text('⏳ Pending 待审核', 'admin:pending').row()
        .text('🔍 By ASN 按 ASN 查', 'peer:byasn').row()
        .text('❌ Close 关闭', 'peer:close');
    if (editId) {
        try { await ctx.api.editMessageText(ctx.chat!.id, editId, text, { parse_mode: 'Markdown', reply_markup: kb }); }
        catch (e) { if (!(e instanceof Error && e.message.includes('not modified'))) throw e; }
    } else {
        await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
    }
}

/** List every session across the network as an inline list (admin). */
const ALL_SESSIONS_PAGE = 18; // sessions per page (keeps the button list scrollable)

async function showAllSessions(ctx: BotContext, editId?: number, page = 0) {
    const result = await apiRequest('/admin', 'POST', { action: 'enumSessions' }, config.apiToken);
    const sessions = (result.data?.sessions || []) as Array<{ uuid: string; router: string; routerName?: string; status: number; asn: number }>;
    // Sort by ASN so each ASN's sessions are grouped together, then by node name.
    sessions.sort((a, b) => a.asn - b.asn || (a.routerName || a.router).localeCompare(b.routerName || b.router));

    const asnCount = new Set(sessions.map((s) => s.asn)).size;
    const totalPages = Math.max(1, Math.ceil(sessions.length / ALL_SESSIONS_PAGE));
    const p = Math.min(Math.max(page, 0), totalPages - 1);
    const pageItems = sessions.slice(p * ALL_SESSIONS_PAGE, p * ALL_SESSIONS_PAGE + ALL_SESSIONS_PAGE);

    const text =
        `📋 *All Sessions 所有会话*\n` +
        `${sessions.length} sessions · ${asnCount} ASNs · 第 ${p + 1}/${totalPages} 页`;

    const kb = new InlineKeyboard();
    // Group visually: the first row of each ASN shows the ASN; its other sessions
    // are indented under it.
    let lastAsn = -1;
    for (const s of pageItems) {
        const node = s.routerName || s.router;
        const label = s.asn !== lastAsn
            ? `AS${s.asn} · ${peerDot(s.status)} ${node}`
            : `      ${peerDot(s.status)} ${node}`;
        lastAsn = s.asn;
        kb.text(label, `peer:v:${s.uuid}`).row();
    }
    if (totalPages > 1) {
        if (p > 0) kb.text('◀️ 上一页', `peer:all:${p - 1}`);
        kb.text(`${p + 1}/${totalPages}`, 'peer:all:noop');
        if (p < totalPages - 1) kb.text('下一页 ▶️', `peer:all:${p + 1}`);
        kb.row();
    }
    kb.text('🔙 Panel 面板', 'peer:panel');
    if (editId) {
        try { await ctx.api.editMessageText(ctx.chat!.id, editId, text, { parse_mode: 'Markdown', reply_markup: kb }); }
        catch (e) { if (!(e instanceof Error && e.message.includes('not modified'))) throw e; }
    } else {
        await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
    }
}

export function registerPeerCommands(bot: Bot<BotContext>) {

    // Register handlers from extracted modules
    registerCreationHandlers(bot);
    registerConfirmHandlers(bot);
    registerModifyHandlers(bot, showModifyMenu);
    registerRemoveHandlers(bot);

    /**
     * /peer - Start peer creation wizard
     */
    // /peer — unified peer command. No arg: your peer list (inline). /peer <asn>:
    // admin views another ASN. Creation moved to the ➕ New button (peer:new).
    bot.command('peer', async (ctx) => {
        const args = ctx.match?.trim().split(/\s+/) || [];
        // /peer <asn> — admin views a specific ASN's peers.
        if (args[0] && isAsnInput(args[0])) {
            if (!isAdmin(ctx)) {
                await ctx.reply('❌ Only admin can view other ASN peers\n只有管理员可查看其他 ASN 的 Peer');
                return;
            }
            await showPeerList(ctx, normalizeAsn(args[0]), true);
            return;
        }
        // No arg: admin gets the management panel (admins have no peers of their
        // own); a normal user gets their own peer list.
        if (isAdmin(ctx)) {
            await showAdminPeerPanel(ctx);
            return;
        }
        if (!ctx.session.asn) {
            await ctx.reply('❌ Please /login first.\n请先登录');
            return;
        }
        await showPeerList(ctx, ctx.session.asn, false);
    });

    // Peer creation wizard (the old /peer body). Reached via ➕ New (user, own
    // ASN) or the admin panel's Add (opts.adminMode + targetAsn — any ASN/node).
    async function startPeerCreation(ctx: BotContext, opts?: { adminMode?: boolean; targetAsn?: number }) {
        const adminMode = opts?.adminMode ?? false;
        const asn = adminMode ? (opts?.targetAsn ?? 0) : (ctx.session.asn ?? 0);
        if (!asn) {
            await ctx.reply('❌ Please /login first.\n请先登录');
            return;
        }

        // Show identity confirmation
        await ctx.reply(
            `👤 *Identity Confirmation 身份确认*\n\n` +
            `You are logged in as \`AS${asn}\`\n` +
            `当前登录身份: \`AS${asn}\`\n\n` +
            `_Use /cancel at any step to cancel / 任意步骤输入 /cancel 可取消_\n\n` +
            `Starting peer creation wizard...\n` +
            `正在启动 Peer 创建向导...`,
            { parse_mode: 'Markdown' }
        );

        // Fetch available nodes
        try {
            const result = await apiRequest('/admin', 'POST', {
                action: 'enumRouters',
            }, config.apiToken);

            if (result.code !== 0 || !result.data?.routers) {
                await ctx.reply('❌ Failed to fetch nodes.\n获取节点列表失败。');
                return;
            }

            const routers = result.data.routers;

            if (routers.length === 0) {
                await ctx.reply('❌ No available nodes.\n没有可用节点');
                return;
            }

            // Build node list message with detailed info (same style as /addpeer)
            let msgText = '🛰 *Node List 节点列表*\n\n';
            const nodeMap: Record<string, { uuid: string; endpoint: string; pubkey: string; nodeId: number; regionCode: number; name: string; allowCnPeers?: boolean }> = {};
            const couldPeer: string[] = [];

            for (const r of routers.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))) {
                // Build label: NAME | City | Provider (same as /addpeer)
                const nodeName = r.name.toUpperCase();
                const city = r.location || '';
                const provider = r.provider || '';
                const label = provider ? `${nodeName} | ${city} | ${provider}` : `${nodeName} | ${city}`;

                // Status section - multi-line per node (same as /addpeer)
                let statusLines = `- ${label}\n`;

                if (r.isOpen) {
                    statusLines += `  🟢 Open For Peer\n`;
                } else {
                    statusLines += `  🔴 Closed\n`;
                }

                // Capacity
                const current = r.sessionCount || 0;
                const max = r.maxPeers || 0;
                if (max > 0) {
                    statusLines += `  👥 Capacity: ${current} / ${max}\n`;
                } else {
                    statusLines += `  👥 Capacity: ${current} / Unlimited\n`;
                }

                // IPv4/IPv6 support - only show if not supported
                if (r.supportsIpv4 === false) {
                    statusLines += `  ⚠️ IPv4: No\n`;
                }
                if (r.supportsIpv6 === false) {
                    statusLines += `  ⚠️ IPv6: No\n`;
                }

                // CN peer restriction
                if (r.allowCnPeers === false) {
                    statusLines += `  🚫 Not allowed to peer with Chinese Mainland\n`;
                }

                msgText += statusLines + '\n';

                // Add to selectable list if open and has capacity. Admin can add
                // to any node, including closed/full ones.
                const hasCapacity = max === 0 || current < max;
                if (adminMode || (r.isOpen && hasCapacity)) {
                    couldPeer.push(label);
                    nodeMap[label] = {
                        uuid: r.uuid,
                        endpoint: r.endpoint || `${r.name}.dn42.moenet.work`,
                        pubkey: r.wgPublicKey || 'N/A',
                        nodeId: r.nodeId || 0,
                        regionCode: r.regionCode || 0,
                        name: r.name,
                        allowCnPeers: r.allowCnPeers,
                    };
                }
            }

            if (couldPeer.length === 0) {
                await ctx.reply(
                    `${msgText}\n❌ No available nodes for peering\n当前没有可 Peer 的节点`,
                    { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
                );
                return;
            }

            // Auto-select if only one node
            if (couldPeer.length === 1) {
                const selectedLabel = couldPeer[0] || '';
                const nodeInfo = nodeMap[selectedLabel];
                if (!nodeInfo || !selectedLabel) return;

                const userPort = calculatePort(asn);

                ctx.session.peerFlow = {
                    step: 'show_wg_info',
                    routerName: nodeInfo.name,
                    sessionUuid: nodeInfo.uuid,
                    serverEndpoint: nodeInfo.endpoint,
                    serverPort: userPort,
                    serverPubkey: nodeInfo.pubkey,
                    serverLla: `fe80::998:${nodeInfo.regionCode}:${nodeInfo.nodeId}:1`,
                    nodeMap,
                    isAdminMode: adminMode,
                    targetAsn: adminMode ? asn : undefined,
                };

                await ctx.reply(
                    `${msgText}\nOnly one node available, auto-selected \`${selectedLabel}\`\n只有一个可选节点，自动选择`,
                    { parse_mode: 'Markdown' }
                );

                // Show WG info
                await showServerWgInfo(ctx);
                return;
            }

            // Save nodeMap + ordered labels for inline selection.
            ctx.session.peerFlow = {
                step: 'select_node',
                nodeMap,
                couldPeerLabels: couldPeer,
                isAdminMode: adminMode,
                targetAsn: adminMode ? asn : undefined,
            };

            // Send node list
            await ctx.reply(msgText, { parse_mode: 'Markdown' });

            // Inline node picker — callback carries the index; labels stay in
            // session (no ReplyKeyboard).
            const keyboard = new InlineKeyboard();
            couldPeer.forEach((label, i) => keyboard.text(label, `peer:pick:${i}`).row());
            keyboard.text('🚫 Cancel 取消', 'peer:cancel');
            await ctx.reply('Select node:\n选择节点:', { reply_markup: keyboard });
        } catch (error) {
            console.error('[Peer] Error:', error);
            await ctx.reply('❌ Failed to fetch nodes.\n获取节点列表失败。');
        }
    }

    // ===== Unified /peer list + detail handlers =====
    bot.callbackQuery('peer:list', async (ctx) => {
        if (!ctx.session.asn) { await ctx.answerCallbackQuery('❌ /login first'); return; }
        await ctx.answerCallbackQuery();
        await showPeerList(ctx, ctx.session.asn, false, ctx.callbackQuery.message?.message_id);
    });
    bot.callbackQuery(/^peer:la:(\d+)$/, async (ctx) => {
        if (!isAdmin(ctx)) { await ctx.answerCallbackQuery('❌ Admin only'); return; }
        await ctx.answerCallbackQuery();
        await showPeerList(ctx, Number(ctx.match[1]), true, ctx.callbackQuery.message?.message_id);
    });
    bot.callbackQuery(/^peer:v:(.+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        try {
            await showPeerDetail(ctx, ctx.match[1]!, ctx.callbackQuery.message?.message_id);
        } catch (e) {
            console.error('[peer:v] showPeerDetail failed:', e);
            await ctx.reply('❌ Failed to load peer detail.\n加载详情失败。');
        }
    });
    bot.callbackQuery('peer:new', async (ctx) => {
        await ctx.answerCallbackQuery();
        await startPeerCreation(ctx);
    });

    // ===== Admin peer panel =====
    bot.callbackQuery('peer:panel', async (ctx) => {
        if (!isAdmin(ctx)) { await ctx.answerCallbackQuery('❌ Admin only'); return; }
        await ctx.answerCallbackQuery();
        await showAdminPeerPanel(ctx, ctx.callbackQuery.message?.message_id);
    });
    // peer:all (page 0) and peer:all:<page> (pagination nav).
    bot.callbackQuery(/^peer:all(?::(\d+))?$/, async (ctx) => {
        if (!isAdmin(ctx)) { await ctx.answerCallbackQuery('❌ Admin only'); return; }
        await ctx.answerCallbackQuery();
        const page = ctx.match?.[1] ? parseInt(ctx.match[1], 10) : 0;
        await showAllSessions(ctx, ctx.callbackQuery.message?.message_id, page);
    });
    // Page-indicator button — no-op (just clears the loading spinner).
    bot.callbackQuery('peer:all:noop', async (ctx) => { await ctx.answerCallbackQuery(); });
    // ⏱ Latency button on the peer detail card → WireGuard RTT probe (was /latency).
    bot.callbackQuery(/^peer:lat:(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery('⏱ Probing…');
        await showLatencyStats(ctx, parseInt(ctx.match[1]!, 10));
    });
    bot.callbackQuery('peer:byasn', async (ctx) => {
        if (!isAdmin(ctx)) { await ctx.answerCallbackQuery('❌ Admin only'); return; }
        ctx.session.peerAsnPrompt = 'view';
        await ctx.answerCallbackQuery();
        await ctx.reply('🔍 Enter ASN to view (e.g. `998` / `AS4242420998`):\n输入要查看的 ASN:', { parse_mode: 'Markdown' });
    });
    bot.callbackQuery('peer:adminadd', async (ctx) => {
        if (!isAdmin(ctx)) { await ctx.answerCallbackQuery('❌ Admin only'); return; }
        ctx.session.peerAsnPrompt = 'add';
        await ctx.answerCallbackQuery();
        await ctx.reply('➕ Enter ASN to add a peer for (e.g. `4242420998`):\n输入要为其添加 Peer 的 ASN:', { parse_mode: 'Markdown' });
    });
    bot.callbackQuery('peer:close', async (ctx) => {
        await ctx.answerCallbackQuery();
        try { await ctx.deleteMessage(); } catch { /* already gone */ }
    });
    // Admin ASN-prompt input (view another ASN, or add a peer for one).
    bot.on('message:text', async (ctx, next) => {
        const mode = ctx.session.peerAsnPrompt;
        if (!mode) return next();
        ctx.session.peerAsnPrompt = undefined;
        const text = ctx.message.text.trim();
        if (text === '/cancel') { await ctx.reply('🚫 Cancelled.'); return; }
        const asn = normalizeAsn(text);
        if (Number.isNaN(asn)) { await ctx.reply('❌ Invalid ASN. 无效 ASN。'); return; }
        if (mode === 'view') await showPeerList(ctx, asn, true);
        else await startPeerCreation(ctx, { adminMode: true, targetAsn: asn });
    });

    // Status: reuse the live /info card for this peer's ASN.
    bot.callbackQuery(/^peer:st:(.+)$/, async (ctx) => {
        await ctx.answerCallbackQuery('Fetching status…');
        const r = await apiRequest('/admin', 'POST', { action: 'getSession', uuid: ctx.match[1] }, config.apiToken);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s = r.data?.session as any;
        if (!s) { await ctx.reply('❌ Not found'); return; }
        if (!isAdmin(ctx) && Number(s.asn) !== ctx.session.asn) { await ctx.reply('❌ Not your peer'); return; }
        await fetchAndDisplayInfo(ctx, Number(s.asn), isAdmin(ctx));
    });
    // Restart: resolve the session then reuse executeRestart.
    bot.callbackQuery(/^peer:rs:(.+)$/, async (ctx) => {
        await ctx.answerCallbackQuery('Restarting…');
        const r = await apiRequest('/admin', 'POST', { action: 'getSession', uuid: ctx.match[1] }, config.apiToken);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s = r.data?.session as any;
        if (!s) { await ctx.reply('❌ Not found'); return; }
        if (!isAdmin(ctx) && Number(s.asn) !== ctx.session.asn) { await ctx.reply('❌ Not your peer'); return; }
        await executeRestart(ctx, Number(s.asn), s.routerName || s.router, ctx.match[1]!);
    });

    // Inline node pick during creation (replaces the ReplyKeyboard select_node).
    bot.callbackQuery(/^peer:pick:(\d+)$/, async (ctx) => {
        const flow = ctx.session.peerFlow;
        if (!flow || flow.step !== 'select_node' || !flow.nodeMap || !flow.couldPeerLabels) {
            await ctx.answerCallbackQuery('❌ Expired — run /peer again');
            return;
        }
        const label = flow.couldPeerLabels[Number(ctx.match[1])];
        const nodeInfo = label ? flow.nodeMap[label] : undefined;
        if (!label || !nodeInfo) { await ctx.answerCallbackQuery('❌ Invalid selection'); return; }
        const asn = flow.isAdminMode ? flow.targetAsn : ctx.session.asn;
        if (!asn) { await ctx.answerCallbackQuery('❌ /login first'); return; }
        await ctx.answerCallbackQuery();
        ctx.session.peerFlow = {
            step: 'show_wg_info',
            routerName: nodeInfo.name,
            sessionUuid: nodeInfo.uuid,
            serverEndpoint: nodeInfo.endpoint,
            serverPort: calculatePort(asn),
            serverPubkey: nodeInfo.pubkey,
            serverLla: `fe80::998:${nodeInfo.regionCode}:${nodeInfo.nodeId}:1`,
            nodeMap: flow.nodeMap,
            isAdminMode: flow.isAdminMode,
            targetAsn: flow.targetAsn,
        };
        await ctx.editMessageText(`✅ Selected: \`${label}\``, { parse_mode: 'Markdown' });
        await showServerWgInfo(ctx);
    });

    /**
     * "Peer here" — entry from the /node detail card. Pre-selects a node and
     * jumps straight to the WireGuard-info step, exactly like /peer auto-selecting
     * a single available node.
     */
    bot.callbackQuery(/^peer:here:(.+)$/, async (ctx) => {
        const name = ctx.match[1]!;
        if (!ctx.session.asn) {
            await ctx.answerCallbackQuery();
            await ctx.reply('❌ Please /login first.\n请先登录');
            return;
        }
        const asn = ctx.session.asn;
        await ctx.answerCallbackQuery();

        try {
            const result = await apiRequest('/admin', 'POST', { action: 'enumRouters' }, config.apiToken);
            const routers = (result.data?.routers ?? []) as Array<{
                uuid: string; name: string; endpoint?: string; wgPublicKey?: string;
                nodeId?: number; regionCode?: number; maxPeers?: number;
                sessionCount?: number; isOpen?: boolean; allowCnPeers?: boolean;
            }>;
            const r = routers.find((x) => x.name === name);
            if (!r) { await ctx.reply('❌ Node not found.'); return; }

            const hasCapacity = !r.maxPeers || (r.sessionCount ?? 0) < r.maxPeers;
            if (!r.isOpen || !hasCapacity) {
                await ctx.reply(`❌ \`${name}\` is not open for peering right now.\n该节点当前不可 Peer。`, { parse_mode: 'Markdown' });
                return;
            }

            const endpoint = r.endpoint || `${r.name}.dn42.moenet.work`;
            ctx.session.peerFlow = {
                step: 'show_wg_info',
                routerName: r.name,
                sessionUuid: r.uuid,
                serverEndpoint: endpoint,
                serverPort: calculatePort(asn),
                serverPubkey: r.wgPublicKey || 'N/A',
                serverLla: `fe80::998:${r.regionCode || 0}:${r.nodeId || 0}:1`,
                nodeMap: {
                    [r.name]: {
                        uuid: r.uuid,
                        endpoint,
                        pubkey: r.wgPublicKey || 'N/A',
                        nodeId: r.nodeId || 0,
                        regionCode: r.regionCode || 0,
                        name: r.name,
                        allowCnPeers: r.allowCnPeers,
                    },
                },
            };
            await showServerWgInfo(ctx);
        } catch (error) {
            console.error('[Peer here] Error:', error);
            await ctx.reply('❌ Failed to start peering.\n启动 Peer 失败。');
        }
    });


    // Creation callbacks (peer:node, peer:select_session_type, peer:session:*,
    // peer:ipv6, peer:endpoint:none, peer:mtu, peer:psk) are now in handlers/creation.ts


    /**
     * Handle text input during peer flow
     */
    bot.on('message:text', async (ctx, next) => {
        const flow = ctx.session.peerFlow;
        if (!flow) return next();

        const text = ctx.message.text.trim();

        // Handle /cancel
        if (text === '/cancel') {
            ctx.session.peerFlow = undefined;
            await ctx.reply('🚫 Peer creation cancelled.\n已取消 Peer 创建');
            return;
        }


        switch (ctx.session.peerFlow?.step || flow.step) {
            // ===== Creation wizard ReplyKeyboard handlers =====
            case 'select_node': {
                // Skip admin mode - handled by admin.ts
                if (flow.isAdminMode) {
                    return next();
                }
                // Handle node selection from ReplyKeyboard
                const nodeMap = flow.nodeMap;
                if (!nodeMap) {
                    await ctx.reply('❌ Error: Node map not found', { reply_markup: { remove_keyboard: true } });
                    ctx.session.peerFlow = undefined;
                    return;
                }

                // Match by exact label (keyboard sends full label)
                const nodeInfo = nodeMap[text];

                if (!nodeInfo) {
                    await ctx.reply('❌ Invalid node. Please select from the list.\n无效节点，请从列表中选择。', { reply_markup: { remove_keyboard: true } });
                    return;
                }

                const asn = ctx.session.asn || 0;
                const userPort = calculatePort(asn);

                ctx.session.peerFlow = {
                    ...flow,
                    step: 'await_continue',
                    routerName: nodeInfo.name || text.split(' (')[0] || text,
                    sessionUuid: nodeInfo.uuid,
                    serverEndpoint: nodeInfo.endpoint,
                    serverPort: userPort,
                    serverPubkey: nodeInfo.pubkey,
                    serverLla: `fe80::998:${nodeInfo.regionCode}:${nodeInfo.nodeId}:1`,
                    allowCnPeers: nodeInfo.allowCnPeers,
                };

                await ctx.reply(`✅ Selected: ${ctx.session.peerFlow.routerName}`, { reply_markup: { remove_keyboard: true } });
                await showServerWgInfo(ctx);
                return;
            }

            case 'await_continue': {
                // Handle "Continue" button from ReplyKeyboard
                if (text.includes('Continue') || text.includes('继续')) {
                    await promptSessionType(ctx);
                    return;
                }
                await ctx.reply('Please click the "Continue" button to proceed.\n请点击 "Continue 继续" 按钮继续。');
                return;
            }

            case 'select_session_type': {
                // Handle session type selection from ReplyKeyboard
                if (text.includes('MP-BGP') || text.includes('ENH')) {
                    ctx.session.peerFlow = { ...flow, step: 'input_ipv6', sessionType: 'ipv6_only' };
                    // Use targetAsn for admin mode, session.asn for user mode
                    const asn = flow.isAdminMode ? (flow.targetAsn || 0) : (ctx.session.asn || 0);
                    const suggested = `fe80::${asn % 10000}`;
                    await ctx.reply(`✅ Session Type: *MP-BGP + ENH*`, { parse_mode: 'Markdown' });
                    await promptIpv6(ctx, suggested);
                    return;
                }
                if (text.includes('ULA') || text.includes('GUA')) {
                    ctx.session.peerFlow = { ...flow, step: 'input_peer_ipv6_ula', sessionType: 'ipv6_ipv4' };
                    await ctx.reply(`✅ Session Type: *ULA/GUA Mode*`, { parse_mode: 'Markdown' });
                    await promptUlaIpv6(ctx);
                    return;
                }
                await ctx.reply('Please select a session type.\n请选择会话类型。');
                return;
            }

            case 'input_mtu': {
                // Handle MTU selection from ReplyKeyboard - use button text exact matches
                const mtuButtons: Record<string, number> = {
                    '1420 (默认)': 1420,
                    '1400': 1400,
                    '1380': 1380,
                    '1280': 1280,
                };
                let mtu = mtuButtons[text];
                if (!mtu) {
                    // Custom MTU input - parse directly
                    const parsed = parseInt(text, 10);
                    if (isNaN(parsed) || parsed < 1280 || parsed > 1500) {
                        await ctx.reply('❌ Invalid MTU. Please enter 1280-1500.\n无效的 MTU，请输入 1280-1500');
                        return;
                    }
                    mtu = parsed;
                }
                ctx.session.peerFlow = { ...flow, step: 'input_psk', mtu };
                await ctx.reply(`✅ MTU: \`${mtu}\``, { parse_mode: 'Markdown' });
                await promptPsk(ctx);
                return;
            }

            case 'input_psk': {
                // Handle PSK selection from ReplyKeyboard
                if (text.includes('Auto') || text.includes('Generate') || text.includes('自动')) {
                    const psk = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
                    ctx.session.peerFlow = { ...flow, step: 'input_contact', psk };
                    await ctx.reply(
                        `🔑 *PSK Generated*\n\n\`${psk}\`\n\n` +
                        `⚠️ Save this key! You need it on your side.\n` +
                        `请保存此密钥，稍后配置时需要。`,
                        { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
                    );
                    await promptContact(ctx);
                    return;
                }
                if (text.includes('No') || text.includes('不使用')) {
                    ctx.session.peerFlow = { ...flow, step: 'input_contact', psk: undefined };
                    await ctx.reply(`✅ PSK: Disabled\nPSK 已禁用`, { reply_markup: { remove_keyboard: true } });
                    await promptContact(ctx);
                    return;
                }
                await ctx.reply('Please select a PSK option.\n请选择 PSK 选项。');
                return;
            }

            case 'input_contact': {
                // Handle contact selection from ReplyKeyboard
                if (text.includes('Skip') || text.includes('跳过')) {
                    ctx.session.peerFlow = { ...flow, step: 'confirm', contact: undefined };
                    await ctx.reply('⏩ Contact skipped.\n已跳过联系方式。', { reply_markup: { remove_keyboard: true } });
                    await showConfirmation(ctx);
                    return;
                }
                if (text.includes('Manual') || text.includes('手动')) {
                    ctx.session.peerFlow = { ...flow, step: 'input_contact_manual' };
                    await ctx.reply(
                        `✏️ *Manual Contact Input*\n手动输入联系方式\n\n` +
                        `Enter your contact info (e-mail, Telegram, etc.):\n` +
                        `请输入你的联系方式（邮箱、Telegram 等）：`,
                        { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
                    );
                    return;
                }
                // User selected a contact from the list
                const selectedContact = text.trim();
                ctx.session.peerFlow = { ...flow, step: 'confirm', contact: selectedContact };
                await ctx.reply(`✅ Contact: \`${selectedContact}\``, { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } });
                await showConfirmation(ctx);
                return;
            }

            case 'input_contact_manual': {
                const manualContact = text.trim();
                if (manualContact.length < 3 || manualContact.length > 200) {
                    await ctx.reply('❌ Contact must be 3-200 characters.\n联系方式长度须为 3-200 个字符。');
                    return;
                }
                ctx.session.peerFlow = { ...flow, step: 'confirm', contact: manualContact };
                await ctx.reply(`✅ Contact: \`${manualContact}\``, { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } });
                await showConfirmation(ctx);
                return;
            }


            case 'input_ipv6': {
                const ipv6 = text.includes('/') ? text.split('/')[0] : text;
                if (!isValidIPv6(ipv6 || '')) {
                    await ctx.reply('❌ Invalid IPv6 address. Please try again.\n无效的 IPv6 地址，请重试。');
                    return;
                }
                ctx.session.peerFlow = { ...flow, step: 'input_endpoint', ipv6 };
                await promptEndpoint(ctx);
                break;
            }

            // ULA Mode: Peer IPv6 input
            case 'input_peer_ipv6_ula': {
                const ipv6 = text.includes('/') ? text.split('/')[0] : text;
                if (!isValidIPv6(ipv6 || '')) {
                    await ctx.reply('❌ Invalid IPv6 address. Please try again.\n无效的 IPv6 地址，请重试。');
                    return;
                }

                // Check if ULA/GUA (not link-local)
                if (isLinkLocal(ipv6 || '')) {
                    await ctx.reply(
                        '❌ Link-Local addresses are not allowed in ULA mode.\n' +
                        'ULA 模式不允许使用 Link-Local 地址。\n\n' +
                        'Use MP-BGP + ENH mode for Link-Local addresses.\n' +
                        '请使用 MP-BGP + ENH 模式来使用 Link-Local 地址。'
                    );
                    return;
                }

                // Validate IP ownership (use targetAsn for admin mode)
                const asn = flow.isAdminMode ? (flow.targetAsn || 0) : (ctx.session.asn || 0);
                const validation = await validateIpOwnership(asn, ipv6 || '');
                if (!validation.valid && validation.warning) {
                    await ctx.reply(validation.warning);
                }

                ctx.session.peerFlow = { ...flow, step: 'input_local_ipv6_ula', ipv6 };
                await ctx.reply(
                    `📝 *Local IPv6 Address 我方 IPv6 地址*\n\n` +
                    `Enter the IPv6 address for OUR side (from YOUR IP pool).\n` +
                    `请输入我方使用的 IPv6 地址（从你的 IP 池分配）。\n\n` +
                    `⚠️ Must also be registered in DN42 under your ASN.\n` +
                    `⚠️ 也必须在 DN42 注册表中属于你的 ASN。`,
                    { parse_mode: 'Markdown' }
                );
                break;
            }

            // ULA Mode: Local IPv6 input
            case 'input_local_ipv6_ula': {
                const localIpv6 = text.includes('/') ? text.split('/')[0] : text;
                if (!isValidIPv6(localIpv6 || '')) {
                    await ctx.reply('❌ Invalid IPv6 address. Please try again.\n无效的 IPv6 地址，请重试。');
                    return;
                }

                if (isLinkLocal(localIpv6 || '')) {
                    await ctx.reply(
                        '❌ Link-Local addresses are not allowed in ULA mode.\n' +
                        'ULA 模式不允许使用 Link-Local 地址。'
                    );
                    return;
                }

                // Validate IP ownership (use targetAsn for admin mode)
                const asn = flow.isAdminMode ? (flow.targetAsn || 0) : (ctx.session.asn || 0);
                const validation = await validateIpOwnership(asn, localIpv6 || '');
                if (!validation.valid && validation.warning) {
                    await ctx.reply(validation.warning);
                }

                ctx.session.peerFlow = { ...flow, step: 'input_peer_ipv4_ula', localIpv6 };
                await ctx.reply(
                    `📝 *Peer IPv4 Address 对方 IPv4 地址*\n\n` +
                    `Enter your DN42 IPv4 address (from YOUR IP pool).\n` +
                    `请输入你的 DN42 IPv4 地址（从你的 IP 池分配）。\n\n` +
                    `Allowed ranges 允许的范围:\n` +
                    `• \`172.20.0.0/14\` (DN42)\n` +
                    `• \`10.127.0.0/16\` (DN42)\n` +
                    `• \`44.0.0.0/8\` (ARDC)`,
                    { parse_mode: 'Markdown' }
                );
                break;
            }

            // ULA Mode: Peer IPv4 input
            case 'input_peer_ipv4_ula': {
                const ipv4 = text.trim();
                if (!isDN42IPv4(ipv4)) {
                    await ctx.reply(
                        '❌ Invalid DN42 IPv4 address.\n无效的 DN42 IPv4 地址。\n\n' +
                        'Allowed: 172.20-23.x.x, 10.127.x.x, 44.x.x.x'
                    );
                    return;
                }

                // Validate IP ownership (use targetAsn for admin mode)
                const asn = flow.isAdminMode ? (flow.targetAsn || 0) : (ctx.session.asn || 0);
                const validation = await validateIpOwnership(asn, ipv4);
                if (!validation.valid && validation.warning) {
                    await ctx.reply(validation.warning);
                }

                ctx.session.peerFlow = { ...flow, ipv4, step: 'input_local_ipv4_ula' };
                await ctx.reply(
                    `📝 *Local IPv4 Address 我方 IPv4 地址*\n\n` +
                    `Enter the IPv4 address for OUR side (from YOUR IP pool).\n` +
                    `请输入我方使用的 IPv4 地址（从你的 IP 池分配）。`,
                    { parse_mode: 'Markdown' }
                );
                break;
            }

            // ULA Mode: Local IPv4 input
            case 'input_local_ipv4_ula': {
                const localIpv4 = text.trim();
                if (!isDN42IPv4(localIpv4)) {
                    await ctx.reply(
                        '❌ Invalid DN42 IPv4 address.\n无效的 DN42 IPv4 地址。\n\n' +
                        'Allowed: 172.20-23.x.x, 10.127.x.x, 44.x.x.x'
                    );
                    return;
                }

                // Validate IP ownership (use targetAsn for admin mode)
                const asn = flow.isAdminMode ? (flow.targetAsn || 0) : (ctx.session.asn || 0);
                const validation = await validateIpOwnership(asn, localIpv4);
                if (!validation.valid && validation.warning) {
                    await ctx.reply(validation.warning);
                }

                ctx.session.peerFlow = { ...flow, localIpv4, step: 'input_endpoint' };

                await ctx.reply(
                    `✅ *ULA Mode Addresses Set*\n\n` +
                    `Peer IPv6: \`${flow.ipv6}\`\n` +
                    `Local IPv6: \`${flow.localIpv6}\`\n` +
                    `Peer IPv4: \`${flow.ipv4}\`\n` +
                    `Local IPv4: \`${localIpv4}\``,
                    { parse_mode: 'Markdown' }
                );
                await promptEndpoint(ctx);
                break;
            }

            case 'input_endpoint': {
                let endpoint = text;
                let port: number | undefined;

                // Parse port from endpoint
                if (text.toLowerCase() === 'none' || text.includes('NAT')) {
                    endpoint = '';
                } else if (text.includes(':') && !text.includes('::')) {
                    // IPv4:port or domain:port
                    const parts = text.split(':');
                    const lastPart = parts.pop();
                    if (lastPart && /^\d+$/.test(lastPart)) {
                        port = parseInt(lastPart, 10);
                        endpoint = parts.join(':');
                    }
                } else if (text.startsWith('[') && text.includes(']:')) {
                    // [IPv6]:port
                    const match = text.match(/^\[(.+)\]:(\d+)$/);
                    if (match && match[1] && match[2]) {
                        endpoint = match[1];
                        port = parseInt(match[2], 10);
                    }
                }

                // Reject obviously-bogus endpoints up front (placeholder host like
                // google.com/1.2.3.4, or a reserved/private IP). Domains that only
                // fail on DNS resolution are still caught later at approval time.
                if (endpoint && endpoint !== '') {
                    const epIssue = endpointSyncIssue(endpoint);
                    if (epIssue) {
                        await ctx.reply(
                            `❌ \`${endpoint}\` is ${epIssue}.\n` +
                            `这不是有效的 WireGuard 端点。请输入你真实的公网地址，或点 None (NAT)。\n` +
                            `Enter your real public endpoint, or tap None (NAT).`,
                            { parse_mode: 'Markdown' }
                        );
                        return;
                    }
                }

                // Check if endpoint is from China
                if (endpoint && endpoint !== '') {
                    try {
                        const ip = await resolveEndpoint(endpoint);
                        if (ip && isChinaIP(ip)) {
                            // Per-node CN restriction: block if node disallows CN peers
                            if (flow.allowCnPeers === false) {
                                await ctx.reply(
                                    '❌ *China Mainland IP Blocked*\n中国大陆 IP 已拦截\n\n' +
                                    `The selected node \`${flow.routerName}\` does not allow peering with Chinese Mainland IPs.\n` +
                                    `所选节点 \`${flow.routerName}\` 不允许中国大陆 IP 进行 Peer。\n\n` +
                                    'Please choose a different endpoint or select another node.\n' +
                                    '请更换端点或选择其他节点。',
                                    { parse_mode: 'Markdown' }
                                );
                                return;
                            }
                            // Node allows CN peers — warn only
                            await ctx.reply(CN_REJECTION_MESSAGE);
                        }
                    } catch (e) {
                        console.warn('[Peer] Failed to check China IP:', e);
                    }
                }

                ctx.session.peerFlow = { ...flow, step: port ? 'input_pubkey' : 'input_port', endpoint, port };

                if (port) {
                    await ctx.reply(`✅ Endpoint: \`${endpoint}:${port}\``, { parse_mode: 'Markdown' });
                    await promptPubkey(ctx);
                } else if (endpoint) {
                    await ctx.reply(
                        `📝 *Step 2b: WireGuard Port*\n\n` +
                        `Input your WireGuard listen port (1-65535).\n` +
                        `请输入你的 WireGuard 监听端口。`,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    ctx.session.peerFlow.step = 'input_pubkey';
                    await promptPubkey(ctx);
                }
                break;
            }

            case 'input_port': {
                const port = parseInt(text, 10);
                if (isNaN(port) || port < 1 || port > 65535) {
                    await ctx.reply('❌ Invalid port. Please enter 1-65535.');
                    return;
                }
                ctx.session.peerFlow = { ...flow, step: 'input_pubkey', port };
                await ctx.reply(`✅ Port: \`${port}\``, { parse_mode: 'Markdown' });
                await promptPubkey(ctx);
                break;
            }

            case 'input_pubkey': {
                if (!isValidWgPubkey(text)) {
                    await ctx.reply('❌ Invalid WireGuard public key. Should be 44 characters ending with =');
                    return;
                }
                ctx.session.peerFlow = { ...flow, step: 'input_mtu', publicKey: text };
                await promptMtu(ctx);
                break;
            }

            case 'input_mtu': {
                const mtu = parseInt(text, 10);
                if (isNaN(mtu) || mtu < 1280 || mtu > 1500) {
                    await ctx.reply('❌ Invalid MTU. Please enter 1280-1500.');
                    return;
                }
                ctx.session.peerFlow = { ...flow, step: 'input_psk', mtu };
                await promptPsk(ctx);
                break;
            }

            case 'confirm': {
                // Hybrid confirmation: support both InlineKeyboard button AND text "yes"
                if (text.toLowerCase() === 'yes') {
                    // Trigger confirmation logic (same as peer:confirm callback)
                    const asn = flow.isAdminMode ? flow.targetAsn : ctx.session.asn;
                    if (!asn) {
                        ctx.session.peerFlow = undefined;
                        return;
                    }

                    await ctx.reply('⏳ Creating peer...\n正在创建 Peer...');

                    try {
                        // Must match the API action; 'create'/'adminCreate' don't exist
                        // (the admin handler only knows 'createSession') and previously
                        // made the text "yes" confirm path fail with "Invalid action".
                        const result = await apiRequest('/admin', 'POST', {
                            action: 'createSession',
                            asn,
                            router: flow.sessionUuid,
                            ipv6: flow.ipv6,
                            endpoint: flow.endpoint && flow.port ? `${flow.endpoint}:${flow.port}` : undefined,
                            publicKey: flow.publicKey,
                            mtu: flow.mtu || 1420,
                            psk: flow.psk,
                            contact: flow.contact || undefined,
                            status: flow.isAdminMode ? 1 : undefined,
                        }, config.apiToken);

                        if (result.code !== 0) {
                            await ctx.reply(`❌ Failed to create peer: ${result.message}`);
                            ctx.session.peerFlow = undefined;
                            return;
                        }

                        const sessionUuid = result.data?.uuid || '';

                        // Lenient auto-approve (mirrors the peer:confirm callback).
                        let evaluation: Awaited<ReturnType<typeof evaluatePeerRequest>> | null = null;
                        let autoApproved = false;
                        if (!flow.isAdminMode && sessionUuid) {
                            evaluation = await evaluatePeerRequest({
                                asn: asn as number,
                                routerName: flow.routerName,
                                nodeAllowCn: flow.allowCnPeers,
                                ipv6: flow.ipv6,
                                localIpv6: flow.localIpv6,
                                endpoint: flow.endpoint,
                                port: flow.port,
                                publicKey: flow.publicKey,
                                contact: flow.contact,
                                sessionType: flow.sessionType,
                            });
                            if (config.peerAutoApprove && evaluation.autoApprove) {
                                const appr = await apiRequest('/admin', 'POST', {
                                    action: 'approveSession',
                                    uuid: sessionUuid,
                                }, config.apiToken);
                                autoApproved = appr.code === 0;
                                if (!autoApproved) {
                                    console.error(`[AutoApprove] approveSession failed for AS${asn}: ${appr.message}`);
                                }
                            }
                        }

                        const statusText = flow.isAdminMode
                            ? `✅ Status: ACTIVE (免审核)`
                            : autoApproved
                                ? `✅ Status: Approved — provisioning now\n已自动通过审核，正在部署`
                                : `⏳ Status: Pending Review\n等待管理员审核`;

                        const successText =
                            `🎉 *Peer Created Successfully!*\n成功创建 Peer!\n\n` +
                            `📍 Node: \`${flow.routerName}\`\n` +
                            `🆔 ASN: \`AS${asn}\`\n\n` +
                            `*Your WireGuard Config:*\n` +
                            `\`\`\`\n` +
                            `[Peer]\n` +
                            `PublicKey = ${flow.serverPubkey}\n` +
                            `Endpoint = ${flow.serverEndpoint}:${flow.serverPort}\n` +
                            `AllowedIPs = 172.20.0.0/14, 172.31.0.0/16, fd00::/8, fe80::/64\n` +
                            `\`\`\`\n\n` +
                            statusText;

                        await ctx.reply(successText, { parse_mode: 'Markdown' });

                        // Notify admin if not in admin mode (with retry for reliability)
                        if (!flow.isAdminMode && config.adminChatId && evaluation) {
                            const adminNotification =
                                (autoApproved ? '🟢 *Auto-approved* (all hard checks passed)\n\n' : '') +
                                evaluation.card;

                            const keyboard = autoApproved
                                ? new InlineKeyboard().text('📋 All Pending', 'admin:pending')
                                : new InlineKeyboard()
                                    .text('✅ Approve', `approve:${sessionUuid}`)
                                    .text('❌ Reject', `reject:${sessionUuid}`)
                                    .row()
                                    .text('📋 All Pending', 'admin:pending');

                            let notified = false;
                            for (let attempt = 1; attempt <= 3; attempt++) {
                                try {
                                    await ctx.api.sendMessage(config.adminChatId, adminNotification, {
                                        parse_mode: 'Markdown',
                                        reply_markup: keyboard,
                                    });
                                    notified = true;
                                    break;
                                } catch (e) {
                                    console.error(`[Notify Admin] Attempt ${attempt}/3 failed:`, e);
                                    if (attempt < 3) {
                                        await new Promise(r => setTimeout(r, attempt * 2000));
                                    }
                                }
                            }
                            if (!notified) {
                                console.error(`[Notify Admin] Gave up notifying admin about AS${asn} peer request after 3 attempts`);
                            }
                        } else if (!flow.isAdminMode) {
                            console.warn(`[Notify Admin] New peer request from AS${asn} but TELEGRAM_ADMIN_CHAT_ID is not set — admin will NOT be notified.`);
                        }

                        ctx.session.peerFlow = undefined;
                    } catch (error) {
                        console.error('[Peer] Create error:', error);
                        await ctx.reply('❌ Failed to create peer.');
                        ctx.session.peerFlow = undefined;
                    }
                    return;
                }

                // Other text during confirm step - remind about options
                await ctx.reply(
                    'Please use the buttons above OR type `yes` to confirm.\n' +
                    '请使用上方按钮或输入 `yes` 确认',
                    { parse_mode: 'Markdown' }
                );
                break;
            }


            // Remove confirmation: random code verification
            case 'remove_confirm': {
                const expectedCode = flow.removeCode;
                if (!expectedCode) {
                    ctx.session.peerFlow = undefined;
                    await ctx.reply('❌ Error: No confirmation code. Please retry /remove');
                    return;
                }

                if (text.toLowerCase() === expectedCode.toLowerCase()) {
                    const uuid = flow.sessionUuid;
                    if (!uuid) {
                        ctx.session.peerFlow = undefined;
                        await ctx.reply('❌ Error: No session to remove');
                        return;
                    }

                    await ctx.reply('⏳ Removing peer...\n正在删除 Peer...');

                    try {
                        const result = await apiRequest('/admin', 'POST', {
                            action: 'deleteSession',
                            uuid,
                        }, config.apiToken);

                        if (result.code !== 0) {
                            await ctx.reply(`❌ Failed to remove: ${result.message}`);
                        } else {
                            await ctx.reply('✅ Peer removed successfully!\n成功删除 Peer!');

                            // Notify admin about peer removal
                            if (config.adminChatId) {
                                try {
                                    const asn = ctx.session.asn || 0;
                                    const username = ctx.from?.username ? `@${ctx.from.username}` : `ID:${ctx.from?.id}`;
                                    await ctx.api.sendMessage(config.adminChatId,
                                        `🗑️ *Peer Removed*\n\n` +
                                        `🆔 ASN: \`AS${asn}\`\n` +
                                        `📍 Node: \`${flow.routerName || 'Unknown'}\`\n` +
                                        `👤 By: ${username}`,
                                        { parse_mode: 'Markdown' }
                                    );
                                } catch {
                                    // Non-critical: don't fail if admin notification fails
                                }
                            }
                        }
                    } catch (error) {
                        console.error('[Remove] Text confirm error:', error);
                        await ctx.reply('❌ Failed to remove peer.');
                    }

                    ctx.session.peerFlow = undefined;
                    return;
                }

                // Wrong code - remind
                await ctx.reply(
                    `❌ Incorrect code. Please type \`${expectedCode}\` to confirm deletion.\n` +
                    `验证码错误，请输入 \`${expectedCode}\` 确认删除`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            default:
                return next();
        }
    });

    /**
     * Show confirmation screen
     */
    async function showConfirmation(ctx: BotContext) {
        const flow = ctx.session.peerFlow;
        // Use targetAsn for admin mode, session.asn for user mode
        const asn = flow?.isAdminMode ? flow.targetAsn : ctx.session.asn;
        if (!flow || !asn) return;

        const endpointDisplay = flow.endpoint && flow.port
            ? `\`${flow.endpoint}:${flow.port}\``
            : flow.endpoint
                ? `\`${flow.endpoint}\``
                : 'None (NAT)';

        const pskDisplay = flow.psk ? '✅ Enabled' : '❌ Disabled';

        const confirmText =
            `✅ *Confirm Peer Creation*\n确认创建 Peer\n\n` +
            `📍 Node: \`${flow.routerName}\`\n` +
            `🆔 ASN: \`AS${asn}\`\n` +
            `🌐 Your IPv6: \`${flow.ipv6}\`\n` +
            `📡 Your Endpoint: ${endpointDisplay}\n` +
            `🔑 Your PublicKey: \`${flow.publicKey?.slice(0, 20)}...\`\n` +
            `📏 MTU: \`${flow.mtu || 1420}\`\n` +
            `🔐 PSK: ${pskDisplay}\n\n` +
            `*Server Info:*\n` +
            `🌐 Endpoint: \`${flow.serverEndpoint}:${flow.serverPort}\`\n` +
            `🔑 PublicKey: \`${flow.serverPubkey}\`\n` +
            `📶 LLA: \`${flow.serverLla}\``;

        const keyboard = new InlineKeyboard()
            .text('✅ Confirm 确认', 'peer:confirm')
            .text('❌ Cancel 取消', 'peer:cancel');

        await ctx.reply(confirmText, { parse_mode: 'Markdown', reply_markup: keyboard });
    }


    // Confirm callbacks (peer:confirm, peer:cancel) are now in handlers/confirm.ts


    /**
     * /info - Show peer info with live WG/BGP status
     */
    bot.command('info', async (ctx) => {
        const args = ctx.match?.trim().split(/\s+/) || [];

        const username = ctx.from?.username?.toLowerCase();
        const adminUsername = config.adminUsername?.toLowerCase().replace('@', '');
        const isAdmin = username === adminUsername || ctx.session.isAdmin === true;

        // Admin with ASN arg → direct lookup
        if (args[0] && isAsnInput(args[0])) {
            if (!isAdmin) {
                await ctx.reply('❌ Only admin can view other ASN info\n只有管理员可以查看其他 ASN 的信息');
                return;
            }
            const targetAsn = normalizeAsn(args[0]);
            await fetchAndDisplayInfo(ctx, targetAsn, true);
            return;
        }

        // Admin without args → prompt for ASN
        if (isAdmin && !args[0]) {
            ctx.session.awaitingInfoAsn = true;
            const keyboard = new InlineKeyboard()
                .text('🚫 Cancel 取消', 'info:cancel');

            await ctx.reply(
                `📊 *Peer Info 查询*\n${DIVIDER}\n` +
                `Enter ASN to view peer details\n` +
                `请输入要查看的 ASN\n\n` +
                `Example 示例: \`998\`, \`0998\`, \`AS4242420998\``,
                { parse_mode: 'Markdown', reply_markup: keyboard }
            );
            return;
        }

        // Normal user → show own info
        const targetAsn = ctx.session.asn;
        if (!targetAsn) {
            await ctx.reply('❌ Please /login first.\n请先登录');
            return;
        }

        await fetchAndDisplayInfo(ctx, targetAsn, false);
    });

    // Handle admin ASN text input for /info
    bot.on('message:text', async (ctx, next) => {
        if (!ctx.session.awaitingInfoAsn) {
            return next();
        }

        const text = ctx.message.text.trim();

        // If user sends another command, cancel and pass through
        if (text.startsWith('/')) {
            ctx.session.awaitingInfoAsn = false;
            return next();
        }

        if (!isAsnInput(text)) {
            await ctx.reply(
                `❌ Invalid ASN format. Example: 998, 0998, AS4242420998\n` +
                `无效的 ASN 格式。`
            );
            return;
        }

        ctx.session.awaitingInfoAsn = false;
        const targetAsn = normalizeAsn(text);
        await fetchAndDisplayInfo(ctx, targetAsn, true);
    });

    // Cancel info ASN input
    bot.callbackQuery('info:cancel', async (ctx) => {
        ctx.session.awaitingInfoAsn = false;
        await ctx.answerCallbackQuery();
        await ctx.editMessageText('❌ Cancelled.\n已取消。');
    });

    /**
     * Shared: fetch and display peer info for an ASN.
     *
     * Args:
     *   ctx: Bot context.
     *   targetAsn: The ASN to query.
     *   useAdminApi: Whether to use admin API with token.
     */
    async function fetchAndDisplayInfo(ctx: BotContext, targetAsn: number, useAdminApi: boolean) {
        await ctx.reply('⏳ Fetching peer info...\n正在获取 Peer 信息...');

        try {
            // Always use the admin API: the bot is a trusted backend and holds the
            // admin token, whereas /session requires a per-user JWT the bot never has
            // (which previously made normal-user /info fail with "Unauthorized").
            // useAdminApi only affects display labels below.
            const result = await apiRequest('/admin', 'POST', { action: 'enumSessions', asn: targetAsn }, config.apiToken);

            if (result.code !== 0) {
                await ctx.reply(`❌ Error: ${result.message}`);
                return;
            }

            const sessions: Array<{ uuid: string; router: string; routerName?: string; status: number; ipv6?: string; endpoint?: string; serverEndpoint?: string; serverWgKey?: string }> = result.data?.sessions || [];

            if (sessions.length === 0) {
                const emptyKb = targetAsn === ctx.session.asn
                    ? new InlineKeyboard().text('➕ New Peer', 'peer:new')
                    : undefined;
                await ctx.reply(
                    `📊 *Peer Info for AS${targetAsn}*\n\n` +
                    `No peers found.\n没有 Peer`,
                    { parse_mode: 'Markdown', reply_markup: emptyKb }
                );
                return;
            }

            // Fetch live status from agents in parallel for active sessions
            const { getAgentEndpoint } = await import('../providers/nodes');
            type LiveStatus = {
                bgp_status?: string;
                wg_status?: string;
                last_handshake?: string;
                transfer?: { rx: string; tx: string };
                routes_imported?: number;
                routes_exported?: number;
                uptime?: string;
            };
            const liveStatusMap = new Map<string, LiveStatus | null>();

            const activeSessions = sessions.filter(s => s.status === PeeringStatus.ENABLED);
            if (activeSessions.length > 0) {
                const fetchPromises = activeSessions.map(async (s) => {
                    const router = s.routerName || s.router;
                    try {
                        const agentUrl = await getAgentEndpoint(router);
                        if (!agentUrl) return { router, status: null };

                        const peerName = `dn42_${targetAsn}`;
                        const controller = new AbortController();
                        const timeout = setTimeout(() => controller.abort(), 5000);

                        const resp = await fetch(`${agentUrl}/peer/${peerName}`, {
                            method: 'GET',
                            headers: { 'Authorization': `Bearer ${config.agentToken || ''}` },
                            signal: controller.signal,
                        });
                        clearTimeout(timeout);

                        if (resp.ok) {
                            const data = await resp.json() as LiveStatus;
                            return { router, status: data };
                        }
                        return { router, status: null };
                    } catch {
                        return { router, status: null };
                    }
                });

                const results = await Promise.allSettled(fetchPromises);
                for (const r of results) {
                    if (r.status === 'fulfilled' && r.value) {
                        liveStatusMap.set(r.value.router, r.value.status);
                    }
                }
            }

            let message = `📊 *Peer Info for AS${targetAsn}*\n\n`;

            for (const [i, s] of sessions.entries()) {
                const statusIcon = s.status === PeeringStatus.ENABLED ? '🟢' : s.status === PeeringStatus.PENDING_REVIEW ? '⏳' : '❌';
                const statusText = s.status === PeeringStatus.ENABLED ? 'Active' : s.status === PeeringStatus.PENDING_REVIEW ? 'Pending' : 'Inactive';
                const displayName = s.routerName || s.router;

                message += `*${i + 1}. ${displayName}* ${statusIcon} ${statusText}\n`;

                if (s.ipv6) message += `   IPv6: \`${s.ipv6}\`\n`;
                if (s.endpoint) message += `   ${useAdminApi ? 'Peer' : 'Your'} Endpoint: \`${s.endpoint}\`\n`;
                if (s.serverEndpoint) message += `   🖥️ Server Endpoint: \`${s.serverEndpoint}\`\n`;
                if (s.serverWgKey) message += `   🔑 Server Key: \`${s.serverWgKey.slice(0, 10)}...\`\n`;

                // Live status from agent
                if (s.status === PeeringStatus.ENABLED) {
                    const live = liveStatusMap.get(displayName);
                    if (live) {
                        // BGP status
                        const bgpIcon = live.bgp_status === 'Established' ? '✅' : '⚠️';
                        const routeInfo = (live.routes_imported !== undefined && live.routes_exported !== undefined)
                            ? ` (${live.routes_imported}↓ ${live.routes_exported}↑)`
                            : '';
                        message += `   BGP: ${bgpIcon} ${live.bgp_status || 'unknown'}${routeInfo}\n`;

                        // WG handshake
                        if (live.last_handshake && live.last_handshake !== 'never') {
                            message += `   WG:  ✅ Handshake ${live.last_handshake}\n`;
                        } else if (live.last_handshake === 'never') {
                            message += `   WG:  ❌ No handshake\n`;
                        }

                        // Transfer
                        if (live.transfer) {
                            message += `   Transfer: ↓${live.transfer.rx} ↑${live.transfer.tx}\n`;
                        }
                    } else {
                        message += `   ⚠️ Agent unreachable\n`;
                    }
                }

                message += `\n`;
            }

            const keyboard = new InlineKeyboard()
                .text('🔄 Refresh 刷新', `info:refresh:${targetAsn}`)
                .text('🔧 Modify 修改', `info:modify:${targetAsn}`);

            await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard });
        } catch (error) {
            console.error('[Info] Error:', error);
            await ctx.reply('❌ Failed to fetch peer info.\n获取 Peer 信息失败。');
        }
    }

    // Handle info:refresh — re-fetch with the same ASN
    bot.callbackQuery(/^info:refresh:(\d+)$/, async (ctx) => {
        const targetAsn = parseInt(ctx.match[1]!, 10);
        const useAdminApi = isAdmin(ctx);

        // Ownership: a non-admin may only refresh their own ASN. Without this,
        // any user could craft info:refresh:<other-asn> and read another peer's
        // endpoints/keys/UUIDs.
        if (!useAdminApi && targetAsn !== ctx.session.asn) {
            await ctx.answerCallbackQuery('❌ Not your ASN / 不是你的 ASN');
            return;
        }

        await ctx.answerCallbackQuery('Refreshing... 刷新中...');
        await fetchAndDisplayInfo(ctx, targetAsn, useAdminApi);
    });

    // Modify button on the Peer Info card → open the same inline peer picker
    // as /modify (no "type /modify" dead-end). ASN is carried on the button.
    bot.callbackQuery(/^info:modify:(\d+)$/, async (ctx) => {
        const targetAsn = parseInt(ctx.match[1]!, 10);

        // Ownership: a non-admin may only modify their own ASN. Without this,
        // a crafted info:modify:<other-asn> would enumerate another peer.
        if (!isAdmin(ctx) && targetAsn !== ctx.session.asn) {
            await ctx.answerCallbackQuery('❌ Not your ASN / 不是你的 ASN');
            return;
        }

        await ctx.answerCallbackQuery();
        await presentModifyPeerPicker(ctx, targetAsn);
    });

    // Shared inline "pick a peer to modify" flow, used by both /modify and the
    // Peer Info card's Modify button so neither dead-ends into "type /modify".
    async function presentModifyPeerPicker(ctx: BotContext, targetAsn: number) {
        try {
            // Always use the admin API: the bot holds the admin token, while
            // /session needs a per-user JWT the bot never has (caused "Unauthorized"
            // / 未授权 for normal users running /modify and /remove).
            const result = await apiRequest('/admin', 'POST', { action: 'enumSessions', asn: targetAsn }, config.apiToken);

            if (result.code !== 0) {
                await ctx.reply(`❌ Error: ${result.message}`);
                return;
            }

            const sessions = result.data?.sessions || [];

            if (sessions.length === 0) {
                await ctx.reply(`ℹ️ AS${targetAsn} has no peers to modify.\nAS${targetAsn} 没有可修改的 Peer`);
                return;
            }

            // Build selection keyboard
            const keyboard = new InlineKeyboard();
            sessions.forEach((s: { uuid: string; router: string; routerName?: string; status: number }) => {
                const displayName = s.routerName || s.router;
                keyboard.text(displayName, `modify:peer:${s.uuid}`).row();
            });
            keyboard.text('🚫 Cancel 取消', 'modify:cancel');

            await ctx.reply(
                `🔧 *Modify Peer for AS${targetAsn}*\n修改 AS${targetAsn} 的 Peer\n\n` +
                `Select peer to modify:\n选择要修改的 Peer:`,
                { parse_mode: 'Markdown', reply_markup: keyboard }
            );
        } catch (error) {
            console.error('[Modify] Error:', error);
            await ctx.reply('❌ Failed to fetch peers.');
        }
    }

    /**
     * /modify - Modify existing peer
     */
    bot.command('modify', async (ctx) => {
        // Check if admin specifying ASN
        const args = ctx.match?.trim().split(/\s+/) || [];
        let targetAsn = ctx.session.asn;

        const username = ctx.from?.username?.toLowerCase();
        const adminUsername = config.adminUsername?.toLowerCase().replace('@', '');
        const isAdmin = username === adminUsername || ctx.session.isAdmin === true;

        if (args[0] && isAsnInput(args[0])) {
            if (!isAdmin) {
                await ctx.reply('❌ Only admin can modify other ASN peers\n只有管理员可以修改其他 ASN 的 Peer');
                return;
            }
            targetAsn = normalizeAsn(args[0]);
        }

        if (!targetAsn) {
            await ctx.reply('❌ Please /login first.\n请先登录');
            return;
        }

        await presentModifyPeerPicker(ctx, targetAsn);
    });

    /**
     * Handle modify peer selection - show field selection with ReplyKeyboard (dn42-bot style)
     */
    bot.callbackQuery(/^modify:peer:(.+)$/, async (ctx) => {
        const uuid = ctx.match?.[1];
        if (!uuid) return;

        await ctx.answerCallbackQuery();

        try {
            // Fetch full session details via admin API
            const result = await apiRequest('/admin', 'POST', {
                action: 'getSession',
                uuid,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.editMessageText(`❌ Failed to fetch session: ${result.message}`);
                return;
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const session = result.data?.session as any;
            if (!session) {
                await ctx.editMessageText('❌ Session not found');
                return;
            }

            // Ownership: a non-admin may only modify their own session. Without
            // this, any user could craft modify:peer:<other-uuid> and hijack
            // another peer's WireGuard config.
            if (!isAdmin(ctx) && Number(session.asn) !== ctx.session.asn) {
                await ctx.editMessageText('❌ This peer does not belong to you.\n这不是你的 Peer。');
                return;
            }

            // Parse credential for backup
            let pubkey = '';
            let hasPsk = false;
            let credEndpoint = '';
            let credListenPort = '';
            if (session.credential) {
                try {
                    const cred = typeof session.credential === 'string'
                        ? JSON.parse(session.credential)
                        : session.credential;
                    pubkey = cred.pubkey || cred.public_key || '';
                    hasPsk = !!(cred.preshared_key || cred.psk);
                    // Extract endpoint from credential if DB endpoint doesn't have port
                    if (cred.endpoint) {
                        credEndpoint = cred.endpoint;
                    }
                    if (cred.listen_port) {
                        credListenPort = String(cred.listen_port);
                    }
                } catch {
                    pubkey = String(session.credential).slice(0, 44);
                }
            }

            // Resolve endpoint: prefer DB endpoint, fall back to credential endpoint
            const rawEndpoint = session.endpoint || credEndpoint || '';

            // Parse host:port from the resolved endpoint
            let resolvedHost = rawEndpoint;
            let resolvedPort = '';
            if (rawEndpoint && rawEndpoint.includes(':')) {
                const parts = rawEndpoint.split(':');
                const lastPart = parts[parts.length - 1];
                // Only treat as port if the last segment is purely numeric
                if (lastPart && /^\d+$/.test(lastPart)) {
                    resolvedPort = lastPart;
                    resolvedHost = parts.slice(0, -1).join(':');
                }
            }

            // Parse extensions (handles both JSON array and string format)
            const rawExt = session.extensions;
            const extStr = Array.isArray(rawExt) ? rawExt.join(',') : (rawExt || '');
            const hasMpbgp = extStr.includes('mp_bgp') || extStr.includes('mpbgp');
            const hasEnh = extStr.includes('extended_nexthop') || extStr.includes('enh');

            // Store backup state for diff tracking (dn42-bot style)
            ctx.session.peerFlow = {
                step: 'modify_menu',
                sessionUuid: uuid,
                routerName: session.routerName || session.router,
                asn: session.asn,
                backup: {
                    endpoint: resolvedHost,
                    port: resolvedPort,
                    ipv6: session.ipv6 || '',
                    ipv4: session.ipv4 || '',
                    localIpv6: session.ipv6LinkLocal || '',
                    localIpv4: session.localIpv4 || '',
                    pubkey,
                    psk: hasPsk,
                    mtu: session.mtu || 1420,
                    mpbgp: hasMpbgp,
                    extendedNexthop: hasEnh,
                    contact: session.contact || '',
                },
                // Current values (will be modified by user)
                current: {
                    endpoint: resolvedHost,
                    port: resolvedPort,
                    ipv6: session.ipv6 || '',
                    ipv4: session.ipv4 || '',
                    localIpv6: session.ipv6LinkLocal || '',
                    localIpv4: session.localIpv4 || '',
                    pubkey,
                    psk: hasPsk,
                    mtu: session.mtu || 1420,
                    mpbgp: hasMpbgp,
                    extendedNexthop: hasEnh,
                    contact: session.contact || '',
                },
            };

            // Clear any leftover ReplyKeyboard from the old modify UI (it persists
            // in clients that used it), then render the inline menu.
            await ctx.deleteMessage();
            await ctx.reply('🔄 Updating menu…\n更新菜单…', { reply_markup: { remove_keyboard: true } });
            await showModifyMenu(ctx, true);
        } catch (error) {
            console.error('[Modify Peer] Error:', error);
            await ctx.editMessageText('❌ Failed to fetch session details');
        }
    });

    /**
     * Handle modify field selection - prompt for new value
     */
    bot.callbackQuery(/^modify:field:(.+):(.+)$/, async (ctx) => {
        const uuid = ctx.match?.[1];
        const field = ctx.match?.[2];
        if (!uuid || !field) return;

        await ctx.answerCallbackQuery();

        // Store modify state in peerFlow
        ctx.session.peerFlow = {
            step: `modify_${field}`,
            sessionUuid: uuid,
        };

        let promptText = '';
        let keyboard: InlineKeyboard | undefined;
        switch (field) {
            case 'region':
                // Fetch available routers for node selection
                promptText = `🌍 *Migrate to Another Node*\n迁移到另一节点\n\n` +
                    `⚠️ This will recreate your peer on a different node.\n` +
                    `这将在不同节点重建你的 Peer。\n\n` +
                    `Select new node:\n选择新节点:`;
                // Build node keyboard dynamically
                try {
                    const nodeResult = await apiRequest('/admin', 'POST', { action: 'enumRouters' }, config.apiToken);
                    const nodes = nodeResult.data?.routers;
                    if (nodeResult.code === 0 && Array.isArray(nodes)) {
                        keyboard = new InlineKeyboard();
                        for (const node of nodes) {
                            if (node.isOpen) { // Only open nodes
                                // Session uuid is kept in session (set above), not in
                                // callback_data — two UUIDs would exceed Telegram's
                                // 64-byte callback_data limit.
                                keyboard.text(`📍 ${node.name}`, `modify:region:${node.uuid}`).row();
                            }
                        }
                        keyboard.text('🚫 Cancel 取消', 'modify:cancel');
                    }
                } catch {
                    promptText = `❌ Failed to fetch nodes\n获取节点列表失败`;
                }
                break;
            case 'sessionType':
                promptText = `⚙️ *Session Type*\nBGP 会话类型\n\n` +
                    `Select session type:\n选择会话类型:`;
                // Session uuid kept in session (set above); callback carries only
                // the type so callback_data stays under Telegram's 64-byte limit.
                keyboard = new InlineKeyboard()
                    .text('MP-BGP + ENH (推荐)', `modify:sessionType:mpbgp_enh`).row()
                    .text('MP-BGP Only', `modify:sessionType:mpbgp`).row()
                    .text('IPv6 + IPv4 独立会话', `modify:sessionType:separate`).row()
                    .text('🚫 Cancel 取消', 'modify:cancel');
                break;
            case 'peerIpv6':
                promptText = `🌐 *Modify Peer IPv6*\n修改对方 IPv6\n\n` +
                    `Enter new IPv6 address for BGP:\n` +
                    `输入对方的 BGP IPv6 地址:\n\n` +
                    `Supported: \`fe80::/64\` Link-Local or \`fd00::/8\` ULA`;
                break;
            case 'peerIpv4':
                promptText = `🌍 *Modify Peer IPv4*\n修改对方 IPv4\n\n` +
                    `Enter new IPv4 address for BGP:\n` +
                    `输入对方的 BGP IPv4 地址:\n\n` +
                    `Example: \`172.20.x.x\`\n` +
                    `Or send "none" to clear`;
                break;
            case 'localIpv6':
                promptText = `📍 *Modify Local IPv6*\n修改我方 IPv6\n\n` +
                    `Enter new local IPv6 address:\n` +
                    `输入我方的 IPv6 地址:\n\n` +
                    `Supported: \`fe80::/64\` Link-Local or \`fd00::/8\` ULA`;
                break;
            case 'localIpv4':
                promptText = `📍 *Modify Local IPv4*\n修改我方 IPv4\n\n` +
                    `Enter new local IPv4 address:\n` +
                    `输入我方的 IPv4 地址:\n\n` +
                    `Example: \`172.20.x.x\`\n` +
                    `Or send "none" to clear`;
                break;
            case 'ipv6':  // Legacy compatibility
                promptText = `🌐 *Modify IPv6*\n\n` +
                    `Enter new IPv6 address for BGP:\n` +
                    `输入新的 BGP IPv6 地址:\n\n` +
                    `Supported: \`fe80::/64\` Link-Local or \`fc00::/7\` ULA`;
                break;
            case 'endpoint':
                promptText = `📡 *Modify Endpoint*\n\n` +
                    `Enter new endpoint (domain:port or IP:port):\n` +
                    `输入新端点 (域名:端口 或 IP:端口):\n\n` +
                    `Example: \`tunnel.example.com:51820\`\n` +
                    `Or send "none" for no endpoint`;
                break;
            case 'pubkey':
                promptText = `🔑 *Modify Public Key*\n\n` +
                    `Enter new WireGuard public key:\n` +
                    `输入新的 WireGuard 公钥:\n\n` +
                    `Format: 44 characters, ends with \`=\``;
                break;
            case 'mtu':
                promptText = `📏 *Modify MTU*\n\n` +
                    `Enter new MTU (1280-1500):\n` +
                    `输入新的 MTU (1280-1500):`;
                keyboard = new InlineKeyboard()
                    .text('1420 (Default)', `modify:mtu:${uuid}:1420`)
                    .text('1400', `modify:mtu:${uuid}:1400`).row()
                    .text('1380', `modify:mtu:${uuid}:1380`)
                    .text('1360', `modify:mtu:${uuid}:1360`).row()
                    .text('🚫 Cancel 取消', 'modify:cancel');
                ctx.session.peerFlow = undefined; // Uses buttons or text
                break;
            case 'psk':
                promptText = `🔐 *Modify PSK*\n\n` +
                    `Choose action:\n选择操作:`;
                keyboard = new InlineKeyboard()
                    .text('🔄 Generate New 生成新密钥', `modify:psk:${uuid}:generate`).row()
                    .text('❌ Disable PSK 禁用', `modify:psk:${uuid}:disable`).row()
                    .text('🚫 Cancel 取消', 'modify:cancel');
                ctx.session.peerFlow = undefined; // PSK uses buttons, not text
                break;
            case 'contact':
                promptText = `📞 *Modify Contact*\n修改联系方式\n\n` +
                    `Enter new contact info:\n` +
                    `输入新的联系方式:\n\n` +
                    `Example: Telegram @username, Email, etc.`;
                break;
            default:
                promptText = `❌ Unknown field: ${field}`;
        }

        await ctx.editMessageText(promptText, { parse_mode: 'Markdown', reply_markup: keyboard });
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
     * Handle modify:back - dismiss the inline keyboard and let user continue from menu
     */
    bot.callbackQuery('modify:back', async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.deleteMessage();
        // User can continue selecting from ReplyKeyboard menu
    });


    // Modify callbacks (modify:psk, modify:sessionType, modify:mtu, modify:region) 
    // are now in handlers/modify.ts


    /**
     * /remove - Remove peer
     */
    bot.command('remove', async (ctx) => {
        // Check if admin specifying ASN
        const args = ctx.match?.trim().split(/\s+/) || [];
        let targetAsn = ctx.session.asn;
        let isAdminMode = false;

        const username = ctx.from?.username?.toLowerCase();
        const adminUsername = config.adminUsername?.toLowerCase().replace('@', '');
        const isAdmin = username === adminUsername || ctx.session.isAdmin === true;

        if (args[0] && isAsnInput(args[0])) {
            if (!isAdmin) {
                await ctx.reply('❌ Only admin can remove other ASN peers\n只有管理员可以删除其他 ASN 的 Peer');
                return;
            }
            targetAsn = normalizeAsn(args[0]);
            isAdminMode = true;
        }

        if (!targetAsn) {
            await ctx.reply('❌ Please /login first.\n请先登录');
            return;
        }

        try {
            // Always use the admin API: the bot holds the admin token, while
            // /session needs a per-user JWT the bot never has (caused "Unauthorized"
            // / 未授权 for normal users running /modify and /remove).
            const result = await apiRequest('/admin', 'POST', { action: 'enumSessions', asn: targetAsn }, config.apiToken);

            if (result.code !== 0) {
                await ctx.reply(`❌ Error: ${result.message}`);
                return;
            }

            const sessions = (result.data?.sessions || [])
                .filter((s: { status: number }) => s.status !== 5); // Exclude QUEUED_FOR_DELETE

            if (sessions.length === 0) {
                await ctx.reply(`ℹ️ AS${targetAsn} has no peers to remove.\nAS${targetAsn} 没有可删除的 Peer`);
                return;
            }

            // Build selection keyboard
            const keyboard = new InlineKeyboard();
            sessions.forEach((s: { uuid: string; router: string; routerName?: string; status: number }) => {
                keyboard.text(`${s.routerName || s.router}`, `remove:select:${s.uuid}`).row();
            });
            keyboard.text('🚫 Cancel 取消', 'remove:cancel');

            await ctx.reply(
                `🗑️ *Remove Peer for AS${targetAsn}*\n删除 AS${targetAsn} 的 Peer\n\n` +
                `Select peer to remove:\n选择要删除的 Peer:`,
                { parse_mode: 'Markdown', reply_markup: keyboard }
            );
        } catch (error) {
            console.error('[Remove] Error:', error);
            await ctx.reply('❌ Failed to fetch peers.');
        }
    });


    // Remove callbacks (remove:select, remove:confirm, remove:cancel) 
    // are now in handlers/remove.ts


    /**
     * /restart - Restart WireGuard tunnel and BGP session
     */
    bot.command('restart', async (ctx) => {
        // Check if admin specifying ASN
        const args = ctx.match?.trim().split(/\s+/) || [];
        let targetAsn = ctx.session.asn;

        const username = ctx.from?.username?.toLowerCase();
        const adminUsername = config.adminUsername?.toLowerCase().replace('@', '');
        const isAdmin = username === adminUsername || ctx.session.isAdmin === true;

        if (args[0] && isAsnInput(args[0])) {
            if (!isAdmin) {
                await ctx.reply('❌ Only admin can restart other ASN peers\n只有管理员可以重启其他 ASN 的 Peer');
                return;
            }
            targetAsn = normalizeAsn(args[0]);
        }

        if (!targetAsn) {
            await ctx.reply('❌ Please /login first.\n请先登录');
            return;
        }

        // Fetch user's active sessions
        try {
            const result = await apiRequest('/admin', 'POST', {
                action: 'enumSessions',
                asn: targetAsn,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.reply(`❌ Error: ${result.message}`);
                return;
            }

            const sessions = (result.data?.sessions || []).filter((s: { status: number }) => s.status === PeeringStatus.ENABLED);

            if (sessions.length === 0) {
                await ctx.reply(`❌ AS${targetAsn} has no active peers\nAS${targetAsn} 没有活跃的 Peer`);
                return;
            }

            if (sessions.length === 1) {
                const session = sessions[0];
                if (session) {
                    await executeRestart(ctx, targetAsn, session.router, session.uuid);
                }
            } else {
                const keyboard = new InlineKeyboard();
                for (const s of sessions) {
                    keyboard.text(s.router, `restart:${targetAsn}:${s.uuid}:${s.router}`).row();
                }
                await ctx.reply(
                    `🔄 *Restart Peer*\n重启 Peer\n\n` +
                    `Select node for AS${targetAsn}:\n选择要重启的节点:`,
                    { parse_mode: 'Markdown', reply_markup: keyboard }
                );
            }
        } catch (_error) {
            console.error('[Restart] Error:', _error);
            await ctx.reply('❌ Failed to fetch sessions.');
        }
    });

    // Handle restart selection callback
    bot.callbackQuery(/^restart:(\d+):([^:]+):(.+)$/, async (ctx) => {
        const asn = parseInt(ctx.match?.[1] || '0', 10);
        const uuid = ctx.match?.[2] || '';
        const router = ctx.match?.[3] || '';

        if (!asn || !uuid || !router) return;

        await ctx.answerCallbackQuery('Restarting...');
        await executeRestart(ctx, asn, router, uuid);
    });

    async function executeRestart(ctx: BotContext, asn: number, router: string, _uuid: string) {
        await ctx.reply(`⏳ Restarting peer for AS${asn} @ ${router}...\n正在重启...`);

        try {
            const { getAgentEndpoint } = await import('../providers/nodes');
            const endpoint = await getAgentEndpoint(router);

            if (!endpoint) {
                await ctx.reply(`❌ Cannot reach agent for ${router}`);
                return;
            }

            const peerName = `dn42_${asn}`;
            const response = await fetch(`${endpoint}/restart`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.agentToken || ''}`,
                },
                body: JSON.stringify({ peer_name: peerName }),
            });

            if (response.ok) {
                const data = await response.json() as { message?: string; steps?: string[] };
                await ctx.reply(
                    `✅ *Peer Restarted*\n已重启 Peer\n\n` +
                    `AS${asn} @ ${router}\n` +
                    `${data.message || 'BGP session restarted'}`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                const error = await response.text();
                await ctx.reply(`❌ Restart failed: ${error}`);
            }
        } catch (error) {
            console.error('[Restart] Error:', error);
            await ctx.reply(`❌ Failed to restart: ${(error as Error).message}`);
        }
    }

    /**
     * /status - Show WireGuard and BGP status for all peers
     */
    bot.command('status', async (ctx) => {
        const asn = ctx.session.asn;
        if (!asn) {
            await ctx.reply('❌ Please /login first.\n请先登录');
            return;
        }

        await ctx.reply('⏳ Checking status...\n正在检查状态...');

        try {
            // Get user's sessions
            const result = await apiRequest('/admin', 'POST', {
                action: 'enumSessions',
                asn,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.reply(`❌ Error: ${result.message}`);
                return;
            }

            const sessions = (result.data?.sessions || []).filter((s: { status: number }) => s.status === PeeringStatus.ENABLED);

            if (sessions.length === 0) {
                await ctx.reply('ℹ️ You have no active peers.\n你没有活跃的 Peer');
                return;
            }

            // Fetch live status from agents in parallel
            const { getAgentEndpoint } = await import('../providers/nodes');
            type LiveStatus = {
                bgp_status?: string;
                wg_status?: string;
                last_handshake?: string;
                transfer?: { rx: string; tx: string };
                routes_imported?: number;
                routes_exported?: number;
            };

            const fetchPromises = sessions.map(async (session: { router: string; routerName?: string; ipv6?: string; endpoint?: string }) => {
                const router = session.routerName || session.router;
                try {
                    const agentUrl = await getAgentEndpoint(router);
                    if (!agentUrl) return { router, session, live: null };

                    const peerName = `dn42_${asn}`;
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 5000);

                    const resp = await fetch(`${agentUrl}/peer/${peerName}`, {
                        method: 'GET',
                        headers: { 'Authorization': `Bearer ${config.agentToken || ''}` },
                        signal: controller.signal,
                    });
                    clearTimeout(timeout);

                    if (resp.ok) {
                        const data = await resp.json() as LiveStatus;
                        return { router, session, live: data };
                    }
                    return { router, session, live: null };
                } catch {
                    return { router, session, live: null };
                }
            });

            const results = await Promise.allSettled(fetchPromises);

            let statusMessage = `📊 *Status for AS${asn}*\n\n`;

            for (const r of results) {
                if (r.status !== 'fulfilled' || !r.value) continue;
                const { router, session, live } = r.value;

                if (live) {
                    // BGP line
                    const bgpIcon = live.bgp_status === 'Established' ? '🟢' : '🟡';
                    const routeInfo = (live.routes_imported !== undefined && live.routes_exported !== undefined)
                        ? ` (${live.routes_imported}↓ ${live.routes_exported}↑)`
                        : '';
                    statusMessage += `📍 *${router}* ${bgpIcon} ${live.bgp_status || 'unknown'}${routeInfo}\n`;

                    // WG handshake line
                    if (live.last_handshake && live.last_handshake !== 'never') {
                        statusMessage += `   🔒 WG handshake: ${live.last_handshake}\n`;
                    } else {
                        statusMessage += `   ❌ WG: no handshake\n`;
                    }

                    // Transfer line
                    if (live.transfer) {
                        statusMessage += `   📶 Transfer: ↓${live.transfer.rx} ↑${live.transfer.tx}\n`;
                    }
                } else {
                    // Agent unreachable — show DB status
                    statusMessage += `📍 *${router}* 🟢 Active\n`;
                    if (session.ipv6) statusMessage += `   IPv6: \`${session.ipv6}\`\n`;
                    statusMessage += `   ⚠️ Agent unreachable\n`;
                }
                statusMessage += `\n`;
            }

            await ctx.reply(statusMessage.slice(0, 4000), { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('[Status] Error:', error);
            await ctx.reply('❌ Failed to check status.');
        }
    });

    /**
     * /peers - Quick list of all peers (lightweight, no agent calls)
     */
    bot.command('peers', async (ctx) => {
        const args = ctx.match?.trim().split(/\s+/) || [];
        let targetAsn = ctx.session.asn;

        const username = ctx.from?.username?.toLowerCase();
        const adminUsername = config.adminUsername?.toLowerCase().replace('@', '');
        const isAdmin = username === adminUsername || ctx.session.isAdmin === true;

        if (args[0] && isAsnInput(args[0])) {
            if (!isAdmin) {
                await ctx.reply('❌ Only admin can list other ASN peers\n只有管理员可以查看其他 ASN 的 Peer');
                return;
            }
            targetAsn = normalizeAsn(args[0]);
        }

        if (!targetAsn) {
            await ctx.reply('❌ Please /login first.\n请先登录');
            return;
        }

        // Unified inline list (buttons → detail card), same as /peer. No text
        // command hints — every action is a tap. adminMode when viewing another
        // ASN (hides ➕ New Peer, which only makes sense for your own ASN).
        await showPeerList(ctx, targetAsn, targetAsn !== ctx.session.asn);
    });
}
