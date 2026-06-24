import type { Bot } from 'grammy';
import type { BotContext } from '../index';
import { registerUserCommands } from './user';
import { registerPeerCommands } from './peer';
import { registerToolsCommands } from './tools';
import { registerAdminCommands } from './admin';
import { registerStatsCommands } from './stats';
import { registerCommunityCommands } from './community';
import { registerBlockCommands } from './block';
import { registerMaintenanceCommands } from './maintenance';
import { registerNodeCommands } from './nodes';
import { registerFlapCommands } from './flap';

/**
 * Register all bot commands
 */
export function registerCommands(bot: Bot<BotContext>) {
    registerUserCommands(bot);
    registerPeerCommands(bot);
    registerToolsCommands(bot);
    registerAdminCommands(bot);
    registerStatsCommands(bot);
    registerCommunityCommands(bot);
    registerBlockCommands(bot);
    registerMaintenanceCommands(bot);
    registerNodeCommands(bot);
    registerFlapCommands(bot);
}

