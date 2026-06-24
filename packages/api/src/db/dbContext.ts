import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Sequelize } from "sequelize";
import config from "../config";
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
	const migrationsDir = resolve(currentDir, "..", "..", "..", "migrations");
	await runMigrations(sequelize, models.settings, migrationsDir);
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
