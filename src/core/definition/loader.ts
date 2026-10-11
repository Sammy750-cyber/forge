import path from 'node:path';
import { DefinitionError } from '../../errors/index.js';
import type { FileSystem } from '../../ports/index.js';
import { parseManifest, type Manifest } from './manifest.js';

const MAX_FILES = 5_000;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const ID = /^[a-z][a-z0-9-]*$/;

export interface SourceFile {
  /** Path relative to the definition's files/ directory, using "/" separators. */
  readonly sourcePath: string;
  readonly content: Uint8Array;
}

export interface Partial {
  readonly name: string;
  readonly source: string;
}

export interface LoadedDefinition {
  readonly manifest: Manifest;
  readonly files: readonly SourceFile[];
  readonly partials: readonly Partial[];
  /** Where it was loaded from, for messages. */
  readonly origin: string;
}

export interface DefinitionSource {
  list(): Promise<string[]>;
  load(id: string): Promise<LoadedDefinition>;
}

const MANIFEST_NAMES = { template: 'forge.template.json', feature: 'forge.feature.json' } as const;

interface Budget {
  files: number;
  bytes: number;
}

async function walk(fs: FileSystem, root: string, relative: string, budget: Budget, out: SourceFile[]): Promise<void> {
  const directory = relative === '' ? root : path.join(root, ...relative.split('/'));
  for (const name of await fs.readdir(directory)) {
    const childRelative = relative === '' ? name : `${relative}/${name}`;
    const childPath = path.join(directory, name);
    const stat = await fs.lstat(childPath);
    if (stat === null) continue;
    if (stat.kind === 'symlink') {
      throw new DefinitionError(`${childPath}: symbolic links are not allowed inside templates.`, { code: 'FORGE_E_TEMPLATE_SYMLINK' });
    }
    if (stat.kind === 'dir') {
      await walk(fs, root, childRelative, budget, out);
      continue;
    }
    budget.files += 1;
    budget.bytes += stat.size;
    if (budget.files > MAX_FILES || budget.bytes > MAX_TOTAL_BYTES) {
      throw new DefinitionError(`${root}: template exceeds the size limits (${MAX_FILES} files, ${MAX_TOTAL_BYTES} bytes).`, {
        code: 'FORGE_E_TEMPLATE_TOO_LARGE',
      });
    }
    out.push({ sourcePath: childRelative, content: await fs.readFile(childPath) });
  }
}

/** Reads definitions laid out as `<root>/<id>/forge.<kind>.json` with files/ and partials/ directories. */
export class DirectoryDefinitionSource implements DefinitionSource {
  constructor(
    private readonly fs: FileSystem,
    private readonly root: string,
    private readonly kind: 'template' | 'feature',
  ) {}

  async list(): Promise<string[]> {
    if ((await this.fs.lstat(this.root))?.kind !== 'dir') return [];
    const ids: string[] = [];
    for (const name of await this.fs.readdir(this.root)) {
      const manifest = path.join(this.root, name, MANIFEST_NAMES[this.kind]);
      if ((await this.fs.lstat(manifest))?.kind === 'file') ids.push(name);
    }
    return ids;
  }

  async load(id: string): Promise<LoadedDefinition> {
    if (!ID.test(id)) {
      throw new DefinitionError(`"${id}" is not a valid ${this.kind} id.`, {
        code: 'FORGE_E_NOT_FOUND',
        hint: 'Ids are lowercase letters, digits and hyphens.',
      });
    }
    const directory = path.join(this.root, id);
    const manifestPath = path.join(directory, MANIFEST_NAMES[this.kind]);
    if ((await this.fs.lstat(manifestPath))?.kind !== 'file') {
      const available = await this.list();
      throw new DefinitionError(`No ${this.kind} named "${id}" was found.`, {
        code: 'FORGE_E_NOT_FOUND',
        hint: available.length > 0 ? `Available: ${available.join(', ')}.` : `There are no ${this.kind}s installed.`,
      });
    }

    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(await this.fs.readFile(manifestPath)));
    } catch (error) {
      throw new DefinitionError(`${manifestPath}: not valid JSON.`, { code: 'FORGE_E_MANIFEST_INVALID', cause: error });
    }
    const manifest = parseManifest(raw, manifestPath);
    if (manifest.id !== id || manifest.kind !== this.kind) {
      throw new DefinitionError(`${manifestPath}: manifest id/kind (${manifest.id}/${manifest.kind}) does not match its location.`, {
        code: 'FORGE_E_MANIFEST_INVALID',
      });
    }

    const budget: Budget = { files: 0, bytes: 0 };
    const files: SourceFile[] = [];
    const filesRoot = path.join(directory, 'files');
    if ((await this.fs.lstat(filesRoot))?.kind === 'dir') await walk(this.fs, filesRoot, '', budget, files);

    const partialFiles: SourceFile[] = [];
    const partialsRoot = path.join(directory, 'partials');
    if ((await this.fs.lstat(partialsRoot))?.kind === 'dir') await walk(this.fs, partialsRoot, '', budget, partialFiles);
    const partials = partialFiles
      .filter((f) => f.sourcePath.endsWith('.hbs'))
      .map((f) => ({ name: f.sourcePath.slice(0, -'.hbs'.length), source: new TextDecoder().decode(f.content) }));

    const known = new Set(files.map((f) => f.sourcePath));
    for (const rule of manifest.files) {
      if (!known.has(rule.path)) {
        throw new DefinitionError(`${manifestPath}: file rule refers to "${rule.path}", which does not exist under files/.`, {
          code: 'FORGE_E_MANIFEST_INVALID',
        });
      }
    }
    return { manifest, files, partials, origin: directory };
  }
}
