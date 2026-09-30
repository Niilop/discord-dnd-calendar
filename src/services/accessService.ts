import type { Db } from "../db/db.js";
import { deleteManager, insertManager, listAllManagers, listManagers } from "../db/repositories/managers.js";
import { PermissionDeniedError, UserError } from "../domain/errors.js";
import type { Actor } from "../domain/permissions.js";

/**
 * Who has full rights on a server besides Discord's own server admins:
 *
 * - **bot admins** (`BOT_ADMIN_USER_IDS`), on every server, whoever hosts the bot;
 * - **calendar managers**, per server, stored in the database and managed
 *   with `/calendar manager-add` / `manager-remove`.
 *
 * Kept in memory so building an actor stays synchronous; the bot runs as a
 * single process, and every change goes through this class.
 */
export class AccessList {
  private readonly managers = new Map<string, Set<string>>();

  constructor(private readonly botAdmins: ReadonlySet<string> = new Set()) {}

  async load(db: Db): Promise<void> {
    this.managers.clear();
    for (const row of await listAllManagers(db)) this.remember(row.guildId, row.userId);
  }

  isBotAdmin(userId: string): boolean {
    return this.botAdmins.has(userId);
  }

  /** Bot admin or this server's calendar manager. */
  hasFullAccess(guildId: string, userId: string): boolean {
    return this.isBotAdmin(userId) || (this.managers.get(guildId)?.has(userId) ?? false);
  }

  private remember(guildId: string, userId: string): void {
    const set = this.managers.get(guildId) ?? new Set<string>();
    set.add(userId);
    this.managers.set(guildId, set);
  }

  private forget(guildId: string, userId: string): void {
    this.managers.get(guildId)?.delete(userId);
  }

  /** Server admins, bot admins and managers can make someone a manager. */
  async addManager(db: Db, actor: Actor, userId: string): Promise<void> {
    if (!actor.isGuildAdmin) throw new PermissionDeniedError("Only server admins and calendar managers can add calendar managers.");
    if (!(await insertManager(db, actor.guildId, userId, actor.userId))) throw new UserError(`<@${userId}> is already a calendar manager.`);
    this.remember(actor.guildId, userId);
  }

  async removeManager(db: Db, actor: Actor, userId: string): Promise<void> {
    if (!actor.isGuildAdmin) throw new PermissionDeniedError("Only server admins and calendar managers can remove calendar managers.");
    if (!(await deleteManager(db, actor.guildId, userId))) throw new UserError(`<@${userId}> is not a calendar manager.`);
    this.forget(actor.guildId, userId);
  }

  async listManagers(db: Db, guildId: string): Promise<{ managers: string[]; botAdmins: string[] }> {
    return { managers: await listManagers(db, guildId), botAdmins: [...this.botAdmins] };
  }
}
