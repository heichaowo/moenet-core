import { describe, expect, it } from "bun:test";
import { codeSafe, escapeMarkdown } from "../src/markdown";

describe("escapeMarkdown", () => {
	it("escapes underscores — DN42 names like KIOUBIT_NET must not crash Telegram Markdown", () => {
		expect(escapeMarkdown("KIOUBIT_NET")).toBe("KIOUBIT\\_NET");
	});

	it("escapes asterisks", () => {
		expect(escapeMarkdown("hello *world*")).toBe("hello \\*world\\*");
	});

	it("escapes backticks", () => {
		expect(escapeMarkdown("`code`")).toBe("\\`code\\`");
	});

	it("escapes opening square brackets", () => {
		expect(escapeMarkdown("[link]")).toBe("\\[link]");
	});

	it("escapes all special chars together", () => {
		expect(escapeMarkdown("*_`[")).toBe("\\*\\_\\`\\[");
	});

	it("leaves plain text unchanged", () => {
		expect(escapeMarkdown("hello world 42")).toBe("hello world 42");
	});
});

describe("codeSafe", () => {
	it("replaces backticks so they cannot break a code span", () => {
		expect(codeSafe("value`with`backtick")).toBe("value'with'backtick");
	});

	it("replaces every backtick when multiple are present", () => {
		expect(codeSafe("`a``b`")).toBe("'a''b'");
	});

	it("leaves text without backticks unchanged", () => {
		expect(codeSafe("safe text")).toBe("safe text");
	});
});
