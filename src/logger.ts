import { pino } from "pino";

/** JSON logs to stdout; Docker's log driver handles collection and rotation. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "dnd-calendar-bot" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
