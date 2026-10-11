/** Ports: the only way the core talks to the outside world. */

export type EntryKind = 'file' | 'dir' | 'symlink';

export interface FileStat {
  readonly kind: EntryKind;
  readonly mode: number;
  readonly size: number;
}

export interface WriteOptions {
  /** Permission bits applied when the file is created. */
  readonly mode?: number;
  /** Fail instead of replacing or following anything that already exists at the path. */
  readonly exclusive?: boolean;
}

export interface FileSystem {
  /** Stat without following symlinks. Resolves to null when the path does not exist. */
  lstat(path: string): Promise<FileStat | null>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array, options?: WriteOptions): Promise<void>;
  /** Create a directory and any missing parents. */
  mkdir(path: string): Promise<void>;
  /** Entry names (not paths), sorted. */
  readdir(path: string): Promise<string[]>;
  /** Atomically move `from` onto `to`, replacing a file at `to`. */
  rename(from: string, to: string): Promise<void>;
  /** Remove a file, or a directory when `recursive` is set. Missing paths are ignored. */
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  realpath(path: string): Promise<string>;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
}

export interface Clock {
  now(): Date;
}

export interface Prompter {
  /** Free text. `secret` hides the input as it is typed. */
  text(message: string, options?: { default?: string; secret?: boolean }): Promise<string>;
  confirm(message: string, options?: { default?: boolean }): Promise<boolean>;
  select<T extends string>(message: string, choices: readonly T[], options?: { default?: T }): Promise<T>;
  /** Show a non-fatal message, such as why an answer was rejected. */
  warn(message: string): void;
}

export interface ProcessResult {
  /** Exit code, or null if the process could not be started or was killed. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs an external program. Never through a shell, and with a minimal environment. */
export interface ProcessRunner {
  run(command: string, args: readonly string[], options: { cwd: string; signal?: AbortSignal }): Promise<ProcessResult>;
}
