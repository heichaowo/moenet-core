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
		if (!standalone) {
			// Validate critical secrets
			if (config.auth.jwtSecret === "change-me-in-production") {
				console.error("❌ JWT_SECRET must be set (cannot use default value)");
				process.exit(1);
			}
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
	hostname: "0.0.0.0",
	fetch: app.fetch,
};
