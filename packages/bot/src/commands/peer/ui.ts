/**
 * Peer UI Components
 *
 * Reusable UI prompt functions for the peer creation wizard.
 * Fully inline-keyboard driven: selection steps use InlineKeyboard callbacks
 * (handled in handlers/creation.ts); free-text steps (IPv6 / endpoint / pubkey /
 * manual contact) prompt for typed input. No ReplyKeyboards — they persist in
 * the client and leak between steps (the old "Continue → Invalid node" bug).
 */

import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../../index';
import { fetchContacts } from '../../services/dn42Registry';

/**
 * Show server WireGuard info with an inline Continue button.
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

    ctx.session.peerFlow = { ...flow, step: 'await_continue' };

    const keyboard = new InlineKeyboard().text('Continue ➡️ 继续', 'peer:continue');
    await ctx.reply(infoText, { parse_mode: 'Markdown', reply_markup: keyboard });
}

/**
 * Prompt for session type selection (inline).
 */
export async function promptSessionType(ctx: BotContext): Promise<void> {
    const flow = ctx.session.peerFlow;
    if (!flow) return;

    ctx.session.peerFlow = { ...flow, step: 'select_session_type' };

    const keyboard = new InlineKeyboard()
        .text('MP-BGP + ENH (推荐)', 'peer:stype:enh')
        .row()
        .text('ULA/GUA 模式', 'peer:stype:ula');

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
 * Prompt for Link-Local IPv6 input (typed).
 * NOTE: Caller must set peerFlow.step before calling this function.
 */
export async function promptIpv6(ctx: BotContext, suggested: string): Promise<void> {
    await ctx.reply(
        `📝 *Peer IPv6 Address 对方 IPv6 地址*\n\n` +
        `Enter your Link-Local IPv6 address for BGP peering.\n` +
        `请输入你用于 BGP 对等的 Link-Local IPv6 地址。\n\n` +
        (suggested ? `Suggested 建议: \`${suggested}\`\n(copy & send, or enter your own)\n` : '') +
        `例如 / e.g. \`fe80::1234\``,
        { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
    );
}

/**
 * Prompt for ULA/GUA IPv6 input (typed).
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
 * Prompt for endpoint input (typed) with an inline None (NAT) button.
 */
export async function promptEndpoint(ctx: BotContext): Promise<void> {
    const keyboard = new InlineKeyboard().text('🚫 None (NAT)', 'peer:endpoint:none');
    await ctx.reply(
        `📝 *Step 2: WireGuard Endpoint*\n第二步: WireGuard 端点\n\n` +
        `Input your clearnet address for WireGuard tunnel.\n` +
        `请输入你的公网地址用于 WireGuard 隧道。\n\n` +
        `You can use IPv4 or IPv6. Include port if needed.\n` +
        `可使用 IPv4 或 IPv6，可包含端口如 \`example.com:51820\`\n\n` +
        `If behind NAT with no public IP, tap "None".\n` +
        `如果在 NAT 后无公网 IP，点击 "None"。`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
    );
}

/**
 * Prompt for public key input (typed).
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
 * Prompt for MTU selection (inline).
 */
export async function promptMtu(ctx: BotContext): Promise<void> {
    const keyboard = new InlineKeyboard()
        .text('1420 (默认)', 'peer:mtu:1420').text('1400', 'peer:mtu:1400')
        .row()
        .text('1380', 'peer:mtu:1380').text('1280', 'peer:mtu:1280');

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
 * Prompt for PSK option (inline).
 */
export async function promptPsk(ctx: BotContext): Promise<void> {
    const keyboard = new InlineKeyboard()
        .text('🔄 Auto Generate 自动生成', 'peer:psk:auto')
        .row()
        .text('❌ No PSK 不使用', 'peer:psk:none');

    await ctx.reply(
        `📝 *Step 5: Pre-Shared Key (PSK)*\n第五步: 预共享密钥\n\n` +
        `Use PSK for extra security?\n使用 PSK 增加安全性?\n\n` +
        `• 🔄 Auto Generate - 自动生成 PSK\n` +
        `• ❌ No PSK - 不使用 PSK`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
    );
}

/**
 * Prompt for contact selection (inline).
 *
 * Fetches NOC contacts from the DN42 registry and presents them as inline
 * buttons (peer:ct:<index>, options kept in session), plus manual/skip.
 */
export async function promptContact(ctx: BotContext): Promise<void> {
    const flow = ctx.session.peerFlow;
    if (!flow) return;

    const asn = flow.isAdminMode ? flow.targetAsn : ctx.session.asn;
    if (!asn) return;

    await ctx.reply('🔍 Fetching contacts from DN42 registry...\n正在从 DN42 注册表获取联系方式...');

    const contacts = await fetchContacts(asn);

    const keyboard = new InlineKeyboard();
    contacts.forEach((c, i) => keyboard.text(c, `peer:ct:${i}`).row());
    keyboard.text('✏️ Manual input 手动输入', 'peer:ct:manual')
        .row()
        .text('⏩ Skip 跳过', 'peer:ct:skip');

    const contactList = contacts.length > 0
        ? `Found contacts 找到的联系方式:\n${contacts.map(c => `• \`${c}\``).join('\n')}\n\n`
        : 'No contacts found in registry.\n未在注册表中找到联系方式。\n\n';

    ctx.session.peerFlow = { ...flow, step: 'input_contact', contactOptions: contacts };

    await ctx.reply(
        `📞 *Step 6: Contact Info*\n第六步: 联系方式\n\n` +
        contactList +
        `Select a contact or enter manually.\n` +
        `选择一个联系方式或手动输入。`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
    );
}

/**
 * Show confirmation screen (inline).
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

    const keyboard = new InlineKeyboard()
        .text('✅ Confirm 确认', 'peer:confirm')
        .text('❌ Cancel 取消', 'peer:cancel');

    ctx.session.peerFlow = { ...flow, step: 'confirm' };

    await ctx.reply(confirmText, { parse_mode: 'Markdown', reply_markup: keyboard });
}
