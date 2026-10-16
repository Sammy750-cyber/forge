import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemClock } from '../src/adapters/clock.js';
import { createNodeFileSystem } from '../src/adapters/node-fs.js';
import { run, type CliIo } from '../src/cli/main.js';
import { DirectoryDefinitionSource } from '../src/core/definition/loader.js';
import type { Pins } from '../src/core/pipeline/pins.js';
import { EXIT } from '../src/errors/index.js';
import type { ProcessRunner, Prompter } from '../src/ports/index.js';
import { fakeRunner, PINS, REPO_ROOT, ScriptedPrompter } from './helpers/fixtures.js';

let tmp: string;
let defs: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-upd-'));
  defs = path.join(tmp, 'defs');
  // A private copy of the real templates and features that we can "release a new version" of.
  await fs.cp(path.join(REPO_ROOT, 'templates'), path.join(defs, 'templates'), { recursive: true });
  await fs.cp(path.join(REPO_ROOT, 'features'), path.join(defs, 'features'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'work'));
});
afterEach(async () => fs.rm(tmp, { recursive: true, force: true }));

const nodeFs = createNodeFileSystem();
async function forge(args: string[], extra: { pins?: Pins; runner?: ProcessRunner; prompter?: Prompter; env?: Record<string, string> } = {}) {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (t) => void (stdout += t), stderr: (t) => void (stderr += t),
    cwd: path.join(tmp, 'work'), env: { HOME: path.join(tmp, 'home'), ...extra.env }, isTTY: extra.prompter !== undefined,
  };
  const code = await run(args, io, {
    fs: nodeFs, clock: systemClock, forgeVersion: '1.2.3', pins: extra.pins ?? PINS, runner: extra.runner ?? fakeRunner(),
    templates: new DirectoryDefinitionSource(nodeFs, path.join(defs, 'templates'), 'template'),
    features: new DirectoryDefinitionSource(nodeFs, path.join(defs, 'features'), 'feature'),
    ...(extra.prompter === undefined ? {} : { prompter: extra.prompter }),
  });
  return { code, stdout, stderr };
}
const proj = (...p: string[]) => path.join(tmp, 'work', 'demo', ...p);
const read = (...p: string[]) => fs.readFile(proj(...p), 'utf8');
const write = async (rel: string, content: string) => fs.writeFile(proj(rel), content);
const exists = (...p: string[]) => fs.access(proj(...p)).then(() => true, () => false);
const cd = ['--cwd', 'demo'];

/** Publish "version 0.2.0" of the minimal template: a new README, and a new file. */
async function releaseMinimal(extra: { question?: boolean; version?: string } = {}) {
  const dir = path.join(defs, 'templates', 'minimal');
  const manifestPath = path.join(dir, 'forge.template.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.version = extra.version ?? '0.2.0';
  if (extra.question) manifest.questions.push({ id: 'badge', type: 'boolean', message: 'Add a build badge?', default: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await fs.appendFile(path.join(dir, 'files', 'README.md.hbs'), '\nSee CHANGELOG.md for what is new.\n');
  await fs.writeFile(path.join(dir, 'files', 'CHANGELOG.md'), '# Changes\n');
}
const create = () => forge(['new', 'demo', '--template', 'minimal', '--yes']);

describe('forge update (CLI)', () => {
  it('says so when there is nothing to do', async () => {
    await create();
    const result = await forge(['update', ...cd, '--yes']);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stderr).toContain('Already up to date (minimal 0.1.0)');
    expect(result.stdout).toBe('');
  });

  it('previews with --dry-run and applies for real, showing the version change and where backups went', async () => {
    await create();
    await releaseMinimal();
    const preview = await forge(['update', ...cd, '--dry-run']);
    expect(preview.code).toBe(EXIT.OK);
    expect(preview.stdout).toContain('minimal 0.1.0 -> 0.2.0');
    expect(preview.stdout).toContain('~ update    README.md');
    expect(preview.stdout).toContain('+ create    CHANGELOG.md');
    expect(preview.stderr).toMatch(/Would update 1, create 1/);
    expect(await exists('CHANGELOG.md')).toBe(false);

    const applied = await forge(['update', ...cd]);
    expect(applied.code).toBe(EXIT.OK);
    expect(await read('README.md')).toContain('See CHANGELOG.md');
    expect(await exists('CHANGELOG.md')).toBe(true);
    expect(applied.stderr).toMatch(/Updated 1, created 1/);
    expect(applied.stderr).toContain('.forge');
    expect(await forge(['update', ...cd])).toMatchObject({ code: EXIT.OK });
  });

  it('--check exits 8 when behind and 0 when current, and never writes', async () => {
    await create();
    expect((await forge(['update', ...cd, '--check'])).code).toBe(EXIT.OK);
    await releaseMinimal();
    const behind = await forge(['update', ...cd, '--check']);
    expect(behind.code).toBe(EXIT.OUTDATED);
    expect(behind.code).toBe(8);
    expect(await exists('CHANGELOG.md')).toBe(false);
    await forge(['update', ...cd]);
    expect((await forge(['update', ...cd, '--check'])).code).toBe(EXIT.OK);
  });

  it('--diff shows exactly what would change in a conflicting file', async () => {
    await create();
    await releaseMinimal();
    await write('README.md', 'my own readme\n');
    const result = await forge(['update', ...cd, '--dry-run', '--diff']);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain('! conflict  README.md  (you changed it and the template changed it)');
    expect(result.stdout).toContain('--- README.md (yours)');
    expect(result.stdout).toContain('+++ README.md (template)');
    expect(result.stdout).toContain('-my own readme');
  });

  it('exits 4 and changes nothing on a conflict; --partial applies the rest but still exits 4; --force takes the template', async () => {
    await create();
    await releaseMinimal();
    await write('README.md', 'my own readme\n');

    const refused = await forge(['update', ...cd]);
    expect(refused.code).toBe(EXIT.CONFLICT);
    expect(refused.stderr).toContain('README.md: you changed it and the template changed it');
    expect(refused.stderr).toContain('--partial');
    expect(await exists('CHANGELOG.md')).toBe(false);
    expect(await read('README.md')).toBe('my own readme\n');

    const partial = await forge(['update', ...cd, '--partial']);
    expect(partial.code).toBe(EXIT.CONFLICT);
    expect(await exists('CHANGELOG.md')).toBe(true);
    expect(await read('README.md')).toBe('my own readme\n');
    expect(partial.stdout).toContain('! conflict');

    const forced = await forge(['update', ...cd, '--force']);
    expect(forced.code).toBe(EXIT.OK);
    expect(forced.stderr).not.toContain('need your attention');
    expect(forced.stdout).toContain('~ update    README.md  (overwrites your changes');
    expect(await read('README.md')).toContain('See CHANGELOG.md');
    const backups = await fs.readdir(proj('.forge', 'backup'));
    // The --partial run made an earlier backup folder; the --force run's is the newest.
    expect(await fs.readFile(proj('.forge', 'backup', backups.at(-1) as string, 'README.md'), 'utf8')).toBe('my own readme\n');
  });

  it('--prune removes an untouched orphan; without it the file is only reported', async () => {
    await create();
    const dir = path.join(defs, 'templates', 'minimal');
    await fs.rm(path.join(dir, 'files', 'scripts', 'hello.sh.hbs'));
    await fs.writeFile(path.join(dir, 'forge.template.json'), JSON.stringify({ ...JSON.parse(await fs.readFile(path.join(dir, 'forge.template.json'), 'utf8')), version: '0.2.0', files: JSON.parse(await fs.readFile(path.join(dir, 'forge.template.json'), 'utf8')).files.filter((f: { path: string }) => f.path !== 'scripts/hello.sh.hbs') }));
    const reported = await forge(['update', ...cd]);
    expect(reported.stdout).toContain('? orphan    scripts/hello.sh');
    expect(reported.stderr).toContain('--prune removes them');
    expect(await exists('scripts', 'hello.sh')).toBe(true);
    const pruned = await forge(['update', ...cd, '--prune']);
    expect(pruned.code).toBe(EXIT.OK);
    expect(await exists('scripts', 'hello.sh')).toBe(false);
    expect(pruned.stderr).toMatch(/Deleted 1/);
    expect(pruned.stderr).not.toContain('--prune removes them');
  });

  it('--format json is complete and machine-readable', async () => {
    await create();
    await releaseMinimal();
    const json = JSON.parse((await forge(['update', ...cd, '--dry-run', '--format', 'json'])).stdout);
    expect(json).toMatchObject({ upToDate: false, dryRun: true, versions: [{ id: 'minimal', from: '0.1.0', to: '0.2.0' }], conflictsRemaining: 0 });
    expect(json.outcomes.map((o: { path: string; kind: string }) => `${o.kind}:${o.path}`)).toEqual(expect.arrayContaining(['update:README.md', 'create:CHANGELOG.md']));
    expect(json.counts.update).toBe(1);
    const applied = JSON.parse((await forge(['update', ...cd, '--format', 'json'])).stdout);
    expect(applied.applied.written).toEqual(expect.arrayContaining(['README.md', 'CHANGELOG.md', '.forge/state.json']));
  });

  it('refuses a downgrade (3), a missing template (5), and a non-Forge directory (2), with clear messages', async () => {
    await create();
    await releaseMinimal({ version: '0.5.0' });
    await forge(['update', ...cd]);
    await releaseMinimal({ version: '0.1.0' });
    const downgrade = await forge(['update', ...cd]);
    expect(downgrade.code).toBe(EXIT.CONFIG);
    expect(downgrade.stderr).toContain('would downgrade');
    expect(downgrade.stderr).toContain('code: FORGE_E_DOWNGRADE');

    await fs.rm(path.join(defs, 'templates', 'minimal'), { recursive: true });
    const missing = await forge(['update', ...cd]);
    expect(missing.code).toBe(EXIT.DEFINITION);
    expect(missing.stderr).toContain('does not provide it');

    await fs.mkdir(path.join(tmp, 'work', 'plain'));
    const plain = await forge(['update', '--cwd', 'plain']);
    expect(plain.code).toBe(EXIT.USAGE);
    expect(plain.stderr).toContain('forge add');
    expect(plain.stderr).toContain('code: FORGE_E_NOT_A_PROJECT');
  });

  it('a question added upstream: an error naming the flag without --yes, accepted with --yes or --answer, asked when interactive', async () => {
    await create();
    await releaseMinimal({ question: true });
    const missing = await forge(['update', ...cd]);
    expect(missing.code).toBe(EXIT.CONFIG);
    expect(missing.stderr).toContain('Missing answer "badge"');
    expect(missing.stderr).toContain('--answer badge=');
    expect((await forge(['update', ...cd, '--dry-run', '--yes'])).code).toBe(EXIT.OK);
    const prompter = new ScriptedPrompter([false]);
    const interactive = await forge(['update', ...cd], { prompter });
    expect(interactive.code).toBe(EXIT.OK);
    expect(prompter.asked).toEqual(['Add a build badge?']);
    expect(JSON.parse(await read('.forge', 'state.json')).answers.badge).toBe(false);
    expect((await forge(['update', ...cd, '--check'])).code).toBe(EXIT.OK);
  });

  it('--answer changes a decision and it is remembered', async () => {
    await create();
    const result = await forge(['update', ...cd, '--answer', 'contributing=true']);
    expect(result.code).toBe(EXIT.OK);
    expect(await exists('CONTRIBUTING.md')).toBe(true);
    expect((await forge(['update', ...cd, '--check'])).code).toBe(EXIT.OK);
  });

  it('warns about uncommitted changes when applying, but not when only previewing', async () => {
    await create();
    await fs.mkdir(proj('.git'));
    await releaseMinimal();
    const dirty = fakeRunner(() => ({ stdout: ' M src/index.ts\n' }));
    expect((await forge(['update', ...cd, '--dry-run'], { runner: dirty })).stderr).not.toContain('uncommitted');
    const warned = await forge(['update', ...cd], { runner: dirty });
    expect(warned.code).toBe(EXIT.OK);
    expect(warned.stderr).toContain('uncommitted changes');
  });
});

describe('forge update: what it tells you (found by running the real binary)', () => {
  it('does not nag about a file you customised, and still says "up to date"', async () => {
    await create();
    await write('README.md', 'my own readme\n');
    const quiet = await forge(['update', ...cd]);
    expect(quiet.stdout).not.toContain('keep');
    expect(quiet.stderr).toContain('Already up to date');
    expect(quiet.stderr).not.toMatch(/kept|Would \d/);
    const verbose = await forge(['update', ...cd, '--verbose']);
    expect(verbose.stdout).toContain('. keep      README.md');
    expect((await forge(['update', ...cd, '--check'])).code).toBe(EXIT.OK);
  });

  it('writes grammatical summaries in every combination', async () => {
    await create();
    await releaseMinimal();
    const dry = await forge(['update', ...cd, '--dry-run']);
    expect(dry.stderr).toMatch(/^Would update 1, create 1; \d+ unchanged\.$/m);
    const applied = await forge(['update', ...cd]);
    expect(applied.stderr).toMatch(/^Updated 1, created 1; \d+ unchanged\.$/m);
  });
});

describe('forge update on the real express-api template', () => {
  it('adopts a template improvement and refreshed pins, protects your edits, and the result still passes doctor', async () => {
    const created = await forge(['new', 'demo', '--template', 'express-api', '--feature', 'ci', '--feature', 'scan', '--yes']);
    expect(created.code).toBe(EXIT.OK);

    // Upstream: the Dockerfile gets better, and a new Forge release refreshes the pinned checkout action.
    const dockerfile = path.join(defs, 'templates', 'express-api', 'files', 'Dockerfile.hbs');
    await fs.writeFile(dockerfile, `${await fs.readFile(dockerfile, 'utf8')}# Rebuilt weekly to pick up base image fixes.\n`);
    const manifest = path.join(defs, 'templates', 'express-api', 'forge.template.json');
    await fs.writeFile(manifest, (await fs.readFile(manifest, 'utf8')).replace('"version": "0.1.0"', '"version": "0.2.0"'));
    const newSha = 'c'.repeat(40);
    const pins: Pins = { ...PINS, actions: { ...PINS.actions, 'actions/checkout': { version: 'v9.0.0', sha: newSha } } };

    // The user has customised src/app.ts, which upstream did not touch.
    await write('src/app.ts', `${await read('src/app.ts')}// our custom middleware goes here\n`);

    const result = await forge(['update', ...cd, '--verbose'], { pins });
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain('~ update    Dockerfile');
    expect(result.stdout).toContain('~ update    .github/workflows/ci.yml');
    expect(result.stdout).toContain('~ update    .github/workflows/scan.yml');
    expect(result.stdout).toContain('. keep      src/app.ts');
    expect(await read('Dockerfile')).toContain('Rebuilt weekly');
    expect(await read('.github', 'workflows', 'ci.yml')).toContain(`actions/checkout@${newSha} # v9.0.0`);
    expect(await read('src', 'app.ts')).toContain('// our custom middleware goes here');

    expect((await forge(['update', ...cd, '--check'], { pins })).code).toBe(EXIT.OK);
    const doctor = JSON.parse((await forge(['doctor', ...cd, '--format', 'json'], { pins })).stdout);
    expect(doctor.findings.filter((f: { severity: string }) => f.severity === 'error')).toEqual([]);
  });
});
