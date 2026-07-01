/**
 * Simple SQL Migration Runner
 *
 * Tracks executed migrations in the `settings` KV table (key: `_migrations`).
 * On startup, scans the `migrations/` directory for `*.sql` files,
 * compares against the executed list, and runs any pending ones in alphabetical order.
 *
 * Migration files must be named with a sortable prefix, e.g.:
 *   001_add_rejected_status.sql
 *   002_add_some_column.sql
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sequelize } from "sequelize";
import type { SettingsModel } from "./models/settings";

const MIGRATIONS_KEY = "_migrations";

interface MigrationRecord {
	name: string;
	executedAt: string;
}

/**
 * Run pending SQL migrations from the migrations directory.
 *
 * @param sequelize - Sequelize instance for raw queries
 * @param settingsModel - Settings model for tracking executed migrations
 * @param migrationsDir - Absolute path to the migrations directory
 */
export async function runMigrations(
	sequelize: Sequelize,
	settingsModel: SettingsModel,
	migrationsDir: string,
): Promise<void> {
	// Discover migration files
	let files: string[];
	try {
		const entries = await readdir(migrationsDir);
		files = entries.filter((f) => f.endsWith(".sql")).sort(); // alphabetical = execution order
	} catch {
		// migrations/ directory doesn't exist — nothing to do
		console.log("[Migrations] No migrations directory found, skipping");
		return;
	}
	if (files.length === 0) return;

	// Serialize concurrent startups (multiple pods / restart races) with a
	// Postgres session advisory lock — otherwise two processes can run the same
	// DDL in parallel and corrupt the schema. The lock is released in `finally`.
	await sequelize.query("SELECT pg_advisory_lock(4242420998)");
	try {
		// Re-read executed list AFTER acquiring the lock, in case another process
		// applied migrations while we were waiting.
		const executed = await getExecutedMigrations(settingsModel);
		const executedSet = new Set(executed.map((m) => m.name));

		const pending = files.filter((f) => !executedSet.has(f));
		if (pending.length === 0) {
			console.log(
				`[Migrations] All ${files.length} migrations already applied`,
			);
			return;
		}

		console.log(`[Migrations] ${pending.length} pending migration(s) to run`);

		// NOTE: migrations MUST be idempotent (use IF [NOT] EXISTS, guarded
		// UPDATEs). We run the SQL then record it; a crash in between re-runs the
		// file, so non-idempotent migrations could double-apply.
		for (const file of pending) {
			const filePath = join(migrationsDir, file);
			const sql = await readFile(filePath, "utf-8");

			console.log(`[Migrations] Running: ${file}`);
			try {
				// Run the whole file as a single query — splitting on ';' breaks
				// dollar-quoted blocks (DO $$ ... END $$;). pg's simple query
				// protocol (no bind params) executes all statements in the file.
				const hasSql = sql
					.split("\n")
					.some(
						(line) => line.trim().length > 0 && !line.trim().startsWith("--"),
					);
				if (hasSql) {
					await sequelize.query(sql);
				}

				executed.push({ name: file, executedAt: new Date().toISOString() });
				await saveExecutedMigrations(settingsModel, executed);
				console.log(`[Migrations] ✅ ${file} applied successfully`);
				// Files are NOT deleted: keep them so the schema is replayable if
				// the migration-tracking row is ever lost/restored.
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				console.error(`[Migrations] ❌ ${file} failed: ${msg}`);
				throw new Error(`Migration ${file} failed: ${msg}`);
			}
		}

		console.log(`[Migrations] All migrations applied successfully`);
	} finally {
		await sequelize.query("SELECT pg_advisory_unlock(4242420998)");
	}
}

/**
 * Get the list of already-executed migrations from settings.
 */
async function getExecutedMigrations(
	settingsModel: SettingsModel,
): Promise<MigrationRecord[]> {
	const setting = await settingsModel.findOne({
		where: { key: MIGRATIONS_KEY },
	});
	if (!setting) return [];
	try {
		return JSON.parse(setting.get("value") as string) as MigrationRecord[];
	} catch {
		return [];
	}
}

/**
 * Save the executed migrations list to settings.
 */
async function saveExecutedMigrations(
	settingsModel: SettingsModel,
	migrations: MigrationRecord[],
): Promise<void> {
	await settingsModel.upsert({
		key: MIGRATIONS_KEY,
		value: JSON.stringify(migrations),
	});
}
