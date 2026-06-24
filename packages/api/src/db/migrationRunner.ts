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

import { readdir, readFile, unlink } from "node:fs/promises";
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
	// Read executed migrations from settings
	const executed = await getExecutedMigrations(settingsModel);
	const executedSet = new Set(executed.map((m) => m.name));

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

	// Find pending migrations
	const pending = files.filter((f) => !executedSet.has(f));
	if (pending.length === 0) {
		console.log(`[Migrations] All ${files.length} migrations already applied`);
		return;
	}

	console.log(`[Migrations] ${pending.length} pending migration(s) to run`);

	// Execute each pending migration
	for (const file of pending) {
		const filePath = join(migrationsDir, file);
		const sql = await readFile(filePath, "utf-8");

		console.log(`[Migrations] Running: ${file}`);
		try {
			// Execute the raw SQL (skip empty/comment-only files)
			const statements = sql
				.split(";")
				.map((s) => s.trim())
				.filter((s) => s.length > 0 && !s.startsWith("--"));

			for (const stmt of statements) {
				// Skip transaction control — Sequelize handles this
				if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(stmt)) continue;
				await sequelize.query(stmt);
			}

			// Record as executed
			executed.push({
				name: file,
				executedAt: new Date().toISOString(),
			});
			await saveExecutedMigrations(settingsModel, executed);

			console.log(`[Migrations] ✅ ${file} applied successfully`);

			// Clean up — delete the migration file to avoid clutter
			try {
				await unlink(filePath);
				console.log(`[Migrations] 🗑️ ${file} removed`);
			} catch {
				console.warn(`[Migrations] ⚠️ Could not delete ${file} (non-fatal)`);
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[Migrations] ❌ ${file} failed: ${msg}`);
			// Stop on first failure — don't run subsequent migrations
			throw new Error(`Migration ${file} failed: ${msg}`);
		}
	}

	console.log(`[Migrations] All migrations applied successfully`);
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
