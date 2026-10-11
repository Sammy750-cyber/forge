import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/adapters/memory-fs.js';
import { fixedClock } from '../src/adapters/clock.js';
import { nullLogger } from '../src/adapters/logger.js';
import { newProject, type NewProjectRequest } from '../src/app/new-project.js';
import { DirectoryDefinitionSource } from '../src/core/definition/loader.js';
import { readState } from '../src/core/state/state.js';
import { ConfigError, ConflictError, DefinitionError, FsError, InterruptedError, UsageError } from '../src/errors/index.js';
import type { FileSystem } from '../src/ports/index.js';
import { BUILTIN_FEATURES, BUILTIN_TEMPLATES, depsFor, faultyFs, seedTemplate } from './helpers/fixtures.js';

const TARGET = '/work/demo';
const request = (extra: Partial<NewProjectRequest> = {}): NewProjectRequest => ({
  name: 'demo', templateId: 'minimal', targetDir: TARGET, answers: {}, useDefaults: true, dryRun: false, force: false, ...extra,
});

describe('newProject with the built-in minimal template', () => {
  it('creates the project, records state, and keeps secrets out', async () => {
    const fs = new MemoryFileSystem();
    const result = await newProject(depsFor(fs), request({ answers: { description: 'Hello "quoted" world' } }));
    expect(result.applied?.written).toContain('README.md');
    expect(JSON.parse(fs.text(`${TARGET}/package.json`)).description).toBe('Hello "quoted" world');
    expect(fs.text(`${TARGET}/src/demo.ts`)).toBe('export const projectName = "demo";\n');
    expect(fs.text(`${TARGET}/.gitignore`)).toContain('.forge/backup/');
    expect(fs.mode(`${TARGET}/scripts/hello.sh`)).toBe(0o755);
    const state = await readState(fs, TARGET);
    expect(state?.template).toEqual({ id: 'minimal', version: '0.1.0' });
    expect(Object.keys(state?.files ?? {})).toContain('LICENSE');
    expect(state?.files).not.toHaveProperty('CONTRIBUTING.md');
  });

  it('INVARIANT 1, idempotency: the second run plans nothing and touches nothing', async () => {
    const fs = new MemoryFileSystem();
    await newProject(depsFor(fs), request());
    const before = fs.snapshot();
    const again = await newProject(depsFor(fs, '2030-01-01T00:00:00Z'), request());
    expect(again.applied).toBeNull();
    expect(again.plan.ops.filter((o) => o.kind === 'create' || o.kind === 'update' || o.kind === 'conflict')).toEqual([]);
    expect(fs.snapshot()).toEqual(before);
  });

  it('INVARIANT 2, determinism: identical inputs give byte-identical trees at different places and times', async () => {
    const a = new MemoryFileSystem();
    const b = new MemoryFileSystem();
    await newProject(depsFor(a, '2026-01-01T00:00:00Z'), request({ targetDir: '/one/demo' }));
    await newProject(depsFor(b, '2031-06-06T06:06:06Z'), request({ targetDir: '/two/demo' }));
    const strip = (snap: Record<string, string>, prefix: string) =>
      Object.fromEntries(Object.entries(snap).filter(([k]) => k.startsWith(prefix) && k !== prefix).map(([k, v]) => [k.slice(prefix.length), v]));
    expect(strip(a.snapshot(), '/one/demo')).toEqual(strip(b.snapshot(), '/two/demo'));
  });

  it('INVARIANT 3, containment: nothing is written outside the target directory', async () => {
    const fs = new MemoryFileSystem();
    fs.seed({ '/work/other/keep.txt': 'untouched', '/work/neighbour': 'x' });
    const before = fs.snapshot();
    await newProject(depsFor(fs), request());
    const after = fs.snapshot();
    for (const key of Object.keys(after)) {
      if (!(key in before)) expect(key === '/work' || key === TARGET || key.startsWith(`${TARGET}/`), key).toBe(true);
    }
    expect(after['/work/other/keep.txt']).toBe(before['/work/other/keep.txt']);
  });

  it('INVARIANT 4, atomicity: failure at any mutation leaves the filesystem as it was', async () => {
    const counted = faultyFs(new MemoryFileSystem(), 0);
    await newProject(depsFor(counted), request());
    const total = counted.mutations;
    expect(total).toBeGreaterThan(10);
    for (let failAt = 1; failAt <= total; failAt += 1) {
      const mem = new MemoryFileSystem();
      const before = mem.snapshot();
      await expect(newProject(depsFor(faultyFs(mem, failAt)), request()), `failAt ${failAt}`).rejects.toThrow(FsError);
      expect(mem.snapshot(), `failAt ${failAt}`).toEqual(before);
    }
  });

  it('a pre-aborted signal (Ctrl-C) leaves nothing behind', async () => {
    const fs = new MemoryFileSystem();
    const controller = new AbortController();
    controller.abort();
    await expect(newProject(depsFor(fs), request({ signal: controller.signal }))).rejects.toThrow(InterruptedError);
    expect(await fs.lstat(TARGET)).toBeNull();
  });

  it('dry run writes nothing but returns the full plan', async () => {
    const fs = new MemoryFileSystem();
    const before = fs.snapshot();
    const result = await newProject(depsFor(fs), request({ dryRun: true }));
    expect(result.dryRun).toBe(true);
    expect(result.plan.ops.filter((o) => o.kind === 'create').length).toBeGreaterThan(5);
    expect(fs.snapshot()).toEqual(before);
  });

  it('applies conditional files and enum answers', async () => {
    const fs = new MemoryFileSystem();
    await newProject(depsFor(fs), request({ answers: { license: 'none', contributing: 'true' } }));
    expect(await fs.lstat(`${TARGET}/LICENSE`)).toBeNull();
    expect(fs.text(`${TARGET}/CONTRIBUTING.md`)).toContain('# Contributing to demo');
  });

  it('updates pristine generated files when answers change, with backups, and no conflict', async () => {
    const fs = new MemoryFileSystem();
    await newProject(depsFor(fs), request({ answers: { description: 'first' } }));
    const result = await newProject(depsFor(fs), request({ answers: { description: 'second' } }));
    expect(result.plan.ops.filter((o) => o.kind === 'update' && !o.internal).map((o) => o.path).sort()).toEqual(['README.md', 'package.json', 'scripts/hello.sh']);
    expect(fs.text(`${TARGET}/README.md`)).toContain('second');
    expect(fs.text(`${result.applied?.backupDir}/README.md`)).toContain('first');
  });

  it('CONFLICT FLOW: protects user edits, then --force overwrites with a backup and converges', async () => {
    const fs = new MemoryFileSystem();
    await newProject(depsFor(fs), request());
    await fs.writeFile(`${TARGET}/README.md`, new TextEncoder().encode('my own words\n'));
    const edited = fs.snapshot();

    await expect(newProject(depsFor(fs), request({ answers: { description: 'changed' } }))).rejects.toThrow(ConflictError);
    expect(fs.snapshot()).toEqual(edited);

    const forced = await newProject(depsFor(fs), request({ answers: { description: 'changed' }, force: true }));
    expect(fs.text(`${forced.applied?.backupDir}/README.md`)).toBe('my own words\n');
    expect(fs.text(`${TARGET}/README.md`)).toContain('changed');
    expect(forced.plan.ops.some((o) => o.kind === 'conflict')).toBe(false);

    const settled = fs.snapshot();
    const again = await newProject(depsFor(fs), request({ answers: { description: 'changed' } }));
    expect(again.applied).toBeNull();
    expect(fs.snapshot()).toEqual(settled);
  });

  it('refuses a non-empty directory unless forced, and a file in place of the directory', async () => {
    const fs = new MemoryFileSystem();
    fs.seed({ [`${TARGET}/notes.txt`]: 'mine' });
    await expect(newProject(depsFor(fs), request())).rejects.toMatchObject({ code: 'FORGE_E_NOT_EMPTY' });
    await newProject(depsFor(fs), request({ force: true }));
    expect(fs.text(`${TARGET}/notes.txt`)).toBe('mine');

    const fs2 = new MemoryFileSystem();
    fs2.seed({ [TARGET]: 'i am a file' });
    await expect(newProject(depsFor(fs2), request())).rejects.toThrow(ConflictError);
  });

  it('even --force cannot write through a symlink', async () => {
    const fs = new MemoryFileSystem();
    fs.seed({ '/secrets/id_rsa': 'KEY' });
    await fs.mkdir(TARGET);
    fs.symlink(`${TARGET}/src`, '/secrets');
    const before = fs.snapshot();
    await expect(newProject(depsFor(fs), request({ force: true }))).rejects.toMatchObject({ code: 'FORGE_E_BLOCKED_PATH' });
    expect(fs.snapshot()).toEqual(before);
    expect(fs.text('/secrets/id_rsa')).toBe('KEY');
  });

  it('validates names, templates and answers before touching disk', async () => {
    const fs = new MemoryFileSystem();
    for (const name of ['', 'Upper', '-lead', '../x', 'a b', 'x'.repeat(215)]) {
      await expect(newProject(depsFor(fs), request({ name }))).rejects.toThrow(UsageError);
    }
    await expect(newProject(depsFor(fs), request({ templateId: 'ghost' }))).rejects.toThrow(DefinitionError);
    await expect(newProject(depsFor(fs), request({ answers: { nope: 'x' } }))).rejects.toThrow(ConfigError);
    await expect(newProject(depsFor(fs), request({ answers: { license: 'GPL' } }))).rejects.toThrow(ConfigError);
    await expect(newProject(depsFor(fs), request({ useDefaults: false }))).rejects.toThrow(/Missing answer/);
    expect(fs.snapshot()).toEqual(new MemoryFileSystem().snapshot());
  });

  it('every built-in template renders with defaults and is idempotent', async () => {
    const ids = await BUILTIN_TEMPLATES.list();
    expect(ids).toContain('minimal');
    for (const templateId of ids) {
      const fs = new MemoryFileSystem();
      await newProject(depsFor(fs), request({ templateId }));
      const snapshot = fs.snapshot();
      expect((await newProject(depsFor(fs), request({ templateId }))).applied, templateId).toBeNull();
      expect(fs.snapshot(), templateId).toEqual(snapshot);
    }
  });
});

describe('newProject with hostile definitions', () => {
  const run = async (manifest: Record<string, unknown>, files: Record<string, string>, answers: NewProjectRequest['answers'] = {}) => {
    const tpl = new MemoryFileSystem();
    seedTemplate(tpl, 'evil', manifest, files);
    const fs: FileSystem = new MemoryFileSystem();
    const before = (fs as MemoryFileSystem).snapshot();
    const outcome = newProject(
      { fs, templates: new DirectoryDefinitionSource(tpl, '/tpl', 'template'), features: BUILTIN_FEATURES, clock: fixedClock('2026-01-01T00:00:00Z'), logger: nullLogger, forgeVersion: 't' },
      request({ templateId: 'evil', answers }),
    );
    return { outcome, fs: fs as MemoryFileSystem, before };
  };

  it('blocks traversal smuggled through an answer used in a path', async () => {
    const { outcome, fs, before } = await run({ questions: [{ id: 'dir', type: 'string', message: 'd' }] }, { '{{dir}}/x.txt': 'x' }, { dir: '../../etc' });
    await expect(outcome).rejects.toMatchObject({ code: 'FORGE_E_PATH_UNSAFE' });
    expect(fs.snapshot()).toEqual(before);
  });

  it('refuses a template that tries to write into .git or .forge', async () => {
    for (const path of ['_dot_git/hooks/pre-commit', '_dot_forge/state.json']) {
      const { outcome, fs, before } = await run({}, { [path]: '#!/bin/sh\nrm -rf ~' });
      await expect(outcome).rejects.toMatchObject({ code: 'FORGE_E_PATH_UNSAFE' });
      expect(fs.snapshot()).toEqual(before);
    }
  });

  it('cannot execute code: unknown helpers and constructor tricks fail at render time', async () => {
    const payloads = ['{{#with "x"}}{{constructor.constructor "return process"}}{{/with}}', '{{exec "id"}}', '{{{{raw}}}}{{{{/raw}}}}{{__proto__}}'];
    for (const payload of payloads) {
      const { outcome, fs, before } = await run({}, { 'a.txt.hbs': payload });
      await expect(outcome).rejects.toThrow(DefinitionError);
      expect(fs.snapshot()).toEqual(before);
    }
  });
});
