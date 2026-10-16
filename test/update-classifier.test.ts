import { describe, expect, it } from 'vitest';
import type { DiskEntry } from '../src/core/plan/inspect.js';
import { classifyUpdate, WRITING_KINDS, type UpdateInput } from '../src/core/plan/update-classifier.js';

const X = 'x'.repeat(64);
const Y = 'y'.repeat(64);
const Z = 'z'.repeat(64);
const file = (hash: string): DiskEntry => ({ kind: 'file', hash, mode: 0o644, content: new Uint8Array() });
const MISSING: DiskEntry = { kind: 'missing' };
const run = (base: string | undefined, disk: DiskEntry, next: string | undefined, strategy: UpdateInput['strategy'] = 'overwrite') =>
  classifyUpdate({ base, disk, next, strategy });

describe('the 14 documented outcomes (overwrite files)', () => {
  it.each([
    [1, 'create', undefined, MISSING, X, 'next'],
    [2, 'adopt', undefined, file(X), X, 'next'],
    [3, 'conflict', undefined, file(Y), X, 'drop'],
    [4, 'unchanged', X, file(X), X, 'next'],
    [5, 'update', X, file(X), Y, 'next'],
    [6, 'keep', X, file(Y), X, 'base'],
    [7, 'converged', X, file(Y), Y, 'next'],
    [8, 'conflict', X, file(Y), Z, 'base'],
    [9, 'kept-removed', X, MISSING, X, 'drop'],
    [10, 'conflict', X, MISSING, Y, 'base'],
    [11, 'orphan', X, file(X), undefined, 'base'],
    [12, 'orphan-modified', X, file(Y), undefined, 'drop'],
    [13, 'gone', X, MISSING, undefined, 'drop'],
  ] as const)('#%i -> %s', (_n, kind, base, disk, next, state) => {
    expect(run(base, disk, next)).toMatchObject({ kind, state });
  });

  it('#14 directories and symlinks are blocked, whatever else is true', () => {
    for (const disk of [{ kind: 'dir' } as DiskEntry, { kind: 'blocked', reason: 'a is a symbolic link' } as DiskEntry]) {
      for (const base of [undefined, X]) for (const next of [undefined, X, Y]) expect(run(base, disk, next).kind).toBe('blocked');
    }
    expect(run(X, { kind: 'blocked', reason: 'a is a symbolic link' }, Y).reason).toBe('a is a symbolic link');
  });

  it('every outcome that is not an error carries a reason or is self-explanatory', () => {
    for (const result of [run(X, file(Y), Z), run(X, MISSING, Y), run(undefined, file(Y), X), run(X, file(Y), X)]) expect(result.reason).toBeTruthy();
  });
});

describe('create-only (none) files', () => {
  it('are never updated, even when untouched and the template changed', () => {
    expect(run(X, file(X), Y, 'none')).toMatchObject({ kind: 'keep', state: 'base' });
  });
  it('are not recreated after the user removed them', () => {
    expect(run(X, MISSING, Y, 'none')).toMatchObject({ kind: 'kept-removed', state: 'drop' });
  });
  it('are still created the first time and adopted if identical', () => {
    expect(run(undefined, MISSING, X, 'none').kind).toBe('create');
    expect(run(undefined, file(X), X, 'none').kind).toBe('adopt');
    expect(run(X, file(X), X, 'none').kind).toBe('unchanged');
  });
});

describe('totality and safety, over EVERY combination', () => {
  const hashes = [undefined, X, Y, Z] as const;
  const disks: DiskEntry[] = [MISSING, file(X), file(Y), file(Z), { kind: 'dir' }, { kind: 'blocked', reason: 'link' }];
  const combos = hashes.flatMap((base) => disks.flatMap((disk) => hashes.flatMap((next) => (['overwrite', 'none'] as const).map((strategy) => ({ base, disk, next, strategy })))));

  it('covers 4 x 6 x 4 x 2 = 192 combinations, each with a defined outcome', () => {
    expect(combos).toHaveLength(192);
    for (const combo of combos) {
      const result = classifyUpdate(combo);
      expect(result.kind, JSON.stringify(combo)).toBeTruthy();
      expect(['next', 'base', 'drop']).toContain(result.state);
    }
  });

  it('SAFETY: a file is written only if it is absent or exactly what Forge last wrote', () => {
    for (const combo of combos) {
      const result = classifyUpdate(combo);
      if (!WRITING_KINDS.has(result.kind)) continue;
      const onDisk = combo.disk.kind === 'file' ? combo.disk.hash : undefined;
      expect(onDisk === undefined || onDisk === combo.base, `unsafe write for ${JSON.stringify(combo)}`).toBe(true);
    }
  });

  it('SAFETY: untracked files are only created into empty space, never over something', () => {
    for (const combo of combos.filter((c) => c.base === undefined && c.next !== undefined)) {
      const result = classifyUpdate(combo);
      if (result.kind === 'create') expect(combo.disk.kind).toBe('missing');
    }
  });

  it('SAFETY: a modified file is never classified as pristine-only outcomes (update, orphan)', () => {
    for (const combo of combos) {
      if (combo.disk.kind !== 'file' || combo.base === undefined || combo.disk.hash === combo.base) continue;
      expect(['update', 'orphan']).not.toContain(classifyUpdate(combo).kind);
    }
  });

  it('SAFETY: create-only files are never classified as update', () => {
    for (const combo of combos.filter((c) => c.strategy === 'none')) expect(classifyUpdate(combo).kind).not.toBe('update');
  });

  it('STATE: a recorded hash advances to NEXT only when disk will equal NEXT afterwards', () => {
    for (const combo of combos) {
      const result = classifyUpdate(combo);
      if (result.state !== 'next') continue;
      const onDisk = combo.disk.kind === 'file' ? combo.disk.hash : undefined;
      const diskAfter = WRITING_KINDS.has(result.kind) ? combo.next : onDisk;
      expect(diskAfter, JSON.stringify(combo)).toBe(combo.next);
    }
  });

  it('STATE: blocked and conflicted files never advance their recorded hash', () => {
    for (const combo of combos) {
      const result = classifyUpdate(combo);
      if (result.kind === 'blocked' || result.kind === 'conflict') expect(result.state).not.toBe('next');
    }
  });
});
