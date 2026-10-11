import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemClock } from '../src/adapters/clock.js';
import { createNodeFileSystem } from '../src/adapters/node-fs.js';
import { run, type CliIo } from '../src/cli/main.js';
import { RULES } from '../src/core/doctor/rules.js';
import { EXIT } from '../src/errors/index.js';
import { BUILTIN_FEATURES, BUILTIN_TEMPLATES, fakeRunner, PINS } from './helpers/fixtures.js';

let tmp: string;
beforeEach(async () => void (tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-cli2-'))));
afterEach(async () => fs.rm(tmp, { recursive: true, force: true }));

async function forge(args: string[], env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const io: CliIo = { stdout: (t) => void (stdout += t), stderr: (t) => void (stderr += t), cwd: tmp, env: { HOME: path.join(tmp, 'home'), ...env }, isTTY: false };
  const code = await run(args, io, {
    fs: createNodeFileSystem(), clock: systemClock, templates: BUILTIN_TEMPLATES, features: BUILTIN_FEATURES, pins: PINS, forgeVersion: '9.9.9', runner: fakeRunner(),
  });
  return { code, stdout, stderr };
}
const write = async (rel: string, content: string) => {
  await fs.mkdir(path.dirname(path.join(tmp, rel)), { recursive: true });
  await fs.writeFile(path.join(tmp, rel), content);
};
const read = (rel: string) => fs.readFile(path.join(tmp, rel), 'utf8');
const exists = (rel: string) => fs.access(path.join(tmp, rel)).then(() => true, () => false);

describe('forge list --features', () => {
  it('lists features, as text or JSON', async () => {
    expect((await forge(['list', '--features'])).stdout).toBe('ci\nscan\n');
    expect(JSON.parse((await forge(['list', '--features', '--format', 'json'])).stdout)).toEqual({ features: ['ci', 'scan'] });
  });
});

describe('forge new --feature', () => {
  it('creates a project with CI and security scanning wired in', async () => {
    const result = await forge(['new', 'svc', '--template', 'express-api', '--feature', 'ci', '--feature', 'scan', '--yes']);
    expect(result.code).toBe(EXIT.OK);
    expect(await exists('svc/.github/workflows/ci.yml')).toBe(true);
    expect(await read('svc/.github/workflows/scan.yml')).toContain('aquasecurity/trivy-action@');
    expect(result.stdout).toContain('+ create    .github/workflows/scan.yml');
  });
  it('honours --ci gitlab and reports an unknown feature with exit 5', async () => {
    expect((await forge(['new', 'svc', '--template', 'express-api', '--feature', 'ci', '--ci', 'gitlab', '--answer', 'docker=false', '--yes'])).code).toBe(EXIT.OK);
    expect(await exists('svc/.gitlab-ci.yml')).toBe(true);
    expect(await exists('svc/.github')).toBe(false);
    const unknown = await forge(['new', 'other', '--template', 'express-api', '--feature', 'nope', '--yes']);
    expect(unknown.code).toBe(EXIT.DEFINITION);
    expect(unknown.stderr).toContain('Available: ci, scan');
  });
  it('FORGE_CI picks the provider when no flag is given', async () => {
    await forge(['new', 'svc', '--template', 'express-api', '--feature', 'ci', '--yes', '--answer', 'docker=false'], { FORGE_CI: 'gitlab' });
    expect(await exists('svc/.gitlab-ci.yml')).toBe(true);
  });
});

describe('forge add', () => {
  const repo = async () => {
    await write('package.json', JSON.stringify({ name: 'legacy-app', engines: { node: '>=22' } }, null, 2));
    await write('pnpm-lock.yaml', 'lockfileVersion: 9');
    await write('src/index.ts', 'export {};\n');
  };

  it('adds features to an existing repo using what it detects, and is idempotent', async () => {
    await repo();
    const result = await forge(['add', 'ci', 'scan', '--yes']);
    expect(result.code).toBe(EXIT.OK);
    expect(await read('.github/workflows/ci.yml')).toContain('pnpm install --frozen-lockfile');
    expect(result.stdout).toContain('+ create');
    const again = await forge(['add', 'ci', 'scan', '--yes']);
    expect(again.code).toBe(EXIT.OK);
    expect(again.stderr).toContain('2 unchanged'.replace('2', '3'));
  });

  it('--dry-run writes nothing; --ci beats detection; unknown features exit 5', async () => {
    await repo();
    await write('.github/CODEOWNERS', '* @me');
    expect((await forge(['add', 'ci', '--yes', '--dry-run'])).code).toBe(EXIT.OK);
    expect(await exists('.github/workflows/ci.yml')).toBe(false);
    await forge(['add', 'ci', '--yes', '--ci', 'gitlab']);
    expect(await exists('.gitlab-ci.yml')).toBe(true);
    expect((await forge(['add', 'nope', '--yes'])).code).toBe(EXIT.DEFINITION);
  });

  it('exits 2 without a feature name and 4 when it would clobber a hand-written file', async () => {
    await repo();
    expect((await forge(['add'])).code).toBe(EXIT.USAGE);
    await write('.github/workflows/ci.yml', 'name: mine\n');
    const clash = await forge(['add', 'ci', '--yes']);
    expect(clash.code).toBe(EXIT.CONFLICT);
    expect(await read('.github/workflows/ci.yml')).toBe('name: mine\n');
  });
});

describe('forge doctor', () => {
  const insecure = async () => {
    await write('Dockerfile', 'FROM node\nCMD ["node","x"]\n');
    await write('.github/workflows/ci.yml', 'on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n');
  };

  it('exits 6 and explains each problem, with hints', async () => {
    await insecure();
    const result = await forge(['doctor']);
    expect(result.code).toBe(EXIT.DOCTOR);
    expect(result.stdout).toContain('error  supply-chain/actions-pinned  .github/workflows/ci.yml:5');
    expect(result.stdout).toContain('hint:');
    expect(result.stdout).toMatch(/\d+ errors?, \d+ warnings?/);
  });

  it('exits 0 for a clean generated project, and honours --fail-on warn', async () => {
    await forge(['new', 'svc', '--template', 'minimal', '--yes', '--answer', 'contributing=false']);
    expect((await forge(['doctor', '--cwd', 'svc'])).code).toBe(EXIT.OK);
    const strict = await forge(['doctor', '--cwd', 'svc', '--fail-on', 'warn']);
    expect(strict.code).toBe(EXIT.DOCTOR);
    expect(strict.stdout).toContain('ci/present');
    expect((await forge(['doctor', '--fail-on', 'nope'])).code).toBe(EXIT.USAGE);
  });

  it('--format json and --format sarif are machine-readable', async () => {
    await insecure();
    const json = JSON.parse((await forge(['doctor', '--format', 'json'])).stdout);
    expect(json.failed).toBe(true);
    expect(json.findings.map((f: { ruleId: string }) => f.ruleId)).toContain('docker/non-root');
    const sarif = JSON.parse((await forge(['doctor', '--format', 'sarif'])).stdout);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results.length).toBe(json.findings.length);
    expect((await forge(['list', '--format', 'sarif'])).code).toBe(EXIT.USAGE);
  });

  it('--rule and --skip narrow the run, and unknown rules exit 2', async () => {
    await insecure();
    const only = JSON.parse((await forge(['doctor', '--rule', 'docker/non-root', '--format', 'json'])).stdout);
    expect(only.findings.map((f: { ruleId: string }) => f.ruleId)).toEqual(['docker/non-root']);
    const skipped = JSON.parse((await forge(['doctor', '--skip', 'docker/non-root', '--format', 'json'])).stdout);
    expect(skipped.findings.map((f: { ruleId: string }) => f.ruleId)).not.toContain('docker/non-root');
    const bad = await forge(['doctor', '--rule', 'docker/typo']);
    expect(bad.code).toBe(EXIT.USAGE);
    expect(bad.stderr).toContain('Known rules:');
  });

  it('waivers from forge.config.json silence a rule but stay visible, with their reason', async () => {
    await insecure();
    await write('forge.config.json', JSON.stringify({ doctor: { waivers: [
      { rule: 'docker/non-root', reason: 'distroless image sets the user for us' },
      { rule: 'supply-chain/base-image-pinned', reason: 'pinned by the platform team admission policy' },
      { rule: 'supply-chain/actions-pinned', reason: 'temporary until the migration lands' },
      { rule: 'ci/permissions', reason: 'workflow only runs on trusted branches' },
      { rule: 'docker/typo', reason: 'a typo is reported, not ignored' },
    ] } }));
    const result = await forge(['doctor']);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain('waived: distroless image sets the user for us');
    expect(result.stdout).toContain('waiver for unknown rule "docker/typo"');
  });

  it('rejects a waiver that does not explain itself (exit 3)', async () => {
    await write('forge.config.json', JSON.stringify({ doctor: { waivers: [{ rule: 'docker/non-root', reason: 'no' }] } }));
    const result = await forge(['doctor']);
    expect(result.code).toBe(EXIT.CONFIG);
    expect(result.stderr).toContain('explain why');
  });

  it('--fix repairs, shows the plan, and a second run is clean; --dry-run only previews', async () => {
    await write('package.json', JSON.stringify({ name: 'x' }, null, 2));
    await write('README.md', 'x');
    await write('.gitignore', 'node_modules/\n');
    const preview = await forge(['doctor', '--fix', '--dry-run']);
    expect(preview.stdout).toContain('& merge');
    expect(await read('.gitignore')).toBe('node_modules/\n');
    const fixed = await forge(['doctor', '--fix', '--format', 'json']);
    expect(JSON.parse(fixed.stdout).fixed).toEqual(expect.arrayContaining(['.gitignore', 'package.json']));
    expect(JSON.parse(await read('package.json')).engines).toEqual({ node: '>=22' });
    const after = JSON.parse((await forge(['doctor', '--format', 'json'])).stdout);
    expect(after.findings.filter((f: { fixable: boolean }) => f.fixable)).toEqual([]);
  });

  it('--list-rules shows every rule', async () => {
    const text = (await forge(['doctor', '--list-rules'])).stdout;
    for (const rule of RULES) expect(text).toContain(rule.id);
    expect(JSON.parse((await forge(['doctor', '--list-rules', '--format', 'json'])).stdout).rules).toHaveLength(RULES.length);
  });

  it('config shows the doctor settings and where they came from', async () => {
    await write('forge.config.json', JSON.stringify({ doctor: { failOn: 'warn' } }));
    const json = JSON.parse((await forge(['config', '--format', 'json'])).stdout);
    expect(json.values.doctor.failOn).toBe('warn');
    expect(json.sources.doctor).toContain('forge.config.json');
  });
});
