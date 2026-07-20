import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { getModels as GetModels } from "../../src/db/dbContext";

// Integration test — runs against a REAL Postgres + Redis (CI service
// containers), not mocks. It self-skips unless INTEGRATION=1, so the plain
// `bun test` unit job ignores it.
//
// The real DB/route modules are imported DYNAMICALLY inside the guarded blocks,
// never at the top level. The unit tests `mock.module(...)` dbContext/
// redisContext, and Bun's module mocks are process-global — a top-level
// `import { initRedis }` here would resolve against that mock (which lacks it)
// and crash the whole unit run just by being collected. Dynamic imports keep
// this file inert unless it actually runs.
const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("integration: agent /bird-config against real Postgres", () => {
	let app: Hono;
	let getModels: typeof GetModels;

	beforeAll(async () => {
		const dbContext = await import("../../src/db/dbContext");
		const { initRedis } = await import("../../src/db/redisContext");
		const { registerRoutes } = await import("../../src/routes");
		getModels = dbContext.getModels;

		// sync schema (NODE_ENV != production) + run migrations + seed default policy
		await dbContext.initDatabase();
		await initRedis();

		// A router the agent route can resolve by name.
		await getModels().routers.create({
			name: "test-node",
			location: "Test",
			maxPeers: 10,
			supportsIpv4: true,
			supportsIpv6: true,
			nodeId: 1,
			regionCode: 1,
		} as never);

		// Build the app from the real routes WITHOUT importing app.ts (which calls
		// main() at import and would connect + serve).
		app = new Hono();
		registerRoutes(app);
	});

	test("bootstrap seeded the default BIRD policy", async () => {
		const policy = await getModels().birdPolicies.findOne({
			where: { isDefault: true },
		});
		expect(policy).not.toBeNull();
	});

	test("policy.dn42As is serialized as a STRING", async () => {
		const res = await app.request("/api/v1/agent/test-node/bird-config", {
			headers: { Authorization: `Bearer ${process.env.AGENT_API_KEY}` },
		});
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			code: number;
			data: { policy: { dn42As: unknown } };
		};
		expect(body.code).toBe(0); // ResponseCode.SUCCESS

		// The regression this test exists for: sending dn42As as a JSON number
		// silently broke bird-config sync across the entire fleet for ~40 days
		// (the Go agent's decoder expects a string). It must be a string.
		expect(typeof body.data.policy.dn42As).toBe("string");
	});
});
