import { REST, Routes } from "discord.js";
import { commands } from "../discord/commands/index.js";
import { logger } from "../logger.js";

/**
 * Bulk-overwrites the bot's slash commands. Idempotent, so it runs on every
 * deploy. With DISCORD_DEV_GUILD_ID set, commands go to that guild only and
 * update instantly (handy while developing).
 */
const token = process.env.DISCORD_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const devGuildId = process.env.DISCORD_DEV_GUILD_ID?.trim();
if (!token || !applicationId) {
  logger.fatal("DISCORD_TOKEN and DISCORD_APPLICATION_ID are required");
  process.exit(1);
}

const rest = new REST().setToken(token);
const body = commands.map((c) => c.toJSON());
const route = devGuildId ? Routes.applicationGuildCommands(applicationId, devGuildId) : Routes.applicationCommands(applicationId);
try {
  await rest.put(route, { body });
  logger.info({ count: body.length, scope: devGuildId ? `guild ${devGuildId}` : "global" }, "commands registered");
} catch (error) {
  logger.fatal({ err: error }, "command registration failed");
  process.exitCode = 1;
}
