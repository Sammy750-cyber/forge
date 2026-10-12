import path from 'node:path';
import { FsError } from '../errors/index.js';
import type { FileStat, FileSystem, WriteOptions } from '../ports/index.js';

type Node =
  | { kind: 'file'; data: Uint8Array; mode: number }
  | { kind: 'dir'; mode: number }
  | { kind: 'symlink'; target: string };

const posix = path.posix;
const MAX_SYMLINK_HOPS = 40;

function fail(errno: string, operation: string, target: string): FsError {
  return new FsError(`Could not ${operation} ${target} (${errno}).`, { errno });
}

/** Accept Windows-style paths ("C:\work\proj", "\work\proj") as the in-memory POSIX path "/work/proj". */
function toMemoryPath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/|$)/, '');
}

/** An in-memory, POSIX-style filesystem used by tests. Mirrors the semantics the engine relies on. */
export class MemoryFileSystem implements FileSystem {
  private readonly nodes = new Map<string, Node>([['/', { kind: 'dir', mode: 0o755 }]]);

  /** Resolve symlinks in every ancestor, and in the final component when `followLast` is set. */
  private canonical(input: string, followLast: boolean): string {
    let current = posix.resolve('/', toMemoryPath(input));
    for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop += 1) {
      const parts = current.split('/').filter(Boolean);
      let acc = '';
      let redirected = false;
      for (const [index, part] of parts.entries()) {
        const candidate = `${acc}/${part}`;
        const node = this.nodes.get(candidate);
        const isLast = index === parts.length - 1;
        if (node?.kind === 'symlink' && (!isLast || followLast)) {
          current = posix.resolve(posix.dirname(candidate), node.target, ...parts.slice(index + 1));
          redirected = true;
          break;
        }
        acc = candidate;
      }
      if (!redirected) return acc === '' ? '/' : acc;
    }
    throw fail('ELOOP', 'resolve', input);
  }

  private requireParentDir(canonicalPath: string, operation: string, original: string): void {
    const parent = this.nodes.get(posix.dirname(canonicalPath));
    if (parent === undefined) throw fail('ENOENT', operation, original);
    if (parent.kind !== 'dir') throw fail('ENOTDIR', operation, original);
  }

  async lstat(input: string): Promise<FileStat | null> {
    const node = this.nodes.get(this.canonical(input, false));
    if (node === undefined) return null;
    if (node.kind === 'file') return { kind: 'file', mode: node.mode, size: node.data.byteLength };
    if (node.kind === 'dir') return { kind: 'dir', mode: node.mode, size: 0 };
    return { kind: 'symlink', mode: 0o777, size: node.target.length };
  }

  async readFile(input: string): Promise<Uint8Array> {
    const node = this.nodes.get(this.canonical(input, true));
    if (node === undefined) throw fail('ENOENT', 'read', input);
    if (node.kind !== 'file') throw fail('EISDIR', 'read', input);
    return new Uint8Array(node.data);
  }

  async writeFile(input: string, data: Uint8Array, options: WriteOptions = {}): Promise<void> {
    const target = this.canonical(input, !options.exclusive);
    this.requireParentDir(target, 'write', input);
    const existing = this.nodes.get(target);
    if (options.exclusive && existing !== undefined) throw fail('EEXIST', 'write', input);
    if (existing?.kind === 'dir') throw fail('EISDIR', 'write', input);
    const mode = existing?.kind === 'file' ? existing.mode : (options.mode ?? 0o644);
    this.nodes.set(target, { kind: 'file', data: new Uint8Array(data), mode });
  }

  async mkdir(input: string): Promise<void> {
    const target = this.canonical(input, true);
    let acc = '';
    for (const part of target.split('/').filter(Boolean)) {
      acc = `${acc}/${part}`;
      const existing = this.nodes.get(acc);
      if (existing === undefined) this.nodes.set(acc, { kind: 'dir', mode: 0o755 });
      else if (existing.kind !== 'dir') throw fail('EEXIST', 'create directory', input);
    }
  }

  async readdir(input: string): Promise<string[]> {
    const target = this.canonical(input, true);
    const node = this.nodes.get(target);
    if (node === undefined) throw fail('ENOENT', 'list', input);
    if (node.kind !== 'dir') throw fail('ENOTDIR', 'list', input);
    const prefix = target === '/' ? '/' : `${target}/`;
    const names = new Set<string>();
    for (const key of this.nodes.keys()) {
      if (key !== target && key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0] ?? '');
    }
    return [...names].sort();
  }

  async rename(from: string, to: string): Promise<void> {
    const source = this.canonical(from, false);
    const destination = this.canonical(to, false);
    const node = this.nodes.get(source);
    if (node === undefined) throw fail('ENOENT', 'move', from);
    this.requireParentDir(destination, 'move', to);
    const existing = this.nodes.get(destination);
    if (existing?.kind === 'dir') throw fail('EISDIR', 'move', to);
    if (node.kind === 'dir') {
      const moved = [...this.nodes.entries()].filter(([key]) => key === source || key.startsWith(`${source}/`));
      for (const [key] of moved) this.nodes.delete(key);
      for (const [key, value] of moved) this.nodes.set(destination + key.slice(source.length), value);
    } else {
      this.nodes.delete(source);
      this.nodes.set(destination, node);
    }
  }

  async remove(input: string, options: { recursive?: boolean } = {}): Promise<void> {
    const target = this.canonical(input, false);
    const node = this.nodes.get(target);
    if (node === undefined) return;
    if (node.kind === 'dir') {
      const children = [...this.nodes.keys()].filter((key) => key.startsWith(`${target}/`));
      if (children.length > 0 && !options.recursive) throw fail('ENOTEMPTY', 'remove', input);
      for (const key of children) this.nodes.delete(key);
    }
    this.nodes.delete(target);
  }

  async realpath(input: string): Promise<string> {
    const target = this.canonical(input, true);
    if (!this.nodes.has(target)) throw fail('ENOENT', 'resolve', input);
    return target;
  }

  // ---- Test helpers (not part of the FileSystem port) ----

  /** Create a symlink whose target is stored verbatim. */
  symlink(linkPath: string, target: string): void {
    const location = this.canonical(linkPath, false);
    this.nodes.set(location, { kind: 'symlink', target: toMemoryPath(target) });
  }

  /** Create files (and parent directories) from a path -> content map. */
  seed(files: Readonly<Record<string, string>>): void {
    for (const [file, content] of Object.entries(files)) {
      const target = posix.resolve('/', toMemoryPath(file));
      let acc = '';
      for (const part of posix.dirname(target).split('/').filter(Boolean)) {
        acc = `${acc}/${part}`;
        if (!this.nodes.has(acc)) this.nodes.set(acc, { kind: 'dir', mode: 0o755 });
      }
      this.nodes.set(target, { kind: 'file', data: new TextEncoder().encode(content), mode: 0o644 });
    }
  }

  /** Every entry as "kind mode content" keyed by path. Used to assert that a tree did not change. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, node] of [...this.nodes.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (node.kind === 'file') out[key] = `file ${node.mode.toString(8)} ${Buffer.from(node.data).toString('base64')}`;
      else if (node.kind === 'dir') out[key] = `dir ${node.mode.toString(8)}`;
      else out[key] = `symlink ${node.target}`;
    }
    return out;
  }

  text(file: string): string {
    const node = this.nodes.get(this.canonical(file, true));
    if (node?.kind !== 'file') throw new Error(`No such file in memory fs: ${file}`);
    return new TextDecoder().decode(node.data);
  }

  mode(file: string): number {
    const node = this.nodes.get(this.canonical(file, true));
    if (node === undefined || node.kind === 'symlink') throw new Error(`No such entry in memory fs: ${file}`);
    return node.mode;
  }
}
