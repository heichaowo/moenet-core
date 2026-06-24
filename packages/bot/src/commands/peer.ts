import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../index';
import config from '../config';
import { apiRequest } from '../api';
import { isChinaIP, resolveEndpoint, CN_REJECTION_MESSAGE } from '../providers/chinaIp';
import { validateIpOwnership, isLinkLocal, isDN42ULA, isDN42IPv4 } from '../services/dn42Validator';
import { DIVIDER } from '../templates';

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
    BUTTONS,
    isBackButton,
    isAbortButton,
    isFinishButton,
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

    await ctx.reply(
        `🔧 *Modify Peer*\n修改 Peer\n\n` +
        `${headerText}\n\n` +
        currentInfo + `\n\n` +
        `Select the item to be modified:\n选择想要修改的内容:\n\n` +
        `- \`Region\` - Migration to another node\n` +
        `- \`Session Type\` - Change BGP session type\n` +
        `- \`BGP Address\` - Change BGP addresses\n` +
        `- \`Clearnet Endpoint\` - Change WireGuard endpoint\n` +
        `- \`WireGuard PublicKey\` - Change public key\n` +
        `- \`PSK\` - Enable/Disable Pre-Shared Key\n` +
        `- \`MTU\` - Change tunnel MTU\n` +
        `- \`Contact\` - Change contact info\n\n` +
        `- \`Finish modification\` - Submit changes\n` +
        `- \`Abort modification\` - Cancel all changes`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [
                    [{ text: 'Region' }, { text: 'Clearnet Endpoint' }],
                    [{ text: 'Session Type' }, { text: 'WireGuard PublicKey' }],
                    [{ text: 'BGP Address' }, { text: 'PSK' }],
                    [{ text: 'MTU' }, { text: 'Contact' }],
                    [{ text: BUTTONS.FINISH }, { text: BUTTONS.ABORT }],
                ],
                resize_keyboard: true,
                one_time_keyboard: false,
            }
        }
    );
}


/**
 * Show BGP Address sub-menu with ReplyKeyboard
 * Called when user presses Back from a specific BGP address field edit
 */
async function showBgpAddressMenu(ctx: BotContext, flow: NonNullable<BotContext['session']['peerFlow']>) {
    await ctx.reply(
        '🌐 *BGP Address*\n\n' +
        `Current:\n` +
        `• Peer IPv6: \`${flow.current?.ipv6 || 'Not set'}\`\n` +
        `• Peer IPv4: \`${flow.current?.ipv4 || 'Not set'}\`\n` +
        `• Local IPv6: \`${flow.current?.localIpv6 || 'Not set'}\`\n` +
        `• Local IPv4: \`${flow.current?.localIpv4 || 'Not set'}\`\n\n` +
        'Select which to modify:\n选择要修改的项:',
        {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [
                    [{ text: 'Peer IPv6 (对方)' }, { text: 'Peer IPv4 (对方)' }],
                    [{ text: 'Local IPv6 (我方)' }, { text: 'Local IPv4 (我方)' }],
                    [{ text: '🔙 Back' }],
                ],
                resize_keyboard: true,
            }
        }
    );
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
    bot.command('peer', async (ctx) => {
        if (!ctx.session.asn) {
            await ctx.reply('❌ Please /login first.\n请先登录');
            return;
        }

        const asn = ctx.session.asn;

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

                // Add to selectable list if open and has capacity
                const hasCapacity = max === 0 || current < max;
                if (r.isOpen && hasCapacity) {
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
                };

                await ctx.reply(
                    `${msgText}\nOnly one node available, auto-selected \`${selectedLabel}\`\n只有一个可选节点，自动选择`,
                    { parse_mode: 'Markdown' }
                );

                // Show WG info
                await showServerWgInfo(ctx);
                return;
            }

            // Save nodeMap to session
            ctx.session.peerFlow = {
                step: 'select_node',
                nodeMap,
            };

            // Send node list
            await ctx.reply(msgText, { parse_mode: 'Markdown' });

            // Build ReplyKeyboard with one row per option (same as /addpeer)
            const keyboard: { text: string }[][] = couldPeer.map(label => [{ text: label }]);

            // Send selection prompt with ReplyKeyboard
            await ctx.reply(
                'Select node:\n选择节点:',
                {
                    reply_markup: {
                        keyboard,
                        resize_keyboard: true,
                        one_time_keyboard: true,
                    }
                }
            );
        } catch (error) {
            console.error('[Peer] Error:', error);
            await ctx.reply('❌ Failed to fetch nodes.\n获取节点列表失败。');
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

        // Guard: intercept abort/finish buttons in modify sub-steps
        // (modify_menu and modify_confirm handle these themselves)
        if (flow.step?.startsWith('modify_') && flow.step !== 'modify_menu' && flow.step !== 'modify_confirm') {
            if (isAbortButton(text) || text === '/cancel') {
                ctx.session.peerFlow = undefined;
                await ctx.reply(
                    'Abort modification, operation has been canceled.\n放弃修改，操作已取消。',
                    { reply_markup: { remove_keyboard: true } }
                );
                return;
            }
            if (isFinishButton(text)) {
                // Redirect to modify_menu's finish handler
                ctx.session.peerFlow = { ...flow, step: 'modify_menu' };
                // Fall through to switch — modify_menu will handle finish
            }
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

            // ===== Modify menu handlers (dn42-bot style) =====
            case 'modify_menu': {
                const uuid = flow.sessionUuid;
                if (!uuid) {
                    ctx.session.peerFlow = undefined;
                    return;
                }

                // Handle Abort modification
                if (isAbortButton(text) || text === '/cancel') {
                    ctx.session.peerFlow = undefined;
                    await ctx.reply(
                        'Abort modification, operation has been canceled.\n放弃修改，操作已取消。',
                        { reply_markup: { remove_keyboard: true } }
                    );
                    return;
                }

                // Handle Finish modification
                if (isFinishButton(text)) {
                    const backup = flow.backup;
                    const current = flow.current;

                    if (!backup || !current) {
                        ctx.session.peerFlow = undefined;
                        await ctx.reply('❌ Error: No session data', { reply_markup: { remove_keyboard: true } });
                        return;
                    }

                    // Check if any changes were made (including pending migration)
                    const hasFieldChanges = JSON.stringify(backup) !== JSON.stringify(current);
                    const hasMigration = !!flow.pendingMigration;
                    if (!hasFieldChanges && !hasMigration) {
                        ctx.session.peerFlow = undefined;
                        await ctx.reply(
                            'No changes detected, operation cancelled.\n未检测到任何变更，操作已取消。',
                            { reply_markup: { remove_keyboard: true } }
                        );
                        return;
                    }

                    // Build diff text showing changes
                    const diffLines: string[] = [];
                    diffLines.push('Region:');
                    if (flow.pendingMigration) {
                        diffLines.push(`    ${flow.routerName || 'Unknown'}`);
                        diffLines.push('  ->');
                        diffLines.push(`      ${flow.pendingMigration.nodeName}`);
                    } else {
                        diffLines.push(`    ${flow.routerName || 'Unknown'}`);
                    }

                    // Basic section
                    diffLines.push('Basic:');
                    diffLines.push(`    ASN:         ${flow.asn || ''}`);

                    // Session Type (MP-BGP + ENH)
                    const oldSession = backup.mpbgp
                        ? (backup.extendedNexthop ? 'MP-BGP + ENH' : 'MP-BGP Only')
                        : 'IPv6 + IPv4 (独立)';
                    const newSession = current.mpbgp
                        ? (current.extendedNexthop ? 'MP-BGP + ENH' : 'MP-BGP Only')
                        : 'IPv6 + IPv4 (独立)';
                    if (oldSession !== newSession) {
                        diffLines.push(`    Session:     ${oldSession}`);
                        diffLines.push('  ->');
                        diffLines.push(`      ${newSession}`);
                    } else {
                        diffLines.push(`    Session:     ${newSession}`);
                    }

                    // BGP Address section
                    diffLines.push('BGP Address:');

                    // Peer IPv6 diff
                    if (backup.ipv6 !== current.ipv6) {
                        diffLines.push(`    Peer IPv6:   ${backup.ipv6 || 'Not set'}`);
                        diffLines.push('  ->');
                        diffLines.push(`      ${current.ipv6 || 'Not set'}`);
                    } else {
                        diffLines.push(`    Peer IPv6:   ${current.ipv6 || 'Not set'}`);
                    }

                    // Peer IPv4 diff
                    if (backup.ipv4 !== current.ipv4) {
                        diffLines.push(`    Peer IPv4:   ${backup.ipv4 || 'Not set'}`);
                        diffLines.push('  ->');
                        diffLines.push(`      ${current.ipv4 || 'Not set'}`);
                    } else {
                        diffLines.push(`    Peer IPv4:   ${current.ipv4 || 'Not set'}`);
                    }

                    // Local IPv6 diff
                    if (backup.localIpv6 !== current.localIpv6) {
                        diffLines.push(`    Local IPv6:  ${backup.localIpv6 || 'Not set'}`);
                        diffLines.push('  ->');
                        diffLines.push(`      ${current.localIpv6 || 'Not set'}`);
                    } else {
                        diffLines.push(`    Local IPv6:  ${current.localIpv6 || 'Not set'}`);
                    }

                    // Local IPv4 diff
                    if (backup.localIpv4 !== current.localIpv4) {
                        diffLines.push(`    Local IPv4:  ${backup.localIpv4 || 'Not set'}`);
                        diffLines.push('  ->');
                        diffLines.push(`      ${current.localIpv4 || 'Not set'}`);
                    } else {
                        diffLines.push(`    Local IPv4:  ${current.localIpv4 || 'Not set'}`);
                    }

                    // Tunnel section
                    diffLines.push('Tunnel:');

                    // Endpoint diff
                    const oldEndpoint = backup.endpoint
                        ? (backup.port ? `${backup.endpoint}:${backup.port}` : backup.endpoint)
                        : 'Not set';
                    const newEndpoint = current.endpoint
                        ? (current.port ? `${current.endpoint}:${current.port}` : current.endpoint)
                        : 'Not set';
                    if (oldEndpoint !== newEndpoint) {
                        diffLines.push(`    Endpoint:    ${oldEndpoint}`);
                        diffLines.push('  ->');
                        diffLines.push(`      ${newEndpoint}`);
                    } else {
                        diffLines.push(`    Endpoint:    ${newEndpoint}`);
                    }

                    // WG PublicKey diff
                    const oldPubkey = backup.pubkey ? backup.pubkey.slice(0, 20) + '...' : 'Not set';
                    const newPubkey = current.pubkey ? current.pubkey.slice(0, 20) + '...' : 'Not set';
                    if (backup.pubkey !== current.pubkey) {
                        diffLines.push(`    WG Pubkey:   ${oldPubkey}`);
                        diffLines.push('  ->');
                        diffLines.push(`      ${newPubkey}`);
                    } else {
                        diffLines.push(`    WG Pubkey:   ${newPubkey}`);
                    }

                    // PSK diff
                    const oldPsk = backup.psk ? 'Enabled' : 'Disabled';
                    const newPsk = current.psk ? 'Enabled' : 'Disabled';
                    if (backup.psk !== current.psk) {
                        diffLines.push(`    PSK:         ${oldPsk}`);
                        diffLines.push('  ->');
                        diffLines.push(`      ${newPsk}`);
                    } else {
                        diffLines.push(`    PSK:         ${newPsk}`);
                    }

                    // MTU diff
                    if (backup.mtu !== current.mtu) {
                        diffLines.push(`    MTU:         ${backup.mtu}`);
                        diffLines.push('  ->');
                        diffLines.push(`      ${current.mtu}`);
                    } else {
                        diffLines.push(`    MTU:         ${current.mtu}`);
                    }

                    // Contact section
                    diffLines.push('Contact:');
                    if (backup.contact !== current.contact) {
                        diffLines.push(`    ${backup.contact || 'Not set'}`);
                        diffLines.push('  ->');
                        diffLines.push(`      ${current.contact || 'Not set'}`);
                    } else {
                        diffLines.push(`    ${current.contact || 'Not set'}`);
                    }

                    ctx.session.peerFlow = { ...flow, step: 'modify_confirm' };

                    // Hybrid confirmation: InlineKeyboard buttons + text "yes" fallback
                    const confirmKeyboard = new InlineKeyboard()
                        .text('✅ Confirm 确认', 'modify:submit')
                        .text('❌ Cancel 取消', 'modify:cancel');

                    await ctx.reply(
                        'Please check all your information\n请确认你的信息\n\n' +
                        '```ConfirmInfo\n' + diffLines.join('\n') + '\n```\n\n' +
                        'Click button or type `yes` to confirm.\n' +
                        '点击按钮或输入 `yes` 确认。',
                        {
                            parse_mode: 'Markdown',
                            reply_markup: confirmKeyboard
                        }
                    );
                    return;
                }

                // Handle menu options - use ReplyKeyboard for sub-menus (dn42-bot style)
                console.log(`[DEBUG modify_menu] text="${text}", checking switch cases...`);
                switch (text) {
                    case 'Region': {
                        // Fetch available nodes and show as ReplyKeyboard
                        try {
                            const nodeResult = await apiRequest('/admin', 'POST', { action: 'enumRouters' }, config.apiToken);
                            const nodes = nodeResult.data?.routers;
                            if (nodeResult.code === 0 && Array.isArray(nodes)) {
                                // Check if user's current endpoint is a China IP
                                let userIsChinaIp = false;
                                const userEndpoint = flow.current?.endpoint as string | undefined;
                                if (userEndpoint) {
                                    try {
                                        const host = userEndpoint.split(':')[0] || userEndpoint;
                                        const ip = await resolveEndpoint(host);
                                        if (ip && isChinaIP(ip)) userIsChinaIp = true;
                                    } catch { /* ignore resolve errors */ }
                                }

                                const nodeButtons: { text: string }[][] = [];
                                for (const node of [...nodes].sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))) {
                                    // Skip current node, closed nodes, and CN-restricted nodes for CN users
                                    if (node.isOpen === false) continue;
                                    if (node.uuid === flow.sessionUuid) continue;
                                    if (userIsChinaIp && node.allowCnPeers === false) continue;
                                    nodeButtons.push([{ text: `📍 ${node.name} (${node.location || 'Unknown'})` }]);
                                }
                                nodeButtons.push([{ text: '🔙 Back' }]);

                                // Set step for selection
                                ctx.session.peerFlow = { ...flow, step: 'modify_region' };

                                let warning = '';
                                if (userIsChinaIp) {
                                    warning = '\n⚠️ Nodes that block CN IPs are hidden.\n不允许中国大陆 IP 的节点已隐藏。\n';
                                }

                                await ctx.reply(
                                    '🌍 *Migrate to Another Node*\n迁移到另一节点\n\n' +
                                    '⚠️ This will recreate your peer.\n这将重建你的 Peer。\n' +
                                    warning + '\n' +
                                    'Select new node:\n选择新节点:',
                                    { parse_mode: 'Markdown', reply_markup: { keyboard: nodeButtons, resize_keyboard: true } }
                                );
                            } else {
                                await ctx.reply('❌ Failed to fetch nodes\n获取节点列表失败');
                            }
                        } catch {
                            await ctx.reply('❌ Failed to fetch nodes\n获取节点列表失败');
                        }
                        return;
                    }

                    case 'Session Type': {
                        ctx.session.peerFlow = { ...flow, step: 'modify_session_type' };
                        await ctx.reply(
                            '⚙️ *Session Type*\nBGP 会话类型\n\n' +
                            'Current: ' + (flow.current?.mpbgp ? (flow.current?.extendedNexthop ? 'MP-BGP + ENH' : 'MP-BGP Only') : 'IPv6 + IPv4 独立会话') + '\n\n' +
                            'Select session type:\n选择会话类型:',
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    keyboard: [
                                        [{ text: 'MP-BGP + ENH (推荐)' }],
                                        [{ text: 'MP-BGP Only' }],
                                        [{ text: 'IPv6 + IPv4 (独立会话)' }],
                                        [{ text: '🔙 Back' }],
                                    ],
                                    resize_keyboard: true,
                                }
                            }
                        );
                        return;
                    }

                    case 'BGP Address': {
                        ctx.session.peerFlow = { ...flow, step: 'modify_bgp_address' };
                        await ctx.reply(
                            '🌐 *BGP Address*\n\n' +
                            `Current:\n` +
                            `• Peer IPv6: \`${flow.current?.ipv6 || 'Not set'}\`\n` +
                            `• Peer IPv4: \`${flow.current?.ipv4 || 'Not set'}\`\n` +
                            `• Local IPv6: \`${flow.current?.localIpv6 || 'Not set'}\`\n` +
                            `• Local IPv4: \`${flow.current?.localIpv4 || 'Not set'}\`\n\n` +
                            'Select which to modify:\n选择要修改的项:',
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    keyboard: [
                                        [{ text: 'Peer IPv6 (对方)' }, { text: 'Peer IPv4 (对方)' }],
                                        [{ text: 'Local IPv6 (我方)' }, { text: 'Local IPv4 (我方)' }],
                                        [{ text: '🔙 Back' }],
                                    ],
                                    resize_keyboard: true,
                                }
                            }
                        );
                        return;
                    }

                    case 'PSK': {
                        ctx.session.peerFlow = { ...flow, step: 'modify_psk' };
                        const pskButtons = flow.current?.psk
                            ? [[{ text: '🔄 Regenerate PSK' }], [{ text: '❌ Disable PSK' }], [{ text: '🔙 Back' }]]
                            : [[{ text: '🔄 Enable & Generate PSK' }], [{ text: '🔙 Back' }]];
                        await ctx.reply(
                            '🔐 *PSK Settings*\n\n' +
                            `Current: \`${flow.current?.psk ? 'Enabled' : 'Not enabled'}\`\n\n` +
                            'Select action:\n选择操作:',
                            {
                                parse_mode: 'Markdown',
                                reply_markup: { keyboard: pskButtons, resize_keyboard: true }
                            }
                        );
                        return;
                    }

                    case 'MTU': {
                        ctx.session.peerFlow = { ...flow, step: 'modify_mtu' };
                        await ctx.reply(
                            '📏 *MTU Settings*\n\n' +
                            `Current: \`${flow.current?.mtu || 1420}\`\n\n` +
                            'Select common MTU or enter custom value (1280-1500):\n' +
                            '选择常用 MTU 或输入自定义值:',
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    keyboard: [
                                        [{ text: '1420 (Default)' }, { text: '1400' }],
                                        [{ text: '1380' }, { text: '1360' }],
                                        [{ text: '1340' }, { text: '1320' }],
                                        [{ text: '🔙 Back' }],
                                    ],
                                    resize_keyboard: true,
                                }
                            }
                        );
                        return;
                    }

                    case 'Clearnet Endpoint': {
                        ctx.session.peerFlow = { ...flow, step: 'modify_endpoint' };
                        await ctx.reply(
                            '📡 *Modify Endpoint*\n\n' +
                            'Enter new endpoint (host:port) or "none":\n' +
                            '输入新端点 (域名:端口) 或 "none":',
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    keyboard: [
                                        [{ text: 'None (NAT)' }],
                                        [{ text: '🔙 Back' }],
                                    ],
                                    resize_keyboard: true,
                                }
                            }
                        );
                        return;
                    }

                    case 'WireGuard PublicKey': {
                        ctx.session.peerFlow = { ...flow, step: 'modify_pubkey' };
                        await ctx.reply(
                            '🔑 *Modify Public Key*\n\n' +
                            'Enter new WireGuard public key:\n' +
                            '输入新的 WireGuard 公钥:',
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    keyboard: [[{ text: '🔙 Back' }]],
                                    resize_keyboard: true,
                                }
                            }
                        );
                        return;
                    }

                    case 'Contact': {
                        ctx.session.peerFlow = { ...flow, step: 'modify_contact' };
                        await ctx.reply(
                            '📞 *Modify Contact*\n修改联系方式\n\n' +
                            'Enter new contact info:\n' +
                            '输入新的联系方式:\n\n' +
                            'Example: Telegram @username, Email, etc.',
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    keyboard: [[{ text: '🔙 Back' }]],
                                    resize_keyboard: true,
                                }
                            }
                        );
                        return;
                    }
                }

                // Unknown input - show menu again
                await ctx.reply('❓ Please select from the menu.\n请从菜单中选择。');
                return;
            }

            case 'modify_confirm': {
                if (text.toLowerCase() !== 'yes') {
                    ctx.session.peerFlow = undefined;
                    await ctx.reply('Modification cancelled.\n修改已取消。');
                    return;
                }

                // Submit all changes to API
                if (!flow.sessionUuid || !flow.current) {
                    ctx.session.peerFlow = undefined;
                    await ctx.reply('❌ Error: No session data\n错误：缺少会话数据');
                    return;
                }

                try {
                    const result = await submitModifyChanges(flow);

                    if (!result.success) {
                        await ctx.reply(`❌ ${result.message}`, { reply_markup: { remove_keyboard: true } });
                        ctx.session.peerFlow = undefined;
                        return;
                    }

                    if (result.migrated) {
                        await ctx.reply(
                            `✅ *Changes submitted \& migration initiated!*\n` +
                            `修改已提交，迁移已启动！\n\n` +
                            `From: \`${flow.routerName}\` → To: \`${flow.pendingMigration!.nodeName}\`\n\n` +
                            `⏳ Peer is being recreated on the new node.\n` +
                            `Peer 正在新节点上重建。\n\n` +
                            `You will be notified when it's ready.\n` +
                            `就绪后会通知你。\n\n` +
                            `Use \`/info\` to check your new WG config.\n` +
                            `使用 \`/info\` 查看新的 WG 配置信息。`,
                            { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
                        );

                        // Store deferred migration notification
                        const asn = flow.isAdminMode ? flow.targetAsn : ctx.session.asn;
                        if (asn) {
                            await apiRequest('/admin', 'POST', {
                                action: 'storeMigrationNotify',
                                asns: [asn],
                                fromRouter: flow.routerName || 'Unknown',
                                toRouter: flow.pendingMigration!.nodeName,
                                adminChatId: undefined, // Self-service, no admin chat
                            }, config.apiToken);
                        }
                    } else {
                        await ctx.reply(
                            `✅ Modification submitted successfully!\n` +
                            `修改已成功提交！\n\n` +
                            `Node: \`${flow.routerName}\`\n` +
                            `Changes will be applied within a few minutes.\n` +
                            `更改将在几分钟内生效。`,
                            { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
                        );
                    }
                } catch (error) {
                    console.error('[modify_confirm] Error:', error);
                    await ctx.reply(`❌ Failed to submit changes: ${error instanceof Error ? error.message : 'Unknown error'}`, { reply_markup: { remove_keyboard: true } });
                }
                ctx.session.peerFlow = undefined;
                return;
            }

            // === New ReplyKeyboard-based step handlers ===

            case 'modify_region': {
                if (isBackButton(text)) {
                    await showModifyMenu(ctx);
                    return;
                }

                // Parse node selection (format: "📍 nodeName (location)")
                const nodeMatch = text.match(/📍\s*(.+?)\s*\(/);
                if (!nodeMatch) {
                    await ctx.reply('❌ Invalid selection. Please choose from the menu.\n无效选项，请从菜单中选择。');
                    return;
                }

                const selectedNodeName = nodeMatch[1]!.trim();

                // Fetch nodes to get UUID
                try {
                    const nodeResult = await apiRequest('/admin', 'POST', { action: 'enumRouters' }, config.apiToken);
                    const nodes = nodeResult.data?.routers || [];
                    const targetNode = nodes.find((n: { name: string }) => n.name === selectedNodeName);

                    if (!targetNode) {
                        await ctx.reply('❌ Node not found. Please try again.\n未找到节点，请重试。');
                        return;
                    }

                    // Store pending migration (will execute on confirm)
                    ctx.session.peerFlow = {
                        ...flow,
                        step: 'modify_menu',
                        pendingMigration: {
                            nodeUuid: targetNode.uuid,
                            nodeName: selectedNodeName,
                        },
                    };

                    await ctx.reply(
                        `✅ Region change queued: → \`${selectedNodeName}\`\n` +
                        `区域变更已暂存: → \`${selectedNodeName}\`\n\n` +
                        `⚠️ Migration will execute after you confirm all changes.\n` +
                        `迁移将在你确认所有更改后执行。`,
                        { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
                    );
                } catch {
                    await ctx.reply('❌ Failed to fetch node info\n获取节点信息失败');
                }

                await showModifyMenu(ctx);
                return;
            }

            case 'modify_session_type': {
                if (isBackButton(text)) {
                    await showModifyMenu(ctx);
                    return;
                }

                const current = flow.current;
                if (!current) {
                    await showModifyMenu(ctx);
                    return;
                }

                if (text.includes('MP-BGP + ENH')) {
                    current.mpbgp = true;
                    current.extendedNexthop = true;
                    await ctx.reply('✅ Session type updated: MP-BGP + ENH\n会话类型已更新');
                } else if (text.includes('MP-BGP Only')) {
                    current.mpbgp = true;
                    current.extendedNexthop = false;
                    await ctx.reply('✅ Session type updated: MP-BGP Only\n会话类型已更新');
                } else if (text.includes('IPv6 + IPv4')) {
                    current.mpbgp = false;
                    current.extendedNexthop = false;
                    await ctx.reply('✅ Session type updated: IPv6 + IPv4 (独立会话)\n会话类型已更新');
                } else {
                    await ctx.reply('❌ Invalid selection\n无效选项');
                    return;
                }

                ctx.session.peerFlow = { ...flow, current };
                await showModifyMenu(ctx);
                return;
            }

            case 'modify_bgp_address': {
                if (isBackButton(text)) {
                    await showModifyMenu(ctx);
                    return;
                }

                const current = flow.current;
                if (!current) {
                    await showModifyMenu(ctx);
                    return;
                }

                if (text.includes('Peer IPv6')) {
                    ctx.session.peerFlow = { ...flow, step: 'modify_peerIpv6' };
                    await ctx.reply(
                        '🌐 *Modify Peer IPv6*\n\n' +
                        `Current: \`${current.ipv6 || 'Not set'}\`\n\n` +
                        'Supported types:\n' +
                        '• fe80::/64 Link-Local\n' +
                        '• fd00::/8 or fc00::/7 ULA\n\n' +
                        'Enter new IPv6:\n输入新的 IPv6:',
                        { parse_mode: 'Markdown' }
                    );
                } else if (text.includes('Peer IPv4')) {
                    ctx.session.peerFlow = { ...flow, step: 'modify_peerIpv4' };
                    await ctx.reply(
                        '🌐 *Modify Peer IPv4*\n\n' +
                        `Current: \`${current.ipv4 || 'Not set'}\`\n\n` +
                        'Supported ranges:\n' +
                        '• 172.20.0.0/14 (DN42)\n' +
                        '• 10.127.0.0/16 (DN42)\n' +
                        '• Enter "none" to disable\n\n' +
                        'Enter new IPv4:\n输入新的 IPv4:',
                        { parse_mode: 'Markdown' }
                    );
                } else if (text.includes('Local IPv6')) {
                    ctx.session.peerFlow = { ...flow, step: 'modify_localIpv6' };
                    await ctx.reply(
                        '🌐 *Modify Local IPv6*\n\n' +
                        `Current: \`${current.localIpv6 || 'Not set'}\`\n\n` +
                        'Enter our IPv6 address for BGP peering:\n' +
                        '输入我方用于 BGP 对等的 IPv6 地址:',
                        { parse_mode: 'Markdown' }
                    );
                } else if (text.includes('Local IPv4')) {
                    ctx.session.peerFlow = { ...flow, step: 'modify_localIpv4' };
                    await ctx.reply(
                        '🌐 *Modify Local IPv4*\n\n' +
                        `Current: \`${current.localIpv4 || 'Not set'}\`\n\n` +
                        'Enter our IPv4 address for BGP peering:\n' +
                        '输入我方用于 BGP 对等的 IPv4 地址:',
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    await ctx.reply('❌ Invalid selection\n无效选项');
                }
                return;
            }

            case 'modify_psk': {
                if (isBackButton(text)) {
                    await showModifyMenu(ctx);
                    return;
                }

                const current = flow.current;
                if (!current) {
                    await showModifyMenu(ctx);
                    return;
                }

                if (text.includes('Generate') || text.includes('Enable')) {
                    // Generate new PSK
                    const psk = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
                    current.psk = true;
                    ctx.session.peerFlow = { ...flow, current, psk };
                    await ctx.reply(
                        '🔑 *PSK Generated*\n已生成 PSK\n\n' +
                        `\`${psk}\`\n\n` +
                        '⚠️ Save this key! You need to configure it on your side.\n' +
                        '请保存此密钥，稍后需要在你这边配置。',
                        { parse_mode: 'Markdown' }
                    );
                } else if (text.includes('Disable')) {
                    current.psk = false;
                    ctx.session.peerFlow = { ...flow, current };
                    await ctx.reply('✅ PSK disabled\nPSK 已禁用');
                } else {
                    await ctx.reply('❌ Invalid selection\n无效选项');
                    return;
                }

                await showModifyMenu(ctx);
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
                        const action = flow.isAdminMode ? 'adminCreate' : 'create';
                        const result = await apiRequest('/admin', 'POST', {
                            action,
                            asn,
                            router: flow.sessionUuid,
                            ipv6: flow.ipv6,
                            endpoint: flow.endpoint && flow.port ? `${flow.endpoint}:${flow.port}` : undefined,
                            publicKey: flow.publicKey,
                            mtu: flow.mtu || 1420,
                            psk: flow.psk,
                            status: flow.isAdminMode ? 1 : undefined,
                        }, config.apiToken);

                        if (result.code !== 0) {
                            await ctx.reply(`❌ Failed to create peer: ${result.message}`);
                            ctx.session.peerFlow = undefined;
                            return;
                        }

                        const sessionUuid = result.data?.uuid || '';

                        const statusText = flow.isAdminMode
                            ? `✅ Status: ACTIVE (免审核)`
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
                        if (!flow.isAdminMode && config.adminChatId) {
                            const adminNotification =
                                `🔔 *New Peer Request*\n新的 Peer 申请\n\n` +
                                `🆔 ASN: \`AS${asn}\`\n` +
                                `📍 Node: \`${flow.routerName}\`\n` +
                                `🌐 IPv6: \`${flow.ipv6}\`\n` +
                                `📡 Endpoint: ${flow.endpoint ? `\`${flow.endpoint}:${flow.port}\`` : 'NAT'}\n` +
                                (flow.contact ? `📞 Contact: \`${flow.contact}\`\n` : '') +
                                `\nUse /pending to review all`;

                            const keyboard = new InlineKeyboard()
                                .text('✅ Approve', `approve:${sessionUuid}`)
                                .text('❌ Reject', `reject:${sessionUuid}`)
                                .row()
                                .text('📋 All Pending', 'admin:pending');

                            for (let attempt = 1; attempt <= 3; attempt++) {
                                try {
                                    await ctx.api.sendMessage(config.adminChatId, adminNotification, {
                                        parse_mode: 'Markdown',
                                        reply_markup: keyboard,
                                    });
                                    break;
                                } catch (e) {
                                    console.error(`[Notify Admin] Attempt ${attempt}/3 failed:`, e);
                                    if (attempt < 3) {
                                        await new Promise(r => setTimeout(r, attempt * 2000));
                                    }
                                }
                            }
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

            // Modify handlers
            case 'modify_ipv6': {
                if (isBackButton(text)) {
                    await showModifyMenu(ctx);
                    return;
                }
                const ipv6 = text.includes('/') ? text.split('/')[0] : text;
                if (!isValidIPv6(ipv6 || '')) {
                    await ctx.reply('❌ Invalid IPv6 address. Please try again.');
                    return;
                }

                try {
                    const result = await apiRequest('/admin', 'POST', {
                        action: 'updateSession',
                        uuid: flow.sessionUuid,
                        ipv6,
                    }, config.apiToken);

                    if (result.code !== 0) {
                        await ctx.reply(`❌ Failed: ${result.message}`);
                    } else {
                        await ctx.reply(`✅ IPv6 updated to \`${ipv6}\`\nIPv6 已更新`, { parse_mode: 'Markdown' });
                    }
                } catch (e) {
                    await ctx.reply('❌ Update failed');
                }
                ctx.session.peerFlow = undefined;
                break;
            }

            case 'modify_endpoint': {
                if (isBackButton(text)) {
                    await showModifyMenu(ctx);
                    return;
                }
                const current = flow.current;
                if (!current) {
                    await showModifyMenu(ctx);
                    return;
                }

                let endpoint = '';
                let port = '';

                if (text.toLowerCase() !== 'none') {
                    // Parse endpoint:port
                    if (text.includes(':')) {
                        const parts = text.split(':');
                        const lastPart = parts.pop();
                        if (lastPart && /^\d+$/.test(lastPart)) {
                            port = lastPart;
                            endpoint = parts.join(':');
                        } else {
                            endpoint = text;
                        }
                    } else {
                        endpoint = text;
                    }
                }

                const oldEndpoint = flow.backup?.endpoint
                    ? (flow.backup?.port ? `${flow.backup.endpoint}:${flow.backup.port}` : flow.backup.endpoint)
                    : 'none';
                const newEndpoint = endpoint ? (port ? `${endpoint}:${port}` : endpoint) : 'none';

                current.endpoint = endpoint;
                current.port = port;
                ctx.session.peerFlow = { ...flow, current };
                await ctx.reply(`✅ Endpoint updated!\n端点已更新\n\n\`${oldEndpoint}\` → \`${newEndpoint}\``, { parse_mode: 'Markdown' });
                await showModifyMenu(ctx);
                return;
            }

            case 'modify_pubkey': {
                if (isBackButton(text)) {
                    await showModifyMenu(ctx);
                    return;
                }
                if (!isValidWgPubkey(text)) {
                    await ctx.reply('❌ Invalid public key. Should be 44 chars ending with =');
                    return;
                }

                const current = flow.current;
                if (!current) {
                    await showModifyMenu(ctx);
                    return;
                }

                const oldPubkey = flow.backup?.pubkey ? flow.backup.pubkey.slice(0, 20) + '...' : 'Not set';
                const newPubkey = text.slice(0, 20) + '...';

                current.pubkey = text;
                ctx.session.peerFlow = { ...flow, current };
                await ctx.reply(`✅ Public key updated!\n公钥已更新\n\n\`${oldPubkey}\` → \`${newPubkey}\``, { parse_mode: 'Markdown' });
                await showModifyMenu(ctx);
                return;
            }

            case 'modify_mtu': {
                // Handle '🔙 Back'
                if (isBackButton(text)) {
                    await showModifyMenu(ctx);
                    return;
                }

                // Parse MTU from text (handle "1420 (Default)" format)
                const mtuMatch = text.match(/^(\d+)/);
                const mtu = mtuMatch ? parseInt(mtuMatch[1]!, 10) : parseInt(text, 10);
                if (isNaN(mtu) || mtu < 1280 || mtu > 1500) {
                    await ctx.reply('❌ Invalid MTU. Please enter 1280-1500.');
                    return;
                }

                const current = flow.current;
                if (!current) {
                    await showModifyMenu(ctx);
                    return;
                }

                const oldMtu = flow.backup?.mtu || 1420;
                current.mtu = mtu;
                ctx.session.peerFlow = { ...flow, current };
                await ctx.reply(`✅ MTU updated!\nMTU 已更新\n\n\`${oldMtu}\` → \`${mtu}\``, { parse_mode: 'Markdown' });
                await showModifyMenu(ctx);
                return;
            }

            // New field handlers
            case 'modify_peerIpv6': {
                if (isBackButton(text)) {
                    ctx.session.peerFlow = { ...flow, step: 'modify_bgp_address' };
                    await showBgpAddressMenu(ctx, flow);
                    return;
                }
                // Validate IPv6 format
                const ipv6 = text.trim();
                if (!/^(fe80:|fd[0-9a-f]{2}:|fc[0-9a-f]{2}:)/i.test(ipv6)) {
                    await ctx.reply('❌ Invalid IPv6. Use Link-Local (fe80::) or ULA (fd00::/fc00::)');
                    return;
                }

                const current = flow.current;
                if (!current) {
                    await showModifyMenu(ctx);
                    return;
                }

                const oldIpv6 = flow.backup?.ipv6 || 'Not set';
                current.ipv6 = ipv6;
                ctx.session.peerFlow = { ...flow, current };
                await ctx.reply(`✅ Peer IPv6 updated!\n对方 IPv6 已更新\n\n\`${oldIpv6}\` → \`${ipv6}\``, { parse_mode: 'Markdown' });
                await showModifyMenu(ctx);
                return;
            }

            case 'modify_peerIpv4': {
                if (isBackButton(text)) {
                    ctx.session.peerFlow = { ...flow, step: 'modify_bgp_address' };
                    await showBgpAddressMenu(ctx, flow);
                    return;
                }
                const ipv4 = text.trim().toLowerCase();
                if (ipv4 !== 'none' && !/^172\.(2[0-3]|1[6-9])\./.test(ipv4)) {
                    await ctx.reply('❌ Invalid DN42 IPv4. Use 172.20.x.x - 172.23.x.x or "none"');
                    return;
                }

                const current = flow.current;
                if (!current) {
                    await showModifyMenu(ctx);
                    return;
                }

                const oldIpv4 = flow.backup?.ipv4 || 'Not set';
                const newIpv4 = ipv4 === 'none' ? 'none' : ipv4;
                current.ipv4 = ipv4 === 'none' ? '' : ipv4;
                ctx.session.peerFlow = { ...flow, current };
                await ctx.reply(`✅ Peer IPv4 updated!\n对方 IPv4 已更新\n\n\`${oldIpv4}\` → \`${newIpv4}\``, { parse_mode: 'Markdown' });
                await showModifyMenu(ctx);
                return;
            }

            case 'modify_localIpv6': {
                if (isBackButton(text)) {
                    ctx.session.peerFlow = { ...flow, step: 'modify_bgp_address' };
                    await showBgpAddressMenu(ctx, flow);
                    return;
                }
                const ipv6 = text.trim();
                if (!/^(fe80:|fd[0-9a-f]{2}:|fc[0-9a-f]{2}:)/i.test(ipv6)) {
                    await ctx.reply('❌ Invalid IPv6. Use Link-Local (fe80::) or ULA (fd00::/fc00::)');
                    return;
                }

                const current = flow.current;
                if (!current) {
                    await showModifyMenu(ctx);
                    return;
                }

                const oldLocalIpv6 = flow.backup?.localIpv6 || 'Not set';
                current.localIpv6 = ipv6;
                ctx.session.peerFlow = { ...flow, current };
                await ctx.reply(`✅ Local IPv6 updated!\n我方 IPv6 已更新\n\n\`${oldLocalIpv6}\` → \`${ipv6}\``, { parse_mode: 'Markdown' });
                await showModifyMenu(ctx);
                return;
            }

            case 'modify_localIpv4': {
                if (isBackButton(text)) {
                    ctx.session.peerFlow = { ...flow, step: 'modify_bgp_address' };
                    await showBgpAddressMenu(ctx, flow);
                    return;
                }
                const ipv4 = text.trim().toLowerCase();
                if (ipv4 !== 'none' && !/^172\.(2[0-3]|1[6-9])\./.test(ipv4)) {
                    await ctx.reply('❌ Invalid DN42 IPv4. Use 172.20.x.x - 172.23.x.x or "none"');
                    return;
                }

                const current = flow.current;
                if (!current) {
                    await showModifyMenu(ctx);
                    return;
                }

                const oldLocalIpv4 = flow.backup?.localIpv4 || 'Not set';
                const newLocalIpv4 = ipv4 === 'none' ? 'none' : ipv4;
                current.localIpv4 = ipv4 === 'none' ? '' : ipv4;
                ctx.session.peerFlow = { ...flow, current };
                await ctx.reply(`✅ Local IPv4 updated!\n我方 IPv4 已更新\n\n\`${oldLocalIpv4}\` → \`${newLocalIpv4}\``, { parse_mode: 'Markdown' });
                await showModifyMenu(ctx);
                return;
            }

            case 'modify_contact': {
                if (isBackButton(text)) {
                    await showModifyMenu(ctx);
                    return;
                }
                const contact = text.trim();
                if (contact.length < 3 || contact.length > 200) {
                    await ctx.reply('❌ Contact must be 3-200 characters');
                    return;
                }

                const current = flow.current;
                if (!current) {
                    await showModifyMenu(ctx);
                    return;
                }

                const oldContact = flow.backup?.contact || 'Not set';
                current.contact = contact;
                ctx.session.peerFlow = { ...flow, current };
                await ctx.reply(`✅ Contact updated!\n联系方式已更新\n\n\`${oldContact}\` → \`${contact}\``, { parse_mode: 'Markdown' });
                await showModifyMenu(ctx);
                return;
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
            const result = useAdminApi
                ? await apiRequest('/admin', 'POST', { action: 'enumSessions', asn: targetAsn }, config.apiToken)
                : await apiRequest('/session', 'POST', { action: 'list', asn: targetAsn });

            if (result.code !== 0) {
                await ctx.reply(`❌ Error: ${result.message}`);
                return;
            }

            const sessions: Array<{ uuid: string; router: string; routerName?: string; status: number; ipv6?: string; endpoint?: string; serverEndpoint?: string; serverWgKey?: string }> = result.data?.sessions || [];

            if (sessions.length === 0) {
                await ctx.reply(
                    `📊 *Peer Info for AS${targetAsn}*\n\n` +
                    `No peers found.\n没有 Peer\n\n` +
                    `Use /peer to create one.\n使用 /peer 创建。`,
                    { parse_mode: 'Markdown' }
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

            const activeSessions = sessions.filter(s => s.status === 1);
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
                const statusIcon = s.status === 1 ? '🟢' : s.status === 3 ? '⏳' : '❌';
                const statusText = s.status === 1 ? 'Active' : s.status === 3 ? 'Pending' : 'Inactive';
                const displayName = s.routerName || s.router;

                message += `*${i + 1}. ${displayName}* ${statusIcon} ${statusText}\n`;

                if (s.ipv6) message += `   IPv6: \`${s.ipv6}\`\n`;
                if (s.endpoint) message += `   ${useAdminApi ? 'Peer' : 'Your'} Endpoint: \`${s.endpoint}\`\n`;
                if (s.serverEndpoint) message += `   🖥️ Server Endpoint: \`${s.serverEndpoint}\`\n`;
                if (s.serverWgKey) message += `   🔑 Server Key: \`${s.serverWgKey.slice(0, 10)}...\`\n`;

                // Live status from agent
                if (s.status === 1) {
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
                .text('🔧 Modify 修改', 'info:modify');

            await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard });
        } catch (error) {
            console.error('[Info] Error:', error);
            await ctx.reply('❌ Failed to fetch peer info.\n获取 Peer 信息失败。');
        }
    }

    // Handle info:refresh — re-fetch with the same ASN
    bot.callbackQuery(/^info:refresh:(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery('Refreshing... 刷新中...');
        const targetAsn = parseInt(ctx.match[1]!, 10);

        const username = ctx.from?.username?.toLowerCase();
        const adminUsername = config.adminUsername?.toLowerCase().replace('@', '');
        const useAdminApi = username === adminUsername || ctx.session.isAdmin === true;

        await fetchAndDisplayInfo(ctx, targetAsn, useAdminApi);
    });

    bot.callbackQuery('info:modify', async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.reply('Use /modify to modify a peer\n使用 /modify 修改 Peer');
    });

    /**
     * /modify - Modify existing peer
     */
    bot.command('modify', async (ctx) => {
        // Check if admin specifying ASN
        const args = ctx.match?.trim().split(/\s+/) || [];
        let targetAsn = ctx.session.asn;
        let isAdminMode = false;

        const username = ctx.from?.username?.toLowerCase();
        const adminUsername = config.adminUsername?.toLowerCase().replace('@', '');
        const isAdmin = username === adminUsername || ctx.session.isAdmin === true;

        if (args[0] && isAsnInput(args[0])) {
            if (!isAdmin) {
                await ctx.reply('❌ Only admin can modify other ASN peers\n只有管理员可以修改其他 ASN 的 Peer');
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
            const result = isAdminMode
                ? await apiRequest('/admin', 'POST', { action: 'enumSessions', asn: targetAsn }, config.apiToken)
                : await apiRequest('/session', 'POST', { action: 'list', asn: targetAsn });

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

            // Build current info display
            const channel = hasMpbgp ? 'IPv6 & IPv4' : 'IPv6 only';
            const mpbgpText = hasMpbgp ? (hasEnh ? 'IPv6 (ENH)' : 'IPv6') : 'Not supported';
            const endpointDisplay = resolvedHost
                ? (resolvedPort ? `${resolvedHost}:${resolvedPort}` : resolvedHost)
                : 'Not set';

            const currentInfo =
                `\`\`\`CurrentInfo\n` +
                `Region:\n` +
                `    ${session.routerName || session.router || 'Unknown'}\n` +
                `Basic:\n` +
                `    ASN:         ${session.asn}\n` +
                `    Channel:     ${channel}\n` +
                `    MP-BGP:      ${mpbgpText}\n` +
                `    Peer IPv6:   ${session.ipv6 || 'Not set'}\n` +
                `    Peer IPv4:   ${session.ipv4 || 'Not set'}\n` +
                `    Local IPv6:  ${session.ipv6LinkLocal || 'Not set'}\n` +
                `    Local IPv4:  ${session.localIpv4 || 'Not set'}\n` +
                `Tunnel:\n` +
                `    Endpoint:    ${endpointDisplay}\n` +
                `    PublicKey:   ${pubkey ? pubkey.slice(0, 20) + '...' : 'Not set'}\n` +
                `    PSK:         ${hasPsk ? 'Enabled' : 'Not enabled'}\n` +
                `    MTU:         ${session.mtu || 1420}\n` +
                `Contact:\n` +
                `    ${session.contact || 'Not set'}\n` +
                `\`\`\``;

            // Delete old message and send new one with ReplyKeyboard
            await ctx.deleteMessage();

            // Send ReplyKeyboard menu (dn42-bot style)
            await ctx.reply(
                `🔧 *Modify Peer*\n修改 Peer\n\n` +
                `Current information is as follows\n当前信息如下\n\n` +
                currentInfo + `\n\n` +
                `Select the item to be modified:\n选择想要修改的内容:\n\n` +
                `- \`Region\` - Migration to another node\n` +
                `- \`Session Type\` - Change BGP session type\n` +
                `- \`BGP Address\` - Change BGP addresses\n` +
                `- \`Clearnet Endpoint\` - Change WireGuard endpoint\n` +
                `- \`WireGuard PublicKey\` - Change public key\n` +
                `- \`PSK\` - Enable/Disable Pre-Shared Key\n` +
                `- \`MTU\` - Change tunnel MTU\n` +
                `- \`Contact\` - Change contact info\n\n` +
                `- \`Finish modification\` - Submit changes\n` +
                `- \`Abort modification\` - Cancel all changes`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        keyboard: [
                            [{ text: 'Region' }, { text: 'Clearnet Endpoint' }],
                            [{ text: 'Session Type' }, { text: 'WireGuard PublicKey' }],
                            [{ text: 'BGP Address' }, { text: 'PSK' }],
                            [{ text: 'MTU' }, { text: 'Contact' }],
                            [{ text: 'Finish modification' }, { text: 'Abort modification' }],
                        ],
                        resize_keyboard: true,
                        one_time_keyboard: false,
                    }
                }
            );
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
                                keyboard.text(`📍 ${node.name}`, `modify:region:${uuid}:${node.uuid}`).row();
                            }
                        }
                        keyboard.text('🚫 Cancel 取消', 'modify:cancel');
                    }
                } catch {
                    promptText = `❌ Failed to fetch nodes\n获取节点列表失败`;
                }
                ctx.session.peerFlow = undefined; // Uses buttons
                break;
            case 'sessionType':
                promptText = `⚙️ *Session Type*\nBGP 会话类型\n\n` +
                    `Select session type:\n选择会话类型:`;
                keyboard = new InlineKeyboard()
                    .text('MP-BGP + ENH (推荐)', `modify:sessionType:${uuid}:mpbgp_enh`).row()
                    .text('MP-BGP Only', `modify:sessionType:${uuid}:mpbgp`).row()
                    .text('IPv6 + IPv4 独立会话', `modify:sessionType:${uuid}:separate`).row()
                    .text('🚫 Cancel 取消', 'modify:cancel');
                ctx.session.peerFlow = undefined; // Uses buttons
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
            const result = isAdminMode
                ? await apiRequest('/admin', 'POST', { action: 'enumSessions', asn: targetAsn }, config.apiToken)
                : await apiRequest('/session', 'POST', { action: 'list', asn: targetAsn });

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

            const sessions = (result.data?.sessions || []).filter((s: { status: number }) => s.status === 1);

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

            const sessions = (result.data?.sessions || []).filter((s: { status: number }) => s.status === 1);

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

        try {
            const result = await apiRequest('/admin', 'POST', {
                action: 'enumSessions',
                asn: targetAsn,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.reply(`❌ Error: ${result.message}`);
                return;
            }

            const sessions: Array<{
                uuid: string;
                router: string;
                routerName?: string;
                status: number;
            }> = result.data?.sessions || [];

            if (sessions.length === 0) {
                await ctx.reply(
                    `📋 *Peers for AS${targetAsn}*\n\n` +
                    `No peers found. Use /peer to create one.\n` +
                    `没有 Peer，使用 /peer 创建。`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            const STATUS_MAP: Record<number, string> = {
                0: '❌ Inactive',
                1: '🟢 Active',
                2: '🔴 Failed',
                3: '⏳ Pending',
                4: '🔄 Migrating',
                5: '🗑️ Deleting',
            };

            let message = `📋 *Peers for AS${targetAsn}* (${sessions.length})\n\n`;

            for (const s of sessions) {
                const displayName = s.routerName || s.router;
                const status = STATUS_MAP[s.status] || `❓ Unknown(${s.status})`;
                message += `• \`${displayName}\` — ${status}\n`;
            }

            message += `\nUse /info for details, /modify to change, /remove to delete.`;

            await ctx.reply(message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('[Peers] Error:', error);
            await ctx.reply('❌ Failed to fetch peers.');
        }
    });
}
