import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/adapters/memory-fs.js';
import { nullLogger } from '../src/adapters/logger.js';
import { fixedClock } from '../src/adapters/clock.js';
import { applyPlan } from '../src/core/apply/applier.js';
import { snapshotDisk } from '../src/core/plan/inspect.js';
import { createPlan } from '../src/core/plan/planner.js';
import type { RenderedFile } from '../src/core/render/renderer.js';
import { sha256Hex } from '../src/core/util/hash.js';
import { ConflictError, FsError, InterruptedError } from '../src/errors/index.js';
import type { FileSystem } from '../src/ports/index.js';
import { faultyFs } from './helpers/fixtures.js';

const enc = (s: string) => new TextEncoder().encode(s);
const file = (path: string, content: string, mode = 0o644): RenderedFile => ({ path, content: enc(content), mode, mergeStrategy: 'overwrite', sourcePath: path });
const ROOT = '/work/proj';

async function planFor(fs: FileSystem, files: RenderedFile[], previous: Record<string, string> = {}) {
  const disk = await snapshotDisk(fs, ROOT, files.map((f) => f.path));
  return createPlan({ files, skipped: [], disk, previous });
}
const hashes = (files: RenderedFile[]) => Object.fromEntries(files.map((f) => [f.path, sha256Hex(f.content)]));
const options = (fs: FileSystem, extra: Partial<Parameters<typeof applyPlan>[1]> = {}) => ({
  fs, root: ROOT, clock: fixedClock('2026-10-10T12:00:00Z'), logger: nullLogger, overwriteConflicts: false, ...extra,
});

const V1 = [file('README.md', 'v1 readme'), file('src/a.ts', 'v1 a'), file('src/deep/b.ts', 'v1 b'), file('bin/run.sh', '#!/bin/sh', 0o755)];
const V2 = [file('README.md', 'v2 readme'), file('src/a.ts', 'v1 a'), file('src/deep/b.ts', 'v2 b'), file('docs/new.md', 'new')];

describe('applyPlan', () => {
  it('creates files and directories with the requested modes and leaves no temp files', async () => {
    const fs = new MemoryFileSystem();
    const result = await applyPlan(await planFor(fs, V1), options(fs));
    expect(result.written).toHaveLength(4);
    expect(result.backupDir).toBeNull();
    expect(fs.text(`${ROOT}/src/deep/b.ts`)).toBe('v1 b');
    expect(fs.mode(`${ROOT}/bin/run.sh`)).toBe(0o755);
    expect(Object.keys(fs.snapshot()).filter((k) => k.includes('forge-tmp'))).toEqual([]);
  });

  it('does nothing for an empty or all-unchanged plan', async () => {
    const fs = new MemoryFileSystem();
    await applyPlan(await planFor(fs, V1), options(fs));
    const before = fs.snapshot();
    const result = await applyPlan(await planFor(fs, V1, hashes(V1)), options(fs));
    expect(result.written).toEqual([]);
    expect(fs.snapshot()).toEqual(before);
  });

  it('backs up files before updating them', async () => {
    const fs = new MemoryFileSystem();
    await applyPlan(await planFor(fs, V1), options(fs));
    const result = await applyPlan(await planFor(fs, V2, hashes(V1)), options(fs));
    expect([...result.backedUp].sort()).toEqual(['README.md', 'src/deep/b.ts']);
    expect(result.backupDir).toBe(`${ROOT}/.forge/backup/20261010T120000Z`);
    expect(fs.text(`${result.backupDir}/README.md`)).toBe('v1 readme');
    expect(fs.text(`${ROOT}/README.md`)).toBe('v2 readme');
    expect(fs.text(`${ROOT}/docs/new.md`)).toBe('new');
  });

  it('never reuses a backup folder name within the same second', async () => {
    const fs = new MemoryFileSystem();
    await applyPlan(await planFor(fs, V1), options(fs));
    const first = await applyPlan(await planFor(fs, V2, hashes(V1)), options(fs));
    const third = [file('README.md', 'v3 readme')];
    const second = await applyPlan(await planFor(fs, third, hashes([V2[0]!])), options(fs));
    expect(second.backupDir).toBe(`${first.backupDir}-2`);
  });

  it('keeps only the most recent backups', async () => {
    const fs = new MemoryFileSystem();
    let previous: Record<string, string> = {};
    for (let i = 0; i < 6; i += 1) {
      const files = [file('f.txt', `content ${i}`)];
      const clock = fixedClock(`2026-10-10T12:00:0${i}Z`);
      await applyPlan(await planFor(fs, files, previous), options(fs, { clock, backupRetention: 3 }));
      previous = hashes(files);
    }
    expect(await fs.readdir(`${ROOT}/.forge/backup`)).toEqual(['20261010T120003Z', '20261010T120004Z', '20261010T120005Z']);
  });

  it('refuses unresolved conflicts and writes nothing', async () => {
    const fs = new MemoryFileSystem();
    fs.seed({ [`${ROOT}/README.md`]: 'theirs' });
    const before = fs.snapshot();
    await expect(applyPlan(await planFor(fs, V1), options(fs))).rejects.toThrow(ConflictError);
    expect(fs.snapshot()).toEqual(before);
  });

  it('overwrites conflicts only when told to, and backs them up', async () => {
    const fs = new MemoryFileSystem();
    fs.seed({ [`${ROOT}/README.md`]: 'theirs' });
    const result = await applyPlan(await planFor(fs, V1), options(fs, { overwriteConflicts: true }));
    expect(fs.text(`${ROOT}/README.md`)).toBe('v1 readme');
    expect(fs.text(`${result.backupDir}/README.md`)).toBe('theirs');
  });

  it('never overwrites a symlink even with overwriteConflicts', async () => {
    const fs = new MemoryFileSystem();
    fs.seed({ '/outside/secret': 'keep' });
    fs.mkdir(ROOT);
    fs.symlink(`${ROOT}/README.md`, '/outside/secret');
    await expect(applyPlan(await planFor(fs, V1), options(fs, { overwriteConflicts: true }))).rejects.toThrow(ConflictError);
    expect(fs.text('/outside/secret')).toBe('keep');
  });

  it('detects a symlink planted between planning and applying (TOCTOU)', async () => {
    const fs = new MemoryFileSystem();
    fs.seed({ '/outside/placeholder': 'x' });
    await fs.mkdir(ROOT);
    const plan = await planFor(fs, V1);
    fs.symlink(`${ROOT}/src`, '/outside');
    const before = fs.snapshot();
    await expect(applyPlan(plan, options(fs))).rejects.toMatchObject({ code: 'FORGE_E_BLOCKED_PATH' });
    expect(fs.snapshot()).toEqual(before);
    expect(await fs.readdir('/outside')).toEqual(['placeholder']);
  });

  it('refuses a plan whose paths escape the root', async () => {
    const fs = new MemoryFileSystem();
    const plan = createPlan({ files: [file('../evil', 'x')], skipped: [], disk: new Map(), previous: {} });
    await expect(applyPlan(plan, options(fs))).rejects.toMatchObject({ code: 'FORGE_E_PATH_TRAVERSAL' });
    expect(await fs.lstat('/work/evil')).toBeNull();
  });
});

describe('atomicity: a failure at ANY step restores the exact previous tree', () => {
  async function countMutations(setup: (fs: MemoryFileSystem) => Promise<void>, run: (fs: FileSystem) => Promise<unknown>): Promise<number> {
    const mem = new MemoryFileSystem();
    await setup(mem);
    const counted = faultyFs(mem, 0);
    await run(counted);
    return counted.mutations;
  }

  it('fresh project (root does not exist yet)', async () => {
    const run = async (fs: FileSystem) => applyPlan(await planFor(fs, V1), options(fs));
    const total = await countMutations(async () => undefined, run);
    expect(total).toBeGreaterThan(8);
    for (let failAt = 1; failAt <= total; failAt += 1) {
      const mem = new MemoryFileSystem();
      const before = mem.snapshot();
      await expect(run(faultyFs(mem, failAt)), `failure at mutation ${failAt}`).rejects.toThrow(FsError);
      expect(mem.snapshot(), `tree after failure at mutation ${failAt}`).toEqual(before);
    }
  });

  it('updating an existing project (backups, replaced files, new directories)', async () => {
    const setup = async (mem: MemoryFileSystem) => void (await applyPlan(await planFor(mem, V1), options(mem)));
    const run = async (fs: FileSystem) => applyPlan(await planFor(fs, V2, hashes(V1)), options(fs));
    const total = await countMutations(setup, run);
    expect(total).toBeGreaterThan(8);
    for (let failAt = 1; failAt <= total; failAt += 1) {
      const mem = new MemoryFileSystem();
      await setup(mem);
      const before = mem.snapshot();
      await expect(run(faultyFs(mem, failAt)), `failure at mutation ${failAt}`).rejects.toThrow(FsError);
      expect(mem.snapshot(), `tree after failure at mutation ${failAt}`).toEqual(before);
    }
  });

  it('interrupt (abort signal) at ANY step also restores the tree', async () => {
    const run = async (fs: FileSystem, signal?: AbortSignal) => applyPlan(await planFor(fs, V1), options(fs, signal === undefined ? {} : { signal }));
    const total = await countMutations(async () => undefined, (fs) => run(fs));
    for (let abortAt = 1; abortAt <= total; abortAt += 1) {
      const mem = new MemoryFileSystem();
      const before = mem.snapshot();
      const controller = new AbortController();
      const fs = faultyFs(mem, 0, (count) => {
        if (count === abortAt) controller.abort();
      });
      // The abort is only observed between steps, so late aborts may legitimately complete the run.
      const outcome = await run(fs, controller.signal).then(() => 'completed', (error: unknown) => error);
      if (outcome === 'completed') continue;
      expect(outcome, `abort at mutation ${abortAt}`).toBeInstanceOf(InterruptedError);
      expect(mem.snapshot(), `tree after abort at mutation ${abortAt}`).toEqual(before);
    }
  });

  it('a signal that is already aborted changes nothing', async () => {
    const fs = new MemoryFileSystem();
    const controller = new AbortController();
    controller.abort();
    await expect(applyPlan(await planFor(fs, V1), options(fs, { signal: controller.signal }))).rejects.toThrow(InterruptedError);
    expect(await fs.lstat(ROOT)).toBeNull();
  });

  it('reports an incomplete rollback loudly and points at the backups', async () => {
    const mem = new MemoryFileSystem();
    await applyPlan(await planFor(mem, V1), options(mem));
    let writes = 0;
    const hostile: FileSystem = {
      lstat: (p) => mem.lstat(p), readFile: (p) => mem.readFile(p), readdir: (p) => mem.readdir(p), realpath: (p) => mem.realpath(p),
      mkdir: (p) => mem.mkdir(p),
      rename: (a, b) => mem.rename(a, b),
      remove: async () => { throw new FsError('disk on fire'); },
      writeFile: async (p, d, o) => {
        writes += 1;
        if (writes === 5) throw new FsError('primary failure');
        return mem.writeFile(p, d, o);
      },
    };
    await expect(applyPlan(await planFor(hostile, V2, hashes(V1)), options(hostile))).rejects.toMatchObject({
      code: 'FORGE_E_ROLLBACK_INCOMPLETE',
      hint: expect.stringContaining('.forge/backup'),
    });
  });
});
