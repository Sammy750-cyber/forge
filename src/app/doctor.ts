import path from 'node:path';
import { applyPlan, type ApplyResult } from '../core/apply/applier.js';
import { combineFiles, type OwnedFile } from '../core/definition/compose.js';
import { createProjectView } from '../core/doctor/project.js';
import { exceeds, runRules, selectRules, summarizeFindings, type Report, type Summary } from '../core/doctor/engine.js';
import { RULES } from '../core/doctor/rules.js';
import type { Finding, Rule, Waiver } from '../core/doctor/types.js';
import { snapshotDisk } from '../core/plan/inspect.js';
import { assertResolvable, createPlan, hasChanges, resolveForcedConflicts, type Plan } from '../core/plan/planner.js';
import { readState } from '../core/state/state.js';
import { UsageError } from '../errors/index.js';
import type { Clock, FileSystem, Logger } from '../ports/index.js';

export interface DoctorDeps {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly rules?: readonly Rule[];
}

export interface DoctorRequest {
  readonly root: string;
  readonly only: readonly string[];
  readonly skip: readonly string[];
  readonly waivers: readonly Waiver[];
  readonly failOn: 'error' | 'warn';
  readonly fix: boolean;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly signal?: AbortSignal;
}

export interface DoctorResult {
  readonly report: Report;
  readonly summary: Summary;
  /** True when unwaived findings at or above the threshold remain. */
  readonly failed: boolean;
  /** The repair plan, when --fix was requested. */
  readonly fixPlan: Plan | null;
  readonly applied: ApplyResult | null;
  readonly findingsBeforeFix: readonly Finding[] | null;
}

/** Inspect a project against the rules; optionally repair what can be repaired safely. */
export async function runDoctor(deps: DoctorDeps, request: DoctorRequest): Promise<DoctorResult> {
  const rules = deps.rules ?? RULES;
  const root = path.resolve(request.root);
  const unknown = [...request.only, ...request.skip].filter((id) => !rules.some((rule) => rule.id === id));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown rule${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`, {
      code: 'FORGE_E_UNKNOWN_RULE',
      hint: `Known rules: ${rules.map((r) => r.id).join(', ')}.`,
    });
  }
  if ((await deps.fs.lstat(root))?.kind !== 'dir') throw new UsageError(`${root} is not a directory.`, { hint: 'Run this from your project, or pass --cwd <dir>.' });

  const state = await readState(deps.fs, root);
  const view = createProjectView(deps.fs, root, state);
  const options = { only: request.only, skip: request.skip, waivers: request.waivers };
  let report = await runRules(rules, view, options);
  const before = report.findings;

  let fixPlan: Plan | null = null;
  let applied: ApplyResult | null = null;
  if (request.fix) {
    // Only unwaived, fixable findings are repaired; each rule's fix is produced once however many findings it has.
    const fixable = new Set(report.findings.filter((f) => f.fixable && f.waived === undefined && !f.internal).map((f) => f.ruleId));
    const entries: OwnedFile[] = [];
    for (const rule of selectRules(rules, options)) {
      if (fixable.has(rule.id) && rule.fix !== undefined) for (const file of await rule.fix(view)) entries.push({ file, owner: rule.id });
    }
    const build = async (): Promise<Plan> => {
      const files = combineFiles(entries);
      const disk = await snapshotDisk(deps.fs, root, files.map((f) => f.path));
      return createPlan({ files, skipped: [], disk, previous: state?.files ?? {} });
    };
    let plan0 = await build();
    // Overwriting or merging saves a backup under .forge/backup. Make sure that folder is ignored by git,
    // otherwise the repair itself would create a new finding and doctor would never converge.
    const backsUp = plan0.ops.some((op) => op.kind === 'update' || op.kind === 'merge' || op.kind === 'conflict');
    const ignoreRule = rules.find((rule) => rule.id === 'hygiene/forge-backup-ignored');
    if (backsUp && ignoreRule?.fix !== undefined && !fixable.has(ignoreRule.id)) {
      for (const file of await ignoreRule.fix(view)) entries.push({ file, owner: ignoreRule.id });
      plan0 = await build();
    }
    const plan = plan0;
    fixPlan = request.force ? resolveForcedConflicts(plan) : plan;
    if (!request.dryRun) {
      assertResolvable(plan, { force: request.force });
      if (hasChanges(plan)) {
        applied = await applyPlan(plan, {
          fs: deps.fs, root, clock: deps.clock, logger: deps.logger, overwriteConflicts: request.force,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        report = await runRules(rules, createProjectView(deps.fs, root, state), options);
      }
    }
  }
  return {
    report,
    summary: summarizeFindings(report.findings),
    failed: exceeds(report.findings, request.failOn),
    fixPlan,
    applied,
    findingsBeforeFix: request.fix ? before : null,
  };
}
