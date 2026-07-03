/**
 * Escape Telegram Markdown v1 special characters in user-supplied / external
 * text. Prevents unmatched `*`, `_`, `` ` ``, `[` from breaking message parsing
 * (Telegram rejects the whole message with 400 "can't parse entities").
 */
export function escapeMarkdown(text: string): string {
	return text.replace(/([*_`[])/g, "\\$1");
}
