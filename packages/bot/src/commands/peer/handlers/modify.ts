/**
 * Peer Modify Flow Handlers
 * 
 * Handles all callbacks for the peer modification flow.
 */

import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../../../index';
import config from '../../../config';
import { apiRequest, submitModifyChanges } from '../api';
import { isValidWgPubkey } from '../validators';

/** Free-text modify fields (immediate submit). */
type TextField = 'endpoint' | 'pubkey' | 'contact' | 'peerIpv6' | 'peerIpv4' | 'localIpv6' | 'localIpv4';

/**
 * Validate a typed value for a modify field, submit it immediately via
 * updateSession, and update flow.current so the refreshed menu reflects it.
 * Returns a user-facing error string on validation/API failure, or null on ok.
 */
async function applyTextField(ctx: BotContext, field: TextField, raw: string): Promise<string | null> {
    const flow = ctx.session.peerFlow;
    const uuid = flow?.sessionUuid;
    if (!uuid || !flow?.current) return 'Session expired, run /modify again.';

    const text = raw.trim();
    const payload: Record<string, unknown> = { action: 'updateSession', uuid };
    const cur = flow.current;

    switch (field) {
        case 'endpoint': {
            if (text.toLowerCase() === 'none' || /nat/i.test(text)) {
                payload.endpoint = '';
                cur.endpoint = ''; cur.port = '';
            } else {
                const idx = text.lastIndexOf(':');
                const host = idx > 0 ? text.slice(0, idx) : text;
                const port = idx > 0 ? text.slice(idx + 1) : '';
                if (port && !/^\d+$/.test(port)) return 'Invalid port. Use `host:port` or `none`.';
                payload.endpoint = port ? `${host}:${port}` : host;
                cur.endpoint = host; cur.port = port;
            }
            break;
        }
        case 'pubkey': {
            if (!isValidWgPubkey(text)) return 'Invalid WireGuard public key (44 chars ending with `=`).';
            payload.publicKey = text;
            cur.pubkey = text;
            break;
        }
        case 'contact': {
            if (text.length < 3 || text.length > 200) return 'Contact must be 3–200 characters.';
            payload.contact = text;
            cur.contact = text;
            break;
        }
        case 'peerIpv6':
        case 'localIpv6': {
            if (!/^(fe80:|fd[0-9a-f]{2}:|fc[0-9a-f]{2}:)/i.test(text)) {
                return 'Must be a link-local (fe80:) or ULA (fd../fc..) IPv6.';
            }
            if (field === 'peerIpv6') { payload.ipv6 = text; cur.ipv6 = text; }
            else { payload.ipv6LinkLocal = text; cur.localIpv6 = text; }
            break;
        }
        case 'peerIpv4':
        case 'localIpv4': {
            const val = text.toLowerCase() === 'none' ? '' : text;
            if (val && !/^172\.(1[6-9]|2[0-3])\./.test(val)) {
                return 'Must be a DN42 IPv4 (172.16–172.23.x.x) or `none`.';
            }
            if (field === 'peerIpv4') { payload.ipv4 = val; cur.ipv4 = val; }
            else { payload.localIpv4 = val; cur.localIpv4 = val; }
            break;
        }
    }

    const result = await apiRequest('/admin', 'POST', payload, config.apiToken);
    if (result.code !== 0) return result.message || 'Update failed.';
    return null;
}

const FIELD_PROMPTS: Record<TextField, string> = {
    endpoint: '📡 Send the new endpoint as `host:port`, or tap None (NAT).\n输入新端点 `host:端口`，或点 None。',
    pubkey: '🔑 Send the new WireGuard public key (44 chars ending `=`).\n输入新的 WireGuard 公钥。',
    contact: '📇 Send the new contact info (3–200 chars).\n输入新的联系方式。',
    peerIpv6: '🌐 Send the peer IPv6 (fe80:/fd../fc..).\n输入对方 IPv6。',
    peerIpv4: '🌐 Send the peer IPv4 (172.16–23.x.x), or tap None.\n输入对方 IPv4，或点 None。',
    localIpv6: '🌐 Send the local IPv6 (fe80:/fd../fc..).\n输入我方 IPv6。',
    localIpv4: '🌐 Send the local IPv4 (172.16–23.x.x), or tap None.\n输入我方 IPv4，或点 None。',
};

/**
 * Show modify menu helper type - will be passed from peer.ts
 */
type ShowModifyMenuFn = (ctx: BotContext, isFirstTime?: boolean) => Promise<void>;

/**
 * Register all modify flow callback handlers
 * Note: showModifyMenu is still passed because it's defined in peer.ts and complex to extract
 */
export function registerModifyHandlers(
    bot: Bot<BotContext>,
    showModifyMenu: ShowModifyMenuFn
) {
    // Clear leftover ReplyKeyboards from the old (now-removed) ReplyKeyboard-based
    // /modify. Those buttons persist in clients that used the old flow; tapping one
    // now sends its label as plain text, which would fall into an unrelated step
    // (e.g. the remove-confirm code check → "incorrect code"). Intercept the known
    // modify-only labels, drop any stale flow, and remove the keyboard. These
    // labels don't collide with the creation flow (which uses different ones).
    const ORPHAN_MODIFY_KB = new Set([
        'Region', 'Clearnet Endpoint', 'Session Type', 'WireGuard PublicKey',
        'BGP Address', 'PSK', 'MTU', 'Contact', 'Finish modification', 'Abort modification',
        'Peer IPv6 (对方)', 'Peer IPv4 (对方)', 'Local IPv6 (我方)', 'Local IPv4 (我方)',
    ]);
    bot.on('message:text', async (ctx, next) => {
        if (!ORPHAN_MODIFY_KB.has(ctx.message.text.trim())) return next();
        ctx.session.peerFlow = undefined;
        ctx.session.modifyInput = undefined;
        await ctx.reply(
            '✅ Old keyboard cleared. /modify is now inline buttons — run /modify again.\n' +
            '旧键盘已清除。/modify 现在是内联按钮，请重新 /modify。',
            { reply_markup: { remove_keyboard: true } },
        );
    });

    /**
     * Handle info:status callback
     */
    bot.callbackQuery('info:status', async (ctx) => {
        await ctx.answerCallbackQuery('Use /status command');
        await ctx.reply('Use /status to check WG/BGP status\n使用 /status 查看状态');
    });

    /**
     * Handle info:modify callback
     */
    bot.callbackQuery('info:modify', async (ctx) => {
        await ctx.answerCallbackQuery('Use /modify command');
        await ctx.reply('Use /modify to modify a peer\n使用 /modify 修改 Peer');
    });

    /**
     * Handle modify cancel
     */
    bot.callbackQuery('modify:cancel', async (ctx) => {
        ctx.session.peerFlow = undefined;
        await ctx.answerCallbackQuery('Cancelled');
        await ctx.editMessageText('🚫 Modify cancelled.\n已取消修改');
    });

    /**
     * Handle modify submit - submit all pending modifications
     */
    bot.callbackQuery('modify:submit', async (ctx) => {
        const flow = ctx.session.peerFlow;

        if (!flow?.sessionUuid || !flow?.current || !flow?.backup) {
            ctx.session.peerFlow = undefined;
            await ctx.answerCallbackQuery('Error: No session data');
            await ctx.editMessageText('❌ Error: No session data');
            return;
        }

        await ctx.answerCallbackQuery('Submitting changes...');
        await ctx.editMessageText('⏳ Submitting changes...\n正在提交更改...');

        try {
            const result = await submitModifyChanges(flow);

            if (!result.success) {
                await ctx.reply(`❌ ${result.message}`, { reply_markup: { remove_keyboard: true } });
                ctx.session.peerFlow = undefined;
                return;
            }

            if (result.migrated) {
                await ctx.reply(
                    `✅ *Changes submitted & migration initiated!*\n` +
                    `修改已提交，迁移已启动！\n\n` +
                    `From: \`${flow.routerName}\` → To: \`${flow.pendingMigration!.nodeName}\`\n\n` +
                    `Peer will be automatically recreated on the new node.\n` +
                    `Peer 将在新节点上自动重建。\n\n` +
                    `⏳ Please wait a few minutes for changes to apply.\n` +
                    `请等待几分钟让更改生效。`,
                    { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
                );
            } else {
                await ctx.reply(
                    `✅ Modification submitted successfully!\n` +
                    `修改已成功提交！\n\n` +
                    `Node: \`${flow.routerName}\`\n` +
                    `Changes will be applied within a few minutes.\n` +
                    `更改将在几分钟内生效。`,
                    { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
                );
            }
        } catch (error) {
            console.error('[modify:submit] Error:', error);
            await ctx.reply(`❌ Failed to submit changes: ${error instanceof Error ? error.message : 'Unknown error'}`, { reply_markup: { remove_keyboard: true } });
        }

        ctx.session.peerFlow = undefined;
    });

    /**
     * Handle modify:back - dismiss the inline keyboard
     */
    bot.callbackQuery('modify:back', async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.deleteMessage();
    });

    /**
     * Handle PSK modify callbacks
     */
    bot.callbackQuery(/^modify:psk:(.+):(generate|disable)$/, async (ctx) => {
        const uuid = ctx.match?.[1];
        const action = ctx.match?.[2];
        if (!uuid || !action) return;

        // Ownership: must match the session opened via the ownership-checked
        // /modify flow — otherwise a crafted callback could change another
        // peer's PSK.
        if (ctx.session.peerFlow?.sessionUuid !== uuid) {
            await ctx.answerCallbackQuery('❌ Not your peer / 不是你的 Peer');
            return;
        }

        await ctx.answerCallbackQuery('Updating PSK...');

        try {
            const pskValue = action === 'generate'
                ? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
                : null;

            const result = await apiRequest('/admin', 'POST', {
                action: 'updateSession',
                uuid,
                psk: pskValue,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.editMessageText(`❌ Failed: ${result.message}`);
                return;
            }

            // Update current state
            if (ctx.session.peerFlow?.current) {
                ctx.session.peerFlow.current.psk = pskValue !== null;
            }

            if (action === 'generate') {
                await ctx.editMessageText(
                    `✅ *PSK Generated*\nPSK 已生成\n\n` +
                    `\`${pskValue}\`\n\n` +
                    `⚠️ Save this key and configure it on your side.\n` +
                    `请保存此密钥并在你这边配置。`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                await ctx.editMessageText('✅ PSK disabled\nPSK 已禁用');
            }

            await showModifyMenu(ctx);
        } catch (error) {
            console.error('[Modify PSK] Error:', error);
            await ctx.editMessageText('❌ Update failed');
        }
    });

    /**
     * Handle session type modify callbacks
     */
    bot.callbackQuery(/^modify:sessionType:(.+)$/, async (ctx) => {
        const newType = ctx.match?.[1];
        const uuid = ctx.session.peerFlow?.sessionUuid;
        if (!newType) return;
        if (!uuid) {
            await ctx.answerCallbackQuery('❌ Session expired, run /modify again');
            return;
        }

        await ctx.answerCallbackQuery('Updating session type...');

        try {
            // Map session type to extensions
            let extensions = '';
            switch (newType) {
                case 'mpbgp_enh':
                    extensions = 'mp_bgp,extended_nexthop';
                    break;
                case 'mpbgp':
                    extensions = 'mp_bgp';
                    break;
                case 'separate':
                    extensions = '';
                    break;
            }

            const result = await apiRequest('/admin', 'POST', {
                action: 'updateSession',
                uuid,
                extensions,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.editMessageText(`❌ Failed: ${result.message}`);
                return;
            }

            await ctx.editMessageText('✅ Session type updated\n会话类型已更新');
            await showModifyMenu(ctx);
        } catch (error) {
            console.error('[Modify SessionType] Error:', error);
            await ctx.editMessageText('❌ Update failed');
        }
    });

    /**
     * Handle MTU modify callbacks
     */
    bot.callbackQuery(/^modify:mtu:(.+):(\d+)$/, async (ctx) => {
        const uuid = ctx.match?.[1];
        const mtu = parseInt(ctx.match?.[2] || '1420', 10);
        if (!uuid) return;

        // Ownership: must match the session opened via the ownership-checked
        // /modify flow.
        if (ctx.session.peerFlow?.sessionUuid !== uuid) {
            await ctx.answerCallbackQuery('❌ Not your peer / 不是你的 Peer');
            return;
        }

        await ctx.answerCallbackQuery('Updating MTU...');

        try {
            const result = await apiRequest('/admin', 'POST', {
                action: 'updateSession',
                uuid,
                mtu,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.editMessageText(`❌ Failed: ${result.message}`);
                return;
            }

            // Update current state
            if (ctx.session.peerFlow?.current) {
                ctx.session.peerFlow.current.mtu = mtu;
            }

            await ctx.editMessageText(`✅ MTU updated to ${mtu}\nMTU 已更新为 ${mtu}`);
            await showModifyMenu(ctx);
        } catch (error) {
            console.error('[Modify MTU] Error:', error);
            await ctx.editMessageText('❌ Update failed');
        }
    });

    /**
     * Handle Region migration callbacks
     */
    bot.callbackQuery(/^modify:region:(.+)$/, async (ctx) => {
        const newNodeUuid = ctx.match?.[1];
        const sessionUuid = ctx.session.peerFlow?.sessionUuid;
        if (!newNodeUuid) return;
        if (!sessionUuid) {
            await ctx.answerCallbackQuery('❌ Session expired, run /modify again');
            return;
        }

        await ctx.answerCallbackQuery('Migrating peer...');

        try {
            const result = await apiRequest('/admin', 'POST', {
                action: 'migrate',
                uuid: sessionUuid,
                newRouter: newNodeUuid,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.editMessageText(`❌ Migration failed: ${result.message}`);
                return;
            }

            await ctx.editMessageText(
                `✅ *Peer Migration Initiated*\nPeer 迁移已启动\n\n` +
                `Your peer will be recreated on the new node.\n` +
                `Peer 将在新节点上重建。\n\n` +
                `⚠️ Please wait a few minutes for changes to apply.\n` +
                `请等待几分钟让更改生效。`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('[Modify Region] Error:', error);
            await ctx.editMessageText('❌ Migration failed');
        }
    });

    // ===== Fully-inline modify menu (modify:m:*) =====
    // Session UUID is read from ctx.session.peerFlow (set by the ownership-checked
    // modify:peer entry) — never from callback_data.

    const requireFlow = async (ctx: BotContext): Promise<string | null> => {
        const uuid = ctx.session.peerFlow?.sessionUuid;
        if (!uuid) { await ctx.answerCallbackQuery('❌ Session expired, run /modify again'); return null; }
        return uuid;
    };

    // Close the flow.
    bot.callbackQuery('modify:m:done', async (ctx) => {
        ctx.session.peerFlow = undefined;
        ctx.session.modifyInput = undefined;
        await ctx.answerCallbackQuery('Done');
        await ctx.editMessageText('✅ Done modifying.\n修改完成。');
    });

    // Re-render the main menu (Back from a sub-view).
    bot.callbackQuery('modify:m:menu', async (ctx) => {
        ctx.session.modifyInput = undefined;
        await ctx.answerCallbackQuery();
        await showModifyMenu(ctx);
    });

    // Region: list open target nodes (reuses the existing modify:region callback).
    bot.callbackQuery('modify:m:region', async (ctx) => {
        const flow = ctx.session.peerFlow;
        if (!flow?.sessionUuid) { await ctx.answerCallbackQuery('❌ Session expired'); return; }
        await ctx.answerCallbackQuery();
        const res = await apiRequest('/admin', 'POST', { action: 'enumRouters' }, config.apiToken);
        const routers = (res.data?.routers ?? []) as Array<{
            uuid: string; name: string; location?: string; isOpen?: boolean; maxPeers?: number; sessionCount?: number;
        }>;
        const kb = new InlineKeyboard();
        let count = 0;
        for (const r of routers.filter((r) => r.name !== flow.routerName)) {
            const hasCap = !r.maxPeers || (r.sessionCount ?? 0) < r.maxPeers;
            if (!r.isOpen || !hasCap) continue;
            kb.text(`📍 ${r.name}${r.location ? ` (${r.location})` : ''}`, `modify:region:${r.uuid}`).row();
            count++;
        }
        kb.text('🔙 Back', 'modify:m:menu');
        await ctx.editMessageText(
            count > 0
                ? '📍 *Migrate to which node?*\n迁移到哪个节点？'
                : '❌ No other open nodes available.\n没有其他可用节点。',
            { parse_mode: 'Markdown', reply_markup: kb },
        );
    });

    // Session type options (reuses modify:sessionType).
    bot.callbackQuery('modify:m:stype', async (ctx) => {
        if (!(await requireFlow(ctx))) return;
        await ctx.answerCallbackQuery();
        const kb = new InlineKeyboard()
            .text('MP-BGP + ENH (推荐)', 'modify:sessionType:mpbgp_enh').row()
            .text('MP-BGP Only', 'modify:sessionType:mpbgp').row()
            .text('IPv6 + IPv4 (独立)', 'modify:sessionType:separate').row()
            .text('🔙 Back', 'modify:m:menu');
        await ctx.editMessageText('🔀 *Session Type*\n选择会话类型:', { parse_mode: 'Markdown', reply_markup: kb });
    });

    // PSK options (reuses modify:psk).
    bot.callbackQuery('modify:m:psk', async (ctx) => {
        const flow = ctx.session.peerFlow;
        const uuid = await requireFlow(ctx);
        if (!uuid) return;
        await ctx.answerCallbackQuery();
        const kb = new InlineKeyboard();
        if (flow?.current?.psk) {
            kb.text('🔄 Regenerate', `modify:psk:${uuid}:generate`).row()
              .text('❌ Disable', `modify:psk:${uuid}:disable`).row();
        } else {
            kb.text('🔄 Enable & Generate', `modify:psk:${uuid}:generate`).row();
        }
        kb.text('🔙 Back', 'modify:m:menu');
        await ctx.editMessageText(
            `🔐 *PSK* — currently ${flow?.current?.psk ? 'enabled 已启用' : 'disabled 未启用'}`,
            { parse_mode: 'Markdown', reply_markup: kb },
        );
    });

    // MTU presets (reuses modify:mtu).
    bot.callbackQuery('modify:m:mtu', async (ctx) => {
        const uuid = await requireFlow(ctx);
        if (!uuid) return;
        await ctx.answerCallbackQuery();
        const kb = new InlineKeyboard();
        const presets = [1420, 1400, 1380, 1360, 1340, 1320];
        presets.forEach((m, i) => {
            kb.text(m === 1420 ? '1420 (默认)' : String(m), `modify:mtu:${uuid}:${m}`);
            if (i % 3 === 2) kb.row();
        });
        kb.row().text('🔙 Back', 'modify:m:menu');
        await ctx.editMessageText('📏 *MTU* — pick a value:', { parse_mode: 'Markdown', reply_markup: kb });
    });

    // BGP address sub-menu.
    bot.callbackQuery('modify:m:bgp', async (ctx) => {
        const flow = ctx.session.peerFlow;
        if (!flow?.sessionUuid) { await ctx.answerCallbackQuery('❌ Session expired'); return; }
        await ctx.answerCallbackQuery();
        const c = flow.current;
        const kb = new InlineKeyboard()
            .text('Peer IPv6 对方', 'modify:m:peerIpv6').text('Peer IPv4 对方', 'modify:m:peerIpv4').row()
            .text('Local IPv6 我方', 'modify:m:localIpv6').text('Local IPv4 我方', 'modify:m:localIpv4').row()
            .text('🔙 Back', 'modify:m:menu');
        await ctx.editMessageText(
            `🌐 *BGP Address*\n\n` +
            `Peer IPv6: \`${c?.ipv6 || '—'}\`\nPeer IPv4: \`${c?.ipv4 || '—'}\`\n` +
            `Local IPv6: \`${c?.localIpv6 || '—'}\`\nLocal IPv4: \`${c?.localIpv4 || '—'}\``,
            { parse_mode: 'Markdown', reply_markup: kb },
        );
    });

    // Text-input fields: prompt then await the typed value.
    const promptField = async (ctx: BotContext, field: TextField) => {
        const flow = ctx.session.peerFlow;
        if (!flow?.sessionUuid) { await ctx.answerCallbackQuery('❌ Session expired'); return; }
        ctx.session.modifyInput = { uuid: flow.sessionUuid, field };
        await ctx.answerCallbackQuery();
        const kb = new InlineKeyboard();
        if (field === 'endpoint' || field === 'peerIpv4' || field === 'localIpv4') {
            kb.text('🚫 None', `modify:m:none:${field}`).row();
        }
        kb.text('🔙 Back', 'modify:m:menu');
        await ctx.editMessageText(FIELD_PROMPTS[field], { parse_mode: 'Markdown', reply_markup: kb });
    };
    for (const f of ['endpoint', 'pubkey', 'contact', 'peerIpv6', 'peerIpv4', 'localIpv6', 'localIpv4'] as TextField[]) {
        bot.callbackQuery(`modify:m:${f}`, async (ctx) => { await promptField(ctx, f); });
    }

    // "None" shortcut for endpoint / ipv4 fields.
    bot.callbackQuery(/^modify:m:none:(endpoint|peerIpv4|localIpv4)$/, async (ctx) => {
        const field = ctx.match[1] as TextField;
        await ctx.answerCallbackQuery();
        const err = await applyTextField(ctx, field, 'none');
        ctx.session.modifyInput = undefined;
        if (err) { await ctx.editMessageText(`❌ ${err}`); return; }
        await showModifyMenu(ctx);
    });

    // Collect the typed value for the active modifyInput field. Registered before
    // peer.ts's own message:text handler, so it wins when an edit is in progress.
    bot.on('message:text', async (ctx, next) => {
        const input = ctx.session.modifyInput;
        if (!input) return next();
        const text = ctx.message.text.trim();
        if (text === '/cancel') {
            ctx.session.modifyInput = undefined;
            await ctx.reply('🚫 Cancelled.');
            return;
        }
        const err = await applyTextField(ctx, input.field, text);
        ctx.session.modifyInput = undefined;
        if (err) { await ctx.reply(`❌ ${err}`); return; }
        await ctx.reply('✅ Updated.');
        await showModifyMenu(ctx);
    });
}
