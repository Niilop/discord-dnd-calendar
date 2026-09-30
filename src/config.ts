export interface Config {
  discordToken: string;
  discordApplicationId: string;
  /** When set, commands are registered to this guild only (instant updates while developing). */
  devGuildId: string | undefined;
  /** Discord user IDs with full access on every server the bot is in. */
  botAdminUserIds: string[];
  /** Servers the bot may be in; empty = any. It leaves and ignores the rest. */
  allowedGuildIds: string[];
  databaseUrl: string;
  logLevel: string;
  healthPort: number;
  schedulerIntervalSeconds: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function discordIds(env: NodeJS.ProcessEnv, name: string, what: "user" | "server"): string[] {
  const ids = (env[name] ?? "").split(/[\s,]+/).filter(Boolean);
  const bad = ids.find((id) => !/^\d{15,21}$/.test(id));
  if (bad) throw new Error(`${name} must be Discord ${what} IDs separated by commas; "${bad}" isn't one`);
  return ids;
}

export function loadDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return required(env, "DATABASE_URL");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    discordToken: required(env, "DISCORD_TOKEN"),
    discordApplicationId: required(env, "DISCORD_APPLICATION_ID"),
    devGuildId: env.DISCORD_DEV_GUILD_ID?.trim() || undefined,
    botAdminUserIds: discordIds(env, "BOT_ADMIN_USER_IDS", "user"),
    allowedGuildIds: discordIds(env, "ALLOWED_GUILD_IDS", "server"),
    databaseUrl: loadDatabaseUrl(env),
    logLevel: env.LOG_LEVEL?.trim() || "info",
    healthPort: integer(env, "HEALTH_PORT", 8080),
    schedulerIntervalSeconds: integer(env, "SCHEDULER_INTERVAL_SECONDS", 60),
  };
}
