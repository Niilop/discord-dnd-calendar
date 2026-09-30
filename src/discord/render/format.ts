import type { Guild } from "discord.js";

export const COLORS = {
  primary: 0x5865f2,
  success: 0x57f287,
  danger: 0xed4245,
  muted: 0x99aab5,
  warning: 0xfee75c,
} as const;

export const mention = (userId: string): string => `<@${userId}>`;

/** Mentions joined for an embed field, truncated to fit Discord's 1024-char field limit. */
export function mentionList(userIds: readonly string[], empty = "—", limit = 1000): string {
  if (!userIds.length) return empty;
  let out = "";
  for (let i = 0; i < userIds.length; i++) {
    const next = (out ? ", " : "") + mention(userIds[i]!);
    if (out.length + next.length > limit - 20) return `${out} …and ${userIds.length - i} more`;
    out += next;
  }
  return out;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function messageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/**
 * Display names for plain-text places where mentions don't render (select
 * option labels). Fetches members individually via REST, which does not
 * require the privileged Guild Members intent.
 */
export async function resolveDisplayNames(guild: Guild, userIds: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];
  const entries = await Promise.all(
    unique.map(async (id): Promise<[string, string]> => {
      const member = guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
      return [id, member?.displayName ?? "unknown user"];
    }),
  );
  return new Map(entries);
}
