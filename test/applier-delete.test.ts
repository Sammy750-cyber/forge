import { describe, expect, it } from 'vitest';
import { fixedClock } from '../src/adapters/clock.js';
import { nullLogger } from '../src/adapters/logger.js';
import { MemoryFileSystem } from '../src/adapters/memory-fs.js';
import { applyPlan, type ApplyOptions } from '../src/core/apply/applier.js';
import { snapshotDisk } from '../src/core/plan/inspect.js';
import { createPlan } from '../src/core/plan/planner.js';
import type { RenderedFile } from '../src/core/render/renderer.js';
import { sha256Hex } from '../src/core/util/hash.js';
import { FsError, InterruptedError } from '../src/errors/index.js';
import type { FileSystem } from '../src/ports/index.js';
import { faultyFs } from './helpers/fixtures.js';

const enc = (s: string) => new TextEncoder().encode(s);
const posix = (p: string): string => p.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/|$)/, '');
const ROOT = '/work/proj';
const file = (path: string, content: string): RenderedFile => ({ path, content: enc(content), mode: 0o644, mergeStrategy: 'overwrite', sourcePath: path });
const base = (fs: FileSystem, extra: Partial<ApplyOptions> = {}): ApplyOptions => ({
  fs, root: ROOT, clock: fixedClock('2026-10-10T12:00:00Z'), logger: nullLogger, overwriteConflicts: false, ...extra,
});
const emptyPlan = createPlan({ files: [], skipped: [], disk: new Map(), previous: {} });
const seeded = () => {
  const fs = new MemoryFileSystem();
  fs.seed({ [`${ROOT}/old.txt`]: 'old', [`${ROOT}/keep.txt`]: 'keep', [`${ROOT}/sub/deep/orphan.txt`]: 'orphan', [`${ROOT}/README.md`]: 'v1' });
  return fs;
};

describe('applyPlan deletes', () => {
  it('deletes files, backing each up first, and reports them', async () => {
    const fs = seeded();
    const result = await applyPlan(emptyPlan, base(fs, { deletes: ['old.txt', 'sub/deep/orphan.txt'] }));
    expect(result.deleted).toEqual(['old.txt', 'sub/deep/orphan.txt']);
    expect(result.written).toEqual([]);
    expect(await fs.lstat(`${ROOT}/old.txt`)).toBeNull();
    expect(fs.text(`${ROOT}/keep.txt`)).toBe('keep');
    expect(fs.text(`${result.backupDir}/old.txt`)).toBe('old');
    expect(fs.text(`${result.backupDir}/sub/deep/orphan.txt`)).toBe('orphan');
    expect(posix(result.backupDir ?? '')).toBe(`${ROOT}/.forge/backup/20261010T120000Z`);
  });

  it('leaves directories in place even when they become empty', async () => {
    const fs = seeded();
    await applyPlan(emptyPlan, base(fs, { deletes: ['sub/deep/orphan.txt'] }));
    expect((await fs.lstat(`${ROOT}/sub/deep`))?.kind).toBe('dir');
  });

  it('skips paths that are already gone, and does nothing at all when there is nothing to do', async () => {
    const fs = seeded();
    const before = fs.snapshot();
    const result = await applyPlan(emptyPlan, base(fs, { deletes: ['never-existed.txt'] }));
    expect(result.deleted).toEqual([]);
    expect(result.backupDir).toBeNull();
    expect(fs.snapshot()).toEqual(before);
    expect((await applyPlan(emptyPlan, base(fs))).deleted).toEqual([]);
  });

  it('combines with writes in one transaction', async () => {
    const fs = seeded();
    const files = [file('README.md', 'v2'), file('new.txt', 'new')];
    const plan = createPlan({ files, skipped: [], disk: await snapshotDisk(fs, ROOT, files.map((f) => f.path)), previous: { 'README.md': sha256Hex(enc('v1')) } });
    const result = await applyPlan(plan, base(fs, { deletes: ['old.txt'] }));
    expect([...result.written].sort()).toEqual(['README.md', 'new.txt']);
    expect(result.deleted).toEqual(['old.txt']);
    expect([...result.backedUp].sort()).toEqual(['README.md', 'old.txt']);
  });

  it('refuses directories and symlinks, and changes nothing', async () => {
    const fs = seeded();
    fs.seed({ '/outside/secret': 'keep me' });
    fs.symlink(`${ROOT}/link.txt`, '/outside/secret');
    fs.symlink(`${ROOT}/linkdir`, '/outside');
    const before = fs.snapshot();
    await expect(applyPlan(emptyPlan, base(fs, { deletes: ['old.txt', 'sub'] }))).rejects.toMatchObject({ code: 'FORGE_E_BLOCKED_PATH' });
    await expect(applyPlan(emptyPlan, base(fs, { deletes: ['old.txt', 'link.txt'] }))).rejects.toMatchObject({ code: 'FORGE_E_BLOCKED_PATH' });
    await expect(applyPlan(emptyPlan, base(fs, { deletes: ['linkdir/secret'] }))).rejects.toMatchObject({ code: 'FORGE_E_BLOCKED_PATH' });
    expect(fs.snapshot()).toEqual(before);
    expect(fs.text('/outside/secret')).toBe('keep me');
  });

  it('refuses a path that escapes the project', async () => {
    const fs = seeded();
    await expect(applyPlan(emptyPlan, base(fs, { deletes: ['../outside.txt'] }))).rejects.toThrow(FsError);
  });

  it('is atomic: a failure at ANY step (writes and deletes together) restores the exact tree', async () => {
    const run = async (fs: FileSystem) => {
      const files = [file('README.md', 'v2'), file('new/dir/file.txt', 'new')];
      const plan = createPlan({ files, skipped: [], disk: await snapshotDisk(fs, ROOT, files.map((f) => f.path)), previous: { 'README.md': sha256Hex(enc('v1')) } });
      return applyPlan(plan, base(fs, { deletes: ['old.txt', 'sub/deep/orphan.txt'] }));
    };
    const counted = faultyFs(seeded(), 0);
    await run(counted);
    expect(counted.mutations).toBeGreaterThan(10);
    for (let failAt = 1; failAt <= counted.mutations; failAt += 1) {
      const mem = seeded();
      const before = mem.snapshot();
      await expect(run(faultyFs(mem, failAt)), `failAt ${failAt}`).rejects.toThrow(FsError);
      expect(mem.snapshot(), `tree after failure at mutation ${failAt}`).toEqual(before);
    }
  });

  it('an interrupt at ANY step restores deleted files too', async () => {
    const run = (fs: FileSystem, signal?: AbortSignal) => applyPlan(emptyPlan, base(fs, { deletes: ['old.txt', 'keep.txt'], ...(signal === undefined ? {} : { signal }) }));
    const counted = faultyFs(seeded(), 0);
    await run(counted);
    for (let abortAt = 1; abortAt <= counted.mutations; abortAt += 1) {
      const mem = seeded();
      const before = mem.snapshot();
      const controller = new AbortController();
      const outcome = await run(faultyFs(mem, 0, (count) => count === abortAt && controller.abort()), controller.signal).then(() => 'completed', (e: unknown) => e);
      if (outcome === 'completed') continue;
      expect(outcome, `abort at ${abortAt}`).toBeInstanceOf(InterruptedError);
      expect(mem.snapshot(), `abort at ${abortAt}`).toEqual(before);
    }
  });
});
