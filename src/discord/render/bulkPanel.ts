import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { encodeCustomId, type BulkState } from "../customIds.js";
import { truncate } from "./format.js";

export const BULK_MODAL_FIELDS = { time: "time" } as const;

/** Pressing Create asks for the start time (prefilled with what the campaign used last). */
export function renderBulkCreateModal(
  state: BulkState,
  campaignName: string,
  count: number,
  /** e.g. "UTC+2" */
  offset: string,
  usualTime: string,
): ModalBuilder {
  const input = (id: string, label: string, value: string) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label.slice(0, 45))
        .setStyle(TextInputStyle.Short)
        .setValue(value)
        .setMaxLength(10)
        .setRequired(true),
    );
  return new ModalBuilder()
    .setCustomId(encodeCustomId({ kind: "bk.create", ...state }))
    .setTitle(truncate(`Create ${count === 1 ? "1 session" : `${count} sessions`} — ${campaignName}`, 45))
    .addComponents(
      input(BULK_MODAL_FIELDS.time, `Start time (${offset})`, usualTime),
    );
}
