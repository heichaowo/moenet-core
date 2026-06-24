/**
 * Peer Command Types and Constants
 *
 * Centralized definitions for the peer command flow state machine.
 * This eliminates magic strings and provides type safety for step transitions.
 */

/**
 * Peer creation flow steps
 */
export const PEER_CREATE_STEPS = {
    SELECT_NODE: 'select_node',
    SHOW_WG_INFO: 'show_wg_info',
    INPUT_IPV6: 'input_ipv6',
    INPUT_ENDPOINT: 'input_endpoint',
    INPUT_PORT: 'input_port',
    INPUT_PUBKEY: 'input_pubkey',
    INPUT_MTU: 'input_mtu',
    INPUT_PSK: 'input_psk',
    INPUT_CONTACT: 'input_contact',
    INPUT_CONTACT_MANUAL: 'input_contact_manual',
    CONFIRM: 'confirm',
} as const;

/**
 * Peer modify flow steps
 */
export const PEER_MODIFY_STEPS = {
    MENU: 'modify_menu',
    REGION: 'modify_region',
    SESSION_TYPE: 'modify_session_type',
    BGP_ADDRESS: 'modify_bgp_address',
    PEER_IPV6: 'modify_peerIpv6',
    PEER_IPV4: 'modify_peerIpv4',
    LOCAL_IPV6: 'modify_localIpv6',
    LOCAL_IPV4: 'modify_localIpv4',
    ENDPOINT: 'modify_endpoint',
    PUBKEY: 'modify_pubkey',
    PSK: 'modify_psk',
    MTU: 'modify_mtu',
    CONTACT: 'modify_contact',
    CONFIRM: 'modify_confirm',
    // Legacy steps (for backward compatibility)
    IPV6: 'modify_ipv6',
} as const;

/**
 * All peer flow steps combined
 */
export const PEER_STEPS = {
    ...PEER_CREATE_STEPS,
    ...PEER_MODIFY_STEPS,
} as const;

/**
 * Step type for type checking
 */
export type PeerCreateStep = typeof PEER_CREATE_STEPS[keyof typeof PEER_CREATE_STEPS];
export type PeerModifyStep = typeof PEER_MODIFY_STEPS[keyof typeof PEER_MODIFY_STEPS];
export type PeerStep = PeerCreateStep | PeerModifyStep;

/**
 * Modify menu keyboard options
 */
export const MODIFY_MENU_OPTIONS = {
    REGION: 'Region',
    SESSION_TYPE: 'Session Type',
    BGP_ADDRESS: 'BGP Address',
    CLEARNET_ENDPOINT: 'Clearnet Endpoint',
    WG_PUBKEY: 'WireGuard PublicKey',
    PSK: 'PSK',
    MTU: 'MTU',
    CONTACT: 'Contact',
    FINISH: 'Finish modification',
    ABORT: 'Abort modification',
    BACK: '🔙 Back',
} as const;

/**
 * BGP Address sub-menu options
 */
export const BGP_ADDRESS_OPTIONS = {
    PEER_IPV6: 'Peer IPv6 (对方)',
    PEER_IPV4: 'Peer IPv4 (对方)',
    LOCAL_IPV6: 'Local IPv6 (我方)',
    LOCAL_IPV4: 'Local IPv4 (我方)',
} as const;

/**
 * Session type options
 */
export const SESSION_TYPE_OPTIONS = {
    MP_BGP_ENH: 'MP-BGP + ENH (推荐)',
    MP_BGP_ONLY: 'MP-BGP Only',
    IPV6_IPV4_SEPARATE: 'IPv6 + IPv4 (独立会话)',
} as const;

/**
 * PSK options
 */
export const PSK_OPTIONS = {
    GENERATE: '🔄 Auto Generate 自动生成',
    NO_PSK: '❌ No PSK 不使用',
    REGENERATE: '🔄 Regenerate PSK',
    ENABLE_GENERATE: '🔄 Enable & Generate PSK',
    DISABLE: '❌ Disable PSK',
} as const;

/**
 * Common MTU values
 */
export const MTU_VALUES = {
    DEFAULT: 1420,
    COMMON: [1420, 1400, 1380, 1360, 1340, 1320, 1280],
    MIN: 1280,
    MAX: 1500,
} as const;

/**
 * Peer state data structure (for backup/current diff tracking)
 */
export interface PeerState {
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
}

/**
 * Node information from API
 */
export interface NodeInfo {
    uuid: string;
    endpoint: string;
    pubkey: string;
    nodeId: number;
}

/**
 * Router data from API
 */
export interface RouterData {
    uuid: string;
    name: string;
    isOpen: boolean;
    location?: string;
    region?: string;
    endpoint?: string;
    wgPublicKey?: string;
    nodeId?: number;
    regionCode?: number;
    maxPeers?: number;
    currentPeers?: number;
    sessionCount?: number;
    provider?: string;
    supportsIpv4?: boolean;
    supportsIpv6?: boolean;
    allowCnPeers?: boolean;
}

/**
 * API response structure
 */
export interface APIResponse {
    code: number;
    message?: string;
    data?: {
        routers?: RouterData[];
        session?: {
            uuid: string;
            serverEndpoint?: string;
            serverPort?: number;
            serverPubkey?: string;
            serverLla?: string;
        };
        sessions?: Array<{
            uuid: string;
            router: string;
            status: number;
            ipv6?: string;
            endpoint?: string;
        }>;
        [key: string]: unknown;
    };
}
