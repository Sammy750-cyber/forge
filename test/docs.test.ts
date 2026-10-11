import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/doctor/rules.js';
import { REPO_ROOT } from './helpers/fixtures.js';

const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** docs/RULES.md is generated from the rule registry. Run with UPDATE_DOCS=1 to rewrite it. */
function renderRulesDoc(): string {
  const order = { error: 0, warn: 1, info: 2 } as const;
  const sections = [...RULES]
    .sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id))
    .map((rule) => `### \`${rule.id}\`\n\n**${rule.severity}** — ${rule.title}\n\n${rule.description}\n${rule.fix === undefined ? '' : '\nFixable with `forge doctor --fix`.\n'}`);
  return [
    '# Doctor rules',
    '',
    '_This file is generated from the rule registry by `test/docs.test.ts`. Do not edit it by hand (run the tests with `UPDATE_DOCS=1`)._',
    '',
    '`forge doctor` exits 6 when unwaived findings at or above `--fail-on` (default `error`) remain. Waive a rule in `forge.config.json` with a stated reason:',
    '',
    '```json',
    '{ "doctor": { "waivers": [ { "rule": "docker/healthcheck", "reason": "health is checked by the orchestrator" } ] } }',
    '```',
    '',
    'Waived findings stay in the report (and in SARIF as suppressions) so the decision is auditable.',
    '',
    ...sections,
  ].join('\n');
}

describe('documentation stays true to the code', () => {
  it('docs/RULES.md matches the rule registry', () => {
    const expected = `${renderRulesDoc()}\n`;
    if (process.env['UPDATE_DOCS'] === '1') writeFileSync(path.join(REPO_ROOT, 'docs/RULES.md'), expected);
    expect(read('docs/RULES.md')).toBe(expected);
  });

  it('every error code in the source is explained in TROUBLESHOOTING.md', () => {
    const doc = read('docs/TROUBLESHOOTING.md');
    const codes = new Set<string>();
    for (const file of sourceFiles(path.join(REPO_ROOT, 'src'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/FORGE_E_[A-Z_]+/g)) codes.add(match[0]);
    }
    expect(codes.size).toBeGreaterThan(25);
    const missing = [...codes].filter((code) => !doc.includes(`**\`${code}\`**`));
    expect(missing).toEqual([]);
  });

  it('TROUBLESHOOTING.md does not document codes that no longer exist', () => {
    const all = sourceFiles(path.join(REPO_ROOT, 'src')).map((f) => readFileSync(f, 'utf8')).join('\n');
    const documented = [...read('docs/TROUBLESHOOTING.md').matchAll(/\*\*`(FORGE_E_[A-Z_]+)`/g)].map((m) => m[1] ?? '');
    expect(documented.filter((code) => !all.includes(code))).toEqual([]);
  });

  it('exit codes in the docs match the code', async () => {
    const { EXIT } = await import('../src/errors/index.js');
    const doc = read('docs/TROUBLESHOOTING.md');
    for (const code of Object.values(EXIT)) expect(doc).toMatch(new RegExp(`\\| ${code} \\|`));
  });

  it('every template and feature question appears in the authoring guide vocabulary', () => {
    const doc = read('docs/AUTHORING.md');
    for (const word of ['json-merge', 'yaml-merge', 'line-set', 'overwrite', 'shellQuote', 'yamlString', '_dot_', 'when']) expect(doc).toContain(word);
  });

  it('the README quick start only uses commands and flags that exist', () => {
    const readme = read('README.md');
    for (const command of ['new', 'add', 'doctor', 'list', 'config']) expect(readme).toContain(`forge ${command}`);
  });

  it('package metadata is release-ready', () => {
    const pkg = JSON.parse(read('package.json')) as Record<string, unknown>;
    expect(pkg['version']).toBe('1.0.0');
    expect(pkg['private']).toBeUndefined();
    expect(pkg['license']).toBe('MIT');
    expect(pkg['publishConfig']).toMatchObject({ provenance: true, access: 'public' });
    expect(pkg['packageManager']).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(read('CHANGELOG.md')).toMatch(/^## 1\.0\.0 /m);
    expect(read('LICENSE')).toContain('MIT License');
  });
});
