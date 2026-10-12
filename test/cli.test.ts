import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemClock } from '../src/adapters/clock.js';
import { createNodeFileSystem } from '../src/adapters/node-fs.js';
import { run, type CliIo } from '../src/cli/main.js';
import { EXIT } from '../src/errors/index.js';
import { BUILTIN_FEATURES, BUILTIN_TEMPLATES, canSymlink, fakeRunner, PINS, ScriptedPrompter } from './helpers/fixtures.js';
import type { ProcessRunner, Prompter } from '../src/ports/index.js';

const symlinkOk = await canSymlink();

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-cli-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function forge(
  args: string[],
  extra: { env?: Record<string, string>; signal?: AbortSignal; isTTY?: boolean; runner?: ProcessRunner; prompter?: Prompter } = {},
) {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    cwd: tmp,
    env: { HOME: path.join(tmp, 'home'), FORGE_TEMPLATE: 'minimal', ...extra.env },
    isTTY: extra.isTTY ?? false,
  };
  const code = await run(args, io, {
    fs: createNodeFileSystem(), clock: systemClock, templates: BUILTIN_TEMPLATES, features: BUILTIN_FEATURES, pins: PINS, forgeVersion: '9.9.9', runner: extra.runner ?? fakeRunner(),
    ...(extra.prompter === undefined ? {} : { prompter: extra.prompter }),
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
  });
  return { code, stdout, stderr };
}
const exists = (p: string) => fs.access(path.join(tmp, p)).then(() => true, () => false);

describe('forge CLI', () => {
  it('prints the version and help, exiting 0', async () => {
    expect(await forge(['--version'])).toMatchObject({ code: EXIT.OK, stdout: '9.9.9\n' });
    const help = await forge(['--help']);
    expect(help.code).toBe(EXIT.OK);
    expect(help.stdout).toContain('--dry-run');
    expect(help.stdout).toContain('new');
  });

  it('exits 2 for unknown commands and options', async () => {
    expect((await forge(['frobnicate'])).code).toBe(EXIT.USAGE);
    expect((await forge(['new', 'x', '--bogus'])).code).toBe(EXIT.USAGE);
    expect((await forge(['new'])).code).toBe(EXIT.USAGE);
    expect((await forge(['list', '--format', 'xml'])).code).toBe(EXIT.USAGE);
  });

  it('creates a project on the real filesystem and shows the plan on stdout', async () => {
    const result = await forge(['new', 'demo', '--yes']);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain('+ create');
    expect(result.stdout).not.toContain('.forge/state.json');
    expect(result.stderr).toContain('Created 6');
    expect(await exists('demo/README.md')).toBe(true);
    const mode = (await fs.stat(path.join(tmp, 'demo/scripts/hello.sh'))).mode & 0o777;
    expect(process.platform === 'win32' || (mode & 0o100) !== 0).toBe(true);
  });

  it('--dry-run writes nothing', async () => {
    const result = await forge(['new', 'demo', '--yes', '--dry-run']);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stderr).toContain('Would create');
    expect(await exists('demo')).toBe(false);
  });

  it('emits machine-readable JSON on stdout with --format json', async () => {
    const result = await forge(['new', 'demo', '--yes', '--format', 'json']);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.summary.create).toBe(6);
    expect(parsed.applied.written).toContain('README.md');
    // Bookkeeping is hidden from the plan view but reported honestly as written.
    expect(parsed.ops.map((o: { path: string }) => o.path)).not.toContain('.forge/state.json');
    expect(parsed.applied.written).toContain('.forge/state.json');
  });

  it('exits 3 with a hint when answers are missing and --yes is absent', async () => {
    const result = await forge(['new', 'demo']);
    expect(result.code).toBe(EXIT.CONFIG);
    expect(result.stderr).toMatch(/Missing answer "description"/);
    expect(result.stderr).toMatch(/hint: Pass --answer/);
    expect(result.stderr).toContain('code: FORGE_E_ANSWER_INVALID');
    expect(await exists('demo')).toBe(false);
  });

  it('accepts --answer, rejects malformed or repeated ones', async () => {
    expect((await forge(['new', 'demo', '--yes', '--answer', 'description=Hi there'])).code).toBe(EXIT.OK);
    expect(JSON.parse(await fs.readFile(path.join(tmp, 'demo/package.json'), 'utf8')).description).toBe('Hi there');
    expect((await forge(['new', 'x', '--answer', 'novalue'])).code).toBe(EXIT.USAGE);
    expect((await forge(['new', 'x', '--answer', 'a=1', '--answer', 'a=2'])).code).toBe(EXIT.USAGE);
  });

  it('exits 2 for invalid names and 5 for unknown templates', async () => {
    expect((await forge(['new', 'Bad_Name', '--yes'])).code).toBe(EXIT.USAGE);
    const unknown = await forge(['new', 'demo', '--yes', '--template', 'ghost']);
    expect(unknown.code).toBe(EXIT.DEFINITION);
    expect(unknown.stderr).toContain('Available: express-api, minimal');
  });

  it('is idempotent, and exits 4 on conflicts until --force', async () => {
    await forge(['new', 'demo', '--yes']);
    const again = await forge(['new', 'demo', '--yes']);
    expect(again.code).toBe(EXIT.OK);
    expect(again.stderr).toContain('unchanged');

    await fs.writeFile(path.join(tmp, 'demo/README.md'), 'mine\n');
    const conflict = await forge(['new', 'demo', '--yes']);
    expect(conflict.code).toBe(EXIT.CONFLICT);
    expect(conflict.stderr).toContain('README.md');
    expect(conflict.stderr).toContain('--force');
    expect(await fs.readFile(path.join(tmp, 'demo/README.md'), 'utf8')).toBe('mine\n');

    expect((await forge(['new', 'demo', '--yes', '--force'])).code).toBe(EXIT.OK);
    const backups = await fs.readdir(path.join(tmp, 'demo/.forge/backup'));
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(tmp, 'demo/.forge/backup', backups[0]!, 'README.md'), 'utf8')).toBe('mine\n');
  });

  it.skipIf(!symlinkOk)('refuses to write through a real symlink, even with --force', async () => {
    await fs.mkdir(path.join(tmp, 'outside'));
    await fs.mkdir(path.join(tmp, 'demo'));
    await fs.symlink(path.join(tmp, 'outside'), path.join(tmp, 'demo/src'));
    const result = await forge(['new', 'demo', '--yes', '--force']);
    expect(result.code).toBe(EXIT.CONFLICT);
    expect(await fs.readdir(path.join(tmp, 'outside'))).toEqual([]);
    expect((await fs.readdir(path.join(tmp, 'demo'))).sort()).toEqual(['src']);
  });

  it('exits 130 and leaves nothing behind when interrupted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await forge(['new', 'demo', '--yes'], { signal: controller.signal });
    expect(result.code).toBe(EXIT.INTERRUPTED);
    expect(await exists('demo')).toBe(false);
  });

  it('lists templates', async () => {
    expect((await forge(['list'])).stdout).toBe('express-api\nminimal\n');
    expect(JSON.parse((await forge(['list', '--format', 'json'])).stdout)).toEqual({ templates: ['express-api', 'minimal'] });
  });

  it('shows effective config with provenance across all layers', async () => {
    await fs.mkdir(path.join(tmp, 'home/forge'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'home/.config-unused'), '');
    await fs.mkdir(path.join(tmp, 'home/.config/forge'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'home/.config/forge/config.json'), '{"ci":"gitlab","cloud":"aws","bogus":1}');
    await fs.writeFile(path.join(tmp, 'forge.config.json'), '{"cloud":"gcp","logLevel":"warn"}');
    const result = await forge(['config', '--format', 'json', '--verbose'], { env: { FORGE_LOG_LEVEL: 'error' } });
    const { values, sources } = JSON.parse(result.stdout);
    expect(values).toMatchObject({ ci: 'gitlab', cloud: 'gcp', logLevel: 'debug', noInput: true });
    expect(sources.ci).toContain('config.json');
    expect(sources.cloud).toBe(path.join(tmp, 'forge.config.json'));
    expect(sources.logLevel).toBe('flags');
    expect(result.stderr).toContain('ignoring unknown key "bogus"');
  });

  it('reports invalid config with exit 3', async () => {
    await fs.writeFile(path.join(tmp, 'forge.config.json'), '{"ci":"jenkins"}');
    const result = await forge(['config']);
    expect(result.code).toBe(EXIT.CONFIG);
    expect(result.stderr).toContain('forge.config.json');
  });

  it('honours --cwd and rejects a missing --config file', async () => {
    await fs.mkdir(path.join(tmp, 'sub'));
    expect((await forge(['new', 'demo', '--yes', '--cwd', 'sub'])).code).toBe(EXIT.OK);
    expect(await exists('sub/demo/package.json')).toBe(true);
    expect((await forge(['config', '--config', 'nope.json'])).code).toBe(EXIT.USAGE);
  });

  it('prints stack traces only with --verbose', async () => {
    await fs.writeFile(path.join(tmp, 'forge.config.json'), '{not json');
    expect((await forge(['config'])).stderr).not.toContain('SyntaxError');
    expect((await forge(['config', '--verbose'])).stderr).toContain('SyntaxError');
  });
});


describe('forge new: interactive mode', () => {
  const tty = { isTTY: true };

  it('asks for the template and every answer, then creates the project', async () => {
    const prompter = new ScriptedPrompter(['minimal', 'Prompted description', 'none', true, false, false]);
    const result = await forge(['new', 'demo'], { ...tty, prompter, env: { FORGE_TEMPLATE: '' } });
    expect(result.code).toBe(EXIT.OK);
    expect(prompter.asked).toEqual([
      'Template',
      'One-line project description',
      'License',
      'Include a CONTRIBUTING.md?',
      'Initialize a git repository?',
      'Install dependencies with npm?',
    ]);
    expect(prompter.remaining).toBe(0);
    expect(JSON.parse(await fs.readFile(path.join(tmp, 'demo/package.json'), 'utf8')).description).toBe('Prompted description');
    expect(await exists('demo/LICENSE')).toBe(false);
    expect(await exists('demo/CONTRIBUTING.md')).toBe(true);
  });

  it('does not ask for answers already given by flags, and --yes disables prompting entirely', async () => {
    const prompter = new ScriptedPrompter(['none', false, false, false]);
    await forge(['new', 'a', '--answer', 'description=Given'], { ...tty, prompter });
    expect(prompter.asked).not.toContain('One-line project description');

    const silent = new ScriptedPrompter([]);
    expect((await forge(['new', 'b', '--yes'], { ...tty, prompter: silent })).code).toBe(EXIT.OK);
    expect(silent.asked).toEqual([]);
    const noInput = new ScriptedPrompter([]);
    // --no-input means "fail rather than ask".
    expect((await forge(['new', 'c', '--no-input'], { ...tty, prompter: noInput })).code).toBe(EXIT.CONFIG);
    expect(noInput.asked).toEqual([]);
  });

  it('exits 130 and writes nothing when the user cancels', async () => {
    const result = await forge(['new', 'demo'], { ...tty, prompter: new ScriptedPrompter(['CANCEL']) });
    expect(result.code).toBe(EXIT.INTERRUPTED);
    expect(await exists('demo')).toBe(false);
  });

  it('re-asks when an answer is invalid and explains why', async () => {
    const prompter = new ScriptedPrompter(['99999', 'abc', '8080', true, 'MIT', false, false]);
    const result = await forge(['new', 'svc', '--template', 'express-api', '--answer', 'description=x'], { ...tty, prompter });
    expect(result.code).toBe(EXIT.OK);
    expect(prompter.warnings).toHaveLength(2);
    expect(prompter.warnings[0]).toContain('pattern');
    expect(await fs.readFile(path.join(tmp, 'svc/.env.example'), 'utf8')).toContain('PORT=8080');
  });
});

describe('forge new: post steps', () => {
  it('runs git init then npm install, in that order, inside the project', async () => {
    const runner = fakeRunner();
    const result = await forge(['new', 'demo', '--yes', '--git', '--install'], { runner });
    expect(result.code).toBe(EXIT.OK);
    expect(runner.calls.map((c) => [c.command, ...c.args].join(' '))).toEqual(['git init --initial-branch=main', 'npm install --no-audit --no-fund']);
    expect(runner.calls.every((c) => c.cwd === path.join(tmp, 'demo'))).toBe(true);
    expect(result.stderr).toContain('Ran: git init');
    expect(result.stderr).toContain('Next: cd demo\n');
  });

  it('does nothing extra by default, and suggests npm install', async () => {
    const runner = fakeRunner();
    const result = await forge(['new', 'demo', '--yes'], { runner });
    expect(runner.calls).toEqual([]);
    expect(result.stderr).toContain('Next: cd demo && npm install');
  });

  it('reports a failing step without failing the command, and says how to retry', async () => {
    const runner = fakeRunner((call) => (call.command === 'npm' ? { code: 1, stderr: 'network down' } : {}));
    const result = await forge(['new', 'demo', '--yes', '--install'], { runner });
    expect(result.code).toBe(EXIT.OK);
    expect(await exists('demo/package.json')).toBe(true);
    expect(result.stderr).toContain('npm install failed');
    expect(result.stderr).toContain('network down');
    expect(result.stderr).toContain('Run it yourself: cd demo && npm install');
  });

  it('on dry runs, nothing is executed and the steps are shown as planned', async () => {
    const runner = fakeRunner();
    const text = await forge(['new', 'demo', '--yes', '--dry-run', '--git', '--install'], { runner });
    expect(runner.calls).toEqual([]);
    expect(text.stderr).toContain('Would run: git init');
    const json = JSON.parse((await forge(['new', 'demo', '--yes', '--dry-run', '--git', '--format', 'json'], { runner })).stdout);
    expect(json.postSteps).toEqual([{ step: 'git-init', status: 'planned' }]);
  });

  it('does not run steps when creation fails', async () => {
    await forge(['new', 'demo', '--yes']);
    await fs.writeFile(path.join(tmp, 'demo/README.md'), 'mine\n');
    const runner = fakeRunner();
    expect((await forge(['new', 'demo', '--yes', '--git'], { runner })).code).toBe(EXIT.CONFLICT);
    expect(runner.calls).toEqual([]);
  });

  it('a real git init works, and is skipped when the repo already exists', async () => {
    const { createProcessRunner } = await import('../src/adapters/process-runner.js');
    const runner = createProcessRunner(process.env);
    const probe = await runner.run('git', ['--version'], { cwd: tmp });
    if (probe.code !== 0) return;
    expect((await forge(['new', 'demo', '--yes', '--git'], { runner })).code).toBe(EXIT.OK);
    expect(await exists('demo/.git/HEAD')).toBe(true);
    const again = await forge(['new', 'demo', '--yes', '--git'], { runner });
    expect(again.stderr).toContain('already a git repository');
  });
});
