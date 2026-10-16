import path from 'node:path';
import { applyPlan, type ApplyResult } from '../core/apply/applier.js';
import { persistableAnswers, resolveAnswers, validateAnswer, type Answers, type RawAnswers } from '../core/definition/answers.js';
import { compose, renderComposition, type Composition } from '../core/definition/compose.js';
import type { LoadedDefinition } from '../core/definition/loader.js';
import { isMergeable } from '../core/merge/index.js';
import { inspectPath, snapshotDisk, type DiskEntry } from '../core/plan/inspect.js';
import { createPlan, hasChanges, withOwnedFile, type Plan, type PlanOp } from '../core/plan/planner.js';
import { classifyUpdate, type StateHash, type UpdateKind } from '../core/plan/update-classifier.js';
import type { RenderedFile } from '../core/render/renderer.js';
import { readState, serializeState, STATE_PATH, type ForgeState } from '../core/state/state.js';
import { unifiedDiff } from '../core/util/diff.js';
import { sha256Hex } from '../core/util/hash.js';
import { compareVersions } from '../core/util/semver.js';
import { ConfigError, ConflictError, DefinitionError, isForgeError, UsageError } from '../errors/index.js';
import type { FileSystem, ProcessRunner } from '../ports/index.js';
import { detectProject } from './detect.js';
import type { GenerateDeps } from './generate.js';

export type UpdateDeps = GenerateDeps;

export interface VersionChange {
  readonly id: string;
  readonly kind: 'template' | 'feature';
  /** The version recorded in the project. */
  readonly from: string;
  /** The version this Forge provides. */
  readonly to: string;
}

export interface PreparedUpdate {
  readonly root: string;
  readonly state: ForgeState;
  readonly composition: Composition;
  readonly name: string;
  readonly versions: readonly VersionChange[];
  /** Recorded answers that are still valid for the questions this Forge asks. */
  readonly storedAnswers: RawAnswers;
  /** Recorded answers that were discarded because the question is gone or the value is no longer valid. */
  readonly droppedAnswers: readonly string[];
}

export type OutcomeKind = UpdateKind | 'merge';

export interface UpdateOutcome {
  readonly path: string;
  readonly kind: OutcomeKind;
  readonly reason?: string;
  /** A unified diff of your file against what the template would write, when requested. */
  readonly diff?: string;
}

export interface UpdateRequest {
  /** Answers to use instead of (or in addition to) the recorded ones. */
  readonly answers: RawAnswers;
  readonly useDefaults: boolean;
  readonly dryRun: boolean;
  readonly diff: boolean;
  /** Apply what is safe and leave conflicted files exactly as they are. */
  readonly partial: boolean;
  /** Take the template's version for conflicts (yours is backed up). */
  readonly force: boolean;
  /** Delete files the template no longer produces, if you never edited them. */
  readonly prune: boolean;
  readonly signal?: AbortSignal;
}

export interface UpdateResult {
  readonly versions: readonly VersionChange[];
  readonly outcomes: readonly UpdateOutcome[];
  readonly counts: Readonly<Partial<Record<OutcomeKind, number>>>;
  readonly answers: Answers;
  readonly droppedAnswers: readonly string[];
  /** No file would change. (Recording new versions or answers in state does not count.) */
  readonly upToDate: boolean;
  /** Conflicts still unresolved after this run. */
  readonly conflictsRemaining: number;
  readonly applied: ApplyResult | null;
  readonly dryRun: boolean;
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Anything that means "the project differs from what this Forge would generate". */
const PENDING: ReadonlySet<OutcomeKind> = new Set(['create', 'update', 'merge', 'conflict', 'blocked', 'orphan']);

/** Load what the project was generated from and work out which recorded answers still make sense. */
export async function prepareUpdate(deps: UpdateDeps, rootInput: string): Promise<PreparedUpdate> {
  const root = path.resolve(rootInput);
  const state = await readState(deps.fs, root);
  if (state === null) {
    throw new UsageError(`${root} has no .forge/state.json, so Forge does not know what it was generated from.`, {
      code: 'FORGE_E_NOT_A_PROJECT',
      hint: 'forge update only works on projects created by "forge new" or "forge add". To bring an existing repo under Forge, run "forge add <feature>".',
    });
  }

  const versions: VersionChange[] = [];
  const load = async (kind: 'template' | 'feature', id: string, recorded: string): Promise<LoadedDefinition> => {
    let definition: LoadedDefinition;
    try {
      definition = await (kind === 'template' ? deps.templates : deps.features).load(id);
    } catch (error) {
      if (isForgeError(error) && error.code === 'FORGE_E_NOT_FOUND') {
        throw new DefinitionError(`This project uses the ${kind} "${id}" (version ${recorded}), but this version of Forge does not provide it.`, {
          code: 'FORGE_E_NOT_FOUND',
          hint: 'Install a version of Forge that includes it. Nothing was changed.',
          cause: error,
        });
      }
      throw error;
    }
    const installed = definition.manifest.version;
    if (compareVersions(installed, recorded) === -1) {
      throw new ConfigError(`"${id}" is at version ${recorded} in this project, but this Forge provides ${installed}. Updating would downgrade it.`, {
        code: 'FORGE_E_DOWNGRADE',
        hint: 'Upgrade Forge to a version that provides at least the recorded version. Nothing was changed.',
      });
    }
    versions.push({ id, kind, from: recorded, to: installed });
    return definition;
  };

  const base = state.template === null ? null : await load('template', state.template.id, state.template.version);
  const features: LoadedDefinition[] = [];
  for (const feature of state.features) features.push(await load('feature', feature.id, feature.version));
  const composition = compose(base, features);

  const questions = new Map(composition.questions.questions.map((q) => [q.id, q]));
  const storedAnswers: Record<string, string | boolean> = {};
  const droppedAnswers: string[] = [];
  for (const [key, value] of Object.entries(state.answers)) {
    if (value === null) continue; // a question that was skipped at the time
    const question = questions.get(key);
    if (question === undefined || typeof value === 'number') {
      droppedAnswers.push(key);
      continue;
    }
    try {
      validateAnswer(question, value);
      storedAnswers[key] = value;
    } catch {
      droppedAnswers.push(key);
    }
  }

  const name = state.name ?? (await detectProject(deps.fs, root)).name;
  return { root, state, composition, name, versions, storedAnswers, droppedAnswers: droppedAnswers.sort() };
}

interface Classified extends UpdateOutcome {
  readonly file?: RenderedFile;
  readonly hash?: string;
  readonly state: StateHash;
  readonly blocked?: boolean;
  readonly op?: PlanOp;
  readonly disk: DiskEntry;
}

function conflictMessage(items: readonly UpdateOutcome[], blocked: boolean): ConflictError {
  const shown = items.slice(0, 10).map((o) => `  ${o.path}: ${o.reason ?? 'conflict'}`);
  if (items.length > 10) shown.push(`  ...and ${items.length - 10} more`);
  const noun = `${items.length} path${items.length === 1 ? '' : 's'}`;
  return new ConflictError(`${blocked ? 'Cannot write' : 'Refusing to overwrite'} ${noun}:\n${shown.join('\n')}`, {
    code: blocked ? 'FORGE_E_BLOCKED_PATH' : 'FORGE_E_CONFLICT',
    hint: blocked
      ? 'Remove or rename the offending paths, then re-run. --force never overrides symbolic links or directories.'
      : 'See the differences with "forge update --dry-run --diff". Then merge by hand, or use --partial (apply the rest) or --force (take the template\'s version; yours is backed up).',
  });
}

function renderDiff(item: Classified): string | undefined {
  if (item.file === undefined || item.disk.kind !== 'file') return undefined;
  if (item.disk.content.includes(0) || item.file.content.includes(0)) return '(binary files differ)\n';
  const diff = unifiedDiff(decode(item.disk.content), decode(item.file.content), { oldLabel: `${item.path} (yours)`, newLabel: `${item.path} (template)` });
  return diff === null ? '(too different to show)\n' : diff;
}

/** Work out, and unless `dryRun` perform, the update. Always content-driven: versions only gate downgrades. */
export async function runUpdate(deps: UpdateDeps, prepared: PreparedUpdate, request: UpdateRequest): Promise<UpdateResult> {
  const { fs, logger } = deps;
  const { root, state, composition } = prepared;

  const answers = resolveAnswers(composition.questions, { ...prepared.storedAnswers, ...request.answers }, { useDefaults: request.useDefaults });
  const rendered = renderComposition(composition, { name: prepared.name, answers, pins: deps.pins });
  const rendersByPath = new Map(rendered.files.map((file) => [file.path, file]));
  const paths = [...new Set([...rendered.files.map((f) => f.path), ...Object.keys(state.files)])].sort();
  const disk = await snapshotDisk(fs, root, paths);

  // Files that merge into shared content (.gitignore, package.json, YAML) are not owned, so they are not tracked.
  const mergeFiles = rendered.files.filter((f) => isMergeable(f.mergeStrategy));
  const mergePlan = createPlan({ files: mergeFiles, skipped: [], disk, previous: {} });
  const mergeByPath = new Map(mergePlan.ops.map((op) => [op.path, op]));

  const classified: Classified[] = [];
  for (const filePath of paths) {
    const entry = disk.get(filePath) ?? { kind: 'missing' as const };
    const file = rendersByPath.get(filePath);
    const mergeOp = mergeByPath.get(filePath);
    if (mergeOp !== undefined && file !== undefined) {
      const kind: OutcomeKind = mergeOp.kind === 'merge' ? 'merge' : mergeOp.kind === 'create' ? 'create' : mergeOp.kind === 'conflict' ? 'conflict' : 'unchanged';
      classified.push({
        path: filePath,
        kind,
        ...(mergeOp.reason === undefined ? {} : { reason: mergeOp.reason }),
        file: mergeOp.file ?? file,
        ...(mergeOp.hash === undefined ? {} : { hash: mergeOp.hash }),
        state: 'drop',
        ...(mergeOp.unforceable === true ? { blocked: true } : {}),
        op: mergeOp,
        disk: entry,
      });
      continue;
    }
    const nextHash = file === undefined ? undefined : sha256Hex(file.content);
    const result = classifyUpdate({ base: state.files[filePath], disk: entry, next: nextHash, strategy: file?.mergeStrategy === 'none' ? 'none' : 'overwrite' });
    classified.push({
      path: filePath,
      kind: result.kind,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(file === undefined ? {} : { file }),
      ...(nextHash === undefined ? {} : { hash: nextHash }),
      state: result.state,
      ...(result.kind === 'blocked' ? { blocked: true } : {}),
      disk: entry,
    });
  }

  if (request.diff) {
    for (let i = 0; i < classified.length; i += 1) {
      const item = classified[i] as Classified;
      if (item.kind !== 'conflict' && item.kind !== 'update') continue;
      const diff = renderDiff(item);
      if (diff !== undefined) classified[i] = { ...item, diff };
    }
  }

  const conflicts = classified.filter((c) => c.kind === 'conflict' && c.blocked !== true);
  const blocked = classified.filter((c) => c.blocked === true);
  // With --force a conflict is resolved in the template's favour, so report it as the overwrite it will be.
  const forced = new Set(request.force ? conflicts : []);
  const outcomes: UpdateOutcome[] = classified.map((item) =>
    forced.has(item)
      ? { path: item.path, kind: 'update', reason: 'overwrites your changes (--force); yours is kept in the backup', ...(item.diff === undefined ? {} : { diff: item.diff }) }
      : { path: item.path, kind: item.kind, ...(item.reason === undefined ? {} : { reason: item.reason }), ...(item.diff === undefined ? {} : { diff: item.diff }) },
  );
  const counts: Partial<Record<OutcomeKind, number>> = {};
  for (const outcome of outcomes) counts[outcome.kind] = (counts[outcome.kind] ?? 0) + 1;
  const upToDate = !outcomes.some((o) => PENDING.has(o.kind));
  const base = { versions: prepared.versions, outcomes, counts, answers, droppedAnswers: prepared.droppedAnswers, upToDate };

  if (request.dryRun) return { ...base, conflictsRemaining: conflicts.length + blocked.length, applied: null, dryRun: true };

  // Conflict policy. Nothing is written until we know what we are allowed to do.
  if (blocked.length > 0 && !request.partial) throw conflictMessage(blocked, true);
  if (conflicts.length > 0 && !request.force && !request.partial) throw conflictMessage(conflicts, false);
  const overwriting = [...forced];
  const conflictsRemaining = request.force ? blocked.length : conflicts.length + blocked.length;

  const ops: PlanOp[] = [];
  const deletes: string[] = [];
  const files: Record<string, string> = {};
  for (const item of classified) {
    const hashFor = (choice: StateHash): string | undefined => (choice === 'next' ? item.hash : choice === 'base' ? state.files[item.path] : undefined);
    const forced = overwriting.includes(item);
    const recorded = hashFor(forced ? 'next' : item.state);
    if (recorded !== undefined) files[item.path] = recorded;

    if (item.kind === 'create' || item.kind === 'update') {
      if (item.file !== undefined && item.hash !== undefined) ops.push({ path: item.path, kind: item.kind, file: item.file, hash: item.hash });
    } else if (item.kind === 'merge' && item.op !== undefined) {
      ops.push(item.op);
    } else if (forced && item.file !== undefined && item.hash !== undefined) {
      ops.push({ path: item.path, kind: 'conflict', file: item.file, hash: item.hash });
    } else if (item.kind === 'orphan' && request.prune) {
      deletes.push(item.path);
      delete files[item.path];
    }
  }

  const baseDefinition = composition.definitions.find((d) => d.manifest.kind === 'template');
  const next: ForgeState = {
    schemaVersion: 1,
    forgeVersion: deps.forgeVersion,
    template: baseDefinition === undefined ? state.template : { id: baseDefinition.manifest.id, version: baseDefinition.manifest.version },
    name: prepared.name,
    features: composition.definitions
      .filter((d) => d.manifest.kind === 'feature')
      .map((d) => ({ id: d.manifest.id, version: d.manifest.version }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    answers: persistableAnswers(composition.questions, answers) as ForgeState['answers'],
    files,
  };
  const stateFile: RenderedFile = { path: STATE_PATH, content: serializeState(next), mode: 0o644, mergeStrategy: 'overwrite', sourcePath: STATE_PATH };
  const plan: Plan = withOwnedFile({ ops }, stateFile, await inspectPath(fs, root, STATE_PATH));

  if (!hasChanges(plan) && deletes.length === 0) return { ...base, conflictsRemaining, applied: null, dryRun: false };
  const applied = await applyPlan(plan, {
    fs,
    root,
    clock: deps.clock,
    logger,
    overwriteConflicts: request.force,
    deletes,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  return { ...base, conflictsRemaining, applied, dryRun: false };
}

/** True/false whether git reports uncommitted changes; null when this is not a git checkout or git is unavailable. */
export async function isWorkingTreeDirty(runner: ProcessRunner, fs: FileSystem, root: string): Promise<boolean | null> {
  if ((await fs.lstat(path.join(root, '.git'))) === null) return null;
  const result = await runner.run('git', ['status', '--porcelain'], { cwd: root });
  return result.code === 0 ? result.stdout.trim() !== '' : null;
}
