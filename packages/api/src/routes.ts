import type { Hono } from "hono";
import adminHandler from "./handlers/admin";
import agentHandler from "./handlers/agent";
import authHandler from "./handlers/auth";
import bootstrapHandler from "./handlers/bootstrap";
import flapHandler from "./handlers/flap";
import metricsHandler from "./handlers/metrics";
import peeringHandler from "./handlers/peering";

export function registerRoutes(app: Hono) {
	// Bootstrap API (for node initialization)
	app.get("/bootstrap/:token", bootstrapHandler);

	// Agent API (for Go agent communication)
	app.get("/api/v1/agent/:router/:action", agentHandler);
	app.post("/api/v1/agent/:router/:action", agentHandler);
	// Nested action routes (mesh/status)
	app.post("/api/v1/agent/:router/mesh/status", agentHandler);
	// Also support heartbeat without router param
	app.post("/api/v1/agent/heartbeat", agentHandler);

	// Flap detection (FlapAlerted webhooks)
	app.post("/api/v1/flap/alert", flapHandler);
	app.post("/api/v1/flap/resolved", flapHandler);

	// Authentication
	app.post("/api/v1/auth", authHandler);

	// Admin operations
	app.post("/api/v1/admin", adminHandler);

	// Peering management
	app.post("/api/v1/session", peeringHandler);

	// Metrics
	app.get("/api/v1/metrics", metricsHandler);
}
