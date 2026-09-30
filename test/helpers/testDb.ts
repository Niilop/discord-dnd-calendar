import { PGlite, types, type Transaction } from "@electric-sql/pglite";
import type { Db, Queryable } from "../../src/db/db.js";
import { runMigrations } from "../../src/db/migrate.js";

/**
 * In-process PostgreSQL (PGlite) with all migrations applied. Queries without
 * parameters go through `exec` so multi-statement migration files work.
 */
export async function createTestDb(opts: { migrate?: boolean } = {}): Promise<Db> {
  const pg = new PGlite({ parsers: { [types.DATE]: (value: string) => value } });

  const wrap = (q: PGlite | Transaction): Queryable => ({
    async query<T>(sql: string, params: readonly unknown[] = []) {
      if (!params.length) {
        const results = await q.exec(sql);
        return (results.at(-1)?.rows ?? []) as T[];
      }
      const result = await q.query<T>(sql, params as unknown[]);
      return result.rows;
    },
  });

  const db: Db = {
    ...wrap(pg),
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    close: () => pg.close(),
  };
  if (opts.migrate !== false) await runMigrations(db);
  return db;
}
