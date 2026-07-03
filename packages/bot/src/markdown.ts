/**
 * Escape Telegram Markdown v1 special characters in user-supplied / external
 * text. Prevents unmatched `*`, `_`, `` ` ``, `[` from breaking message parsing
 * (Telegram rejects the whole message with 400 "can't parse entities").
 */
export function escapeMarkdown(text: string): string {
	return text.replace(/([*_`[])/g, "\\$1");
}

/**
 * Make text safe to place INSIDE a Markdown code span / fence (`` `…` `` or
 * ```` ```…``` ````). Code spans can't be escaped, so a stray backtick in the
 * value would break out and corrupt parsing — replace backticks with a quote.
 */
export function codeSafe(text: string): string {
	return text.replace(/`/g, "'");
}
