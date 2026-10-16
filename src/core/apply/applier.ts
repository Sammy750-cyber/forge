import path from 'node:path';
import { ConflictError, FsError, InterruptedError, isForgeError } from '../../errors/index.js';
import type { Clock, FileSystem, Logger } from '../../ports/index.js';
import { inspectPath } from '../plan/inspect.js';
import type { Plan, PlanOp } from '../plan/planner.js';
import { resolveInside } from '../util/safe-path.js';

export interface ApplyOptions {
  readonly fs: FileSystem;
  readonly root: string;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Overwrite conflicting files (after backing them up). Blocked paths are never overwritten. */
  readonly overwriteConflicts: boolean;
  readonly signal?: AbortSignal;
  /** How many backup folders to keep under .forge/backup. Default 5. */
  readonly backupRetention?: number;
  /**
   * Project-relative regular files to delete. Each is backed up first and restored on rollback.
   * Paths that are already gone are skipped; symlinks and directories are refused.
   */
  readonly deletes?: readonly string[];
}

export interface ApplyResult {
  readonly written: readonly string[];
  /** Files removed (each is in the backup folder). */
  readonly deleted: readonly string[];
  readonly backedUp: readonly string[];
  /** Absolute path of the backup folder, or null if nothing needed backing up. */
  readonly backupDir: string | null;
}

interface JournalEntry {
  readonly target: string;
  readonly original: Uint8Array | null;
  readonly originalMode: number;
}

const BACKUP_ROOT = ['.forge', 'backup'] as const;
const DEFAULT_RETENTION = 5;

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function isWritable(op: PlanOp, overwriteConflicts: boolean): op is PlanOp & { file: NonNullable<PlanOp['file']> } {
  if (op.file === undefined) return false;
  return op.kind === 'create' || op.kind === 'update' || op.kind === 'merge' || (op.kind === 'conflict' && overwriteConflicts && op.unforceable !== true);
}

/**
 * Apply a plan transactionally: every file is written atomically (temp file then rename),
 * existing files are backed up first, and any failure or interrupt restores the tree exactly.
 */
export async function applyPlan(plan: Plan, options: ApplyOptions): Promise<ApplyResult> {
  const { fs, logger, signal } = options;

  const unresolved = plan.ops.filter((op) => op.kind === 'conflict' && !isWritable(op, options.overwriteConflicts));
  if (unresolved.length > 0) {
    throw new ConflictError(`Cannot apply a plan with ${unresolved.length} unresolved conflict(s).`, { code: 'FORGE_E_CONFLICT' });
  }
  const writes = plan.ops.filter((op): op is PlanOp & { file: NonNullable<PlanOp['file']> } => isWritable(op, options.overwriteConflicts));
  const requestedDeletes = options.deletes ?? [];
  if (writes.length === 0 && requestedDeletes.length === 0) return { written: [], deleted: [], backedUp: [], backupDir: null };

  const abortIfRequested = (): void => {
    if (signal?.aborted) throw new InterruptedError();
  };
  abortIfRequested();

  const createdDirs: string[] = [];
  const tempFiles = new Set<string>();
  const journal: JournalEntry[] = [];
  let backupDir: string | null = null;
  const backedUp: string[] = [];

  try {
    // Create the root one component at a time so every directory we add (including missing
    // ancestors) is tracked and can be removed again on rollback.
    let walked = path.parse(path.resolve(options.root)).root;
    for (const part of path.resolve(options.root).slice(walked.length).split(path.sep).filter(Boolean)) {
      walked = path.join(walked, part);
      if ((await fs.lstat(walked)) === null) {
        await fs.mkdir(walked);
        createdDirs.push(walked);
      }
    }
    const root = await fs.realpath(options.root);

    // Preflight: re-verify every target right before touching anything (the disk may have changed since planning).
    for (const op of writes) {
      const entry = await inspectPath(fs, root, op.path);
      if (entry.kind === 'blocked' || entry.kind === 'dir') {
        throw new FsError(`Cannot write ${op.path}: ${entry.kind === 'dir' ? 'a directory is in the way' : entry.reason}.`, {
          code: 'FORGE_E_BLOCKED_PATH',
          hint: 'Remove or rename the offending path and re-run.',
        });
      }
    }

    // Deletes get the same scrutiny as writes: only regular files, never through a link.
    const toDelete: string[] = [];
    for (const relative of requestedDeletes) {
      const entry = await inspectPath(fs, root, relative);
      if (entry.kind === 'missing') continue;
      if (entry.kind !== 'file') {
        throw new FsError(`Cannot delete ${relative}: ${entry.kind === 'dir' ? 'it is a directory' : entry.reason}.`, {
          code: 'FORGE_E_BLOCKED_PATH',
          hint: 'Forge only deletes regular files. Remove it yourself if you really want it gone.',
        });
      }
      toDelete.push(relative);
    }

    const ensureDir = async (directory: string): Promise<void> => {
      const relative = path.relative(root, directory);
      if (relative === '') return;
      let current = root;
      for (const part of relative.split(path.sep)) {
        current = path.join(current, part);
        const stat = await fs.lstat(current);
        if (stat === null) {
          await fs.mkdir(current);
          createdDirs.push(current);
        } else if (stat.kind !== 'dir') {
          throw new FsError(`Cannot create directory ${current}: something else is there.`, { code: 'FORGE_E_BLOCKED_PATH' });
        }
      }
    };

    // Backups first, so that rollback and recovery always have the original bytes.
    const needBackup = [
      ...writes.filter((op) => op.kind === 'update' || op.kind === 'merge' || op.kind === 'conflict').map((op) => op.path),
      ...toDelete,
    ];
    if (needBackup.length > 0) {
      const backupBase = path.join(root, ...BACKUP_ROOT);
      const baseName = stamp(options.clock.now());
      let candidate = path.join(backupBase, baseName);
      for (let suffix = 2; (await fs.lstat(candidate)) !== null; suffix += 1) candidate = path.join(backupBase, `${baseName}-${suffix}`);
      await ensureDir(backupBase);
      backupDir = candidate;
      for (const relative of needBackup) {
        abortIfRequested();
        const source = resolveInside(root, relative);
        const copy = resolveInside(backupDir, relative);
        await fs.mkdir(path.dirname(copy));
        await fs.writeFile(copy, await fs.readFile(source));
        backedUp.push(relative);
      }
    }

    let counter = 0;
    for (const op of writes) {
      abortIfRequested();
      const target = resolveInside(root, op.path);
      await ensureDir(path.dirname(target));

      const existing = await fs.lstat(target);
      const original = existing?.kind === 'file' ? await fs.readFile(target) : null;
      const temp = path.join(path.dirname(target), `.${path.basename(target)}.forge-tmp-${counter}`);
      counter += 1;
      tempFiles.add(temp);
      await fs.writeFile(temp, op.file.content, { mode: op.file.mode, exclusive: true });
      await fs.rename(temp, target);
      tempFiles.delete(temp);
      journal.push({ target, original, originalMode: existing?.mode ?? 0o644 });
      logger.debug('wrote file', { path: op.path });
    }

    for (const relative of toDelete) {
      abortIfRequested();
      const target = resolveInside(root, relative);
      const stat = await fs.lstat(target);
      const original = await fs.readFile(target);
      await fs.remove(target);
      journal.push({ target, original, originalMode: stat?.mode ?? 0o644 });
      logger.debug('deleted file', { path: relative });
    }

    await prune(fs, root, backupDir, options.backupRetention ?? DEFAULT_RETENTION);
    return { written: writes.map((op) => op.path), deleted: toDelete, backedUp, backupDir };
  } catch (error) {
    const problems: unknown[] = [];
    const attempt = async (step: () => Promise<void>): Promise<void> => {
      try {
        await step();
      } catch (rollbackError) {
        problems.push(rollbackError);
      }
    };

    for (const entry of [...journal].reverse()) {
      await attempt(async () => {
        if (entry.original === null) {
          await fs.remove(entry.target);
          return;
        }
        const restore = `${entry.target}.forge-restore`;
        await fs.writeFile(restore, entry.original, { mode: entry.originalMode, exclusive: true });
        await fs.rename(restore, entry.target);
      });
    }
    for (const temp of tempFiles) await attempt(() => fs.remove(temp));
    // Once the tree is restored the backup copies are redundant. Remove them before the
    // directories that contain them, so nothing we created is left behind.
    if (problems.length === 0 && backupDir !== null) {
      const folder = backupDir;
      await attempt(() => fs.remove(folder, { recursive: true }));
    }
    for (const directory of [...createdDirs].reverse()) {
      await attempt(async () => {
        try {
          await fs.remove(directory);
        } catch {
          // Not empty: something else lives there now. Leave it alone.
        }
      });
    }

    if (problems.length > 0) {
      logger.error('rollback incomplete', { problems: problems.length });
      throw new FsError('The operation failed and Forge could not fully restore the previous state.', {
        code: 'FORGE_E_ROLLBACK_INCOMPLETE',
        cause: error,
        hint: backupDir === null ? 'Check your working tree with git status.' : `Original files are saved in ${backupDir}.`,
      });
    }
    if (isForgeError(error)) throw error;
    throw new FsError(`Write failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function prune(fs: FileSystem, root: string, keep: string | null, retention: number): Promise<void> {
  const base = path.join(root, ...BACKUP_ROOT);
  if ((await fs.lstat(base))?.kind !== 'dir') return;
  const folders = await fs.readdir(base);
  const removable = folders.filter((name) => path.join(base, name) !== keep);
  const excess = removable.length + (keep === null ? 0 : 1) - retention;
  for (const name of removable.slice(0, Math.max(0, excess))) {
    await fs.remove(path.join(base, name), { recursive: true });
  }
}
