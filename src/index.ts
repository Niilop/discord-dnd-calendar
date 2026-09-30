import { Client, Events, GatewayIntentBits } from "discord.js";
import { readdir } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createPgDb, type Db } from "./db/db.js";
import { MIGRATIONS_DIR } from "./db/migrate.js";
import type { AppContext } from "./discord/context.js";
import { Publisher } from "./discord/publisher.js";
import { createInteractionHandler } from "./discord/router.js";
import { startHealthServer } from "./health.js";
import { logger } from "./logger.js";
import { Scheduler } from "./scheduler/scheduler.js";

const SHUTDOWN_TIMEOUT_MS = 20_000;

/** Refuse to run against a schema that is behind the code; deploys run migrations first. */
async function assertMigrated(db: Db): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
  const applied = await db
    .query<{ version: string }>("SELECT version FROM schema_migrations")
    .then((rows) => new Set(rows.map((r) => r.version)))
    .catch(() => new Set<string>());
  const pending = files.filter((f) => !applied.has(f));
  if (pending.length) throw new Error(`Database has pending migrations: ${pending.join(", ")}. Run "npm run migrate" first.`);
}

async function waitForDatabase(db: Db, attempts = 30): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await db.query("SELECT 1");
      return;
    } catch (error) {
      if (i >= attempts) throw error;
      logger.warn({ attempt: i }, "database not reachable yet; retrying");
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  logger.level = config.logLevel;
  logger.info({ node: process.version }, "starting");

  const db = createPgDb(config.databaseUrl);
  await waitForDatabase(db);
  await assertMigrated(db);
  logger.info("database ready");

  const client = new Client({
    // Slash commands and components need no privileged intents.
    intents: [GatewayIntentBits.Guilds],
    rest: { retries: 3, timeout: 15_000 },
  });
  const publisher = new Publisher(client, db, logger);
  const ctx: AppContext = { db, publisher, log: logger, now: () => new Date() };
  const scheduler = new Scheduler(ctx, config.schedulerIntervalSeconds * 1000);

  const handleInteraction = createInteractionHandler(ctx);
  client.on(Events.InteractionCreate, (interaction) => void handleInteraction(interaction));
  client.once(Events.ClientReady, (c) => {
    logger.info({ user: c.user.tag, guilds: c.guilds.cache.size }, "discord ready");
    scheduler.start();
  });
  client.on(Events.ShardDisconnect, (_event, shardId) => logger.warn({ shardId }, "gateway disconnected"));
  client.on(Events.ShardResume, (shardId) => logger.info({ shardId }, "gateway resumed"));
  client.on(Events.Error, (error) => logger.error({ err: error }, "discord client error"));
  client.on(Events.Warn, (message) => logger.warn(message));

  const health = startHealthServer(config.healthPort, client, db);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      logger.error("graceful shutdown timed out; exiting");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    await scheduler.stop();
    await publisher.flush();
    await client.destroy();
    health.close();
    await db.close();
    logger.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled promise rejection"));

  await client.login(config.discordToken);
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "failed to start");
  process.exit(1);
});
