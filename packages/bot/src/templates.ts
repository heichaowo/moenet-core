/**
 * DN42 Bot - Message Templates
 *
 * Centralized message templates for consistent Telegram formatting.
 * Uses Markdown V1 formatting.
 * 
 * Ported from: moenet-dn42-control-plane/src/bot/templates.py
 */

// =============================================================================
// Common Elements
// =============================================================================

export const DIVIDER = '─'.repeat(20);

export const ICONS = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️',
    peer: '🔗',
    node: '🖥',
    stats: '📊',
    rank: '🏆',
    login: '🔐',
    logout: '👋',
    email: '📧',
    key: '🔑',
    network: '🌐',
    config: '⚙️',
    cancel: '❌',
    confirm: '✅',
    pending: '⏳',
    active: '🟢',
    inactive: '🔴',
} as const;

export type IconKey = keyof typeof ICONS;

// =============================================================================
// Header Helpers
// =============================================================================

/**
 * Create formatted header
 */
export function header(title: string, icon: IconKey | string = ''): string {
    const iconStr = icon ? (ICONS[icon as IconKey] ?? icon) : '';
    return `${iconStr} *${title}*\n${DIVIDER}`;
}

/**
 * Create subheader
 */
export function subheader(text: string): string {
    return `\n*${text}*`;
}

// =============================================================================
// Login Templates
// =============================================================================

export const LOGIN_ALREADY = `
{icon} *已登录*
{div}
当前身份: \`{mnt}\`
使用 /logout 退出
`.trim();

export const LOGIN_ASK_ASN = `
{icon} *DN42 登录*
{div}
请输入你的 ASN
例如: \`998\`, \`0998\`, \`AS4242420998\` 或 \`4242420998\`

/cancel 取消
`.trim();

export const LOGIN_PRIVILEGE = `
{icon} *特权登录*
{div}
请输入 ASN:
`.trim();

export const LOGIN_CHOOSE_METHOD = `
{icon} *验证方式*
{div}
ASN: \`{asn}\`

请选择验证方式:
`.trim();

export const LOGIN_EMAIL_SENT = `
{icon} *验证码已发送*
{div}
已发送至 {count} 个邮箱
10分钟内有效

请输入验证码:
`.trim();

export const LOGIN_SUCCESS = `
{icon} *登录成功*
{div}
身份: \`{mnt}\`
{privilege}
`.trim();

export const LOGIN_SIGNATURE_CHALLENGE = `
{icon} *签名挑战*
{div}
可用认证方式:
{auth_list}

Challenge:
\`{challenge}\`

请用上述密钥签名并发送结果
`.trim();

// =============================================================================
// Peer Wizard Templates
// =============================================================================

export const PEER_WIZARD_START = `
{icon} *Peer 创建向导*
{div}
ASN: \`AS{asn}\`

请选择节点:
`.trim();

export const PEER_WG_PUBKEY = `
{icon} *WireGuard 公钥*
{div}
节点: \`{node}\`

请输入你的 WireGuard 公钥:
`.trim();

export const PEER_ENDPOINT = `
{icon} *WireGuard Endpoint*
{div}
请输入 Endpoint (IP:Port)
例如: \`1.2.3.4:51820\`

无公网输入 \`none\`
`.trim();

export const PEER_CONFIRM = `
{icon} *配置确认*
{div}
节点: \`{node}\`
ASN: \`AS{asn}\`
公钥: \`{pubkey_short}...\`
Endpoint: \`{endpoint}\`

*分配地址:*
IPv4: \`{ipv4}/32\`
IPv6: \`{ipv6}/128\`

确认创建?
`.trim();

export const PEER_SUCCESS = `
{icon} *Peer 创建成功*
{div}

*服务端配置:*
\`\`\`
Endpoint: {endpoint}
PublicKey: {server_pubkey}
AllowedIPs: {allowed_ips}
\`\`\`

配置已发送至邮箱
/info 查看状态
`.trim();

export const PEER_INFO = `
{icon} *Peer 信息*
{div}
ASN: \`AS{asn}\`
节点: \`{node}\`
状态: {status}

*隧道:*
IPv4: \`{ipv4}\`
IPv6: \`{ipv6}\`

*BGP:*
状态: {bgp_status}
收到路由: {routes_received}
`.trim();

// =============================================================================
// Stats Templates
// =============================================================================

export const STATS_NETWORK = `
{icon} *DN42 网络统计*
{div}
总 ASN: \`{total_asns}\`
总链路: \`{total_links}\`
平均 Peers: \`{avg_peers}\`
`.trim();

export const STATS_ASN = `
{icon} *AS{asn} 统计*
{div}
名称: {name}
Peers: \`{peer_count}\`
Centrality: \`{centrality}\`
Closeness: \`{closeness}\`
`.trim();

export const RANK_HEADER = `
{icon} *DN42 Peer 排名*
{div}
{content}
{div}
{page_info}
`.trim();

export const PEERLIST = `
{icon} *AS{asn} Peer 列表*
{div}
{peer_list}
`.trim();

// =============================================================================
// Tools Templates
// =============================================================================

export const TOOL_SELECT_NODE = `
{icon} *选择节点*
{div}
命令: \`{command}\`
目标: \`{target}\`
`.trim();

export const TOOL_RESULT = `
{icon} *{tool_name}*
{div}
节点: \`{node}\`
目标: \`{target}\`

\`\`\`
{output}
\`\`\`
`.trim();

// =============================================================================
// Error Templates (Bilingual 双语)
// =============================================================================

export const ERROR_NOT_LOGGED_IN = `{icon} Please login first with /login
请先使用 /login 登录`;

export const ERROR_INVALID_ASN = `{icon} Invalid ASN format
无效的 ASN 格式`;

export const ERROR_ASN_NOT_FOUND = `{icon} ASN \`{asn}\` not found in DN42 registry
ASN \`{asn}\` 未在 DN42 注册`;

export const ERROR_NO_EMAIL = `{icon} No email address found, please add in registry
未找到邮箱地址，请在 registry 添加`;

export const ERROR_EMAIL_FAILED = `{icon} Failed to send verification email
发送验证邮件失败`;

export const ERROR_INVALID_CODE = `{icon} Invalid or expired verification code
验证码错误或已过期`;

export const ERROR_INVALID_WG_KEY = `{icon} Invalid WireGuard public key format
无效的 WireGuard 公钥格式`;

export const ERROR_GENERIC = `{icon} Operation failed: {error}
操作失败: {error}`;

export const CANCELLED = `{icon} Operation cancelled.
操作已取消。`;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Format template with icons and divider
 */
export function formatTemplate(
    template: string,
    params: Record<string, string | number | undefined> & { icon?: IconKey }
): string {
    const { icon = 'info', ...rest } = params;
    let result = template
        .replace(/{icon}/g, ICONS[icon] ?? '')
        .replace(/{div}/g, DIVIDER);

    for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined) {
            result = result.replace(new RegExp(`{${key}}`, 'g'), String(value));
        }
    }

    return result;
}

/**
 * Format success message
 */
export function success(message: string): string {
    return `${ICONS.success} ${message}`;
}

/**
 * Format error message
 */
export function error(message: string): string {
    return `${ICONS.error} ${message}`;
}

/**
 * Format info message
 */
export function info(message: string): string {
    return `${ICONS.info} ${message}`;
}

/**
 * Format warning message
 */
export function warning(message: string): string {
    return `${ICONS.warning} ${message}`;
}
