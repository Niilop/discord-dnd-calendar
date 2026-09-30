import { availabilityCommand } from "./availability.js";
import { calendarCommand } from "./calendar.js";
import { campaignCommand } from "./campaign.js";
import { sessionCommand } from "./session.js";
import type { SlashCommand } from "./types.js";

export const commands: readonly SlashCommand[] = [campaignCommand, sessionCommand, availabilityCommand, calendarCommand];
