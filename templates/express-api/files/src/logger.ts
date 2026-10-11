export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** One JSON object per line, ready for any log shipper. */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
): Logger {
  const emit = (at: LogLevel, message: string, fields?: LogFields): void => {
    if (ORDER[at] < ORDER[level]) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: at, message, ...fields }));
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}
