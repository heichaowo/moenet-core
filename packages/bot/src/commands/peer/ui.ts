/**
 * Peer UI Components
 * 
 * Reusable UI prompt functions for peer creation and modification flows.
 * Uses ReplyKeyboard for wizard steps (better UX) and InlineKeyboard only for final confirmation.
 */

import { Keyboard, InlineKeyboard } from 'grammy';
import type { BotContext } from '../../index';
import { fetchContacts } from '../../services/dn42Registry';

/**
 * Show server WireGuard info with ReplyKeyboard continue button
 */
export async function showServerWgInfo(ctx: BotContext): Promise<void> {
    const flow = ctx.session.peerFlow;
    if (!flow) return;

    const infoText =
        `🔧 *Server WireGuard Info*\n服务器 WireGuard 信息\n\n` +
        `📍 Node: \`${flow.routerName}\`\n` +
        `🌐 Endpoint: \`${flow.serverEndpoint}:${flow.serverPort}\`\n` +
        `🔑 PublicKey: \`${flow.serverPubkey}\`\n` +
        `📶 LLA: \`${flow.serverLla}\`\n\n` +
        `请使用以上信息配置你的 WireGuard\n` +
        `Use above info to configure your WireGuard`;

    // Use ReplyKeyboard for wizard flow
    const keyboard = new Keyboard()
        .text('Continue ➡️ 继续')
        .resized()
        .oneTime();

    ctx.session.peerFlow = { ...flow, step: 'await_continue' };

    await ctx.reply(infoText, { parse_mode: 'Markdown', reply_markup: keyboard });
}

/**
 * Prompt for session type selection with ReplyKeyboard
 */
export async function promptSessionType(ctx: BotContext): Promise<void> {
    const flow = ctx.session.peerFlow;
    if (!flow) return;

    const keyboard = new Keyboard()
        .text('MP-BGP + ENH (推荐)')
        .row()
        .text('ULA/GUA 模式')
        .resized()
        .oneTime();

    ctx.session.peerFlow = { ...flow, step: 'select_session_type' };

    await ctx.reply(
        `📡 *Session Type 会话类型*\n\n` +
        `**MP-BGP + ENH (推荐)**\n` +
        `Uses Link-Local addresses only. No extra IPs needed.\n` +
        `仅使用 Link-Local 地址，无需额外 IP。\n\n` +
        `**ULA/GUA Mode**\n` +
        `Uses your ULA/GUA addresses. You must provide ALL IPs from YOUR pool.\n` +
        `使用你的 ULA/GUA 地址。所有 IP 都必须从你的 IP 池分配。\n\n` +
        `⚠️ We will verify IP ownership in DN42 registry.\n` +
        `⚠️ 我们将在 DN42 注册表验证 IP 所有权。`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
    );
}

/**
 * Prompt for IPv6 input with ReplyKeyboard suggestion.
 * NOTE: Caller must set peerFlow.step before calling this function.
 */
export async function promptIpv6(ctx: BotContext, suggested: string): Promise<void> {
    const keyboard = suggested
        ? new Keyboard().text(suggested).resized().oneTime()
        : undefined;

    await ctx.reply(
        `📝 *Peer IPv6 Address 对方 IPv6 地址*\n\n` +
        `Enter your Link-Local IPv6 address for BGP peering.\n` +
        `请输入你用于 BGP 对等的 Link-Local IPv6 地址。\n\n` +
        (suggested ? `Suggested 建议: \`${suggested}\`\n` : '') +
        `You can also enter a custom Link-Local address.\n` +
        `你也可以输入其他 Link-Local 地址。`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
    );
}

/**
 * Prompt for ULA/GUA IPv6 input (no keyboard needed).
 */
export async function promptUlaIpv6(ctx: BotContext): Promise<void> {
    await ctx.reply(
        `📝 *Peer IPv6 Address 对方 IPv6 地址*\n\n` +
        `Enter your ULA/GUA IPv6 address (from YOUR IP pool).\n` +
        `请输入你的 ULA/GUA IPv6 地址（从你的 IP 池分配）。\n\n` +
        `⚠️ Must be registered in DN42 under your ASN.\n` +
        `⚠️ 必须在 DN42 注册表中属于你的 ASN。`,
        { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
    );
}

/**
 * Prompt for endpoint input with ReplyKeyboard
 */
export async function promptEndpoint(ctx: BotContext): Promise<void> {
    const keyboard = new Keyboard()
        .text('None (NAT)')
        .resized()
        .oneTime();

    await ctx.reply(
        `📝 *Step 2: WireGuard Endpoint*\n第二步: WireGuard 端点\n\n` +
        `Input your clearnet address for WireGuard tunnel.\n` +
        `请输入你的公网地址用于 WireGuard 隧道。\n\n` +
        `You can use IPv4 or IPv6. Include port if needed.\n` +
        `可使用 IPv4 或 IPv6，可包含端口如 \`example.com:51820\`\n\n` +
        `If behind NAT with no public IP, click "None".\n` +
        `如果在 NAT 后无公网 IP，点击 "None"。`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
    );
}

/**
 * Prompt for public key input (text only, no keyboard needed)
 */
export async function promptPubkey(ctx: BotContext): Promise<void> {
    await ctx.reply(
        `📝 *Step 3: WireGuard Public Key*\n第三步: WireGuard 公钥\n\n` +
        `Input your WireGuard public key.\n` +
        `请输入你的 WireGuard 公钥。\n\n` +
        `Format: 44 characters, ends with \`=\`\n` +
        `格式: 44个字符，以 \`=\` 结尾`,
        { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
    );
}

/**
 * Prompt for MTU selection with ReplyKeyboard
 */
export async function promptMtu(ctx: BotContext): Promise<void> {
    const keyboard = new Keyboard()
        .text('1420 (默认)').text('1400')
        .row()
        .text('1380').text('1280')
        .resized()
        .oneTime();

    await ctx.reply(
        `📝 *Step 4: MTU Setting*\n第四步: MTU 设置\n\n` +
        `Select WireGuard MTU:\n选择 WireGuard MTU:\n\n` +
        `• \`1420\` - 默认 / Default\n` +
        `• \`1400\` - 适用于某些 VPS\n` +
        `• \`1380\` - 有额外封装时\n` +
        `• \`1280\` - IPv6 最小值`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
    );
}

/**
 * Prompt for PSK option with ReplyKeyboard
 */
export async function promptPsk(ctx: BotContext): Promise<void> {
    const keyboard = new Keyboard()
        .text('🔄 Auto Generate 自动生成')
        .row()
        .text('❌ No PSK 不使用')
        .resized()
        .oneTime();

    await ctx.reply(
        `📝 *Step 5: Pre-Shared Key (PSK)*\n第五步: 预共享密钥\n\n` +
        `Use PSK for extra security?\n使用 PSK 增加安全性?\n\n` +
        `• 🔄 Auto Generate - 自动生成 PSK\n` +
        `• ❌ No PSK - 不使用 PSK`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
    );
}

/**
 * Prompt for contact selection with ReplyKeyboard.
 * 
 * Fetches NOC contacts from Burble DN42 registry and presents
 * them as keyboard options, with manual input and skip fallbacks.
 */
export async function promptContact(ctx: BotContext): Promise<void> {
    const flow = ctx.session.peerFlow;
    if (!flow) return;

    const asn = flow.isAdminMode ? flow.targetAsn : ctx.session.asn;
    if (!asn) return;

    await ctx.reply('🔍 Fetching contacts from DN42 registry...\n正在从 DN42 注册表获取联系方式...');

    const contacts = await fetchContacts(asn);

    const keyboard = new Keyboard();

    if (contacts.length > 0) {
        // Add each contact as a button
        for (const contact of contacts) {
            keyboard.text(contact).row();
        }
    }

    keyboard
        .text('✏️ Manual input 手动输入')
        .row()
        .text('⏩ Skip 跳过')
        .resized()
        .oneTime();

    const contactList = contacts.length > 0
        ? `Found contacts 找到的联系方式:\n${contacts.map(c => `• \`${c}\``).join('\n')}\n\n`
        : 'No contacts found in registry.\n未在注册表中找到联系方式。\n\n';

    ctx.session.peerFlow = { ...flow, step: 'input_contact' };

    await ctx.reply(
        `📞 *Step 6: Contact Info*\n第六步: 联系方式\n\n` +
        contactList +
        `Select a contact or enter manually.\n` +
        `选择一个联系方式或手动输入。`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
    );
}

/**
 * Show confirmation screen (keeps InlineKeyboard for final action)
 */
export async function showConfirmation(ctx: BotContext): Promise<void> {
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
    const contactDisplay = flow.contact ? `\`${flow.contact}\`` : 'Not set';

    const confirmText =
        `✅ *Confirm Peer Creation*\n确认创建 Peer\n\n` +
        `📍 Node: \`${flow.routerName}\`\n` +
        `🆔 ASN: \`AS${asn}\`\n` +
        `🌐 Your IPv6: \`${flow.ipv6}\`\n` +
        `📡 Your Endpoint: ${endpointDisplay}\n` +
        `🔑 Your PublicKey: \`${flow.publicKey?.slice(0, 20)}...\`\n` +
        `📏 MTU: \`${flow.mtu || 1420}\`\n` +
        `🔐 PSK: ${pskDisplay}\n` +
        `📞 Contact: ${contactDisplay}\n\n` +
        `*Server Info:*\n` +
        `🌐 Endpoint: \`${flow.serverEndpoint}:${flow.serverPort}\`\n` +
        `🔑 PublicKey: \`${flow.serverPubkey}\`\n` +
        `📶 LLA: \`${flow.serverLla}\`\n\n` +
        `Click button or type \`yes\` to confirm.\n` +
        `点击按钮或输入 \`yes\` 确认。`;

    // Keep InlineKeyboard for final confirmation action
    const keyboard = new InlineKeyboard()
        .text('✅ Confirm 确认', 'peer:confirm')
        .text('❌ Cancel 取消', 'peer:cancel');

    ctx.session.peerFlow = { ...flow, step: 'confirm' };

    await ctx.reply(confirmText, { parse_mode: 'Markdown', reply_markup: keyboard });
}
