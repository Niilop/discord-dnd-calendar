import { loadDatabaseUrl } from "../config.js";
import { createPgDb } from "../db/db.js";
import { runMigrations } from "../db/migrate.js";
import { logger } from "../logger.js";

const db = createPgDb(loadDatabaseUrl());
try {
  const result = await runMigrations(db);
  logger.info({ applied: result.applied, previouslyApplied: result.alreadyApplied }, "migrations complete");
} catch (error) {
  logger.fatal({ err: error }, "migration failed");
  process.exitCode = 1;
} finally {
  await db.close();
}
