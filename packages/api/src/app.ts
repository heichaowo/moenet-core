import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import config from "./config";
import { initDatabase } from "./db/dbContext";
import { initRedis } from "./db/redisContext";
import { rateLimiter } from "./middleware/rateLimiter";
import { requestId } from "./middleware/requestId";
import { registerRoutes } from "./routes";

const app = new Hono();

// Middleware
app.use("*", requestId());
app.use("*", logger());
app.use("*", rateLimiter());
app.use(
	"*",
	cors({
		origin: config.cors.origins,
		credentials: true,
	}),
);

// Health check
app.get("/health", (c) => c.json({ status: "ok", version: "1.0.0" }));

// Register all routes
registerRoutes(app);

// Initialize connections and start server
async function main() {
	const standalone = process.env.STANDALONE === "true";

	try {
		// Validate the JWT secret unconditionally — even standalone must not sign
		// tokens with the known default (a misconfigured standalone could reach prod).
		if (config.auth.jwtSecret === "change-me-in-production") {
			console.error("❌ JWT_SECRET must be set (cannot use default value)");
			process.exit(1);
		}
		if (!standalone) {
			if (!config.auth.agentApiKey) {
				console.warn(
					"⚠️  AGENT_API_KEY not set — agent/admin API will reject all requests",
				);
			}

			await initDatabase();
			console.log("✅ Database connected");

			await initRedis();
			console.log("✅ Redis connected");
		} else {
			console.log("⚠️  Running in STANDALONE mode (no DB/Redis)");
		}

		console.log(`🚀 Server running on http://localhost:${config.server.port}`);
	} catch (error) {
		console.error("❌ Failed to start server:", error);
		process.exit(1);
	}
}

main();

export default {
	port: config.server.port,
	// Was hardcoded "0.0.0.0", ignoring config.server.host (bug-list #7).
	// config.server.host defaults to "0.0.0.0" so container behaviour is
	// unchanged, but it can now be restricted via the HOST env var.
	hostname: config.server.host,
	fetch: app.fetch,
};
