import path from 'node:path';
import { ConflictError, UsageError } from '../errors/index.js';
import { applyPlan, type ApplyResult } from '../core/apply/applier.js';
import { persistableAnswers, resolveAnswers, type Answers, type RawAnswers } from '../core/definition/answers.js';
import { compose, renderComposition, type Composition } from '../core/definition/compose.js';
import type { DefinitionSource } from '../core/definition/loader.js';
import { inspectPath, snapshotDisk } from '../core/plan/inspect.js';
import { assertResolvable, createPlan, hasChanges, resolveForcedConflicts, withOwnedFile, type Plan } from '../core/plan/planner.js';
import type { Pins } from '../core/pipeline/pins.js';
import type { RenderedFile } from '../core/render/renderer.js';
import { readState, serializeState, STATE_PATH, type ForgeState } from '../core/state/state.js';
import type { Clock, FileSystem, Logger } from '../ports/index.js';

export interface GenerateDeps {
  readonly fs: FileSystem;
  readonly templates: DefinitionSource;
  readonly features: DefinitionSource;
  /** Pinned action/tool versions; only needed by features that generate a CI pipeline. */
  readonly pins?: Pins | undefined;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly forgeVersion: string;
}

export interface GenerateRequest {
  /** `new` writes a fresh project; `add` extends an existing directory. */
  readonly mode: 'new' | 'add';
  readonly name: string;
  readonly root: string;
  readonly templateId: string | null;
  readonly featureIds: readonly string[];
  readonly answers: RawAnswers;
  readonly useDefaults: boolean;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly signal?: AbortSignal;
}

export interface GenerateResult {
  readonly plan: Plan;
  readonly answers: Answers;
  /** Null for dry runs and for runs that had nothing to write. */
  readonly applied: ApplyResult | null;
  readonly dryRun: boolean;
}

/** Load the base template and features and combine their questions. Used by the CLI to prompt before generating. */
export async function loadComposition(
  deps: Pick<GenerateDeps, 'templates' | 'features'>,
  templateId: string | null,
  featureIds: readonly string[],
): Promise<Composition> {
  const base = templateId === null ? null : await deps.templates.load(templateId);
  const features = [];
  for (const id of featureIds) features.push(await deps.features.load(id));
  return compose(base, features);
}

const RECORDED_STRATEGIES = new Set<RenderedFile['mergeStrategy']>(['overwrite', 'none']);

export async function generate(deps: GenerateDeps, request: GenerateRequest): Promise<GenerateResult> {
  const { fs, logger } = deps;
  const root = path.resolve(request.root);

  const composition = await loadComposition(deps, request.templateId, request.featureIds);
  const answers = resolveAnswers(composition.questions, request.answers, { useDefaults: request.useDefaults });
  const rendered = renderComposition(composition, { name: request.name, answers, pins: deps.pins });
  logger.debug('rendered', { definitions: composition.definitions.map((d) => d.manifest.id), files: rendered.files.length });

  const previousState = await readState(fs, root);
  const rootStat = await fs.lstat(root);
  if (request.mode === 'add') {
    if (rootStat?.kind !== 'dir') {
      throw new UsageError(`${root} is not a directory.`, { hint: 'Run this from your project, or pass --cwd <dir>.' });
    }
  } else {
    if (rootStat !== null && rootStat.kind !== 'dir') {
      throw new ConflictError(`${root} exists and is not a directory.`, { code: 'FORGE_E_NOT_EMPTY' });
    }
    if (rootStat !== null && previousState === null && !request.force && (await fs.readdir(root)).length > 0) {
      throw new ConflictError(`${root} is not empty.`, {
        code: 'FORGE_E_NOT_EMPTY',
        hint: 'Choose an empty directory, or re-run with --force to write alongside existing files (conflicting files are backed up).',
      });
    }
  }

  const disk = await snapshotDisk(fs, root, rendered.files.map((file) => file.path));
  let plan = createPlan({ files: rendered.files, skipped: rendered.skipped, disk, previous: previousState?.files ?? {} });

  // Record the hash of every file Forge owns outright. Merged files are shared with the user, so they are not tracked.
  const files: Record<string, string> = { ...(previousState?.files ?? {}) };
  for (const op of plan.ops) {
    if (op.hash === undefined || op.file === undefined || op.kind === 'merge') continue;
    if (!RECORDED_STRATEGIES.has(op.file.mergeStrategy)) continue;
    if (op.kind !== 'conflict' || request.force) files[op.path] = op.hash;
  }

  const features = new Map((previousState?.features ?? []).map((f) => [f.id, f]));
  for (const definition of composition.definitions) {
    if (definition.manifest.kind === 'feature') features.set(definition.manifest.id, { id: definition.manifest.id, version: definition.manifest.version });
  }
  const base = composition.definitions.find((d) => d.manifest.kind === 'template');
  const state: ForgeState = {
    schemaVersion: 1,
    forgeVersion: deps.forgeVersion,
    template: base === undefined ? (previousState?.template ?? null) : { id: base.manifest.id, version: base.manifest.version },
    name: request.name,
    features: [...features.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    answers: { ...(previousState?.answers ?? {}), ...persistableAnswers(composition.questions, answers) } as ForgeState['answers'],
    files,
  };
  const stateFile: RenderedFile = { path: STATE_PATH, content: serializeState(state), mode: 0o644, mergeStrategy: 'overwrite', sourcePath: STATE_PATH };
  plan = withOwnedFile(plan, stateFile, rootStat === null ? { kind: 'missing' } : await inspectPath(fs, root, STATE_PATH));

  const shown = (p: Plan): Plan => (request.force ? resolveForcedConflicts(p) : p);
  if (request.dryRun) return { plan: shown(plan), answers, applied: null, dryRun: true };
  assertResolvable(plan, { force: request.force });
  if (!hasChanges(plan)) return { plan, answers, applied: null, dryRun: false };

  const applied = await applyPlan(plan, {
    fs,
    root,
    clock: deps.clock,
    logger,
    overwriteConflicts: request.force,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  return { plan: shown(plan), answers, applied, dryRun: false };
}
