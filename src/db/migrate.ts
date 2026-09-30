import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

/** `migrations/` at the repository root (works from both src/ and dist/). */
export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

// Arbitrary constant so concurrent migrators (e.g. two deploys) serialize.
const MIGRATION_LOCK_ID = 7_412_003;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
}

/**
 * Applies every `*.sql` file in lexical order that has not been applied yet.
 * All pending files run in a single transaction together with their
 * bookkeeping rows, so a failing migration leaves no partial state behind.
 */
export async function runMigrations(db: Db, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  return db.transaction(async (lockTx) => {
    // Transaction-scoped lock: released automatically on commit/rollback.
    await lockTx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    const rows = await lockTx.query<{ version: string }>("SELECT version FROM schema_migrations");
    const done = new Set(rows.map((r) => r.version));
    const applied: string[] = [];

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      try {
        await lockTx.query(sql);
        await lockTx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      } catch (error) {
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
      applied.push(file);
    }
    return { applied, alreadyApplied: done.size };
  });
}
