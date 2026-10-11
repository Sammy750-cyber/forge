import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/adapters/memory-fs.js';
import { FsError } from '../src/errors/index.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('MemoryFileSystem (test double must behave like a real filesystem)', () => {
  it('creates, reads, lists, and removes', async () => {
    const fs = new MemoryFileSystem();
    await fs.mkdir('/a/b');
    await fs.writeFile('/a/b/f.txt', enc('hi'), { mode: 0o755 });
    expect(new TextDecoder().decode(await fs.readFile('/a/b/f.txt'))).toBe('hi');
    expect(fs.mode('/a/b/f.txt')).toBe(0o755);
    expect(await fs.readdir('/a')).toEqual(['b']);
    expect(await fs.lstat('/a/b')).toMatchObject({ kind: 'dir' });
    await expect(fs.remove('/a')).rejects.toThrow(/ENOTEMPTY/);
    await fs.remove('/a', { recursive: true });
    expect(await fs.lstat('/a')).toBeNull();
    await fs.remove('/never-existed');
  });

  it('requires parents, honours exclusive, and keeps the mode of existing files', async () => {
    const fs = new MemoryFileSystem();
    await expect(fs.writeFile('/missing/f', enc('x'))).rejects.toThrow(FsError);
    await fs.mkdir('/d');
    await fs.writeFile('/d/f', enc('1'), { mode: 0o600 });
    await expect(fs.writeFile('/d/f', enc('2'), { exclusive: true })).rejects.toThrow(/EEXIST/);
    await fs.writeFile('/d/f', enc('3'), { mode: 0o777 });
    expect(fs.mode('/d/f')).toBe(0o600);
  });

  it('renames files over existing files and moves directories', async () => {
    const fs = new MemoryFileSystem();
    fs.seed({ '/d/a': 'A', '/d/b': 'B', '/x/y/z': 'Z' });
    await fs.rename('/d/a', '/d/b');
    expect(fs.text('/d/b')).toBe('A');
    await fs.rename('/x', '/moved');
    expect(fs.text('/moved/y/z')).toBe('Z');
    await expect(fs.rename('/nope', '/q')).rejects.toThrow(/ENOENT/);
  });

  it('follows symlinks for reads and writes but lstat reports the link', async () => {
    const fs = new MemoryFileSystem();
    fs.seed({ '/real/target': 'T' });
    fs.symlink('/alias', '/real');
    fs.symlink('/flink', '/real/target');
    expect(fs.text('/alias/target')).toBe('T');
    expect(await fs.lstat('/alias')).toMatchObject({ kind: 'symlink' });
    await fs.writeFile('/flink', enc('changed'));
    expect(fs.text('/real/target')).toBe('changed');
    expect(await fs.realpath('/alias/target')).toBe('/real/target');
  });

  it('detects symlink loops', async () => {
    const fs = new MemoryFileSystem();
    fs.symlink('/a', '/b');
    fs.symlink('/b', '/a');
    await expect(fs.readFile('/a')).rejects.toThrow(/ELOOP/);
  });

  it('snapshot captures content, modes and links', () => {
    const fs = new MemoryFileSystem();
    fs.seed({ '/f': 'x' });
    fs.symlink('/l', '/f');
    const snap = fs.snapshot();
    expect(snap['/f']).toMatch(/^file 644 /);
    expect(snap['/l']).toBe('symlink /f');
  });
});
