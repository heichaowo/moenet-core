/**
 * Peer Module - API Client
 *
 * Centralized API request helper for peer-related operations.
 */

import config from '../../config';
import { apiRequest } from '../../api';
import type { APIResponse } from './types';

// Re-export for backward compatibility with other modules
export { apiRequest } from '../../api';
export type { APIResponse } from './types';

/**
 * Fetch routers list
 */
export async function fetchRouters(): Promise<APIResponse> {
    return apiRequest('/admin', 'POST', { action: 'enumRouters' }, config.apiToken);
}

/**
 * Fetch user sessions
 */
export async function fetchUserSessions(asn: number): Promise<APIResponse> {
    return apiRequest('/admin', 'POST', { action: 'enumSessions', asn }, config.apiToken);
}

/**
 * Fetch session details
 */
export async function fetchSessionDetails(uuid: string): Promise<APIResponse> {
    return apiRequest('/admin', 'POST', { action: 'getSession', uuid }, config.apiToken);
}

/**
 * Create new session
 */
export async function createSession(params: {
    asn: number;
    routerUuid: string;
    ipv6: string;
    ipv4?: string;
    localIpv6?: string;
    localIpv4?: string;
    endpoint?: string;
    port?: number;
    pubkey: string;
    psk?: string;
    mtu?: number;
    mpbgp?: boolean;
    extendedNexthop?: boolean;
    contact?: string;
}): Promise<APIResponse> {
    return apiRequest('/admin', 'POST', {
        action: 'createSession',
        ...params,
    }, config.apiToken);
}

/**
 * Update session
 */
export async function updateSession(params: {
    uuid: string;
    ipv6?: string | null;
    ipv4?: string | null;
    ipv6LinkLocal?: string | null;
    localIpv4?: string | null;
    endpoint?: string | null;
    mtu?: number;
    contact?: string | null;
    extensions?: string;
}): Promise<APIResponse> {
    return apiRequest('/admin', 'POST', {
        action: 'updateSession',
        ...params,
    }, config.apiToken);
}

/**
 * Delete session
 */
export async function deleteSession(uuid: string): Promise<APIResponse> {
    return apiRequest('/admin', 'POST', { action: 'deleteSession', uuid }, config.apiToken);
}

/**
 * Submit modification changes and execute pending migration.
 *
 * Handles deferred migration: field updates are submitted first (updateSession),
 * then migration is executed (migrate). This ordering is intentional — migrate
 * re-reads the session from DB, so it picks up the updated fields.
 *
 * Returns: { success: boolean; message?: string }
 */
export async function submitModifyChanges(flow: {
    sessionUuid?: string;
    current?: Record<string, unknown>;
    backup?: Record<string, unknown>;
    routerName?: string;
    pendingMigration?: { nodeUuid: string; nodeName: string };
}): Promise<{ success: boolean; migrated: boolean; message?: string }> {
    const uuid = flow.sessionUuid;
    const current = flow.current as Record<string, unknown> | undefined;
    const backup = flow.backup as Record<string, unknown> | undefined;

    if (!uuid || !current) {
        return { success: false, migrated: false, message: 'No session data' };
    }

    // Build request with only changed fields
    const requestBody: Record<string, unknown> = {
        action: 'updateSession',
        uuid,
    };

    if (current.ipv6 !== backup?.ipv6) {
        requestBody.ipv6 = current.ipv6 || null;
    }
    if (current.ipv4 !== backup?.ipv4) {
        requestBody.ipv4 = current.ipv4 || null;
    }
    if (current.localIpv6 !== backup?.localIpv6) {
        requestBody.ipv6LinkLocal = current.localIpv6 || null;
    }
    if (current.localIpv4 !== backup?.localIpv4) {
        requestBody.localIpv4 = current.localIpv4 || null;
    }
    if (current.endpoint !== backup?.endpoint || current.port !== backup?.port) {
        const fullEndpoint = current.endpoint
            ? (current.port ? `${current.endpoint}:${current.port}` : current.endpoint)
            : null;
        requestBody.endpoint = fullEndpoint;
    }
    if (current.mtu !== backup?.mtu) {
        requestBody.mtu = current.mtu;
    }
    if (current.contact !== backup?.contact) {
        requestBody.contact = current.contact || null;
    }
    if (current.mpbgp !== backup?.mpbgp || current.extendedNexthop !== backup?.extendedNexthop) {
        requestBody.extensions = (current.mpbgp ? 'mp_bgp' : '') + (current.extendedNexthop ? ',extended_nexthop' : '');
    }

    // Step 1: Submit field changes (if any)
    const hasFieldChanges = Object.keys(requestBody).length > 2; // more than action + uuid
    if (hasFieldChanges) {
        console.log('[submitModifyChanges] Request body:', JSON.stringify(requestBody));
        const result = await apiRequest('/admin', 'POST', requestBody, config.apiToken);
        console.log('[submitModifyChanges] Response:', JSON.stringify(result));

        if (result.code !== 0) {
            return { success: false, migrated: false, message: `Failed to update: ${result.message}` };
        }
    }

    // Step 2: Execute pending migration (if set)
    if (flow.pendingMigration) {
        const migrateResult = await apiRequest('/admin', 'POST', {
            action: 'migrate',
            uuid,
            newRouter: flow.pendingMigration.nodeUuid,
        }, config.apiToken);

        if (migrateResult.code !== 0) {
            return { success: false, migrated: false, message: `Migration failed: ${migrateResult.message}` };
        }

        return { success: true, migrated: true };
    }

    return { success: true, migrated: false };
}
