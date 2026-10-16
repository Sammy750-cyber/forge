import type { UpdateResult, OutcomeKind } from '../app/update-project.js';
import { stableStringify } from '../core/util/stable-json.js';

const LABELS: Readonly<Record<OutcomeKind, { symbol: string; word: string; color: string } | null>> = {
  create: { symbol: '+', word: 'create', color: '32' },
  update: { symbol: '~', word: 'update', color: '33' },
  merge: { symbol: '&', word: 'merge', color: '36' },
  keep: { symbol: '.', word: 'keep', color: '90' },
  converged: { symbol: '=', word: 'converged', color: '90' },
  adopt: { symbol: '=', word: 'adopt', color: '90' },
  'kept-removed': { symbol: '.', word: 'removed', color: '90' },
  conflict: { symbol: '!', word: 'conflict', color: '31' },
  blocked: { symbol: '!', word: 'blocked', color: '31' },
  orphan: { symbol: '?', word: 'orphan', color: '35' },
  'orphan-modified': { symbol: '?', word: 'yours', color: '90' },
  unchanged: null,
  gone: null,
};

const paint = (text: string, code: string, on: boolean): string => (on ? `\u001b[${code}m${text}\u001b[0m` : text);

export interface UpdateViewOptions {
  readonly color: boolean;
  /** Also list files that did not change. */
  readonly verbose: boolean;
}

/** Version transitions first, then every file that is not simply unchanged, then any diffs. Words as well as symbols. */
export function formatUpdate(result: UpdateResult, options: UpdateViewOptions): string {
  const lines: string[] = [];
  for (const v of result.versions) if (v.from !== v.to) lines.push(`${v.id} ${v.from} -> ${v.to}`);
  for (const outcome of result.outcomes) {
    const label = LABELS[outcome.kind];
    // `keep` repeats on every run for as long as you keep your edit, and needs no action, so it is verbose-only.
    if ((label === null || outcome.kind === 'keep') && !options.verbose) continue;
    const { symbol, word, color } = label ?? { symbol: ' ', word: outcome.kind, color: '90' };
    lines.push(`${paint(`${symbol} ${word.padEnd(9)}`, color, options.color)} ${outcome.path}${outcome.reason === undefined ? '' : `  (${outcome.reason})`}`);
  }
  const diffs = result.outcomes.filter((o) => o.diff !== undefined).map((o) => o.diff as string);
  if (diffs.length > 0) lines.push('', ...diffs.map((d) => d.trimEnd()));
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One human sentence for stderr. Only things you might act on are mentioned; kept edits are not. */
export function summarizeUpdate(result: UpdateResult): string {
  const c = result.counts;
  const n = (kind: OutcomeKind): number => c[kind] ?? 0;
  const pruned = result.applied?.deleted.length ?? 0;
  const orphansLeft = n('orphan') - pruned; // anything --prune already removed is no longer an orphan to mention
  const attention = n('conflict') + n('blocked');

  if (result.upToDate && result.applied === null && attention === 0) {
    return `Already up to date (${result.versions.map((v) => `${v.id} ${v.to}`).join(', ') || 'no definitions'}).`;
  }
  const would = result.dryRun;
  const actions = [
    n('update') > 0 ? `${would ? 'update' : 'updated'} ${n('update')}` : null,
    n('create') > 0 ? `${would ? 'create' : 'created'} ${n('create')}` : null,
    n('merge') > 0 ? `${would ? 'merge into' : 'merged into'} ${n('merge')}` : null,
    pruned > 0 ? `${would ? 'delete' : 'deleted'} ${pruned}` : null,
  ].filter((part): part is string => part !== null);
  const notes = [
    orphansLeft > 0 ? `${plural(orphansLeft, 'orphan')} (--prune removes them)` : null,
    n('unchanged') > 0 ? `${n('unchanged')} unchanged` : null,
  ].filter((part): part is string => part !== null);

  const lead = actions.length === 0 ? '' : `${would ? 'Would ' : ''}${actions.join(', ')}`;
  const sentence = [lead, notes.join(', ')].filter((part) => part !== '').join('; ');
  const head = sentence === '' ? 'Nothing to do.' : `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
  return attention > 0 ? `${head}\n${plural(attention, 'path')} need${attention === 1 ? 's' : ''} your attention (marked with !).` : head;
}

export function formatUpdateJson(result: UpdateResult): string {
  return stableStringify({
    upToDate: result.upToDate,
    dryRun: result.dryRun,
    versions: result.versions,
    counts: result.counts,
    outcomes: result.outcomes,
    conflictsRemaining: result.conflictsRemaining,
    droppedAnswers: result.droppedAnswers,
    applied: result.applied === null ? null : { written: result.applied.written, deleted: result.applied.deleted, backedUp: result.applied.backedUp, backupDir: result.applied.backupDir },
  });
}
