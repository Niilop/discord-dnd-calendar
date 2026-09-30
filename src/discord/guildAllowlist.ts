import type { Client, Guild } from "discord.js";
import type { Logger } from "../logger.js";

/**
 * Optional lock to known servers (ALLOWED_GUILD_IDS). With a list, the bot
 * leaves any other server as soon as it's added (and at startup), and the
 * router refuses its interactions before any database work. An empty list
 * allows every server.
 */
export class GuildAllowlist {
  private readonly allowed: ReadonlySet<string>;

  constructor(ids: readonly string[]) {
    this.allowed = new Set(ids);
  }

  isAllowed(guildId: string): boolean {
    return this.allowed.size === 0 || this.allowed.has(guildId);
  }

  /** Leaves `guild` if it isn't allowed. */
  async enforce(guild: Guild, log: Logger): Promise<void> {
    if (this.isAllowed(guild.id)) return;
    log.warn({ guildId: guild.id, guildName: guild.name }, "leaving a server that isn't in ALLOWED_GUILD_IDS");
    await guild.leave().catch((error: unknown) => log.error({ err: error, guildId: guild.id }, "could not leave server"));
  }

  async enforceAll(client: Client, log: Logger): Promise<void> {
    for (const guild of client.guilds.cache.values()) await this.enforce(guild, log);
  }
}
