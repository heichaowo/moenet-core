/**
 * Peer Command Helpers
 *
 * Common helper functions and guards for peer command handlers.
 */

import type { BotContext } from '../../index';
import { PEER_MODIFY_STEPS, type PeerState } from './types';

/**
 * Common button constants
 */
export const BUTTONS = {
    BACK: '🔙 Back',
    FINISH: 'Finish modification',
    ABORT: 'Abort modification',
} as const;

/**
 * Create a keyboard button row
 */
export function buttonRow(...texts: string[]): { text: string }[] {
    return texts.map(text => ({ text }));
}

/**
 * Create a back button row
 */
export function backButtonRow(): { text: string }[] {
    return [{ text: BUTTONS.BACK }];
}

/**
 * Build a simple reply keyboard with back button
 */
export function buildKeyboard(rows: { text: string }[][]): {
    keyboard: { text: string }[][];
    resize_keyboard: boolean;
} {
    return {
        keyboard: [...rows, backButtonRow()],
        resize_keyboard: true,
    };
}

/**
 * Guard: Check if peerFlow exists and has current state
 * Returns flow data or undefined if invalid
 */
export function getFlowWithCurrent(ctx: BotContext): {
    flow: NonNullable<BotContext['session']['peerFlow']>;
    current: PeerState;
} | undefined {
    const flow = ctx.session.peerFlow;
    if (!flow || !flow.current) {
        return undefined;
    }
    return { flow, current: flow.current as PeerState };
}

/**
 * Guard: Check if peerFlow exists with sessionUuid
 */
export function getFlowWithSession(ctx: BotContext): NonNullable<BotContext['session']['peerFlow']> | undefined {
    const flow = ctx.session.peerFlow;
    if (!flow || !flow.sessionUuid) {
        return undefined;
    }
    return flow;
}

/**
 * Check if text is back button
 */
export function isBackButton(text: string): boolean {
    return text === BUTTONS.BACK;
}

/**
 * Check if text is abort button
 */
export function isAbortButton(text: string): boolean {
    return text === BUTTONS.ABORT;
}

/**
 * Check if text is finish button
 */
export function isFinishButton(text: string): boolean {
    return text === BUTTONS.FINISH;
}

/**
 * Clear peer flow and return to normal state
 */
export function clearPeerFlow(ctx: BotContext): void {
    ctx.session.peerFlow = undefined;
}

/**
 * Update peerFlow step
 */
export function setFlowStep(ctx: BotContext, step: string): void {
    if (ctx.session.peerFlow) {
        ctx.session.peerFlow.step = step;
    }
}

/**
 * Update peerFlow with new data
 */
export function updateFlow(
    ctx: BotContext,
    updates: Partial<NonNullable<BotContext['session']['peerFlow']>>
): void {
    if (ctx.session.peerFlow) {
        ctx.session.peerFlow = { ...ctx.session.peerFlow, ...updates };
    }
}

/**
 * Update current peer state
 */
export function updateCurrentState(ctx: BotContext, updates: Partial<PeerState>): void {
    if (ctx.session.peerFlow?.current) {
        Object.assign(ctx.session.peerFlow.current, updates);
    }
}

/**
 * Check if any changes were made (compare backup to current)
 */
export function hasChanges(ctx: BotContext): boolean {
    const flow = ctx.session.peerFlow;
    if (!flow?.backup || !flow?.current) return false;
    return JSON.stringify(flow.backup) !== JSON.stringify(flow.current);
}

/**
 * Format endpoint display
 */
export function formatEndpoint(endpoint?: string, port?: string | number): string {
    if (!endpoint) return 'Not set';
    if (port) return `${endpoint}:${port}`;
    return endpoint;
}

/**
 * Truncate public key for display
 */
export function truncatePubkey(pubkey?: string): string {
    if (!pubkey) return 'Not set';
    return pubkey.slice(0, 20) + '...';
}

/**
 * Format diff line for confirmation
 */
export function formatDiffLine(
    label: string,
    oldValue: string | undefined,
    newValue: string | undefined
): string[] {
    const old = oldValue || 'Not set';
    const current = newValue || 'Not set';

    if (old === current) {
        return [`    ${label}:     ${current}`];
    }
    return [
        `    ${label}:     ${old}`,
        '  ->',
        `      ${current}`,
    ];
}

/**
 * Create formatted modify response 
 */
export function modifySuccessMessage(field: string, value: string): string {
    return `✅ ${field} updated: \`${value}\`\n${field}已更新`;
}

