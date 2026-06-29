import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Sequelize } from "sequelize";
import config from "../config";

// Parse Postgres BIGINT (int8, OID 20) as a JS number instead of a string.
// Sequelize/pg default BIGINT to strings to avoid precision loss, but our
// BIGINT columns (asn, dn42As) hold DN42 ASNs (~4.2e9), well within Number's
// 2^53 safe range. Returning numbers keeps asn comparisons/Map keys working
// once asn columns move from INTEGER to BIGINT (bug-list #2).
pg.types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));
import { runMigrations } from "./migrationRunner";
import { type AuditLogsModel, initAuditLogsModel } from "./models/auditLogs";
// Model imports
import {
	type BgpSessionsModel,
	initBgpSessionsModel,
} from "./models/bgpSessions";
import {
	type BirdPoliciesModel,
	initBirdPoliciesModel,
} from "./models/birdPolicies";
import { initRoutersModel, type RoutersModel } from "./models/routers";
import { initSettingsModel, type SettingsModel } from "./models/settings";
import { initUsersModel, type UsersModel } from "./models/users";

let sequelize: Sequelize | null = null;

export interface Models {
	bgpSessions: BgpSessionsModel;
	routers: RoutersModel;
	users: UsersModel;
	settings: SettingsModel;
	auditLogs: AuditLogsModel;
	birdPolicies: BirdPoliciesModel;
}

let models: Models | null = null;

export async function initDatabase(): Promise<void> {
	sequelize = new Sequelize({
		dialect: config.database.dialect,
		host: config.database.host,
		port: config.database.port,
		database: config.database.database,
		username: config.database.username,
		password: config.database.password,
		logging: config.database.logging ? console.log : false,
		pool: {
			max: 10,
			min: 0,
			acquire: 30000,
			idle: 10000,
		},
	});

	// Test connection
	await sequelize.authenticate();

	// Initialize models
	models = {
		bgpSessions: initBgpSessionsModel(sequelize),
		routers: initRoutersModel(sequelize),
		users: initUsersModel(sequelize),
		settings: initSettingsModel(sequelize),
		auditLogs: initAuditLogsModel(sequelize),
		birdPolicies: initBirdPoliciesModel(sequelize),
	};

	// Sync models (in development)
	if (process.env.NODE_ENV !== "production") {
		await sequelize.sync({ alter: true });
	}

	// Run pending SQL migrations (both dev and prod)
	// migrations/ dir is at the monorepo root: moenet-core/migrations/
	const currentDir =
		typeof __dirname !== "undefined"
			? __dirname
			: dirname(fileURLToPath(import.meta.url));
	// currentDir is <root>/packages/api/src/db, so the repo-root migrations/ dir
	// is 4 levels up (was 3 → resolved to packages/migrations, which doesn't
	// exist, so migrations never ran — bug-list #3). In the Docker image the
	// Dockerfile copies migrations/ to /app/migrations, and the code runs from
	// /app/packages/api/src/db, so 4-up = /app likewise.
	const migrationsDir = resolve(currentDir, "..", "..", "..", "..", "migrations");
	await runMigrations(sequelize, models.settings, migrationsDir);

	// Ensure a default BIRD policy exists. The agent's bird-config requires an
	// isDefault policy; without one a fresh deployment gets "No default BIRD
	// policy configured" and never sets up BIRD. Seed one from the model
	// defaults (DN42 ASN, prefixes, two RPKI sources, limits, communities).
	// findOrCreate leaves any existing default policy untouched.
	const [, created] = await models.birdPolicies.findOrCreate({
		where: { isDefault: true },
		defaults: { name: "default", isDefault: true } as never,
	});
	if (created) {
		console.log("[Seed] Created default BIRD policy");
	}
}

export function getModels(): Models {
	if (!models) {
		throw new Error("Database not initialized. Call initDatabase() first.");
	}
	return models;
}

export function getSequelize(): Sequelize {
	if (!sequelize) {
		throw new Error("Database not initialized. Call initDatabase() first.");
	}
	return sequelize;
}
