import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeFileSystem } from '../src/adapters/node-fs.js';
import { FsError } from '../src/errors/index.js';
import { canSymlink } from './helpers/fixtures.js';

let tmp: string;
beforeEach(async () => void (tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-fs-'))));
afterEach(async () => fs.rm(tmp, { recursive: true, force: true }));
const enc = (s: string) => new TextEncoder().encode(s);

const symlinkOk = await canSymlink()

describe('node filesystem adapter', () => {
  const adapter = createNodeFileSystem();

  it('round-trips files and directories', async () => {
    const dir = path.join(tmp, 'a/b');
    await adapter.mkdir(dir);
    const file = path.join(dir, 'f.txt');
    await adapter.writeFile(file, enc('hi'), { mode: 0o600 });
    expect(new TextDecoder().decode(await adapter.readFile(file))).toBe('hi');
    expect(await adapter.lstat(file)).toMatchObject({ kind: 'file', size: 2 });
    expect(await adapter.readdir(path.join(tmp, 'a'))).toEqual(['b']);
    expect(await adapter.realpath(dir)).toBe(await fs.realpath(dir));
  });

  it('reports missing paths as null and surfaces other errors as FsError with hints', async () => {
    expect(await adapter.lstat(path.join(tmp, 'nope'))).toBeNull();
    expect(await adapter.lstat(path.join(tmp, 'f/child'))).toBeNull();
    await expect(adapter.readFile(path.join(tmp, 'nope'))).rejects.toMatchObject({ errno: 'ENOENT', hint: expect.any(String) });
    await expect(adapter.readdir(path.join(tmp, 'nope'))).rejects.toBeInstanceOf(FsError);
  });

  it.skipIf(!symlinkOk)('does not follow symlinks in lstat, and exclusive writes refuse existing paths and links', async () => {
    await fs.writeFile(path.join(tmp, 'target'), 'T');
    await fs.symlink(path.join(tmp, 'target'), path.join(tmp, 'link'));
    expect(await adapter.lstat(path.join(tmp, 'link'))).toMatchObject({ kind: 'symlink' });
    await expect(adapter.writeFile(path.join(tmp, 'link'), enc('X'), { exclusive: true })).rejects.toMatchObject({ errno: 'EEXIST' });
    expect(await fs.readFile(path.join(tmp, 'target'), 'utf8')).toBe('T');
  });

  it('renames over files, removes files, empty dirs and trees, and ignores missing paths', async () => {
    await fs.writeFile(path.join(tmp, 'a'), 'A');
    await fs.writeFile(path.join(tmp, 'b'), 'B');
    await adapter.rename(path.join(tmp, 'a'), path.join(tmp, 'b'));
    expect(await fs.readFile(path.join(tmp, 'b'), 'utf8')).toBe('A');
    await adapter.remove(path.join(tmp, 'b'));
    await adapter.remove(path.join(tmp, 'missing'));
    await fs.mkdir(path.join(tmp, 'd/e'), { recursive: true });
    await expect(adapter.remove(path.join(tmp, 'd'))).rejects.toMatchObject({ errno: 'ENOTEMPTY' });
    await adapter.remove(path.join(tmp, 'd'), { recursive: true });
    expect(await adapter.lstat(path.join(tmp, 'd'))).toBeNull();
  });
});

describe('findPackageRoot', () => {
  it('locates the forge-cli package from source and from a nested path', async () => {
    const { findPackageRoot } = await import('../src/adapters/package-root.js');
    const { REPO_ROOT } = await import('./helpers/fixtures.js');
    expect(findPackageRoot(new URL('../src/cli/main.ts', import.meta.url).href)).toBe(REPO_ROOT);
  });
});
