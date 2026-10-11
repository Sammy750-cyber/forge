import { stableStringify } from '../core/util/stable-json.js';
import type { PostStepResult } from '../app/post-steps.js';
import type { ApplyResult } from '../core/apply/applier.js';
import { summarize, type OpKind, type Plan } from '../core/plan/planner.js';
import type { ForgeError } from '../errors/index.js';

const LABELS: Readonly<Record<OpKind, { symbol: string; word: string; color: string }>> = {
  create: { symbol: '+', word: 'create', color: '32' },
  update: { symbol: '~', word: 'update', color: '33' },
  merge: { symbol: '&', word: 'merge', color: '36' },
  unchanged: { symbol: '=', word: 'unchanged', color: '90' },
  conflict: { symbol: '!', word: 'conflict', color: '31' },
  skip: { symbol: '-', word: 'skip', color: '90' },
};

const paint = (text: string, code: string, enabled: boolean): string => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);

export interface PlanViewOptions {
  readonly color: boolean;
  /** Include Forge's own bookkeeping files such as .forge/state.json. */
  readonly verbose: boolean;
}

/** Symbols plus words, so the plan stays readable without color. */
export function formatPlan(plan: Plan, options: PlanViewOptions): string {
  const lines = plan.ops
    .filter((op) => options.verbose || op.internal !== true)
    .map((op) => {
      const label = LABELS[op.kind];
      const head = paint(`${label.symbol} ${label.word.padEnd(9)}`, label.color, options.color);
      return `${head} ${op.path}${op.reason === undefined ? '' : `  (${op.reason})`}`;
    });
  return `${lines.join('\n')}\n`;
}

export function formatPlanJson(plan: Plan, applied: ApplyResult | null, dryRun: boolean, postSteps: readonly PostStepResult[] = []): string {
  return stableStringify({
    dryRun,
    summary: summarize(plan),
    ops: plan.ops
      .filter((op) => op.internal !== true)
      .map((op) => ({ path: op.path, kind: op.kind, ...(op.reason === undefined ? {} : { reason: op.reason }) })),
    applied: applied === null ? null : { written: applied.written, backedUp: applied.backedUp, backupDir: applied.backupDir },
    postSteps,
  });
}

export function formatSummary(plan: Plan, dryRun: boolean): string {
  const s = summarize(plan);
  const verb = dryRun ? 'Would' : '';
  const parts = [
    s.create > 0 ? `${verb ? 'create' : 'created'} ${s.create}` : null,
    s.update > 0 ? `${verb ? 'update' : 'updated'} ${s.update}` : null,
    s.merge > 0 ? `${verb ? 'merge into' : 'merged into'} ${s.merge}` : null,
    s.unchanged > 0 ? `${s.unchanged} unchanged` : null,
    s.skip > 0 ? `${s.skip} skipped` : null,
    s.conflict > 0 ? `${s.conflict} in conflict` : null,
  ].filter((part): part is string => part !== null);
  const body = parts.length === 0 ? 'nothing to do' : parts.join(', ');
  return verb ? `${verb} ${body}.` : `${body.charAt(0).toUpperCase()}${body.slice(1)}.`;
}

/** What went wrong, why, and what to do next. Stack traces only with --verbose. */
export function formatError(error: ForgeError, verbose: boolean): string {
  const lines = [`error: ${error.message}`];
  if (error.hint !== undefined) lines.push(`hint: ${error.hint}`);
  lines.push(`code: ${error.code}`);
  if (verbose && error.cause instanceof Error) lines.push(error.cause.stack ?? error.cause.message);
  else if (verbose && error.stack !== undefined) lines.push(error.stack);
  return `${lines.join('\n')}\n`;
}
