import { afterEach, describe, expect, it, mock } from "bun:test";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("apiRequest — non-JSON response resilience", () => {
	it("resolves to { code: -1, message } when the body is not valid JSON", async () => {
		// A missing await once let a non-JSON body (proxy error page, empty body,
		// HTML error) escape the try/catch and silently kill every bot callback.
		globalThis.fetch = mock(async () => ({
			json: async () => {
				throw new SyntaxError("Unexpected token < in JSON");
			},
		})) as unknown as typeof fetch;

		const { apiRequest } = await import("../src/api");
		const result = await apiRequest("/admin", "POST", { action: "ping" });

		expect(result.code).toBe(-1);
		expect(typeof result.message).toBe("string");
		expect((result.message ?? "").length).toBeGreaterThan(0);
	});

	it("returns the parsed APIResponse on a valid JSON body", async () => {
		globalThis.fetch = mock(async () => ({
			json: async () => ({ code: 0, message: "ok" }),
		})) as unknown as typeof fetch;

		const { apiRequest } = await import("../src/api");
		const result = await apiRequest("/admin", "GET");

		expect(result.code).toBe(0);
		expect(result.message).toBe("ok");
	});
});
