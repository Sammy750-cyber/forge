import path from 'node:path';
import type { FileSystem } from '../../ports/index.js';
import type { ForgeState } from '../state/state.js';
import { sha256Hex } from '../util/hash.js';
import type { ProjectView } from './types.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.forge', 'dist', 'build', 'coverage', '.next', '.venv', 'vendor', '__pycache__', '.turbo']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|eot|jar|wasm|lock|lockb|map)$/i;
const MAX_FILES = 5_000;
const MAX_BYTES = 256 * 1024;

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * Inspection may look anywhere inside the project, including Forge's own .forge directory (which template
 * output may not touch), but never outside it.
 */
function safeRelative(relative: string): string {
  const segments = relative.split('/');
  if (relative === '' || relative.startsWith('/') || relative.includes('\\') || relative.includes('\0') || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`Unsafe project path: ${JSON.stringify(relative)}`);
  }
  return relative;
}

export function createProjectView(fs: FileSystem, root: string, state: ForgeState | null): ProjectView {
  const abs = (relative: string): string => path.join(path.resolve(root), ...safeRelative(relative).split('/'));
  // Never read through a symlink: a link could point at a file outside the project.
  const readableFile = async (relative: string): Promise<string | null> => {
    const segments = relative.split('/');
    let current = path.resolve(root);
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat === null || stat.kind === 'symlink') return null;
      if (index === segments.length - 1) return stat.kind === 'file' ? current : null;
    }
    return null;
  };

  const view: ProjectView = {
    root: path.resolve(root),
    state,
    async exists(relative) {
      return (await fs.lstat(abs(relative))) !== null;
    },
    async read(relative) {
      const file = await readableFile(safeRelative(relative));
      return file === null ? null : decode(await fs.readFile(file));
    },
    async readJson(relative) {
      const text = await view.read(relative);
      if (text === null) return null;
      try {
        const value: unknown = JSON.parse(text);
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    },
    async list(relative) {
      const dir = relative === '' ? path.resolve(root) : abs(relative);
      return (await fs.lstat(dir))?.kind === 'dir' ? fs.readdir(dir) : [];
    },
    async walk() {
      const found: string[] = [];
      const visit = async (relative: string): Promise<void> => {
        for (const name of await view.list(relative)) {
          if (found.length >= MAX_FILES) return;
          const child = relative === '' ? name : `${relative}/${name}`;
          const stat = await fs.lstat(path.join(path.resolve(root), ...child.split('/')));
          if (stat === null || stat.kind === 'symlink') continue;
          if (stat.kind === 'dir') {
            if (!SKIP_DIRS.has(name)) await visit(child);
          } else if (stat.size <= MAX_BYTES && !BINARY.test(name)) found.push(child);
        }
      };
      await visit('');
      return found.sort();
    },
    async hash(relative) {
      const file = await readableFile(safeRelative(relative));
      return file === null ? null : sha256Hex(await fs.readFile(file));
    },
  };
  return view;
}
