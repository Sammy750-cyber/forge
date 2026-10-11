import path from 'node:path';
import type { FileSystem } from '../../ports/index.js';
import { sha256Hex } from '../util/hash.js';
import { resolveInside } from '../util/safe-path.js';

export type DiskEntry =
  | { readonly kind: 'missing' }
  | { readonly kind: 'file'; readonly hash: string; readonly mode: number; readonly content: Uint8Array }
  | { readonly kind: 'dir' }
  | { readonly kind: 'blocked'; readonly reason: string };

/**
 * Describe what is on disk at `relativePath` under `root` without ever following a symlink.
 * Any symlink on the way down, or a file where a directory should be, is reported as `blocked`.
 */
export async function inspectPath(fs: FileSystem, root: string, relativePath: string): Promise<DiskEntry> {
  const absolute = resolveInside(root, relativePath);
  const segments = relativePath.split('/');
  let current = path.resolve(root);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat === null) return { kind: 'missing' };
    if (stat.kind === 'symlink') return { kind: 'blocked', reason: `${segments.slice(0, index + 1).join('/')} is a symbolic link` };
    const isLast = index === segments.length - 1;
    if (!isLast && stat.kind !== 'dir') {
      return { kind: 'blocked', reason: `${segments.slice(0, index + 1).join('/')} is a file, but a directory is needed` };
    }
    if (isLast) {
      if (stat.kind === 'dir') return { kind: 'dir' };
      const content = await fs.readFile(absolute);
      return { kind: 'file', hash: sha256Hex(content), mode: stat.mode, content };
    }
  }
  return { kind: 'missing' };
}

export async function snapshotDisk(
  fs: FileSystem,
  root: string,
  relativePaths: readonly string[],
): Promise<Map<string, DiskEntry>> {
  const rootStat = await fs.lstat(root);
  const snapshot = new Map<string, DiskEntry>();
  for (const relativePath of relativePaths) {
    snapshot.set(relativePath, rootStat?.kind === 'dir' ? await inspectPath(fs, root, relativePath) : { kind: 'missing' });
  }
  return snapshot;
}
