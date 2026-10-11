import fs from 'node:fs/promises';
import { FsError } from '../errors/index.js';
import type { FileStat, FileSystem, WriteOptions } from '../ports/index.js';

const HINTS: Readonly<Record<string, string>> = {
  EACCES: 'Check file permissions on the path, or run Forge in a directory you own.',
  EPERM: 'The operation is not permitted. Check file permissions and ownership.',
  ENOSPC: 'The disk is full.',
  EROFS: 'The filesystem is read-only.',
  ENOENT: 'A required file or directory does not exist.',
  EEXIST: 'The path already exists.',
  ENOTDIR: 'A path component that should be a directory is a file.',
  EISDIR: 'Expected a file but found a directory.',
};

function wrap(operation: string, target: string, error: unknown): FsError {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  const hint = errno === undefined ? undefined : HINTS[errno];
  return new FsError(`Could not ${operation} ${target}${errno ? ` (${errno})` : ''}.`, {
    cause: error,
    ...(errno === undefined ? {} : { errno }),
    ...(hint === undefined ? {} : { hint }),
  });
}

export function createNodeFileSystem(): FileSystem {
  return {
    async lstat(path): Promise<FileStat | null> {
      try {
        const stat = await fs.lstat(path);
        const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'file';
        return { kind, mode: stat.mode & 0o7777, size: stat.size };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw wrap('inspect', path, error);
      }
    },
    async readFile(path) {
      try {
        return new Uint8Array(await fs.readFile(path));
      } catch (error) {
        throw wrap('read', path, error);
      }
    },
    async writeFile(path, data, options: WriteOptions = {}) {
      try {
        await fs.writeFile(path, data, {
          ...(options.mode === undefined ? {} : { mode: options.mode }),
          ...(options.exclusive ? { flag: 'wx' } : {}),
        });
      } catch (error) {
        throw wrap('write', path, error);
      }
    },
    async mkdir(path) {
      try {
        await fs.mkdir(path, { recursive: true });
      } catch (error) {
        throw wrap('create directory', path, error);
      }
    },
    async readdir(path) {
      try {
        return (await fs.readdir(path)).sort();
      } catch (error) {
        throw wrap('list', path, error);
      }
    },
    async rename(from, to) {
      try {
        await fs.rename(from, to);
      } catch (error) {
        throw wrap('move', `${from} -> ${to}`, error);
      }
    },
    async remove(path, options = {}) {
      try {
        const stat = await fs.lstat(path).catch(() => null);
        if (stat === null) return;
        if (stat.isDirectory() && !options.recursive) await fs.rmdir(path);
        else await fs.rm(path, { recursive: options.recursive === true, force: true });
      } catch (error) {
        throw wrap('remove', path, error);
      }
    },
    async realpath(path) {
      try {
        return await fs.realpath(path);
      } catch (error) {
        throw wrap('resolve', path, error);
      }
    },
  };
}
