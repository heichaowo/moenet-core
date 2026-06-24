/**
 * Shared API Client for the Bot
 *
 * Canonical apiRequest implementation used by all command modules.
 * Eliminates duplicate apiRequest functions across user.ts, block.ts, stats.ts, etc.
 */

import config from './config';

export interface APIResponse {
    code: number;
    message?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data?: Record<string, any>;
}

/**
 * Make an API request to moenet-core.
 *
 * @param endpoint - API path (e.g. '/admin', '/auth')
 * @param method - HTTP method
 * @param body - Request body (will be JSON.stringify'd)
 * @param token - Optional Bearer token (defaults to no auth)
 */
export async function apiRequest(
    endpoint: string,
    method = 'POST',
    body?: unknown,
    token?: string
): Promise<APIResponse> {
    const response = await fetch(`${config.apiUrl}${endpoint}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': token ? `Bearer ${token}` : '',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    return response.json() as Promise<APIResponse>;
}
