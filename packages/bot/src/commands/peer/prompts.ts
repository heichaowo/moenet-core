/**
 * Peer Module - UI Prompts
 *
 * Common prompt messages and keyboard builders for peer interactions.
 * Note: Core prompt functions (promptEndpoint, promptPubkey, promptMtu, promptPsk)
 * are now in ui.ts for better organization.
 */

import { BUTTONS, backButtonRow, buttonRow } from "./helpers";

/**
 * Common error messages
 */
export const ERROR_MESSAGES = {
	NOT_LOGGED_IN:
		"❌ You are not logged in. Use /login first.\n你还没有登录，请先使用 /login 登录。",
	NO_SESSION_DATA: "❌ Error: No session data",
	INVALID_SELECTION: "❌ Invalid selection. Please choose from the menu.",
	FETCH_FAILED: "❌ Failed to fetch data. Please try again.",
	SUBMIT_FAILED: "❌ Failed to submit. Please try again.",
} as const;

/**
 * Success message helper
 */
export function successMessage(field: string, value: string): string {
	return `✅ ${field} updated: \`${value}\`\n${field}已更新`;
}

// Re-export BUTTONS for backward compatibility
export { BUTTONS, backButtonRow, buttonRow };
