import { stableStringify } from '../util/stable-json.js';
import type { Finding, FindingSeverity, Rule } from './types.js';

const LEVEL: Record<FindingSeverity, 'error' | 'warning' | 'note'> = { error: 'error', warn: 'warning', info: 'note' };

/**
 * SARIF 2.1.0, the format GitHub code scanning, GitLab and most IDEs ingest.
 * Waived findings are included with a suppression and their justification, so the audit trail survives.
 */
export function toSarif(findings: readonly Finding[], rules: readonly Rule[], forgeVersion: string): string {
  const index = new Map(rules.map((rule, i) => [rule.id, i]));
  return stableStringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'forge',
            version: forgeVersion,
            rules: rules.map((rule) => ({
              id: rule.id,
              name: rule.id.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(''),
              shortDescription: { text: rule.title },
              fullDescription: { text: rule.description },
              defaultConfiguration: { level: LEVEL[rule.severity] },
              help: { text: rule.description },
            })),
          },
        },
        results: findings.map((finding) => ({
          ruleId: finding.ruleId,
          ...(index.has(finding.ruleId) ? { ruleIndex: index.get(finding.ruleId) } : {}),
          level: LEVEL[finding.severity],
          message: { text: finding.hint === undefined ? finding.message : `${finding.message} ${finding.hint}` },
          ...(finding.path === undefined
            ? {}
            : {
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: finding.path, uriBaseId: '%SRCROOT%' },
                      ...(finding.line === undefined ? {} : { region: { startLine: finding.line } }),
                    },
                  },
                ],
              }),
          ...(finding.waived === undefined ? {} : { suppressions: [{ kind: 'external', justification: finding.waived }] }),
        })),
      },
    ],
  });
}
