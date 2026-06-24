import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../index';
import config from '../config';
import { apiRequest } from '../api';
import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
    ICONS,
    DIVIDER,
    formatTemplate,
    LOGIN_SUCCESS,
    LOGIN_SIGNATURE_CHALLENGE,
} from '../templates';
import {
    START_WELCOME,
    START_COMMANDS,
    LOGIN_EMAIL_SENT,
    ERROR_NOT_LOGGED_IN,
} from '../i18n';
import { normalizeAsn, isAsnInput } from './peer/validators';


// =============================================================================
// Types
// =============================================================================

interface ChallengeData {
    asn: number;
    mntBy: string;
    challenge: string;
    method: 'gpg' | 'ssh' | 'email';
    gpgFp?: string;
    sshKey?: string;
    email?: string;
    createdAt: number;
    attempts: number;
}

// Store for verification challenges
const challengeStore = new Map<number, ChallengeData>();
const CHALLENGE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_VERIFY_ATTEMPTS = 5;

// Periodic cleanup of expired challenges
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of challengeStore) {
        if (now - data.createdAt > CHALLENGE_TTL_MS) {
            challengeStore.delete(key);
        }
    }
}, 60_000);

/**
 * Register user telegramId via admin API (fire-and-forget).
 */
async function registerUserTelegramId(asn: number, telegramId: number): Promise<void> {
    try {
        await apiRequest('/admin', 'POST', {
            action: 'registerTelegramId',
            asn,
            telegramId,
        }, config.apiToken);
    } catch (error) {
        console.error('[Login] Failed to register telegramId:', error);
    }
}

// =============================================================================
// GPG Verification (Full Implementation)
// =============================================================================

/**
 * Extract primary key fingerprint from GPG output.
 * GPG signatures may use subkeys, but DN42 registry stores primary key fingerprints.
 */
function extractFingerprintFromGpgOutput(stderr: string): string {
    let primaryFingerprint = '';
    let subkeyFingerprint = '';

    for (const line of stderr.split('\n')) {
        if (line.includes('Primary key fingerprint:')) {
            const parts = line.split(':');
            const lastPart = parts[parts.length - 1];
            if (parts.length > 1 && lastPart) {
                primaryFingerprint = lastPart.trim().replace(/ /g, '').toUpperCase();
            }
        } else if (line.includes('Subkey fingerprint:')) {
            const parts = line.split(':');
            const lastPart = parts[parts.length - 1];
            if (parts.length > 1 && lastPart) {
                subkeyFingerprint = lastPart.trim().replace(/ /g, '').toUpperCase();
            }
        } else if (line.toLowerCase().includes('fingerprint:') && !primaryFingerprint) {
            const parts = line.split(':');
            const lastPart = parts[parts.length - 1];
            if (parts.length > 1 && lastPart) {
                primaryFingerprint = lastPart.trim().replace(/ /g, '').toUpperCase();
            }
        } else if (line.toLowerCase().includes('using') && line.toLowerCase().includes('key') && !subkeyFingerprint) {
            const words = line.split(/\s+/);
            for (const word of words) {
                if (word.length >= 16 && /^[0-9A-Fa-f]+$/.test(word)) {
                    subkeyFingerprint = word.toUpperCase();
                }
            }
        }
    }

    return primaryFingerprint || subkeyFingerprint;
}

/**
 * Run a command with spawn (no shell) and collect output.
 *
 * Used by both GPG and SSH verification to avoid shell injection.
 */
function spawnAsync(
    cmd: string,
    args: string[],
    options?: { timeout?: number; stdin?: string }
): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args);
        let stdout = '';
        let stderr = '';
        let settled = false;

        proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
        proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

        if (options?.stdin) {
            proc.stdin.write(options.stdin);
            proc.stdin.end();
        }

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            proc.kill('SIGKILL');
            reject(new Error(`${cmd} timed out`));
        }, options?.timeout ?? 30000);

        proc.on('close', (code: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, code: code ?? 1 });
        });

        proc.on('error', (err: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
    });
}

/**
 * Decrypt GPG signed message to get original content.
 */
async function gpgDecryptChallenge(sigPath: string): Promise<{ content: string | null; stderr: string }> {
    try {
        const result = await spawnAsync('gpg', ['--decrypt', sigPath]);
        // gpg outputs decrypted content to stdout and status to stderr
        const combined = result.stdout + result.stderr;
        return { content: combined.trim(), stderr: result.stderr };
    } catch (error) {
        return { content: null, stderr: String(error) };
    }
}

/**
 * Import GPG key from keyserver.
 */
async function recvGpgKeyFromKeyserver(fingerprint: string, keyserver: string): Promise<boolean> {
    try {
        await spawnAsync('gpg', ['--keyserver', keyserver, '--recv-keys', fingerprint], { timeout: 30000 });
        return true;
    } catch {
        return false;
    }
}

/**
 * Verify GPG signature and check if fingerprint matches.
 */
async function tryGpgVerifyFingerprint(
    sigPath: string,
    gpgFingerprints: string[]
): Promise<{ success: boolean; fingerprint?: string; error?: string }> {
    try {
        const result = await spawnAsync('gpg', ['--verify', sigPath]);
        // gpg outputs verification info to stderr
        const signatureFingerprint = extractFingerprintFromGpgOutput(result.stderr);

        if (!signatureFingerprint) {
            return { success: false, error: 'Could not extract fingerprint from signature' };
        }

        const fingerprintsUpper = gpgFingerprints.map(fp => fp.replace(/ /g, '').toUpperCase());

        const fingerprintMatched = fingerprintsUpper.some(fp =>
            signatureFingerprint.includes(fp) || fp.includes(signatureFingerprint)
        );

        if (!fingerprintMatched) {
            return { success: false, fingerprint: signatureFingerprint, error: 'Fingerprint not matched' };
        }

        return { success: true, fingerprint: signatureFingerprint };
    } catch (error) {
        return { success: false, error: String(error) };
    }
}

/**
 * Full GPG signature verification (dn42-bot style)
 */
async function verifyGpgSignatureFull(
    signature: string,
    expectedContent: string,
    gpgFingerprints: string[]
): Promise<{ verified: boolean; fingerprint?: string; needsManualKey?: boolean; error?: string }> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moenet-gpg-'));
    const sigFile = path.join(tmpDir, 'sig.asc');

    try {
        await fs.writeFile(sigFile, signature);

        // Step 1: Verify challenge string matches
        const { content } = await gpgDecryptChallenge(sigFile);

        if (!content || !content.includes(expectedContent)) {
            return {
                verified: false,
                error: `Challenge mismatch. Expected: ${expectedContent}, Got: ${content || '(unable to decrypt)'}`,
            };
        }

        // Step 2: Try to verify fingerprint directly
        let result = await tryGpgVerifyFingerprint(sigFile, gpgFingerprints);

        if (result.success) {
            return { verified: true, fingerprint: result.fingerprint };
        }

        // Step 3: Try to fetch key from keyservers
        const keyservers = [
            'hkps://keys.openpgp.org',
            'hkps://keyserver.ubuntu.com',
        ];

        for (const fp of gpgFingerprints) {
            for (const keyserver of keyservers) {
                await recvGpgKeyFromKeyserver(fp.replace(/ /g, ''), keyserver);
            }
        }

        // Retry verification
        result = await tryGpgVerifyFingerprint(sigFile, gpgFingerprints);

        if (result.success) {
            return { verified: true, fingerprint: result.fingerprint };
        }

        // Step 4: Need manual key upload
        return { verified: false, needsManualKey: true, error: result.error };

    } finally {
        try {
            await fs.rm(tmpDir, { recursive: true, force: true });
        } catch { }
    }
}

// =============================================================================
// SSH Verification (Full Implementation)
// =============================================================================

/**
 * Full SSH signature verification.
 *
 * Handles all Telegram formatting issues:
 * - Unicode dash substitution (em dash, en dash, etc.)
 * - Arbitrary line wrapping of base64 body
 * - Zero-width characters
 *
 * Uses spawnAsync (no shell) and pipes challenge via stdin,
 * matching the old Python project's subprocess.run approach.
 */

const SSH_SIG_HEADER = '-----BEGIN SSH SIGNATURE-----';
const SSH_SIG_FOOTER = '-----END SSH SIGNATURE-----';

async function verifySshSignatureFull(
    signature: string,
    challenge: string,
    sshKey: string
): Promise<{ verified: boolean; error?: string }> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moenet-ssh-'));
    const sigFile = path.join(tmpDir, 'sig.sig');
    const pubFile = path.join(tmpDir, 'pub.pub');
    const allowFile = path.join(tmpDir, 'allow.txt');

    try {
        const normalizedSig = normalizeSshSignature(signature);

        await fs.writeFile(sigFile, normalizedSig);
        await fs.writeFile(pubFile, sshKey);
        await fs.writeFile(allowFile, `user ${sshKey}\n`);

        const result = await spawnAsync('ssh-keygen', [
            '-Y', 'verify',
            '-f', allowFile,
            '-I', 'user',
            '-n', 'file',
            '-s', sigFile,
        ], { timeout: 10000, stdin: challenge });

        console.log(`[SSH Verify] exit=${result.code}`);

        // ssh-keygen -Y verify outputs: Good "file" signature for user with ...
        // Check exit code first (most reliable), then regex fallback
        const combined = result.stdout + result.stderr;
        const verified = result.code === 0 || /Good\s+"?\w+"?\s+signature/i.test(combined);

        if (!verified) {
            const errMsg = result.stderr.trim() || result.stdout.trim() || 'Verification failed';
            return { verified: false, error: errMsg };
        }

        return { verified: true };

    } catch (error) {
        console.error(`[SSH Verify] Error: ${(error as Error).message}`);
        return { verified: false, error: (error as Error).message || String(error) };
    } finally {
        try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { }
    }
}

/**
 * Normalize SSH signature armor to handle ALL Telegram formatting issues.
 *
 * Telegram applies multiple auto-formatting transformations:
 * 1. Consecutive hyphens (---) → em dash (—) or en dash (–)
 * 2. Various other Unicode dash characters
 * 3. Zero-width characters inserted between words
 * 4. Line wrapping at arbitrary widths in message bubbles
 *
 * This function:
 * - Replaces ALL Unicode dash variants back to ASCII hyphens
 * - Strips zero-width characters
 * - Extracts the base64 body and re-wraps at 70 chars per line
 */
function normalizeSshSignature(raw: string): string {
    // Step 1: Replace ALL Unicode dash/hyphen variants → ASCII hyphen(s)
    // Telegram can substitute any of these depending on platform/version
    let sanitized = raw
        .replace(/\u2014/g, '---')  // em dash → three hyphens (Telegram replaces --- with —)
        .replace(/\u2013/g, '-')    // en dash → hyphen
        .replace(/\u2012/g, '-')    // figure dash
        .replace(/\u2015/g, '-')    // horizontal bar
        .replace(/\u2212/g, '-')    // minus sign
        .replace(/\u2011/g, '-')    // non-breaking hyphen
        .replace(/\uFE63/g, '-')    // small hyphen-minus
        .replace(/\uFF0D/g, '-')    // fullwidth hyphen-minus
        .replace(/\u2010/g, '-');   // hyphen (yes, there's a separate Unicode hyphen)

    // Step 2: Remove zero-width characters
    sanitized = sanitized
        .replace(/[\u200B\u200C\u200D\uFEFF]/g, '');

    // Step 3: Trim
    sanitized = sanitized.trim();

    // Step 4: Find header and footer
    const headerIdx = sanitized.indexOf(SSH_SIG_HEADER);
    const footerIdx = sanitized.indexOf(SSH_SIG_FOOTER);

    if (headerIdx === -1 || footerIdx === -1) {
        // Fallback: return as-is with trailing newline
        return sanitized + '\n';
    }

    const headerEnd = headerIdx + SSH_SIG_HEADER.length;

    // Step 5: Extract base64 body, strip ALL whitespace
    const base64Body = sanitized.slice(headerEnd, footerIdx).replace(/\s+/g, '');

    // Step 6: Re-wrap at 70 chars per line (standard PEM/sshsig format)
    const wrappedLines: string[] = [];
    for (let i = 0; i < base64Body.length; i += 70) {
        wrappedLines.push(base64Body.slice(i, i + 70));
    }

    return [
        SSH_SIG_HEADER,
        ...wrappedLines,
        SSH_SIG_FOOTER,
        '',
    ].join('\n');
}


// =============================================================================
// Command Registration
// =============================================================================

export function registerUserCommands(bot: Bot<BotContext>) {
    /**
     * /start - Welcome message
     */
    bot.command(['start', 'help'], async (ctx) => {
        // Auto-login admin user
        const username = ctx.from?.username?.toLowerCase();
        const adminUsername = config.adminUsername.toLowerCase().replace('@', '');

        if (username === adminUsername && !ctx.session.asn) {
            ctx.session.asn = config.localAsn || 4242420998;
            ctx.session.person = 'MOENET-MNT';
            ctx.session.isAdmin = true;
        }

        // Send welcome message (MarkdownV2 for links and formatting)
        await ctx.reply(START_WELCOME, {
            parse_mode: 'MarkdownV2',
            link_preview_options: { is_disabled: true },
        });

        // Send command list as second message
        await ctx.reply(START_COMMANDS, { parse_mode: 'Markdown' });
    });

    /**
     * /cancel - Global cancel handler
     */
    bot.command('cancel', async (ctx) => {
        const userId = ctx.from?.id;
        let hadFlow = false;

        if (userId) {
            challengeStore.delete(userId);
            if (ctx.session.awaitingAsn) { ctx.session.awaitingAsn = false; hadFlow = true; }
        }
        // Clean up admin flows
        if (ctx.session.announceFlow) { ctx.session.announceFlow = undefined; hadFlow = true; }
        if (ctx.session.notifyFlow) { ctx.session.notifyFlow = undefined; hadFlow = true; }
        if (ctx.session.awaitingInfoAsn) { ctx.session.awaitingInfoAsn = false; hadFlow = true; }

        await ctx.reply(
            hadFlow
                ? `${ICONS.cancel} Operation cancelled.\n操作已取消。`
                : `${ICONS.cancel} No ongoing operations.\n没有正在进行的操作。`
        );
    });

    /**
     * /login - Start authentication flow
     */
    bot.command('login', async (ctx) => {
        // Check if already logged in
        if (ctx.session.asn) {
            await ctx.reply(
                `${ICONS.info} *Already logged in 已登录*\n${DIVIDER}\n` +
                `Current identity 当前身份: \`${ctx.session.person || `AS${ctx.session.asn}`}\`\n\n` +
                `Use /logout to sign out.\n使用 /logout 退出。`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Mark that we're awaiting ASN input
        ctx.session.awaitingAsn = true;

        const keyboard = new InlineKeyboard()
            .text('🚫 Cancel 取消', 'login:cancel');

        await ctx.reply(
            `${ICONS.login} *DN42 Login 登录*\n${DIVIDER}\n` +
            `Enter your ASN\n请输入你的 ASN\n\n` +
            `Example: \`998\`, \`0998\`, \`AS4242420998\` or \`4242420998\``,
            { parse_mode: 'Markdown', reply_markup: keyboard }
        );
    });

    // login:cancel → abort login flow
    bot.callbackQuery('login:cancel', async (ctx) => {
        const userId = ctx.from?.id;

        // If still awaiting ASN input, full cancel
        if (ctx.session.awaitingAsn) {
            if (userId) challengeStore.delete(userId);
            ctx.session.awaitingAsn = false;
            await ctx.answerCallbackQuery();
            await ctx.editMessageText(`${ICONS.cancel} Login cancelled.\n登录已取消。`);
            return;
        }

        // Already past ASN stage — just dismiss stale button, don't disrupt active flow
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`${ICONS.cancel} Login cancelled.\n登录已取消。`);
    });

    // Handle ASN input for login
    bot.on('message:text', async (ctx, next) => {
        // Only process if explicitly awaiting ASN input
        if (!ctx.session.awaitingAsn) {
            return next();
        }

        const text = ctx.message.text.trim();

        // If a command, cancel login and pass through
        if (text.startsWith('/')) {
            ctx.session.awaitingAsn = false;
            return next();
        }

        // Check if it looks like an ASN
        if (!isAsnInput(text)) {
            await ctx.reply(`${ICONS.error} Invalid ASN format. Example: 998, 0998, AS4242420998\n无效的 ASN 格式。`);
            return;
        }

        const asn = normalizeAsn(text);

        if (asn < 4242420000 || asn > 4242429999) {
            await ctx.reply(`${ICONS.error} Invalid ASN. DN42 range: 4242420000-4242429999\n无效的 ASN。DN42 范围: 4242420000-4242429999`);
            return;
        }

        // Clear awaiting flag
        ctx.session.awaitingAsn = false;

        // Query auth methods from API
        try {
            const result = await apiRequest('/auth', 'POST', {
                action: 'query',
                asn: String(asn),
            });

            if (result.code !== 0) {
                await ctx.reply(`${ICONS.error} Error: ${result.message ?? 'Unknown error'}`);
                return;
            }

            const person = result.data?.person;
            const mntBy = result.data?.mntBy || `AS${asn}-MNT`;
            const availableAuthMethods = result.data?.availableAuthMethods || [];

            if (availableAuthMethods.length === 0) {
                await ctx.reply(
                    `${ICONS.error} *No authentication methods found*\n` +
                    `在 Registry 中未找到认证方式\n\n` +
                    `ASN: \`AS${asn}\`\n\n` +
                    `Please make sure your WHOIS object has pgp-fingerprint or contact email.`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            // Parse auth methods
            const gpgFingerprints: string[] = [];
            const sshKeys: string[] = [];
            const emails: string[] = [];

            for (const method of availableAuthMethods) {
                // Handle both formats: {type, value/fingerprint} and {type, name/data}
                const val = method.value || method.name || method.data || method.fingerprint;
                if (method.type === 1 && val) {
                    gpgFingerprints.push(val);
                } else if (method.type === 2 && val) {
                    sshKeys.push(val);
                } else if (method.type === 3 && val) {
                    emails.push(val);
                }
            }

            // Log method counts (avoid logging full key material)
            console.log(`[Login] AS${asn} auth methods - GPG: ${gpgFingerprints.length}, SSH: ${sshKeys.length}, Email: ${emails.length}`);

            // Build auth method keyboard
            const keyboard = new InlineKeyboard();

            if (gpgFingerprints.length > 0) {
                keyboard.text('🔐 GPG Signature GPG 签名', `login:gpg:${asn}`).row();
            }
            if (sshKeys.length > 0) {
                keyboard.text('🔑 SSH Signature SSH 签名', `login:ssh:${asn}`).row();
            }
            if (emails.length > 0) {
                keyboard.text('📧 Email 邮箱', `login:email:${asn}`).row();
            }


            // Store available auth data
            challengeStore.set(ctx.from.id, {
                asn,
                mntBy,
                challenge: '',
                method: 'email', // default
                gpgFp: gpgFingerprints[0],
                sshKey: sshKeys[0],
                email: emails[0],
                createdAt: Date.now(),
                attempts: 0,
            });

            keyboard.text('🚫 Cancel 取消', 'login:cancel').row();

            await ctx.reply(
                `👤 *${person}* (AS${asn})\n\n` +
                `Choose authentication method.\n` +
                `选择验证方式。`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard,
                }
            );
        } catch (error) {
            console.error('[Login] Error:', error);
            await ctx.reply(`${ICONS.error} Failed to query authentication methods\n查询认证方式失败`);
        }
    });

    // Handle GPG login
    bot.callbackQuery(/^login:gpg:(\d+)$/, async (ctx) => {
        const asnStr = ctx.match?.[1];
        if (!asnStr) return;
        const asn = parseInt(asnStr);
        const userId = ctx.from.id;

        // Get stored data
        const stored = challengeStore.get(userId);
        const gpgFp = stored?.gpgFp || '';

        // Generate challenge
        const challenge = crypto.randomBytes(16).toString('hex');

        // Store challenge
        challengeStore.set(userId, {
            asn,
            mntBy: stored?.mntBy || `AS${asn}-MNT`,
            challenge,
            method: 'gpg',
            gpgFp,
            createdAt: Date.now(),
            attempts: 0,
        });

        const fpDisplay = gpgFp.length > 16 ? `${gpgFp.slice(0, 8)}...${gpgFp.slice(-8)}` : gpgFp;

        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
            `🔐 *GPG Signature Challenge*\n` +
            `🔐 *GPG 签名挑战*\n` +
            `${DIVIDER}\n` +
            `Selected GPG Fingerprint 选择的 GPG 指纹:\n` +
            `- \`${fpDisplay}\`\n\n` +
            `Challenge String 挑战字符串:\n` +
            `\`${challenge}\`\n\n` +
            `Please sign the challenge string with your GPG private key and send the signature.\n` +
            `请使用你的 GPG 私钥对挑战字符串进行签名，并发送签名结果。\n\n` +
            `Command 命令:\n` +
            `\`echo -n '${challenge}' | gpg --clearsign\`\n\n` +
            `Send the complete signed message (including headers). Use /cancel to interrupt.\n` +
            `发送完整的签名消息（包括头部）。使用 /cancel 终止操作。`,
            { parse_mode: 'Markdown' }
        );
    });

    // Handle SSH login
    bot.callbackQuery(/^login:ssh:(\d+)$/, async (ctx) => {
        const asnStr = ctx.match?.[1];
        if (!asnStr) return;
        const asn = parseInt(asnStr);
        const userId = ctx.from.id;

        const stored = challengeStore.get(userId);
        const sshKey = stored?.sshKey || '';

        // Generate challenge
        const challenge = crypto.randomBytes(16).toString('hex');

        // Store challenge
        challengeStore.set(userId, {
            asn,
            mntBy: stored?.mntBy || `AS${asn}-MNT`,
            challenge,
            method: 'ssh',
            sshKey,
            createdAt: Date.now(),
            attempts: 0,
        });

        const sshKeyDisplay = sshKey.length > 60 ? `\`${sshKey.slice(0, 60)}...\`` : `\`${sshKey}\``;

        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
            `🔑 *SSH Signature Challenge*\n` +
            `🔑 *SSH 签名挑战*\n` +
            `${DIVIDER}\n` +
            `Selected SSH Public Key 选择的 SSH 公钥:\n` +
            `- ${sshKeyDisplay}\n\n` +
            `Challenge String 挑战字符串:\n` +
            `\`${challenge}\`\n\n` +
            `Please sign the challenge string with your SSH private key and send the signature.\n` +
            `请使用你的 SSH 私钥对挑战字符串进行签名，并发送签名结果。\n\n` +
            `Command 命令:\n` +
            `\`echo -n '${challenge}' | ssh-keygen -Y sign -f ~/.ssh/id_ed25519 -n file\`\n\n` +
            `Send the output signature. Use /cancel to interrupt.\n` +
            `发送输出的签名内容。使用 /cancel 终止操作。`,
            { parse_mode: 'Markdown' }
        );
    });

    // Handle Email login
    bot.callbackQuery(/^login:email:(\d+)$/, async (ctx) => {
        const asnStr = ctx.match?.[1];
        if (!asnStr) return;
        const asn = parseInt(asnStr);
        const userId = ctx.from.id;

        const stored = challengeStore.get(userId);
        const email = stored?.email;

        if (!email) {
            await ctx.answerCallbackQuery();
            await ctx.editMessageText(
                `📧 *Email Login*\n\n` +
                `${ICONS.error} No email address found for AS${asn}.\n` +
                `未找到 AS${asn} 的邮箱地址。\n\n` +
                `Please use GPG or SSH authentication instead.\n` +
                `请使用 GPG 或 SSH 认证。`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Generate 6-digit code
        const code = String(Math.floor(100000 + Math.random() * 900000));

        // Store code
        challengeStore.set(userId, {
            asn,
            mntBy: stored?.mntBy || `AS${asn}-MNT`,
            challenge: code,
            method: 'email',
            email,
            createdAt: Date.now(),
            attempts: 0,
        });

        await ctx.answerCallbackQuery();

        try {
            // Send verification email via admin API (Mailgun)
            const result = await apiRequest('/admin', 'POST', {
                action: 'sendEmail',
                email,
                asn,
                code,
            }, config.apiToken);

            if (result.code !== 0) {
                await ctx.editMessageText(
                    `📧 *Email Login*\n\n` +
                    `${ICONS.error} Failed to send verification email.\n` +
                    `发送验证邮件失败。\n\n` +
                    `Error: ${result.message}\n\n` +
                    `Please use GPG or SSH authentication instead.\n` +
                    `请使用 GPG 或 SSH 认证。`,
                    { parse_mode: 'Markdown' }
                );
                challengeStore.delete(userId);
                return;
            }

            // Mask email for display
            const maskedEmail = email.replace(/^(.{2})(.*)(@.*)$/, '$1***$3');

            await ctx.editMessageText(
                `📧 *Email Login*\n\n` +
                `✉️ Verification code has been sent to:\n` +
                `验证码已发送至：\n` +
                `\`${maskedEmail}\`\n\n` +
                `Please enter the 6-digit code.\n` +
                `请输入 6 位验证码。\n\n` +
                `The code will expire in 10 minutes.\n` +
                `验证码将在 10 分钟后过期。\n\n` +
                `Use /cancel to interrupt.\n` +
                `使用 /cancel 终止操作。`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('[Login] Email send error:', error);
            await ctx.editMessageText(
                `📧 *Email Login*\n\n` +
                `${ICONS.error} Failed to send verification email.\n` +
                `发送验证邮件失败。`,
                { parse_mode: 'Markdown' }
            );
            challengeStore.delete(userId);
        }
    });

    // Handle signature/code verification
    bot.on('message:text', async (ctx, next) => {
        const userId = ctx.from.id;
        const stored = challengeStore.get(userId);

        if (!stored || !stored.challenge) {
            return next();
        }

        // Check TTL
        if (Date.now() - stored.createdAt > CHALLENGE_TTL_MS) {
            challengeStore.delete(userId);
            await ctx.reply(
                `${ICONS.error} Challenge expired. Please use /login again.\n` +
                `验证已过期，请重新 /login。`
            );
            return;
        }

        // Check attempt limit
        stored.attempts++;
        if (stored.attempts > MAX_VERIFY_ATTEMPTS) {
            challengeStore.delete(userId);
            await ctx.reply(
                `${ICONS.error} Too many failed attempts. Please use /login again.\n` +
                `失败次数过多，请重新 /login。`
            );
            return;
        }

        const text = ctx.message.text.trim();

        // If a command, clean up and pass through
        if (text.startsWith('/')) {
            challengeStore.delete(userId);
            return next();
        }

        const { asn, mntBy, challenge, method } = stored;

        try {
            if (method === 'email') {
                // Verify email code
                if (text === challenge) {
                    challengeStore.delete(userId);
                    ctx.session.asn = asn;
                    ctx.session.person = mntBy;
                    // Persist telegramId → users table (non-blocking)
                    registerUserTelegramId(asn, userId).then(() => { ctx.session._registered = true; }).catch(() => {});
                    await ctx.reply(
                        `${ICONS.success} *Signature verified successfully!*\n` +
                        `${ICONS.success} *签名验证成功！*\n\n` +
                        `Welcome! \`${mntBy}  AS${asn}\`\n` +
                        `欢迎你！\`${mntBy}  AS${asn}\``,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    await ctx.reply(`${ICONS.error} Invalid code. Try again.\n验证码错误，请重试。`);
                }
            } else if (method === 'gpg') {
                // Verify GPG signature (full implementation)
                const gpgFps = stored.gpgFp ? [stored.gpgFp] : [];
                const result = await verifyGpgSignatureFull(text, challenge, gpgFps);

                if (result.verified) {
                    challengeStore.delete(userId);
                    ctx.session.asn = asn;
                    ctx.session.person = mntBy;
                    // Persist telegramId → users table (non-blocking)
                    registerUserTelegramId(asn, userId).then(() => { ctx.session._registered = true; }).catch(() => {});
                    await ctx.reply(
                        `${ICONS.success} *Signature verified successfully!*\n` +
                        `${ICONS.success} *签名验证成功！*\n\n` +
                        `Welcome! \`${mntBy}  AS${asn}\`\n` +
                        `欢迎你！\`${mntBy}  AS${asn}\``,
                        { parse_mode: 'Markdown' }
                    );
                } else if (result.needsManualKey) {
                    await ctx.reply(
                        `${ICONS.warning} Could not verify the signature with available keys.\n` +
                        `无法使用可用的密钥验证签名。\n\n` +
                        `Error: ${result.error}\n\n` +
                        `Please try /login again or contact @HeiCha for help.\n` +
                        `请重试 /login 或联系 @HeiCha 寻求帮助。`
                    );
                    challengeStore.delete(userId);
                } else {
                    await ctx.reply(
                        `${ICONS.error} *Signature verification failed*\n签名验证失败\n\n` +
                        `${result.error || 'Unknown error'}\n\n` +
                        `Use /login to try again.\n使用 /login 重试。`,
                        { parse_mode: 'Markdown' }
                    );
                    challengeStore.delete(userId);
                }
            } else if (method === 'ssh') {
                // Verify SSH signature (full implementation)
                const sshKey = stored.sshKey || '';
                const result = await verifySshSignatureFull(text, challenge, sshKey);

                if (result.verified) {
                    challengeStore.delete(userId);
                    ctx.session.asn = asn;
                    ctx.session.person = mntBy;
                    // Persist telegramId → users table (non-blocking)
                    registerUserTelegramId(asn, userId).then(() => { ctx.session._registered = true; }).catch(() => {});
                    await ctx.reply(
                        `${ICONS.success} *Signature verified successfully!*\n` +
                        `${ICONS.success} *签名验证成功！*\n\n` +
                        `Welcome! \`${mntBy}  AS${asn}\`\n` +
                        `欢迎你！\`${mntBy}  AS${asn}\``,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    challengeStore.delete(userId);
                    await ctx.reply(
                        `${ICONS.error} *Signature verification failed*\n签名验证失败\n\n` +
                        `${result.error || 'Unknown error'}\n\n` +
                        `Use /login to try again.\n使用 /login 重试。`,
                        { parse_mode: 'Markdown' }
                    );
                }
            }
        } catch (error) {
            console.error('[Login] Verification error:', error);
            await ctx.reply(`${ICONS.error} Verification error: ${(error as Error).message}`);
        }
    });

    /**
     * /logout - Clear session
     */
    bot.command('logout', async (ctx) => {
        if (!ctx.session.asn) {
            await ctx.reply(`${ICONS.error} You are not logged in.\n你尚未登录。`);
            return;
        }

        const asn = ctx.session.asn;
        ctx.session.asn = undefined;
        ctx.session.person = undefined;
        ctx.session.isAdmin = undefined;

        await ctx.reply(`${ICONS.logout} Logged out from AS${asn}\n已退出 AS${asn}`);
    });

    /**
     * /whoami - Show current user
     */
    bot.command('whoami', async (ctx) => {
        if (!ctx.session.asn) {
            await ctx.reply(ERROR_NOT_LOGGED_IN);
            return;
        }

        const { asn, person, isAdmin } = ctx.session;
        const adminBadge = isAdmin ? ' 👑 Admin' : '';

        await ctx.reply(
            `👤 *Current User 当前用户*\n${DIVIDER}\n\n` +
            `ASN: \`AS${asn}\`\n` +
            `Name: ${person}${adminBadge}`,
            { parse_mode: 'Markdown' }
        );
    });
}
