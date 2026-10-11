import { redact } from '../core/util/redact.js';
import type { LogFields, Logger, LogLevel } from '../ports/index.js';

const ORDER: Readonly<Record<LogLevel, number>> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface LoggerOptions {
  readonly level: LogLevel | 'silent';
  readonly json: boolean;
  /** Receives one complete line (without trailing newline). The composition root points this at stderr. */
  readonly write: (line: string) => void;
  readonly now?: () => Date;
}

function formatFields(fields: LogFields | undefined): string {
  if (fields === undefined) return '';
  const safe = redact(fields) as Record<string, unknown>;
  const parts = Object.entries(safe).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

export function createLogger(options: LoggerOptions): Logger {
  const now = options.now ?? (() => new Date());
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (options.level === 'silent' || ORDER[level] > ORDER[options.level]) return;
    if (options.json) {
      const safe = fields === undefined ? {} : (redact(fields) as Record<string, unknown>);
      options.write(JSON.stringify({ time: now().toISOString(), level, message, ...safe }));
      return;
    }
    const prefix = level === 'info' ? '' : level === 'debug' ? '[debug] ' : `${level === 'warn' ? 'warning' : 'error'}: `;
    options.write(`${prefix}${message}${formatFields(fields)}`);
  };
  return {
    error: (message, fields) => emit('error', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    info: (message, fields) => emit('info', message, fields),
    debug: (message, fields) => emit('debug', message, fields),
  };
}

export const nullLogger: Logger = { error() {}, warn() {}, info() {}, debug() {} };
