import type { AppContext } from "../discord/context.js";
import { completeSessionsTask, createCalendarTask, sessionCardsTask, type SchedulerTask } from "./tasks.js";

/**
 * In-process ticker. The bot runs as a single instance, so a plain interval
 * is enough; ticks never overlap and each task is isolated from the others.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly tasks: SchedulerTask[] = [completeSessionsTask, sessionCardsTask, createCalendarTask()];

  constructor(
    private readonly ctx: AppContext,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.ctx.log.info({ intervalMs: this.intervalMs, tasks: this.tasks.map((t) => t.name) }, "scheduler started");
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = (async () => {
      const now = this.ctx.now();
      for (const task of this.tasks) {
        try {
          await task.run(this.ctx, now);
        } catch (error) {
          this.ctx.log.error({ err: error, task: task.name }, "scheduler task failed");
        }
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }
}
