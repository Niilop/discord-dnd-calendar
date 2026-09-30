import { DiscordAPIError, MessageFlags, RESTJSONErrorCodes, type Interaction } from "discord.js";
import { UserError } from "../domain/errors.js";
import type { AppContext } from "./context.js";
import { commands } from "./commands/index.js";
import { handleComponent } from "./components/index.js";

const byName = new Map(commands.map((c) => [c.name, c]));

/** Entry point for every interaction: dispatch, time, and turn errors into friendly replies. */
export function createInteractionHandler(ctx: AppContext) {
  return async (interaction: Interaction): Promise<void> => {
    const started = Date.now();
    const log = ctx.log.child({
      interactionId: interaction.id,
      type: interaction.type,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      target: interaction.isCommand() || interaction.isAutocomplete() ? interaction.commandName : "customId" in interaction ? interaction.customId : undefined,
    });

    try {
      if (!interaction.inCachedGuild()) {
        if (interaction.isRepliable()) {
          await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Please use this bot inside a server." });
        }
        return;
      }
      if (interaction.isChatInputCommand()) {
        const command = byName.get(interaction.commandName);
        if (!command) throw new UserError("This command no longer exists.");
        await command.execute(interaction, { ...ctx, log });
      } else if (interaction.isAutocomplete()) {
        await byName.get(interaction.commandName)?.autocomplete?.(interaction, { ...ctx, log });
      } else {
        await handleComponent(interaction, { ...ctx, log });
      }
      log.debug({ ms: Date.now() - started }, "interaction handled");
    } catch (error) {
      await reportError(interaction, error, log);
    }
  };
}

async function reportError(interaction: Interaction, error: unknown, log: AppContext["log"]): Promise<void> {
  if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownInteraction) {
    log.warn("interaction expired before we could respond");
    return;
  }
  const userFacing = error instanceof UserError;
  if (userFacing) log.info({ reason: error.message }, "interaction rejected");
  else log.error({ err: error }, "interaction failed");

  if (interaction.isAutocomplete()) {
    if (!interaction.responded) await interaction.respond([]).catch(() => undefined);
    return;
  }
  if (!interaction.isRepliable()) return;
  const content = userFacing ? `⚠️ ${error.message}` : `❌ Something went wrong. Please try again. (ref: ${interaction.id})`;
  try {
    // Only commands use deferReply. Components and modals use deferUpdate on a
    // components-v2 message, which can't take `content`, so they get a follow-up.
    if (interaction.deferred && !interaction.replied && interaction.isChatInputCommand()) {
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
    } else if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ flags: MessageFlags.Ephemeral, content, allowedMentions: { parse: [] } });
    } else {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content, allowedMentions: { parse: [] } });
    }
  } catch (replyError) {
    log.warn({ err: replyError }, "could not report error to user");
  }
}
