import type { RestLogLevel } from "../config";

/** Minimal structured logger accepted by the reusable server APIs. */
export interface RestLogger {
  debug(event: Readonly<Record<string, unknown>>): void;
  info(event: Readonly<Record<string, unknown>>): void;
  warn(event: Readonly<Record<string, unknown>>): void;
  error(event: Readonly<Record<string, unknown>>): void;
}

type LogSink = (line: string, level: RestLogLevel) => void;

const LEVEL_PRIORITY: Readonly<Record<RestLogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

function defaultSink(line: string, level: RestLogLevel): void {
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

/** Creates a level-filtered JSON-lines logger for the stock CLI. */
export function createJsonLogger(
  minimumLevel: RestLogLevel,
  sink: LogSink = defaultSink,
): RestLogger {
  const write = (
    level: RestLogLevel,
    event: Readonly<Record<string, unknown>>,
  ): void => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minimumLevel]) return;
    sink(JSON.stringify({ level, ...event }), level);
  };

  const logger: RestLogger = {
    debug: (event) => write("debug", event),
    info: (event) => write("info", event),
    warn: (event) => write("warn", event),
    error: (event) => write("error", event),
  };
  return Object.freeze(logger);
}

/** Silent default for side-effect-free application construction. */
export const NOOP_LOGGER: RestLogger = Object.freeze({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});
