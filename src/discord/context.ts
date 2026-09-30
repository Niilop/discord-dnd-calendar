import { PermissionFlagsBits, type BaseInteraction } from "discord.js";
import type { Db } from "../db/db.js";
import type { Actor } from "../domain/permissions.js";
import type { Logger } from "../logger.js";
import type { Publisher } from "./publisher.js";

export interface AppContext {
  db: Db;
  publisher: Publisher;
  log: Logger;
  now(): Date;
}

/**
 * Builds the actor from the interaction itself. Discord sends the member's
 * current permissions with every interaction, so server-admin status is never
 * stale. Campaign roles are re-read from the database by the services.
 */
export function actorFrom(interaction: BaseInteraction<"cached">): Actor {
  const perms = interaction.memberPermissions;
  return {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    isGuildAdmin: perms.has(PermissionFlagsBits.ManageGuild) || perms.has(PermissionFlagsBits.Administrator),
  };
}
