import type { Finding, FindingSeverity, Issue, ProjectView, Rule, Waiver } from './types.js';

export interface RunOptions {
  /** Run only these rule ids (empty or undefined = all). */
  readonly only?: readonly string[];
  readonly skip?: readonly string[];
  readonly waivers?: readonly Waiver[];
  /** Per-rule limit so one slow or hung rule cannot stall the whole run. Default 10 seconds. */
  readonly timeoutMs?: number;
}

export interface Report {
  readonly findings: readonly Finding[];
  /** Waivers that name no known rule, so typos do not silently suppress nothing. */
  readonly unknownWaivers: readonly string[];
  readonly rulesRun: readonly string[];
}

const ORDER: Record<FindingSeverity, number> = { error: 0, warn: 1, info: 2 };

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

export function selectRules(rules: readonly Rule[], options: Pick<RunOptions, 'only' | 'skip'>): Rule[] {
  const only = new Set(options.only ?? []);
  const skip = new Set(options.skip ?? []);
  return rules.filter((rule) => (only.size === 0 || only.has(rule.id)) && !skip.has(rule.id));
}

/** Run rules in parallel, read-only. A crashing or hanging rule becomes a finding; it never crashes the run. */
export async function runRules(rules: readonly Rule[], project: ProjectView, options: RunOptions = {}): Promise<Report> {
  const selected = selectRules(rules, options);
  const timeout = options.timeoutMs ?? 10_000;
  const waivers = new Map((options.waivers ?? []).map((w) => [w.rule, w.reason]));

  const results = await Promise.all(
    selected.map(async (rule): Promise<Finding[]> => {
      let issues: Issue[];
      try {
        issues = await withTimeout(rule.check(project), timeout);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return [{ ruleId: rule.id, severity: 'warn', message: `The rule could not finish: ${reason}.`, fixable: false, internal: true, hint: 'This is a problem in Forge, not in your project. Please report it.' }];
      }
      return issues.map((issue) => {
        const waived = waivers.get(rule.id);
        return { ...issue, ruleId: rule.id, severity: rule.severity, fixable: rule.fix !== undefined, ...(waived === undefined ? {} : { waived }) };
      });
    }),
  );

  const findings = results.flat().sort(
    (a, b) =>
      ORDER[a.severity] - ORDER[b.severity] ||
      (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0) ||
      (a.path ?? '').localeCompare(b.path ?? '') ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.message.localeCompare(b.message),
  );
  const known = new Set(rules.map((r) => r.id));
  return { findings, unknownWaivers: [...waivers.keys()].filter((id) => !known.has(id)).sort(), rulesRun: selected.map((r) => r.id) };
}

export interface Summary {
  readonly error: number;
  readonly warn: number;
  readonly info: number;
  readonly waived: number;
}

export function summarizeFindings(findings: readonly Finding[]): Summary {
  const counts = { error: 0, warn: 0, info: 0, waived: 0 };
  for (const finding of findings) {
    if (finding.waived === undefined) counts[finding.severity] += 1;
    else counts.waived += 1;
  }
  return counts;
}

/** True when any unwaived finding is at or above the threshold. */
export function exceeds(findings: readonly Finding[], failOn: 'error' | 'warn'): boolean {
  const limit = failOn === 'error' ? 0 : 1;
  return findings.some((f) => f.waived === undefined && ORDER[f.severity] <= limit);
}
