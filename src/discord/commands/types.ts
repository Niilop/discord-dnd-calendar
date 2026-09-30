import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { AppContext } from "../context.js";

export interface SlashCommand {
  name: string;
  toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute(interaction: ChatInputCommandInteraction<"cached">, ctx: AppContext): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction<"cached">, ctx: AppContext): Promise<void>;
}
