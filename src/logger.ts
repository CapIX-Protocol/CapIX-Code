/**
 * Capix Code logger.
 *
 * The TUI renders its own status surface; raw JSON log lines must NOT spill
 * into the terminal or they overwrite the rendered frames (the "debug
 * message across my screen" customer report). By default only `error` is
 * emitted to stderr; `warn` and `info` are silent unless explicitly enabled
 * via `--log-level` / `CAPIX_LOG_LEVEL`.
 */

type LogLevel = "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { info: 10, warn: 20, error: 30 };

function activeLevel(): LogLevel {
  const raw = (process.env.CAPIX_LOG_LEVEL ?? "error").trim().toLowerCase();
  if (raw === "info" || raw === "warn" || raw === "error") return raw;
  if (raw === "debug" || raw === "trace") return "info";
  return "error";
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[activeLevel()]) return;
  const entry = { ts: new Date().toISOString(), level, message, ...data };
  if (level === "error") console.error(JSON.stringify(entry));
  else if (level === "warn") console.warn(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

export const logger = {
  info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
};
