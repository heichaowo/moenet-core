/**
 * Shared Auth Guards for the Bot
 *
 * Canonical isAdmin check used by admin, block, maintenance, etc.
 */

import type { BotContext } from './index';
import config from './config';

/**
 * Check if the user is an admin (by username match or session flag).
 */
export function isAdmin(ctx: BotContext): boolean {
    const username = ctx.from?.username?.toLowerCase();
    const adminUsername = config.adminUsername.toLowerCase().replace('@', '');
    return username === adminUsername || ctx.session.isAdmin === true;
}
