import type { Context } from "hono";

/**
 * Metrics Handler - Prometheus format
 * Exposes metrics for monitoring with Prometheus/Grafana
 */
export default async function metricsHandler(c: Context): Promise<Response> {
	const metrics: string[] = [];

	// Helper to add metric
	const gauge = (
		name: string,
		help: string,
		value: number,
		labels?: Record<string, string>,
	) => {
		metrics.push(`# HELP ${name} ${help}`);
		metrics.push(`# TYPE ${name} gauge`);
		const labelStr = labels
			? `{${Object.entries(labels)
					.map(([k, v]) => `${k}="${v}"`)
					.join(",")}}`
			: "";
		metrics.push(`${name}${labelStr} ${value}`);
	};

	try {
		// Get database models if available
		const app = c.get("app") as App | undefined;

		if (app?.models) {
			// Session counts
			const [totalSessions, activeSessions, pendingSessions] =
				await Promise.all([
					app.models.bgpSessions.count(),
					app.models.bgpSessions.count({ where: { status: 1 } }), // ACTIVE
					app.models.bgpSessions.count({ where: { status: 3 } }), // PENDING_REVIEW
				]);

			gauge(
				"moenet_sessions_total",
				"Total number of BGP sessions",
				totalSessions,
			);
			gauge(
				"moenet_sessions_active",
				"Number of active BGP sessions",
				activeSessions,
			);
			gauge(
				"moenet_sessions_pending",
				"Number of pending BGP sessions",
				pendingSessions,
			);

			// Router counts
			const routers = await app.models.routers.findAll();
			gauge("moenet_routers_total", "Total number of routers", routers.length);

			const openRouters = routers.filter(
				(r: RouterModel) => r.openPeering,
			).length;
			gauge(
				"moenet_routers_open",
				"Number of routers accepting peering",
				openRouters,
			);

			// Per-router session counts
			for (const router of routers) {
				const sessionCount = await app.models.bgpSessions.count({
					where: { routerUuid: router.uuid, status: 1 },
				});
				gauge("moenet_router_sessions", "Sessions per router", sessionCount, {
					router: router.name,
				});
			}

			// User count
			const userCount = await app.models.users.count();
			gauge("moenet_users_total", "Total registered users", userCount);
		} else {
			// Fallback - no database connection
			gauge("moenet_up", "MoeNet API is up", 1);
		}

		// Add uptime
		gauge("moenet_uptime_seconds", "API uptime in seconds", process.uptime());

		// Add Node.js metrics
		const memUsage = process.memoryUsage();
		gauge(
			"moenet_memory_heap_used_bytes",
			"Heap memory used",
			memUsage.heapUsed,
		);
		gauge(
			"moenet_memory_heap_total_bytes",
			"Total heap memory",
			memUsage.heapTotal,
		);
		gauge("moenet_memory_rss_bytes", "Resident set size", memUsage.rss);
	} catch (error) {
		console.error("[Metrics] Error collecting metrics:", error);
		gauge("moenet_up", "MoeNet API is up", 0);
	}

	return new Response(`${metrics.join("\n")}\n`, {
		headers: {
			"Content-Type": "text/plain; version=0.0.4; charset=utf-8",
		},
	});
}

// Type definitions
interface App {
	models: {
		bgpSessions: ModelStatic;
		routers: ModelStatic;
		users: ModelStatic;
	};
}

interface ModelStatic {
	count(options?: { where?: Record<string, unknown> }): Promise<number>;
	findAll(): Promise<RouterModel[]>;
}

interface RouterModel {
	uuid: string;
	name: string;
	openPeering: boolean;
}
