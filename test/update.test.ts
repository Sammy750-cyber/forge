import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '../src/adapters/clock.js';
import { nullLogger } from '../src/adapters/logger.js';
import { MemoryFileSystem } from '../src/adapters/memory-fs.js';
import { addFeatures } from '../src/app/add-features.js';
import { newProject } from '../src/app/new-project.js';
import { isWorkingTreeDirty, prepareUpdate, runUpdate, type UpdateDeps, type UpdateRequest } from '../src/app/update-project.js';
import { DirectoryDefinitionSource } from '../src/core/definition/loader.js';
import { readState } from '../src/core/state/state.js';
import { ConfigError, ConflictError, DefinitionError, FsError, UsageError } from '../src/errors/index.js';
import type { FileSystem } from '../src/ports/index.js';
import { BUILTIN_FEATURES, fakeRunner, faultyFs, PINS, seedTemplate } from './helpers/fixtures.js';

const ROOT = '/work/app';
const posix = (p: string): string => p.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/|$)/, '');

interface Spec {
  readonly version: string;
  readonly files: Record<string, string>;
  readonly questions?: Record<string, unknown>[];
  readonly rules?: Record<string, unknown>[];
}
const QUESTIONS = [
  { id: 'greeting', type: 'string', message: 'Greeting', default: 'hello' },
  { id: 'docker', type: 'boolean', message: 'Docker?', default: false },
];
const RULES = [
  { path: 'LICENSE', mergeStrategy: 'none' },
  { path: '_dot_gitignore', mergeStrategy: 'line-set' },
  { path: 'Dockerfile', when: { answer: 'docker', equals: true } },
];
const V1: Spec = {
  version: '1.0.0',
  files: {
    'README.md': 'readme v1', 'config.json': '{"a":1}', 'src/app.ts.hbs': 'export const greeting = {{json greeting}};\nexport const v = 1;',
    'docs/notes.md': 'notes v1', LICENSE: 'license v1', _dot_gitignore: 'node_modules/', Dockerfile: 'FROM node:22-slim\nUSER node',
  },
};
const V2: Spec = {
  version: '1.1.0',
  files: {
    'README.md': 'readme v2', 'config.json': '{"a":1}', 'src/app.ts.hbs': 'export const greeting = {{json greeting}};\nexport const v = 2;',
    LICENSE: 'license v2', _dot_gitignore: 'node_modules/\ndist/', Dockerfile: 'FROM node:22-slim\nUSER node\nHEALTHCHECK CMD true', 'CHANGELOG.md': 'changes',
  },
};

class World {
  readonly tpl = new MemoryFileSystem();
  readonly fs = new MemoryFileSystem();
  pins = PINS;
  forgeVersion = '1.0.0';
  features: string[] = [];

  async publish(spec: Spec): Promise<void> {
    await this.tpl.remove('/tpl/app', { recursive: true });
    seedTemplate(this.tpl, 'app', { version: spec.version, questions: spec.questions ?? QUESTIONS, files: spec.rules ?? RULES }, spec.files);
  }
  deps(fs: FileSystem = this.fs): UpdateDeps {
    return {
      fs, templates: new DirectoryDefinitionSource(this.tpl, '/tpl', 'template'), features: BUILTIN_FEATURES, pins: this.pins,
      clock: fixedClock('2026-10-10T12:00:00Z'), logger: nullLogger, forgeVersion: this.forgeVersion,
    };
  }
  async create(answers: Record<string, string | boolean> = {}, root = ROOT, fs: FileSystem = this.fs): Promise<void> {
    await newProject(this.deps(fs), { name: 'app', templateId: 'app', features: this.features, targetDir: root, answers, useDefaults: true, dryRun: false, force: false });
  }
  async update(extra: Partial<UpdateRequest> = {}, root = ROOT, fs: FileSystem = this.fs) {
    const deps = this.deps(fs);
    return runUpdate(deps, await prepareUpdate(deps, root), { answers: {}, useDefaults: true, dryRun: false, diff: false, partial: false, force: false, prune: false, ...extra });
  }
  async edit(file: string, content: string): Promise<void> {
    await this.fs.writeFile(`${ROOT}/${file}`, new TextEncoder().encode(content));
  }
  kinds(result: Awaited<ReturnType<World['update']>>): Record<string, string> {
    return Object.fromEntries(result.outcomes.map((o) => [o.path, o.kind]));
  }
}
const world = async (spec: Spec = V1): Promise<World> => {
  const w = new World();
  await w.publish(spec);
  await w.create();
  return w;
};

describe('forge update: the basics', () => {
  it('does nothing when nothing changed, and leaves every byte alone', async () => {
    const w = await world();
    const before = w.fs.snapshot();
    const result = await w.update();
    expect(result.upToDate).toBe(true);
    expect(result.applied).toBeNull();
    expect(w.fs.snapshot()).toEqual(before);
  });

  it('adopts upstream changes to untouched files, keeping the rest', async () => {
    const w = await world();
    await w.publish(V2);
    const result = await w.update();
    expect(w.kinds(result)).toMatchObject({
      'README.md': 'update', 'src/app.ts': 'update', 'config.json': 'unchanged', 'CHANGELOG.md': 'create',
      LICENSE: 'keep', '.gitignore': 'merge', 'docs/notes.md': 'orphan',
    });
    expect(w.fs.text(`${ROOT}/README.md`)).toBe('readme v2\n');
    expect(w.fs.text(`${ROOT}/src/app.ts`)).toContain('v = 2');
    expect(w.fs.text(`${ROOT}/LICENSE`)).toBe('license v1\n'); // create-only: never updated
    expect(w.fs.text(`${ROOT}/.gitignore`)).toContain('dist/');
    expect(w.fs.text(`${ROOT}/docs/notes.md`)).toBe('notes v1\n'); // orphans are reported, not deleted
    expect(result.versions).toEqual([{ id: 'app', kind: 'template', from: '1.0.0', to: '1.1.0' }]);
    expect(posix(result.applied?.backupDir ?? '')).toContain('.forge/backup/');
    expect(w.fs.text(`${result.applied?.backupDir}/README.md`)).toBe('readme v1\n');
    const state = await readState(w.fs, ROOT);
    expect(state?.template).toEqual({ id: 'app', version: '1.1.0' });
  });

  it('U3 IDEMPOTENT: a second update changes nothing', async () => {
    const w = await world();
    await w.publish(V2);
    await w.update();
    const settled = w.fs.snapshot();
    const again = await w.update();
    expect(again.applied).toBeNull();
    expect(again.outcomes.filter((o) => ['create', 'update', 'merge', 'conflict'].includes(o.kind))).toEqual([]);
    expect(w.fs.snapshot()).toEqual(settled);
  });

  it('U1 CONVERGENCE: an untouched project, updated, matches a fresh project at the new version (for files Forge owns)', async () => {
    const updated = await world();
    await updated.publish(V2);
    await updated.update({ prune: true });

    const fresh = new World();
    await fresh.publish(V2);
    await fresh.create();

    // Files only: pruning leaves emptied directories in place by design. Create-only (LICENSE) and merged
    // (.gitignore) files are shared with the user, so they are not expected to match a fresh project.
    const owned = (snap: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(snap).filter(([k, v]) => !v.startsWith('dir ') && !k.includes('/.forge/backup') && !k.endsWith('/.forge/state.json') && !k.endsWith('/LICENSE') && !k.endsWith('/.gitignore')),
      );
    const a = owned(updated.fs.snapshot());
    const b = owned(fresh.fs.snapshot());
    expect(a).toEqual(b);

    // The recorded state matches too, except for the one create-only file that was (correctly) not updated.
    const stateOf = async (w: World) => {
      const state = (await readState(w.fs, ROOT)) as NonNullable<Awaited<ReturnType<typeof readState>>>;
      const { LICENSE, ...files } = state.files;
      return { state: { ...state, files }, license: LICENSE };
    };
    const [u, f] = [await stateOf(updated), await stateOf(fresh)];
    expect(u.state).toEqual(f.state);
    expect(u.license).not.toBe(f.license);
  });

  it('is driven by CONTENT, not version numbers: same version, changed file, still updated', async () => {
    const w = await world();
    await w.publish({ ...V1, files: { ...V1.files, 'README.md': 'readme v1b' } });
    const result = await w.update();
    expect(result.versions[0]).toMatchObject({ from: '1.0.0', to: '1.0.0' });
    expect(w.kinds(result)['README.md']).toBe('update');
    expect(w.fs.text(`${ROOT}/README.md`)).toBe('readme v1b\n');
  });

  it('a new Forge release with refreshed pins updates generated workflows without any template change', async () => {
    const w = new World();
    await w.publish(V1);
    w.features = ['ci'];
    await w.create();
    const workflow = `${ROOT}/.github/workflows/ci.yml`;
    const before = w.fs.text(workflow);
    const newSha = 'f'.repeat(40);
    w.pins = { ...PINS, actions: { ...PINS.actions, 'actions/checkout': { version: 'v9.9.9', sha: newSha } } };
    w.forgeVersion = '1.0.1';
    const result = await w.update();
    expect(w.kinds(result)['.github/workflows/ci.yml']).toBe('update');
    expect(w.fs.text(workflow)).toContain(`actions/checkout@${newSha} # v9.9.9`);
    expect(w.fs.text(workflow)).not.toBe(before);
    expect((await readState(w.fs, ROOT))?.forgeVersion).toBe('1.0.1');
  });

  it('recording a newer Forge version alone is not "outdated", but is still written', async () => {
    const w = await world();
    w.forgeVersion = '1.0.1';
    const result = await w.update();
    expect(result.upToDate).toBe(true);
    expect(result.applied?.written).toEqual(['.forge/state.json']);
    expect((await w.update()).applied).toBeNull();
  });

  it('--dry-run writes nothing and can show diffs for what would change', async () => {
    const w = await world();
    await w.publish(V2);
    await w.edit('docs/notes.md', 'my notes');
    const before = w.fs.snapshot();
    const result = await w.update({ dryRun: true, diff: true });
    expect(result.dryRun).toBe(true);
    expect(result.applied).toBeNull();
    expect(w.fs.snapshot()).toEqual(before);
    const readme = result.outcomes.find((o) => o.path === 'README.md');
    expect(readme?.diff).toContain('-readme v1');
    expect(readme?.diff).toContain('+readme v2');
    expect(readme?.diff).toContain('README.md (yours)');
  });
});

describe('conflicts', () => {
  const conflicted = async () => {
    const w = await world();
    await w.publish(V2);
    await w.edit('README.md', 'my own readme');
    await w.edit('config.json', '{"a":2}');
    return w;
  };

  it('the default is to refuse, say exactly why, and touch nothing', async () => {
    const w = await conflicted();
    const before = w.fs.snapshot();
    await expect(w.update()).rejects.toThrow(ConflictError);
    await expect(w.update()).rejects.toThrow(/README\.md: you changed it and the template changed it/);
    await expect(w.update()).rejects.toMatchObject({ hint: expect.stringContaining('--diff') });
    expect(w.fs.snapshot()).toEqual(before);
  });

  it('a file you changed that upstream did NOT change is silently kept, and is not a conflict', async () => {
    const w = await conflicted();
    const result = await w.update({ partial: true });
    expect(w.kinds(result)['config.json']).toBe('keep');
    expect(w.fs.text(`${ROOT}/config.json`)).toBe('{"a":2}');
  });

  it('--partial applies what is safe, leaves conflicts byte-for-byte, and keeps reporting them', async () => {
    const w = await conflicted();
    const result = await w.update({ partial: true });
    expect(result.conflictsRemaining).toBe(1);
    expect(w.fs.text(`${ROOT}/README.md`)).toBe('my own readme');
    expect(w.fs.text(`${ROOT}/src/app.ts`)).toContain('v = 2');
    const state = await readState(w.fs, ROOT);
    expect(state?.files['README.md']).not.toBe(undefined);
    const again = await w.update({ partial: true });
    expect(w.kinds(again)['README.md']).toBe('conflict');
    expect(again.applied).toBeNull(); // stable: nothing more to write
  });

  it('after you merge by hand so the file equals the template, it converges and the hash advances', async () => {
    const w = await conflicted();
    await w.update({ partial: true });
    await w.edit('README.md', 'readme v2\n');
    const result = await w.update();
    expect(w.kinds(result)['README.md']).toBe('converged');
    expect(result.conflictsRemaining).toBe(0);
    expect(w.fs.text(`${ROOT}/README.md`)).toBe('readme v2\n');
    expect((await w.update()).applied).toBeNull();
  });

  it('--force takes the template version and backs yours up', async () => {
    const w = await conflicted();
    const result = await w.update({ force: true });
    expect(w.fs.text(`${ROOT}/README.md`)).toBe('readme v2\n');
    expect(w.fs.text(`${result.applied?.backupDir}/README.md`)).toBe('my own readme');
    expect(result.conflictsRemaining).toBe(0);
    expect(w.fs.text(`${ROOT}/config.json`)).toBe('{"a":2}'); // force does not touch files that are not in conflict
    // The report describes what happened (an overwrite), not the conflict it started as.
    const readme = result.outcomes.find((o) => o.path === 'README.md');
    expect(readme).toMatchObject({ kind: 'update', reason: expect.stringContaining('overwrites your changes') });
    expect(result.outcomes.some((o) => o.kind === 'conflict')).toBe(false);
  });

  it('a file you deleted: left alone if upstream did not change it, a conflict if it did', async () => {
    const w = await world();
    await w.fs.remove(`${ROOT}/config.json`);
    await w.fs.remove(`${ROOT}/README.md`);
    await w.publish(V2);
    const dry = await w.update({ dryRun: true });
    expect(w.kinds(dry)).toMatchObject({ 'config.json': 'kept-removed', 'README.md': 'conflict' });
    expect(dry.outcomes.find((o) => o.path === 'README.md')?.reason).toMatch(/deleted/);
    await w.update({ partial: true });
    expect(await w.fs.lstat(`${ROOT}/config.json`)).toBeNull();
    expect(await w.fs.lstat(`${ROOT}/README.md`)).toBeNull();
  });

  it('a file that exists but Forge never generated is a conflict, not silently overwritten', async () => {
    const w = await world();
    await w.publish({ ...V2, files: { ...V2.files, 'extra.txt': 'template extra' } });
    w.fs.seed({ [`${ROOT}/extra.txt`]: 'the user already had this' });
    await expect(w.update()).rejects.toThrow(/extra\.txt: exists and was not generated by Forge/);
    expect(w.fs.text(`${ROOT}/extra.txt`)).toBe('the user already had this');
  });

  it('a symlink or directory in the way is refused, and --force cannot override it', async () => {
    const w = await world();
    await w.publish(V2);
    w.fs.seed({ '/outside/secret': 'keep me' });
    await w.fs.remove(`${ROOT}/CHANGELOG.md`);
    w.fs.symlink(`${ROOT}/CHANGELOG.md`, '/outside/secret');
    const before = w.fs.snapshot();
    await expect(w.update()).rejects.toMatchObject({ code: 'FORGE_E_BLOCKED_PATH' });
    await expect(w.update({ force: true })).rejects.toMatchObject({ code: 'FORGE_E_BLOCKED_PATH' });
    expect(w.fs.snapshot()).toEqual(before);
    const partial = await w.update({ partial: true });
    expect(partial.conflictsRemaining).toBe(1);
    expect(w.fs.text('/outside/secret')).toBe('keep me');
  });
});

describe('orphans and --prune', () => {
  it('reports an untouched orphan, and only --prune removes it (backed up, forgotten by state)', async () => {
    const w = await world();
    await w.publish(V2);
    const first = await w.update();
    expect(w.kinds(first)['docs/notes.md']).toBe('orphan');
    expect(first.upToDate).toBe(false);
    expect(w.fs.text(`${ROOT}/docs/notes.md`)).toBe('notes v1\n');
    const pruned = await w.update({ prune: true });
    expect(await w.fs.lstat(`${ROOT}/docs/notes.md`)).toBeNull();
    expect(pruned.applied?.deleted).toEqual(['docs/notes.md']);
    expect(w.fs.text(`${pruned.applied?.backupDir}/docs/notes.md`)).toBe('notes v1\n');
    expect((await readState(w.fs, ROOT))?.files['docs/notes.md']).toBeUndefined();
    expect((await w.update({ prune: true })).applied).toBeNull();
  });

  it('SAFETY: a file you edited is never deleted, not even with --prune --force; it becomes yours', async () => {
    const w = await world();
    await w.publish(V2);
    await w.edit('docs/notes.md', 'my precious notes');
    const result = await w.update({ prune: true, force: true });
    expect(w.kinds(result)['docs/notes.md']).toBe('orphan-modified');
    expect(w.fs.text(`${ROOT}/docs/notes.md`)).toBe('my precious notes');
    expect((await readState(w.fs, ROOT))?.files['docs/notes.md']).toBeUndefined();
    expect(result.upToDate).toBe(false); // it described the project BEFORE this run, which still had updates to apply
    expect((await w.update({ prune: true, force: true })).upToDate).toBe(true);
  });

  it('changing an answer so a file is no longer produced makes it an orphan too', async () => {
    const w = new World();
    await w.publish(V1);
    await w.create({ docker: true });
    expect(w.fs.text(`${ROOT}/Dockerfile`)).toContain('FROM');
    const result = await w.update({ answers: { docker: false } });
    expect(w.kinds(result).Dockerfile).toBe('orphan');
    expect((await readState(w.fs, ROOT))?.answers['docker']).toBe(false);
    await w.update({ answers: { docker: false }, prune: true });
    expect(await w.fs.lstat(`${ROOT}/Dockerfile`)).toBeNull();
  });
});

describe('answers', () => {
  it('reuses recorded answers, and an override is applied and remembered', async () => {
    const w = new World();
    await w.publish(V1);
    await w.create({ greeting: 'hola' });
    expect((await w.update()).applied).toBeNull();
    expect(w.fs.text(`${ROOT}/src/app.ts`)).toContain('"hola"');
    const result = await w.update({ answers: { greeting: 'bonjour' } });
    expect(w.kinds(result)['src/app.ts']).toBe('update');
    expect(w.fs.text(`${ROOT}/src/app.ts`)).toContain('"bonjour"');
    expect((await w.update()).applied).toBeNull(); // remembered
  });

  const withNewQuestion = { ...V2, questions: [...QUESTIONS, { id: 'logging', type: 'boolean', message: 'Logging?', default: true }] };

  it('a question added upstream is filled from its default only when allowed, otherwise it is an error that names the flag', async () => {
    const w = await world();
    await w.publish(withNewQuestion);
    await expect(w.update({ useDefaults: false })).rejects.toThrow(/Missing answer "logging"/);
    await expect(w.update({ useDefaults: false })).rejects.toMatchObject({ hint: expect.stringContaining('--answer logging') });
    expect((await readState(w.fs, ROOT))?.answers['logging']).toBeUndefined();
    await w.update({ useDefaults: false, answers: { logging: false } });
    expect((await readState(w.fs, ROOT))?.answers['logging']).toBe(false);
  });

  it('a question removed upstream is dropped and reported', async () => {
    const w = await world();
    await w.publish({ ...V2, questions: [QUESTIONS[0] as Record<string, unknown>] , rules: RULES.slice(0, 2) });
    const deps = w.deps();
    const prepared = await prepareUpdate(deps, ROOT);
    expect(prepared.droppedAnswers).toEqual(['docker']);
    const result = await runUpdate(deps, prepared, { answers: {}, useDefaults: true, dryRun: false, diff: false, partial: false, force: false, prune: false });
    expect(result.droppedAnswers).toEqual(['docker']);
    expect((await readState(w.fs, ROOT))?.answers).not.toHaveProperty('docker');
  });

  it('a recorded value that is no longer valid is not trusted: it is dropped and must be answered again', async () => {
    const w = new World();
    const color = (choices: string[]) => ({ ...V1, questions: [{ id: 'color', type: 'enum', message: 'Color', choices, default: choices[0] }], rules: [] });
    await w.publish(color(['red', 'blue']));
    await w.create({ color: 'blue' });
    await w.publish(color(['red', 'green']));
    const prepared = await prepareUpdate(w.deps(), ROOT);
    expect(prepared.droppedAnswers).toEqual(['color']);
    expect(prepared.storedAnswers).not.toHaveProperty('color');
    await expect(runUpdate(w.deps(), prepared, { answers: {}, useDefaults: false, dryRun: false, diff: false, partial: false, force: false, prune: false })).rejects.toThrow(/Missing answer "color"/);
  });

  it('secret answers are never stored, so they must be supplied again', async () => {
    const w = new World();
    const spec = { ...V1, rules: [], questions: [{ id: 'token', type: 'string', message: 'Token', secret: true }] };
    await w.publish(spec);
    await w.create({ token: 's3cr3t' });
    expect(JSON.stringify(await readState(w.fs, ROOT))).not.toContain('s3cr3t');
    await expect(w.update({ useDefaults: false })).rejects.toThrow(/Missing answer "token"/);
    expect((await w.update({ useDefaults: false, answers: { token: 's3cr3t' } })).applied).toBeNull();
  });
});

describe('what it refuses, and why', () => {
  it('refuses to downgrade, changing nothing', async () => {
    const w = await world(V2);
    await w.publish(V1);
    const before = w.fs.snapshot();
    await expect(w.update()).rejects.toThrow(ConfigError);
    await expect(w.update()).rejects.toMatchObject({ code: 'FORGE_E_DOWNGRADE' });
    expect(w.fs.snapshot()).toEqual(before);
  });

  it('explains when the template the project came from is not installed', async () => {
    const w = await world();
    await w.tpl.remove('/tpl/app', { recursive: true });
    await expect(w.update()).rejects.toThrow(DefinitionError);
    await expect(w.update()).rejects.toThrow(/uses the template "app" \(version 1\.0\.0\), but this version of Forge does not provide it/);
  });

  it('only works on Forge projects, and says how to adopt a repo', async () => {
    const w = new World();
    w.fs.seed({ [`${ROOT}/package.json`]: '{}' });
    await expect(w.update()).rejects.toThrow(UsageError);
    await expect(w.update()).rejects.toMatchObject({ code: 'FORGE_E_NOT_A_PROJECT', hint: expect.stringContaining('forge add') });
  });

  it('refuses a state file from a newer Forge rather than guessing', async () => {
    const w = await world();
    const state = JSON.parse(w.fs.text(`${ROOT}/.forge/state.json`));
    await w.edit('.forge/state.json', JSON.stringify({ ...state, schemaVersion: 2 }));
    await expect(w.update()).rejects.toMatchObject({ code: 'FORGE_E_STATE_NEWER' });
  });
});

describe('features and projects Forge did not create', () => {
  it('updates a repo that only ever had features added (no template), and is idempotent', async () => {
    const w = new World();
    w.fs.seed({ [`${ROOT}/package.json`]: JSON.stringify({ name: 'legacy' }), [`${ROOT}/pnpm-lock.yaml`]: '' });
    await addFeatures(w.deps(), { root: ROOT, featureIds: ['ci'], answers: { 'package-manager': 'pnpm' }, useDefaults: true, dryRun: false, force: false, name: 'legacy' });
    expect((await w.update()).applied).toBeNull();
    w.pins = { ...PINS, actions: { ...PINS.actions, 'actions/checkout': { version: 'v8.0.0', sha: 'e'.repeat(40) } } };
    const result = await w.update();
    expect(w.kinds(result)['.github/workflows/ci.yml']).toBe('update');
    expect((await readState(w.fs, ROOT))?.template).toBeNull();
    expect((await w.update()).applied).toBeNull();
  });

  it('a hand-edited workflow is protected: the pin refresh becomes a conflict, not an overwrite', async () => {
    const w = new World();
    await w.publish(V1);
    w.features = ['ci'];
    await w.create();
    const workflow = '.github/workflows/ci.yml';
    await w.edit(workflow, `${w.fs.text(`${ROOT}/${workflow}`)}# our custom note\n`);
    w.pins = { ...PINS, actions: { ...PINS.actions, 'actions/checkout': { version: 'v8.0.0', sha: 'd'.repeat(40) } } };
    await expect(w.update()).rejects.toThrow(/ci\.yml/);
    expect(w.fs.text(`${ROOT}/${workflow}`)).toContain('# our custom note');
  });
});

describe('atomicity', () => {
  const messy = async () => {
    const w = await world();
    await w.publish(V2);
    await w.edit('config.json', '{"a":2}');
    return w;
  };

  it('INVARIANT U4: a failure at ANY step (writes, merges and deletes together) restores the exact tree', async () => {
    const run = (w: World, fs: FileSystem) => w.update({ prune: true }, ROOT, fs);
    const probe = await messy();
    const counted = faultyFs(probe.fs, 0);
    await run(probe, counted);
    expect(counted.mutations).toBeGreaterThan(12);
    for (let failAt = 1; failAt <= counted.mutations; failAt += 1) {
      const w = await messy();
      const before = w.fs.snapshot();
      await expect(run(w, faultyFs(w.fs, failAt)), `failAt ${failAt}`).rejects.toThrow(FsError);
      expect(w.fs.snapshot(), `tree after failure at mutation ${failAt}`).toEqual(before);
    }
  });
});

describe('PROPERTY U2: user edits are never lost', () => {
  const NAMES = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt'];
  const spec = (version: string, changed: ReadonlySet<string>): Spec => ({
    version, questions: [], rules: [],
    files: Object.fromEntries(NAMES.map((n) => [n, changed.has(n) ? `${n} upstream v2` : `${n} v1`])),
  });

  it('for any set of user edits and any set of upstream changes, --partial never modifies an edited file and always updates a pristine one', async () => {
    const subset = fc.subarray(NAMES);
    await fc.assert(
      fc.asyncProperty(subset, subset, async (edited, upstream) => {
        const w = new World();
        await w.publish(spec('1.0.0', new Set()));
        await w.create();
        for (const n of edited) await w.edit(n, `${n} edited by the user`);
        await w.publish(spec('1.1.0', new Set(upstream)));
        await w.update({ partial: true });
        for (const n of NAMES) {
          const now = w.fs.text(`${ROOT}/${n}`);
          if (edited.includes(n)) expect(now, `${n} was edited and must survive`).toBe(`${n} edited by the user`);
          else if (upstream.includes(n)) expect(now, `${n} was pristine and changed upstream`).toBe(`${n} upstream v2\n`);
          else expect(now, `${n} was pristine and unchanged`).toBe(`${n} v1\n`);
        }
        // and the recorded hashes tell the truth about the files Forge now owns
        const state = await readState(w.fs, ROOT);
        for (const n of NAMES) {
          if (edited.includes(n) && upstream.includes(n)) continue; // an unresolved conflict keeps its old hash on purpose
          if (edited.includes(n)) continue; // kept: hash stays at what Forge last wrote
          expect(state?.files[n], n).toBeDefined();
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe('working-tree check', () => {
  it('reports dirty, clean, and not-a-repo', async () => {
    const fs = new MemoryFileSystem();
    await fs.mkdir(`${ROOT}/.git`);
    expect(await isWorkingTreeDirty(fakeRunner(() => ({ stdout: ' M README.md\n' })), fs, ROOT)).toBe(true);
    expect(await isWorkingTreeDirty(fakeRunner(() => ({ stdout: '' })), fs, ROOT)).toBe(false);
    expect(await isWorkingTreeDirty(fakeRunner(() => ({ code: 128 })), fs, ROOT)).toBeNull();
    expect(await isWorkingTreeDirty(fakeRunner(), new MemoryFileSystem(), ROOT)).toBeNull();
  });
});
