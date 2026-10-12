import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/adapters/memory-fs.js';
import { nullLogger } from '../src/adapters/logger.js';
import { createProcessRunner, minimalEnv, resolveSpawn } from '../src/adapters/process-runner.js';
import { collectAnswers } from '../src/app/collect-answers.js';
import { runPostSteps } from '../src/app/post-steps.js';
import { resolveAnswers } from '../src/core/definition/answers.js';
import { parseManifest } from '../src/core/definition/manifest.js';
import { ConfigError, InterruptedError } from '../src/errors/index.js';
import { fakeRunner, ScriptedPrompter } from './helpers/fixtures.js';

const manifest = parseManifest(
  {
    id: 't', version: '1.0.0', kind: 'template', description: 'd',
    questions: [
      { id: 'lang', type: 'enum', message: 'Language', choices: ['ts', 'js'], default: 'ts' },
      { id: 'docker', type: 'boolean', message: 'Docker?', default: false },
      { id: 'image', type: 'string', message: 'Image', pattern: '^[a-z]+$', when: { answer: 'docker', equals: true } },
      { id: 'note', type: 'string', message: 'Note', required: false },
      { id: 'token', type: 'string', message: 'Token', secret: true },
    ],
  },
  'test',
);

describe('collectAnswers', () => {
  it('asks only what is missing, in order, skipping questions whose condition is false', async () => {
    const prompter = new ScriptedPrompter(['js', false, '', 's3cret']);
    const raw = await collectAnswers(manifest, {}, prompter);
    expect(prompter.asked).toEqual(['Language', 'Docker?', 'Note', 'Token']);
    expect(raw).toEqual({ lang: 'js', docker: false, token: 's3cret' });
    expect(resolveAnswers(manifest, raw, { useDefaults: false })).toEqual({ lang: 'js', docker: false, image: null, note: null, token: 's3cret' });
  });

  it('asks conditional questions when their condition holds, and honours supplied answers', async () => {
    const prompter = new ScriptedPrompter(['node', 'note text', 'tok']);
    const raw = await collectAnswers(manifest, { lang: 'ts', docker: true }, prompter);
    expect(prompter.asked).toEqual(['Image', 'Note', 'Token']);
    expect(raw).toMatchObject({ image: 'node', note: 'note text' });
  });

  it('re-asks invalid input up to three times, then gives up with the validation error', async () => {
    const retry = new ScriptedPrompter(['BAD', 'Worse1', 'good', '', 'tok']);
    await collectAnswers(manifest, { lang: 'ts', docker: true }, retry);
    expect(retry.warnings).toHaveLength(2);

    const hopeless = new ScriptedPrompter(['A', 'B', 'C']);
    await expect(collectAnswers(manifest, { lang: 'ts', docker: true }, hopeless)).rejects.toThrow(ConfigError);
    expect(hopeless.warnings).toHaveLength(2);
  });

  it('rejects invalid pre-supplied answers without prompting', async () => {
    const prompter = new ScriptedPrompter([]);
    await expect(collectAnswers(manifest, { lang: 'rust' }, prompter)).rejects.toThrow(ConfigError);
    expect(prompter.asked).toEqual([]);
  });

  it('propagates cancellation', async () => {
    await expect(collectAnswers(manifest, {}, new ScriptedPrompter(['CANCEL']))).rejects.toThrow(InterruptedError);
  });
});

describe('runPostSteps', () => {
  const setup = (files: Record<string, string> = { '/p/package.json': '{}' }) => {
    const fs = new MemoryFileSystem();
    fs.seed(files);
    return fs;
  };
  const deps = (fs: MemoryFileSystem, runner = fakeRunner()) => ({ fs, runner, logger: nullLogger });

  it('runs git init (preferring --initial-branch) and npm install', async () => {
    const runner = fakeRunner();
    const results = await runPostSteps(['git-init', 'install'], deps(setup(), runner), '/p');
    expect(results.map((r) => r.status)).toEqual(['done', 'done']);
    expect(runner.calls.map((c) => c.args)).toEqual([['init', '--initial-branch=main'], ['install', '--no-audit', '--no-fund']]);
  });

  it('falls back to plain git init for old git versions', async () => {
    const runner = fakeRunner((call) => (call.args.includes('--initial-branch=main') ? { code: 129, stderr: 'unknown option' } : {}));
    const results = await runPostSteps(['git-init'], deps(setup(), runner), '/p');
    expect(results[0]?.status).toBe('done');
    expect(runner.calls).toHaveLength(2);
  });

  it('skips git init in an existing repo and install without a package.json', async () => {
    const runner = fakeRunner();
    const results = await runPostSteps(['git-init', 'install'], deps(setup({ '/p/.git/HEAD': 'ref' }), runner), '/p');
    expect(results.map((r) => r.status)).toEqual(['skipped', 'skipped']);
    expect(runner.calls).toEqual([]);
  });

  it('reports failures with the tail of stderr, or a hint when the tool is missing', async () => {
    const noisy = fakeRunner(() => ({ code: 1, stderr: 'l1\nl2\nl3\nl4\nl5\nl6' }));
    const [failed] = await runPostSteps(['install'], deps(setup(), noisy), '/p');
    expect(failed).toEqual({ step: 'install', status: 'failed', detail: 'l3\nl4\nl5\nl6' });

    const missing = fakeRunner(() => ({ code: null }));
    const [absent] = await runPostSteps(['git-init'], deps(setup(), missing), '/p');
    expect(absent?.detail).toMatch(/installed/);
  });

  it('stops on interrupt', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runPostSteps(['install'], deps(setup()), '/p', controller.signal)).rejects.toThrow(InterruptedError);
  });
});

describe('process runner', () => {
  it('passes only an allow-listed environment to children', () => {
    const env = minimalEnv({ PATH: '/bin', HOME: '/h', npm_config_registry: 'r', AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 'y', NODE_OPTIONS: '--evil' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', npm_config_registry: 'r' });
  });

  it('runs a real program without a shell, capturing output and exit codes', async () => {
    const runner = createProcessRunner({ PATH: process.env['PATH'], SECRET_THING: 'leak' });
    const ok = await runner.run(process.execPath, ['-e', 'process.stdout.write(String(process.env.SECRET_THING)); process.stderr.write("e")'], { cwd: process.cwd() });
    expect(ok).toEqual({ code: 0, stdout: 'undefined', stderr: 'e' });
    const bad = await runner.run(process.execPath, ['-e', 'process.exit(3)'], { cwd: process.cwd() });
    expect(bad.code).toBe(3);
  });

  it('does not interpret shell metacharacters in arguments', async () => {
    const runner = createProcessRunner({ PATH: process.env['PATH'] });
    const result = await runner.run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo pwned); `id`'], { cwd: process.cwd() });
    expect(result.stdout).toBe('$(echo pwned); `id`');
  });

  it('returns code null for a missing program, and when aborted', async () => {
    const runner = createProcessRunner({ PATH: process.env['PATH'] });
    expect((await runner.run('definitely-not-a-real-binary-xyz', [], { cwd: process.cwd() })).code).toBeNull();
    const controller = new AbortController();
    const pending = runner.run(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { cwd: process.cwd(), signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect((await pending).code).toBeNull();
  });

  it('runs Windows package-manager shims through cmd.exe with a fixed argument list, and refuses metacharacters', () => {
  expect(resolveSpawn('npm', ['install', '--no-audit'], 'win32')).toEqual({
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npm', 'install', '--no-audit'],
  });
  expect(resolveSpawn('git', ['init'], 'win32')).toEqual({ file: 'git', args: ['init'] });
  expect(resolveSpawn('npm', ['install'], 'linux')).toEqual({ file: 'npm', args: ['install'] });
  for (const bad of ['a & calc', 'a|b', 'a>b', '%PATH%', 'a"b', 'a^b', 'a\nb']) {
    expect(() => resolveSpawn('npm', [bad], 'win32')).toThrow(/unsafe argument/);
  }
});
});
