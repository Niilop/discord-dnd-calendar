import pg from "pg";

/** Minimal query surface shared by the pool, a transaction, and test databases. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /** Runs `fn` inside a transaction; commits on success, rolls back on throw. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// DATE columns are calendar dates in the campaign timezone. Keep them as
// 'YYYY-MM-DD' strings instead of letting pg turn them into local-midnight Dates.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export function createPgDb(connectionString: string): Db & { pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000 });

  return {
    pool,
    async query<T>(sql: string, params: readonly unknown[] = []) {
      const result = await pool.query(sql, params as unknown[]);
      return result.rows as T[];
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx: Queryable = {
          async query<R>(sql: string, params: readonly unknown[] = []) {
            const result = await client.query(sql, params as unknown[]);
            return result.rows as R[];
          },
        };
        const value = await fn(tx);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
