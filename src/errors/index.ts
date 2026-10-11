/**
 * Typed error hierarchy. Every error carries a stable string `code`, an exit code,
 * a human message, and an optional `hint` telling the user what to do next.
 */

export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  CONFIG: 3,
  CONFLICT: 4,
  DEFINITION: 5,
  DOCTOR: 6,
  FS: 7,
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface ForgeErrorOptions {
  readonly hint?: string;
  readonly cause?: unknown;
}

export abstract class ForgeError extends Error {
  abstract readonly exitCode: ExitCode;
  readonly code: string;
  readonly hint: string | undefined;

  protected constructor(code: string, message: string, options: ForgeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.hint = options.hint;
  }
}

export class UsageError extends ForgeError {
  readonly exitCode = EXIT.USAGE;
  constructor(message: string, options: ForgeErrorOptions & { code?: string } = {}) {
    super(options.code ?? 'FORGE_E_USAGE', message, options);
  }
}

export class ConfigError extends ForgeError {
  readonly exitCode = EXIT.CONFIG;
  constructor(message: string, options: ForgeErrorOptions & { code?: string } = {}) {
    super(options.code ?? 'FORGE_E_CONFIG', message, options);
  }
}

/** Raised when `.forge/state.json` is unreadable, invalid, or from a newer Forge. */
export class StateError extends ForgeError {
  readonly exitCode = EXIT.CONFIG;
  constructor(message: string, options: ForgeErrorOptions & { code?: string } = {}) {
    super(options.code ?? 'FORGE_E_STATE', message, options);
  }
}

export class ConflictError extends ForgeError {
  readonly exitCode = EXIT.CONFLICT;
  constructor(message: string, options: ForgeErrorOptions & { code?: string } = {}) {
    super(options.code ?? 'FORGE_E_CONFLICT', message, options);
  }
}

/** Template or feature definition is invalid, or rendering it failed. */
export class DefinitionError extends ForgeError {
  readonly exitCode = EXIT.DEFINITION;
  constructor(message: string, options: ForgeErrorOptions & { code?: string } = {}) {
    super(options.code ?? 'FORGE_E_DEFINITION', message, options);
  }
}

export class FsError extends ForgeError {
  readonly exitCode = EXIT.FS;
  /** Underlying errno-style code such as ENOENT, when known. */
  readonly errno: string | undefined;
  constructor(message: string, options: ForgeErrorOptions & { code?: string; errno?: string } = {}) {
    super(options.code ?? 'FORGE_E_FS', message, options);
    this.errno = options.errno;
  }
}

export class InterruptedError extends ForgeError {
  readonly exitCode = EXIT.INTERRUPTED;
  constructor(message = 'Interrupted. No partial changes were left behind.', options: ForgeErrorOptions = {}) {
    super('FORGE_E_INTERRUPTED', message, options);
  }
}

export class InternalError extends ForgeError {
  readonly exitCode = EXIT.INTERNAL;
  constructor(message: string, options: ForgeErrorOptions = {}) {
    super('FORGE_E_INTERNAL', message, {
      hint: 'This is a bug in Forge. Re-run with --verbose and include the output in a bug report.',
      ...options,
    });
  }
}

export function isForgeError(value: unknown): value is ForgeError {
  return value instanceof ForgeError;
}

/** Wrap anything thrown into a ForgeError. Unknown values become InternalError. */
export function toForgeError(value: unknown): ForgeError {
  if (isForgeError(value)) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new InternalError(`Unexpected error: ${message}`, { cause: value });
}
