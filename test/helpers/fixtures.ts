import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeFileSystem } from '../../src/adapters/node-fs.js';
import type { MemoryFileSystem } from '../../src/adapters/memory-fs.js';
import { nullLogger } from '../../src/adapters/logger.js';
import { fixedClock } from '../../src/adapters/clock.js';
import { DirectoryDefinitionSource } from '../../src/core/definition/loader.js';
import type { NewProjectDeps } from '../../src/app/new-project.js';
import type { Pins } from '../../src/core/pipeline/pins.js';
import type { FileSystem } from '../../src/ports/index.js';
import { FsError } from '../../src/errors/index.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BUILTIN_TEMPLATES = new DirectoryDefinitionSource(createNodeFileSystem(), path.join(REPO_ROOT, 'templates'), 'template');

export const BUILTIN_FEATURES = new DirectoryDefinitionSource(createNodeFileSystem(), path.join(REPO_ROOT, 'features'), 'feature');
export const PINS = JSON.parse(readFileSync(path.join(REPO_ROOT, 'pins', 'pins.json'), 'utf8')) as Pins;

export function depsFor(fs: FileSystem, clock = '2026-10-10T12:00:00Z'): NewProjectDeps {
  return { fs, templates: BUILTIN_TEMPLATES, features: BUILTIN_FEATURES, pins: PINS, clock: fixedClock(clock), logger: nullLogger, forgeVersion: '0.0.0-test' };
}

/** Write a template definition into a memory filesystem under /tpl/<id>. */
export function seedTemplate(
  mem: MemoryFileSystem,
  id: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
  partials: Record<string, string> = {},
): void {
  const seed: Record<string, string> = {
    [`/tpl/${id}/forge.template.json`]: JSON.stringify({ id, version: '1.0.0', kind: 'template', description: 'test', ...manifest }),
  };
  for (const [name, content] of Object.entries(files)) seed[`/tpl/${id}/files/${name}`] = content;
  for (const [name, content] of Object.entries(partials)) seed[`/tpl/${id}/partials/${name}`] = content;
  mem.seed(seed);
}

export interface FaultyFs extends FileSystem {
  /** Number of mutating calls seen so far. */
  readonly mutations: number;
}

/**
 * Wraps a filesystem and throws on exactly one mutating call (1-based). Pass 0 to never fail.
 * `onMutation` runs before each mutating call, which tests use to trigger an abort mid-apply.
 */
export function faultyFs(inner: FileSystem, failAt: number, onMutation?: (count: number) => void): FaultyFs {
  let count = 0;
  const guard = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      count += 1;
      onMutation?.(count);
      if (count === failAt) throw new FsError('injected failure', { code: 'FORGE_E_INJECTED' });
      return fn(...args);
    };
  return {
    lstat: (p) => inner.lstat(p),
    readFile: (p) => inner.readFile(p),
    readdir: (p) => inner.readdir(p),
    realpath: (p) => inner.realpath(p),
    writeFile: guard((p: string, d: Uint8Array, o?: Parameters<FileSystem['writeFile']>[2]) => inner.writeFile(p, d, o)),
    mkdir: guard((p: string) => inner.mkdir(p)),
    rename: guard((a: string, b: string) => inner.rename(a, b)),
    remove: guard((p: string, o?: { recursive?: boolean }) => inner.remove(p, o)),
    get mutations() {
      return count;
    },
  };
}

import type { ProcessResult, ProcessRunner, Prompter } from '../../src/ports/index.js';
import { InterruptedError } from '../../src/errors/index.js';

/** A prompter that replays queued answers in order and records everything it was asked. */
export class ScriptedPrompter implements Prompter {
  readonly asked: string[] = [];
  readonly warnings: string[] = [];
  private readonly queue: (string | boolean | 'CANCEL')[];

  constructor(answers: (string | boolean | 'CANCEL')[]) {
    this.queue = [...answers];
  }

  private next(message: string): string | boolean {
    this.asked.push(message);
    const value = this.queue.shift();
    if (value === undefined) throw new Error(`ScriptedPrompter ran out of answers at: ${message}`);
    if (value === 'CANCEL') throw new InterruptedError('Cancelled. Nothing was written.');
    return value;
  }

  async text(message: string): Promise<string> {
    return this.next(message) as string;
  }
  async confirm(message: string): Promise<boolean> {
    return this.next(message) as boolean;
  }
  async select<T extends string>(message: string): Promise<T> {
    return this.next(message) as T;
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
  get remaining(): number {
    return this.queue.length;
  }
}

export interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** A process runner that never starts anything. `respond` decides each result. */
export function fakeRunner(respond: (call: RecordedCall) => Partial<ProcessResult> = () => ({})): ProcessRunner & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async run(command, args, options) {
      const call = { command, args, cwd: options.cwd };
      calls.push(call);
      return { code: 0, stdout: '', stderr: '', ...respond(call) };
    },
  };
}
