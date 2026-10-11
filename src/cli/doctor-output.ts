import { stableStringify } from '../core/util/stable-json.js';
import type { Finding, Rule } from '../core/doctor/types.js';
import type { DoctorResult } from '../app/doctor.js';

const COLORS = { error: '31', warn: '33', info: '36' } as const;
const paint = (text: string, code: string, on: boolean): string => (on ? `\u001b[${code}m${text}\u001b[0m` : text);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function where(finding: Finding): string {
  if (finding.path === undefined) return '';
  return finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`;
}

/** Words as well as colors, so the report reads the same in a log file. */
export function formatDoctorText(result: DoctorResult, color: boolean): string {
  const lines: string[] = [];
  for (const finding of result.report.findings) {
    const label = finding.waived === undefined ? finding.severity.padEnd(5) : 'waive';
    const head = paint(label, finding.waived === undefined ? COLORS[finding.severity] : '90', color);
    const fixable = finding.fixable && finding.waived === undefined ? ' [fixable]' : '';
    lines.push(`${head}  ${finding.ruleId}${where(finding) === '' ? '' : `  ${where(finding)}`}${fixable}`);
    lines.push(`       ${finding.message}`);
    if (finding.waived !== undefined) lines.push(`       waived: ${finding.waived}`);
    else if (finding.hint !== undefined) lines.push(`       hint: ${finding.hint}`);
  }
  for (const id of result.report.unknownWaivers) lines.push(`warn   waiver for unknown rule "${id}" (check the spelling)`);
  const { error, warn, info, waived } = result.summary;
  lines.push(`${lines.length > 0 ? '\n' : ''}${plural(error, 'error')}, ${plural(warn, 'warning')}, ${info} info${waived > 0 ? `, ${waived} waived` : ''}.`);
  return `${lines.join('\n')}\n`;
}

export function formatDoctorJson(result: DoctorResult): string {
  return stableStringify({
    summary: result.summary,
    failed: result.failed,
    findings: result.report.findings,
    unknownWaivers: result.report.unknownWaivers,
    fixed: result.applied === null ? null : result.applied.written,
  });
}

export function formatRuleList(rules: readonly Rule[]): string {
  return `${rules.map((r) => `${r.severity.padEnd(5)}  ${r.id.padEnd(32)} ${r.title}`).join('\n')}\n`;
}
