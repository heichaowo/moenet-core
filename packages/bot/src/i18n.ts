/**
 * DN42 Bot - Bilingual Message Templates (i18n)
 *
 * All messages in Chinese/English format.
 * Format: "English text\n中文文字"
 * 
 * Ported from: moenet-dn42-control-plane/src/bot/i18n.py
 */

export type Locale = 'en' | 'zh';

/**
 * Get user's locale from language_code
 */
export function getLocale(languageCode?: string): Locale {
    if (languageCode?.startsWith('zh')) {
        return 'zh';
    }
    return 'en';
}

/**
 * Bilingual message type
 */
type BilingualMessage = {
    en: string;
    zh: string;
};

/**
 * Format message with locale
 */
export function t(msg: BilingualMessage, locale: Locale = 'en'): string {
    return msg[locale];
}

/**
 * Format bilingual message (shows both)
 */
export function bi(msg: BilingualMessage): string {
    return `${msg.en}\n${msg.zh}`;
}

// ==============================================================================
// Start / Help
// ==============================================================================

export const START_WELCOME = `🌐 *MoeNet\\-DN42* \\(AS4242420998\\)

Hello\\! I'm *Dorothy* 桃乐丝, your peering assistant\\.
你好！我是你的 Peering 助手。

📖 [Website 官网](https://dn42.asn.moe/)  ·  🐙 [GitHub](https://github.com/heichaowo/moenet-core)

━━━━━━━━━━━━━━━━
💡 *Support 支持*

🔧 Peering issues → Contact @HeiCha
连接问题请联系 @HeiCha

🐛 Bug reports & feature requests → [GitHub Issues](https://github.com/heichaowo/moenet-core/issues)
Bug 反馈 & 功能建议请提 Issue`;

export const START_COMMANDS = `📋 *Commands 指令列表*

━━━━━━━━━━━━━━━━
🔑 *Account 账户*
/login — Login with ASN 登录
/logout — Logout 登出
/whoami — Current session 当前登录

━━━━━━━━━━━━━━━━
🔗 *Peering 连接*
/peer — Create new peer 建立连接
/modify — Modify peer 修改连接
/remove — Remove peer 删除连接
/info — Peer info & status 连接状态
/status — WG/BGP live status 实时状态
/restart — Restart tunnel 重启隧道

━━━━━━━━━━━━━━━━
🛠️ *Tools 工具*
/ping — Ping test 网络测试
/tcping — TCP ping test TCP 测试
/trace — Traceroute 路由追踪
/route — Route lookup 路由查询
/path — AS path query AS 路径
/whois — WHOIS lookup 信息查询
/dig — DNS lookup DNS 查询
/findnoc — NOC contacts 查联系方式

━━━━━━━━━━━━━━━━
📊 *Statistics 统计*
/rank — Global ranking 排行榜
/stats — User statistics 用户统计
/peerlist — Peer list 连接列表
/community — BGP communities 社区标记
/latency — Latency probe 延迟探测
/flaps — Route flap history 路由抖动`;

// ==============================================================================
// Login
// ==============================================================================

export const LOGIN_ASK_ASN = `Enter your ASN
请输入你的 ASN`;

export const LOGIN_CHOOSE_METHOD = `Choose authentication method.
选择验证方式。`;

export const LOGIN_EMAIL_SENT = `✉️ Verification code has been sent to your email.
验证码已发送至您的邮箱。

Not received? Contact @HeiCha for help.
没收到？请联系 @HeiCha

Enter your verification code:
请输入验证码：`;

export const LOGIN_SUCCESS = `✅ Welcome! {mnt} AS{asn}
欢迎你！{mnt} AS{asn}`;

export const LOGIN_ALREADY = `ℹ️ You are already logged in as {mnt}
你已登录为 {mnt}`;

export const LOGIN_SIGNATURE_CHALLENGE = `🔐 Please sign this challenge with your key:
请使用你的密钥签名以下内容：

\`{challenge}\`

Reply with your signature:
回复签名结果：`;

// ==============================================================================
// Peer Wizard
// ==============================================================================

export const PEER_IDENTITY = `You will create a peer through the following identity:
你将通过以下身份创建一个 Peer：
*{mnt} AS{asn}*

If it is wrong, please use /cancel to interrupt.
如果有误请输入 /cancel 终止操作。

Any problems, please contact @HeiCha
如有问题，请联系 @HeiCha`;

export const PEER_SELECT_NODE = `Which node do you want to choose?
你想选择哪个节点？`;

export const PEER_SELECT_ROUTES = `What routes do you want to transmit?
你想传递哪些路由？`;

export const PEER_MPBGP_SUPPORT = `Do you support Multi-Protocol BGP?
你支持多协议 BGP 吗？`;

export const PEER_MPBGP_ADDRESS = `What address for MP-BGP session?
使用什么地址建立 MP-BGP 会话？`;

export const PEER_EXT_NEXTHOP = `Do you support Extended Next Hop?
你支持扩展的下一跳吗？`;

export const PEER_INPUT_IPV6 = `Input your DN42 IPv6 address.
请输入你的 DN42 IPv6 地址。

Both Link-Local and ULA are supported.
Link-Local 和 ULA 地址均支持。`;

export const PEER_INPUT_ENDPOINT = `Input your clearnet address for WireGuard tunnel.
请输入你用于 WireGuard 隧道的公网地址。

Enter \`none\` if behind NAT.
如果在 NAT 后面请输入 \`none\``;

export const PEER_INPUT_PORT = `Input your WireGuard port.
请输入你的 WireGuard 端口。`;

export const PEER_INPUT_PUBKEY = `Input your WireGuard public key.
请输入你的 WireGuard 公钥。`;

export const PEER_INPUT_CONTACT = `Input your contact info (Telegram or Email).
请输入你的联系方式（Telegram 或 Email）。`;

export const PEER_CONFIRM = `Please check all your information:
请确认你的信息：

*Region 节点:*
    {node}
*Basic 基本:*
    ASN:         {asn}
    Channel:     {channel}
    MP-BGP:      {mpbgp}
    IPv6:        {ipv6}
    IPv4:        {ipv4}
*Tunnel 隧道:*
    Endpoint:    {endpoint}:{port}
    PublicKey:   \`{pubkey}\`
*Contact 联系:*
    {contact}

Enter \`yes\` to confirm. Other input = cancel.
确认请输入 \`yes\`，其他输入表示取消。`;

export const PEER_CREATED = `✅ Peer has been created!
Peer 已建立！

Information on my side:
我方信息：
    Endpoint: {my_endpoint}:{my_port}
    PublicKey: \`{my_pubkey}\`
    DN42 Address: {my_address}`;

// ==============================================================================
// Peer Info
// ==============================================================================

export const PEER_INFO = `📍 *Node 节点:*
    {node}

📤 *Your Side 你的信息:*
    ASN: AS{asn}
    Endpoint: {endpoint}:{port}
    WireGuard Key: \`{pubkey}\`
    DN42 Address: {dn42_addr}

📥 *My Side 我方信息:*
    ASN: AS4242420998
    Endpoint: {my_endpoint}:{my_port}
    WireGuard Key: \`{my_pubkey}\`
    DN42 Address: {my_addr}

📡 *WireGuard Status:*
    Latest Handshake: {handshake}
    Transfer: {transfer}

🐦 *Bird Status:*
    {bird_status}

📞 *Contact 联系:*
    {contact}`;

// ==============================================================================
// Errors
// ==============================================================================

export const ERROR_NOT_LOGGED_IN = `❌ Please login first with /login
请先使用 /login 登录`;

export const ERROR_INVALID_ASN = `❌ Invalid ASN format
无效的 ASN 格式`;

export const ERROR_ASN_NOT_FOUND = `❌ ASN not found in DN42 registry
在 DN42 注册表中未找到该 ASN`;

export const ERROR_NO_PEER = `❌ You don't have any peer yet
你还没有任何 Peer`;

export const ERROR_PRIVILEGED_ONLY = `❌ This command is for privileged users only
此命令仅限特权用户使用`;

export const CANCELLED = `🚫 Operation cancelled.
操作已取消。`;

// ==============================================================================
// Node List Template
// ==============================================================================

export const NODE_ITEM = `- *{code}* | {location} | {provider}
  {open_icon} {open_text}
  ✔️ Capacity: {current} / {max}
  {ipv4_icon} IPv4: {ipv4_text}
  {ipv6_icon} IPv6: {ipv6_text}`;

// ==============================================================================
// Whois
// ==============================================================================

export const WHOIS_RESULT = `📋 *WHOIS Result*

\`\`\`
{content}
\`\`\``;

export const WHOIS_NOT_FOUND = `❌ No results found for: {query}
未找到结果：{query}`;

// ==============================================================================
// Legacy MSG object (for backward compatibility)
// ==============================================================================

export const MSG = {
    // Errors
    NOT_LOGGED_IN: {
        en: '❌ Please /login first',
        zh: '❌ 请先登录 /login',
    },
    INVALID_ASN: {
        en: '❌ Invalid ASN. DN42 range: 4242420000-4242429999',
        zh: '❌ 无效 ASN。DN42 范围: 4242420000-4242429999',
    },
    RATE_LIMITED: {
        en: '⏱️ Rate limited. Please wait.',
        zh: '⏱️ 请求过于频繁，请稍候。',
    },
    CANCELLED: {
        en: '🚫 Operation cancelled.',
        zh: '🚫 操作已取消。',
    },
    ERROR: {
        en: '❌ An error occurred.',
        zh: '❌ 发生错误。',
    },

    // Auth
    LOGIN_ASK_ASN: {
        en: '🔐 Please enter your ASN:',
        zh: '🔐 请输入你的 ASN:',
    },
    LOGIN_CHOOSE_METHOD: {
        en: 'Choose authentication method:',
        zh: '选择认证方式:',
    },
    LOGIN_SUCCESS: {
        en: '✅ Login successful!',
        zh: '✅ 登录成功!',
    },
    LOGOUT_SUCCESS: {
        en: '👋 Logged out.',
        zh: '👋 已退出登录。',
    },

    // Peer
    PEER_CREATED: {
        en: '✅ Peer created successfully!',
        zh: '✅ Peer 创建成功!',
    },
    PEER_MODIFIED: {
        en: '✅ Peer modified successfully!',
        zh: '✅ Peer 修改成功!',
    },
    PEER_REMOVED: {
        en: '✅ Peer removed successfully!',
        zh: '✅ Peer 已删除!',
    },
    PEER_RESTARTED: {
        en: '✅ Peer restarted successfully!',
        zh: '✅ Peer 已重启!',
    },
    NO_PEERS: {
        en: 'ℹ️ You have no active peers.',
        zh: 'ℹ️ 你没有活跃的 Peer。',
    },

    // Network
    PING_RUNNING: {
        en: '🏓 Pinging...',
        zh: '🏓 正在 Ping...',
    },
    TRACE_RUNNING: {
        en: '🔀 Tracing route...',
        zh: '🔀 正在追踪路由...',
    },
    WHOIS_RUNNING: {
        en: '🔍 Looking up...',
        zh: '🔍 正在查询...',
    },

    // Help
    WELCOME: {
        en: '🌐 *MoeNet DN42 Bot*\n\nWelcome to MoeNet DN42 Network.',
        zh: '🌐 *MoeNet DN42 Bot*\n\n欢迎来到 MoeNet DN42 网络。',
    },
} as const;

/**
 * Format message with parameters
 */
export function fmt(
    msg: BilingualMessage,
    params: Record<string, string | number>,
    locale: Locale = 'en'
): string {
    let text = msg[locale];
    for (const [key, value] of Object.entries(params)) {
        text = text.replace(`{${key}}`, String(value));
    }
    return text;
}

/**
 * Format template string with parameters
 */
export function formatString(template: string, params: Record<string, string | number | undefined>): string {
    let result = template;
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
            result = result.replace(new RegExp(`{${key}}`, 'g'), String(value));
        }
    }
    return result;
}
