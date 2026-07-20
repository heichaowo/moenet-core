import type { Bot } from "grammy";
import type { BotContext } from "../index";
import { registerAdminCommands } from "./admin";
import { registerBlockCommands } from "./block";
import { registerCommunityCommands } from "./community";
import { registerFlapCommands } from "./flap";
import { registerMaintenanceCommands } from "./maintenance";
import { registerNodeCommands } from "./nodes";
import { registerPeerCommands } from "./peer";
import { registerStatsCommands } from "./stats";
import { registerToolsCommands } from "./tools";
import { registerUserCommands } from "./user";

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
