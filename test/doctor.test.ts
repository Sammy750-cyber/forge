import { describe, expect, it } from 'vitest';
import { fixedClock } from '../src/adapters/clock.js';
import { nullLogger } from '../src/adapters/logger.js';
import { MemoryFileSystem } from '../src/adapters/memory-fs.js';
import { runDoctor, type DoctorRequest } from '../src/app/doctor.js';
import { newProject } from '../src/app/new-project.js';
import { createProjectView } from '../src/core/doctor/project.js';
import { exceeds, runRules, summarizeFindings } from '../src/core/doctor/engine.js';
import { RULES } from '../src/core/doctor/rules.js';
import { toSarif } from '../src/core/doctor/sarif.js';
import type { Rule } from '../src/core/doctor/types.js';
import { UsageError } from '../src/errors/index.js';
import { BUILTIN_TEMPLATES, depsFor, faultyFs } from './helpers/fixtures.js';

const ROOT = '/p';
const deps = (fs: MemoryFileSystem) => ({ fs, clock: fixedClock('2026-10-10T12:00:00Z'), logger: nullLogger });
const request = (extra: Partial<DoctorRequest> = {}): DoctorRequest => ({ root: ROOT, only: [], skip: [], waivers: [], failOn: 'error', fix: false, dryRun: false, force: false, ...extra });
const ids = async (files: Record<string, string>, only?: string): Promise<string[]> => {
  const fs = new MemoryFileSystem();
  fs.seed(Object.fromEntries(Object.entries(files).map(([k, v]) => [`${ROOT}/${k}`, v])));
  if (Object.keys(files).length === 0) await fs.mkdir(ROOT);
  const { report } = await runDoctor(deps(fs), request(only === undefined ? {} : { only: [only] }));
  return report.findings.map((f) => `${f.ruleId}${f.path === undefined ? '' : `@${f.path}${f.line === undefined ? '' : `:${f.line}`}`}`);
};
// Credentials are assembled at runtime so this file never contains a literal that looks like one.
const fake = { aws: ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join(''), ghp: ['gh', 'p_', 'a'.repeat(36)].join(''), pem: ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join('') };

describe('rules', () => {
  it('supply-chain/lockfile', async () => {
    expect(await ids({ 'package.json': '{}' }, 'supply-chain/lockfile')).toEqual(['supply-chain/lockfile@package.json']);
    expect(await ids({ 'package.json': '{}', 'pnpm-lock.yaml': '' }, 'supply-chain/lockfile')).toEqual([]);
    expect(await ids({}, 'supply-chain/lockfile')).toEqual([]);
  });

  it('supply-chain/actions-pinned flags tags and branches but not SHAs, local or docker refs', async () => {
    const sha = 'a'.repeat(40);
    const wf = [
      'jobs:', '  a:', '    steps:',
      '      - uses: actions/checkout@v4',
      `      - uses: actions/setup-node@${sha} # v4`,
      '      - uses: ./local-action',
      '      - uses: docker://alpine:3',
      '      - uses: "owner/repo@main"',
      '      - name: x', '        uses: other/thing@v1.2.3',
    ].join('\n');
    expect(await ids({ '.github/workflows/ci.yml': wf }, 'supply-chain/actions-pinned')).toEqual([
      'supply-chain/actions-pinned@.github/workflows/ci.yml:4',
      'supply-chain/actions-pinned@.github/workflows/ci.yml:8',
      'supply-chain/actions-pinned@.github/workflows/ci.yml:10',
    ]);
  });

  it('supply-chain/base-image-pinned understands stages, digests, scratch and variables', async () => {
    const df = ['FROM node AS a', 'FROM node:latest AS b', 'FROM --platform=linux/amd64 node:22-slim AS c', 'FROM a AS d', 'FROM scratch', 'FROM $BASE', `FROM x/y@sha256:${'0'.repeat(64)}`, 'FROM registry:5000/team/app'].join('\n');
    expect(await ids({ Dockerfile: df }, 'supply-chain/base-image-pinned')).toEqual([
      'supply-chain/base-image-pinned@Dockerfile:1', 'supply-chain/base-image-pinned@Dockerfile:2', 'supply-chain/base-image-pinned@Dockerfile:8',
    ]);
  });

  it('docker/non-root looks only at the final stage and the last USER', async () => {
    expect(await ids({ Dockerfile: 'FROM a:1\nUSER root\nFROM b:1\nCMD x' }, 'docker/non-root')).toHaveLength(1);
    expect(await ids({ Dockerfile: 'FROM a:1\nUSER node\nUSER root' }, 'docker/non-root')).toHaveLength(1);
    expect(await ids({ Dockerfile: 'FROM a:1 AS build\nUSER root\nFROM b:1\nUSER 1000:1000\n' }, 'docker/non-root')).toEqual([]);
    expect(await ids({ Dockerfile: 'FROM a:1\nRUN echo \\\n  hi\nUSER node' }, 'docker/non-root')).toEqual([]);
  });

  it('docker/healthcheck and docker/dockerignore', async () => {
    expect(await ids({ Dockerfile: 'FROM a:1\nHEALTHCHECK NONE' }, 'docker/healthcheck')).toHaveLength(1);
    expect(await ids({ Dockerfile: 'FROM a:1\nHEALTHCHECK CMD curl -f x' }, 'docker/healthcheck')).toEqual([]);
    expect(await ids({ Dockerfile: 'FROM a:1' }, 'docker/dockerignore')).toHaveLength(1);
    expect(await ids({ Dockerfile: 'FROM a:1', '.dockerignore': 'x' }, 'docker/dockerignore')).toEqual([]);
    expect(await ids({}, 'docker/dockerignore')).toEqual([]);
  });

  it('ci/present, ci/permissions', async () => {
    expect(await ids({ 'README.md': 'x' }, 'ci/present')).toEqual(['ci/present']);
    expect(await ids({ '.gitlab-ci.yml': 'a: 1' }, 'ci/present')).toEqual([]);
    const bare = 'on: push\njobs:\n  a:\n    runs-on: x\n    steps: []\n';
    expect(await ids({ '.github/workflows/a.yml': bare }, 'ci/permissions')).toHaveLength(1);
    expect(await ids({ '.github/workflows/a.yml': `permissions:\n  contents: read\n${bare}` }, 'ci/permissions')).toEqual([]);
    expect(await ids({ '.github/workflows/a.yml': 'on: push\njobs:\n  a:\n    permissions: {}\n    steps: []\n' }, 'ci/permissions')).toEqual([]);
    expect(await ids({ '.github/workflows/a.yml': 'on: [unclosed' }, 'ci/permissions')).toHaveLength(1);
  });

  it('ci/secret-scan and ci/dependency-scan accept Forge markers, known tools and dependency bots', async () => {
    const plain = { '.github/workflows/a.yml': 'name: x' };
    expect(await ids(plain, 'ci/secret-scan')).toHaveLength(1);
    expect(await ids(plain, 'ci/dependency-scan')).toHaveLength(1);
    expect(await ids({ '.github/workflows/a.yml': '# forge:checks secrets,dependencies' }, 'ci/secret-scan')).toEqual([]);
    expect(await ids({ '.github/workflows/a.yml': 'uses: gitleaks/gitleaks-action@x' }, 'ci/secret-scan')).toEqual([]);
    expect(await ids({ ...plain, '.github/dependabot.yml': 'version: 2' }, 'ci/dependency-scan')).toEqual([]);
    expect(await ids({}, 'ci/secret-scan')).toEqual([]);
  });

  it('secrets/env-ignored and secrets/env-file-exposed', async () => {
    expect(await ids({ '.gitignore': 'node_modules/', 'package.json': '{}' }, 'secrets/env-ignored')).toHaveLength(1);
    expect(await ids({ '.gitignore': '# .env\nnode_modules/', 'package.json': '{}' }, 'secrets/env-ignored')).toHaveLength(1);
    expect(await ids({ '.gitignore': '.env.*\n', 'package.json': '{}' }, 'secrets/env-ignored')).toEqual([]);
    expect(await ids({ '.env': 'A=1', '.gitignore': 'dist/' }, 'secrets/env-file-exposed')).toEqual(['secrets/env-file-exposed@.env']);
    expect(await ids({ '.env': 'A=1' }, 'secrets/env-file-exposed')).toHaveLength(1);
    expect(await ids({ '.env': 'A=1', '.gitignore': '.env' }, 'secrets/env-file-exposed')).toEqual([]);
  });

  it('secrets/hardcoded finds well-known credential formats, never prints them, and honours the allow marker', async () => {
    const fs = new MemoryFileSystem();
    fs.seed({
      [`${ROOT}/src/a.ts`]: `const k = "${fake.aws}";\nconst ok = 1;`,
      [`${ROOT}/src/b.ts`]: `token=${fake.ghp}`,
      [`${ROOT}/keys/id.pem`]: `${fake.pem}\nMIIB`,
      [`${ROOT}/test/fixture.ts`]: `const k = "${fake.aws}"; // forge:allow-secret`,
      [`${ROOT}/node_modules/x/index.js`]: `"${fake.aws}"`,
      [`${ROOT}/.git/config`]: fake.ghp,
      [`${ROOT}/README.md`]: 'AKIA is the prefix of AWS keys',
    });
    const result = await runDoctor(deps(fs), request({ only: ['secrets/hardcoded'] }));
    expect(result.report.findings.map((f) => `${f.path}:${f.line}`)).toEqual(['keys/id.pem:1', 'src/a.ts:1', 'src/b.ts:1']);
    expect(JSON.stringify(result.report)).not.toContain(fake.aws);
    expect(JSON.stringify(result.report)).not.toContain(fake.ghp);
  });

  it('hygiene rules', async () => {
    expect(await ids({}, 'hygiene/readme')).toEqual(['hygiene/readme']);
    expect(await ids({ 'readme.txt': '' }, 'hygiene/readme')).toEqual([]);
    expect(await ids({}, 'hygiene/license')).toEqual(['hygiene/license']);
    expect(await ids({ COPYING: '' }, 'hygiene/license')).toEqual([]);
    expect(await ids({}, 'hygiene/gitignore')).toEqual(['hygiene/gitignore']);
    expect(await ids({ 'package.json': '{"engines":{}}' }, 'hygiene/engines')).toHaveLength(1);
    expect(await ids({ 'package.json': '{"engines":{"node":">=22"}}' }, 'hygiene/engines')).toEqual([]);
    expect(await ids({ '.forge/backup/x/a': '1', '.gitignore': 'dist/' }, 'hygiene/forge-backup-ignored')).toHaveLength(1);
    expect(await ids({ '.forge/backup/x/a': '1', '.gitignore': '/.forge/backup/' }, 'hygiene/forge-backup-ignored')).toEqual([]);
  });

  it('drift/modified reports edited and deleted generated files (info only)', async () => {
    const fs = new MemoryFileSystem();
    await newProject(depsFor(fs), { name: 'demo', templateId: 'minimal', targetDir: ROOT, answers: {}, useDefaults: true, dryRun: false, force: false });
    await fs.writeFile(`${ROOT}/README.md`, new TextEncoder().encode('mine'));
    await fs.remove(`${ROOT}/LICENSE`);
    const { report } = await runDoctor(deps(fs), request({ only: ['drift/modified'] }));
    expect(report.findings.map((f) => `${f.severity}:${f.path}:${f.message}`)).toEqual([
      'info:LICENSE:Generated file was removed.', 'info:README.md:Generated file was modified after generation.',
    ]);
  });

  it('every rule has a unique id, a title and a description', () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    for (const rule of RULES) {
      expect(rule.id).toMatch(/^[a-z-]+\/[a-z-]+$/);
      expect(rule.title.length).toBeGreaterThan(10);
      expect(rule.description.length).toBeGreaterThan(30);
    }
  });
});

describe('engine', () => {
  const view = () => createProjectView(new MemoryFileSystem(), ROOT, null);
  const make = (id: string, check: Rule['check']): Rule => ({ id, severity: 'error', title: 't', description: 'd', check });

  it('turns a crashing or hanging rule into a finding instead of crashing the run', async () => {
    const rules = [
      make('a/crash', async () => { throw new Error('boom'); }),
      make('a/hang', () => new Promise(() => undefined)),
      make('a/ok', async () => [{ message: 'real problem' }]),
    ];
    const { findings } = await runRules(rules, view(), { timeoutMs: 50 });
    expect(findings.map((f) => [f.ruleId, f.severity, f.internal === true])).toEqual([['a/ok', 'error', false], ['a/crash', 'warn', true], ['a/hang', 'warn', true]]);
    expect(findings.find((f) => f.ruleId === 'a/hang')?.message).toContain('timed out');
  });

  it('sorts deterministically, regardless of which rule finishes first', async () => {
    const slow = make('z/slow', async () => { await new Promise((r) => setTimeout(r, 30)); return [{ message: 'm' }]; });
    const fast = make('a/fast', async () => [{ message: 'm' }]);
    expect((await runRules([slow, fast], view())).findings.map((f) => f.ruleId)).toEqual(['a/fast', 'z/slow']);
  });

  it('applies waivers (keeping the reason visible) and reports unknown ones', async () => {
    const rule = make('a/x', async () => [{ message: 'm' }]);
    const report = await runRules([rule], view(), { waivers: [{ rule: 'a/x', reason: 'accepted until Q3' }, { rule: 'a/typo', reason: 'whatever reason' }] });
    expect(report.findings[0]?.waived).toBe('accepted until Q3');
    expect(report.unknownWaivers).toEqual(['a/typo']);
    expect(summarizeFindings(report.findings)).toEqual({ error: 0, warn: 0, info: 0, waived: 1 });
    expect(exceeds(report.findings, 'error')).toBe(false);
  });

  it('filters with only/skip and applies failOn thresholds', async () => {
    const rules = [make('a/one', async () => [{ message: 'm' }]), { ...make('a/two', async () => [{ message: 'm' }]), severity: 'warn' as const }];
    expect((await runRules(rules, view(), { only: ['a/two'] })).rulesRun).toEqual(['a/two']);
    expect((await runRules(rules, view(), { skip: ['a/two'] })).rulesRun).toEqual(['a/one']);
    const warnOnly = (await runRules(rules, view(), { only: ['a/two'] })).findings;
    expect(exceeds(warnOnly, 'error')).toBe(false);
    expect(exceeds(warnOnly, 'warn')).toBe(true);
  });
});

describe('runDoctor', () => {
  it('rejects unknown rule ids and non-directories', async () => {
    const fs = new MemoryFileSystem();
    await fs.mkdir(ROOT);
    await expect(runDoctor(deps(fs), request({ only: ['nope/rule'] }))).rejects.toThrow(UsageError);
    await expect(runDoctor(deps(fs), request({ root: '/missing' }))).rejects.toThrow(/not a directory/);
  });

  it('INVARIANT 5: every generated project, with and without features, has zero errors', async () => {
    for (const templateId of await BUILTIN_TEMPLATES.list()) {
      for (const features of [[], ['ci', 'scan']]) {
        const fs = new MemoryFileSystem();
        await newProject(depsFor(fs), { name: 'demo', templateId, features, targetDir: ROOT, answers: {}, useDefaults: true, dryRun: false, force: false });
        const result = await runDoctor(deps(fs), request({ failOn: 'error' }));
        expect(result.report.findings.filter((f) => f.severity === 'error'), `${templateId} + [${features}]`).toEqual([]);
        expect(result.failed).toBe(false);
      }
    }
  });

  it('flags a deliberately insecure project and fails', async () => {
    const fs = new MemoryFileSystem();
    fs.seed({
      [`${ROOT}/Dockerfile`]: 'FROM node\nCOPY . .\nCMD ["node","x"]',
      [`${ROOT}/.github/workflows/ci.yml`]: 'on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n',
      [`${ROOT}/.env`]: 'SECRET=1',
    });
    const result = await runDoctor(deps(fs), request());
    expect(result.failed).toBe(true);
    const errors = new Set(result.report.findings.filter((f) => f.severity === 'error').map((f) => f.ruleId));
    expect(errors).toEqual(new Set(['supply-chain/base-image-pinned', 'docker/non-root', 'supply-chain/actions-pinned', 'ci/permissions', 'secrets/env-file-exposed']));
  });

  describe('--fix', () => {
    const messy = () => {
      const fs = new MemoryFileSystem();
      fs.seed({
        [`${ROOT}/package.json`]: JSON.stringify({ name: 'x', engines: {} }, null, 2),
        [`${ROOT}/.gitignore`]: 'node_modules/\nmy-own-entry\n',
        [`${ROOT}/.env`]: 'A=1',
        [`${ROOT}/Dockerfile`]: 'FROM node:22\nUSER node\nHEALTHCHECK CMD true',
        [`${ROOT}/README.md`]: 'x',
      });
      return fs;
    };

    it('repairs what is safe to repair, keeps the user\'s content, and converges', async () => {
      const fs = messy();
      const result = await runDoctor(deps(fs), request({ fix: true, failOn: 'error' }));
      expect([...(result.applied?.written ?? [])].sort()).toEqual(['.dockerignore', '.gitignore', 'package.json']);
      expect(fs.text(`${ROOT}/.gitignore`)).toBe('node_modules/\nmy-own-entry\n\n.env\n.env.local\n.forge/backup/\n');
      expect(JSON.parse(fs.text(`${ROOT}/package.json`))).toEqual({ name: 'x', engines: { node: '>=22' } });
      expect(fs.text(`${ROOT}/.dockerignore`)).toContain('node_modules');
      expect(fs.text(`${result.applied?.backupDir}/.gitignore`)).toBe('node_modules/\nmy-own-entry\n');
      expect(result.report.findings.filter((f) => f.fixable)).toEqual([]);
      expect(result.failed).toBe(false);
      expect(result.findingsBeforeFix?.some((f) => f.ruleId === 'secrets/env-file-exposed')).toBe(true);

      const settled = fs.snapshot();
      const again = await runDoctor(deps(fs), request({ fix: true }));
      expect(again.applied).toBeNull();
      expect(fs.snapshot()).toEqual(settled);
    });

    it('--dry-run shows the repair plan and writes nothing', async () => {
      const fs = messy();
      const before = fs.snapshot();
      const result = await runDoctor(deps(fs), request({ fix: true, dryRun: true }));
      expect(result.fixPlan?.ops.map((o) => `${o.kind}:${o.path}`).sort()).toEqual(['create:.dockerignore', 'merge:.gitignore', 'merge:package.json']);
      expect(fs.snapshot()).toEqual(before);
    });

    it('does not repair waived findings', async () => {
      const fs = messy();
      const result = await runDoctor(deps(fs), request({ fix: true, waivers: [{ rule: 'docker/dockerignore', reason: 'we build from a clean checkout in CI' }] }));
      expect(result.applied?.written).not.toContain('.dockerignore');
    });

    it('leaves a package.json it cannot parse alone, and still repairs everything else', async () => {
      const fs = messy();
      const jsonc = '{ "name": "x", // a comment\n "engines": {} }';
      fs.seed({ [`${ROOT}/package.json`]: jsonc });
      const result = await runDoctor(deps(fs), request({ fix: true }));
      expect(fs.text(`${ROOT}/package.json`)).toBe(jsonc);
      expect([...(result.applied?.written ?? [])].sort()).toEqual(['.dockerignore', '.gitignore']);
    });

    it('refuses to repair through a symlink or over a directory, and changes nothing', async () => {
      const fs = messy();
      await fs.remove(`${ROOT}/.gitignore`);
      await fs.mkdir(`${ROOT}/.gitignore`);
      const before = fs.snapshot();
      await expect(runDoctor(deps(fs), request({ fix: true, force: true }))).rejects.toThrow(/Cannot write/);
      expect(fs.snapshot()).toEqual(before);
    });

    it('is atomic: a failure at any step leaves the project as it was', async () => {
      const counted = faultyFs(messy(), 0);
      await runDoctor(deps(counted as unknown as MemoryFileSystem), request({ fix: true }));
      for (let failAt = 1; failAt <= counted.mutations; failAt += 1) {
        const mem = messy();
        const before = mem.snapshot();
        await expect(runDoctor(deps(faultyFs(mem, failAt) as unknown as MemoryFileSystem), request({ fix: true })), `failAt ${failAt}`).rejects.toThrow();
        expect(mem.snapshot(), `failAt ${failAt}`).toEqual(before);
      }
    });
  });
});

describe('SARIF', () => {
  it('produces a structurally valid SARIF 2.1.0 log, with suppressions for waived findings', async () => {
    const fs = new MemoryFileSystem();
    fs.seed({ [`${ROOT}/Dockerfile`]: 'FROM node\nUSER node' });
    const { report } = await runDoctor(deps(fs), request({ waivers: [{ rule: 'docker/healthcheck', reason: 'health is checked by the orchestrator' }] }));
    const sarif = JSON.parse(toSarif(report.findings, RULES, '1.2.3'));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toContain('sarif-2.1.0');
    const run = sarif.runs[0];
    expect(run.tool.driver).toMatchObject({ name: 'forge', version: '1.2.3' });
    expect(run.tool.driver.rules).toHaveLength(RULES.length);
    const ruleIds = new Set(run.tool.driver.rules.map((r: { id: string }) => r.id));
    for (const result of run.results) {
      expect(ruleIds.has(result.ruleId)).toBe(true);
      expect(run.tool.driver.rules[result.ruleIndex].id).toBe(result.ruleId);
      expect(['error', 'warning', 'note']).toContain(result.level);
      expect(result.message.text.length).toBeGreaterThan(0);
    }
    const unpinned = run.results.find((r: { ruleId: string }) => r.ruleId === 'supply-chain/base-image-pinned');
    expect(unpinned.locations[0].physicalLocation).toMatchObject({ artifactLocation: { uri: 'Dockerfile' }, region: { startLine: 1 } });
    const waived = run.results.find((r: { ruleId: string }) => r.ruleId === 'docker/healthcheck');
    expect(waived.suppressions[0]).toMatchObject({ kind: 'external', justification: 'health is checked by the orchestrator' });
  });
});
