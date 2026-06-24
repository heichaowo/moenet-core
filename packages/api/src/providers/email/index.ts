/**
 * Email Service Provider — Dual Transport (Mailgun + SMTP)
 *
 * Priority: Mailgun HTTP API > SMTP (nodemailer).
 * Disabled when neither is configured.
 */

import { createTransport, type Transporter } from "nodemailer";
import { logger } from "../../common/logger";
import config from "../../config";

interface EmailOptions {
	to: string;
	subject: string;
	text?: string;
	html?: string;
}

export interface EmailResult {
	success: boolean;
	messageId?: string;
	error?: string;
}

type TransportMode = "mailgun" | "smtp" | "disabled";

/**
 * Email Provider with automatic transport selection.
 *
 * Mailgun takes priority when MAILGUN_API_KEY is set.
 * Falls back to SMTP when SMTP_HOST is set.
 * Disabled otherwise.
 */
export class EmailProvider {
	private readonly mode: TransportMode;
	private smtpTransport: Transporter | null = null;

	constructor() {
		if (config.mailgun.apiKey) {
			this.mode = "mailgun";
		} else if (config.smtp.host) {
			this.mode = "smtp";
			this.smtpTransport = createTransport({
				host: config.smtp.host,
				port: config.smtp.port,
				secure: config.smtp.secure,
				auth: config.smtp.user
					? { user: config.smtp.user, pass: config.smtp.pass }
					: undefined,
			});
		} else {
			this.mode = "disabled";
		}

		logger.info("Email provider initialized", { mode: this.mode });
	}

	/**
	 * Whether the email provider can send emails.
	 */
	isEnabled(): boolean {
		return this.mode !== "disabled";
	}

	/**
	 * Send an email via the active transport.
	 */
	async send(options: EmailOptions): Promise<EmailResult> {
		if (this.mode === "mailgun") {
			return this.sendViaMailgun(options);
		}
		if (this.mode === "smtp") {
			return this.sendViaSmtp(options);
		}

		logger.warn("Email send attempted but no transport configured");
		return { success: false, error: "Email service not configured" };
	}

	/**
	 * Send verification code email for auth flow.
	 */
	async sendVerificationCode(
		to: string,
		asn: number,
		code: string,
	): Promise<EmailResult> {
		const subject = `[MoeNet DN42] Verification Code for AS${asn}`;

		const text = `
MoeNet DN42 Autopeering Verification

ASN: AS${asn}
Verification Code: ${code}

This code will expire in 10 minutes.

If you didn't request this, please ignore this email.

---
MoeNet DN42 - https://dn42.moenet.work
        `.trim();

		const html = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        .container { max-width: 500px; margin: 0 auto; padding: 20px; }
        .code { font-size: 32px; font-weight: bold; color: #2563eb; letter-spacing: 4px; }
        .footer { color: #6b7280; font-size: 12px; margin-top: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <h2>🌐 MoeNet DN42 Verification</h2>
        <p>Your verification code for <strong>AS${asn}</strong>:</p>
        <p class="code">${code}</p>
        <p>This code will expire in 10 minutes.</p>
        <p class="footer">If you didn't request this, please ignore this email.</p>
    </div>
</body>
</html>
        `.trim();

		return this.send({ to, subject, text, html });
	}

	/**
	 * Send peer creation notification.
	 */
	async sendPeerNotification(
		to: string,
		asn: number,
		node: string,
		status: string,
	): Promise<EmailResult> {
		const subject = `[MoeNet DN42] Peer ${status} - AS${asn}`;

		const text = `
Your peering request for AS${asn} on ${node} has been ${status.toLowerCase()}.

Node: ${node}
Status: ${status}

Visit our Telegram bot for more details: https://t.me/moenetdn42bot

---
MoeNet DN42 - https://dn42.moenet.work
        `.trim();

		return this.send({ to, subject, text });
	}

	// ── Private transports ──────────────────────────────────────────────

	/**
	 * Send via Mailgun HTTP API.
	 */
	private async sendViaMailgun(options: EmailOptions): Promise<EmailResult> {
		try {
			const formData = new FormData();
			formData.append("from", config.mailgun.from);
			formData.append("to", options.to);
			formData.append("subject", options.subject);
			if (options.text) formData.append("text", options.text);
			if (options.html) formData.append("html", options.html);

			const response = await fetch(
				`https://api.mailgun.net/v3/${config.mailgun.domain}/messages`,
				{
					method: "POST",
					headers: {
						Authorization: `Basic ${btoa(`api:${config.mailgun.apiKey}`)}`,
					},
					body: formData,
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				logger.error("Mailgun API error", undefined, {
					status: response.status,
					body: errorText,
				});
				return {
					success: false,
					error: `Mailgun API error: ${response.status}`,
				};
			}

			const data = (await response.json()) as { id: string };
			logger.info("Email sent via Mailgun", {
				to: options.to,
				messageId: data.id,
			});

			return { success: true, messageId: data.id };
		} catch (err) {
			logger.error(
				"Mailgun send failed",
				err instanceof Error ? err : undefined,
			);
			return { success: false, error: String(err) };
		}
	}

	/**
	 * Send via SMTP (nodemailer).
	 */
	private async sendViaSmtp(options: EmailOptions): Promise<EmailResult> {
		if (!this.smtpTransport) {
			return { success: false, error: "SMTP transport not initialized" };
		}

		try {
			const info = await this.smtpTransport.sendMail({
				from: config.smtp.from,
				to: options.to,
				subject: options.subject,
				text: options.text,
				html: options.html,
			});

			logger.info("Email sent via SMTP", {
				to: options.to,
				messageId: info.messageId,
			});

			return { success: true, messageId: info.messageId };
		} catch (err) {
			logger.error("SMTP send failed", err instanceof Error ? err : undefined);
			return { success: false, error: String(err) };
		}
	}
}

// Singleton instance
let emailProvider: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
	if (!emailProvider) {
		emailProvider = new EmailProvider();
	}
	return emailProvider;
}
