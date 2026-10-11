import path from 'node:path';
import type { RawAnswers } from '../core/definition/answers.js';
import type { FileSystem } from '../ports/index.js';

export interface Detection {
  /** A project name that satisfies Forge's naming rules. */
  readonly name: string;
  /** Facts read from the repository, used as answers so users are not asked what Forge can see. */
  readonly hints: RawAnswers;
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function readText(fs: FileSystem, file: string): Promise<string | null> {
  const stat = await fs.lstat(file);
  return stat?.kind === 'file' ? decode(await fs.readFile(file)) : null;
}

async function readJson(fs: FileSystem, file: string): Promise<Record<string, unknown> | null> {
  const text = await readText(fs, file);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function sanitizeName(raw: string): string {
  const cleaned = raw
    .replace(/^@[^/]+\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 214);
  return cleaned === '' ? 'project' : cleaned;
}

/** Look at an existing repository and report what can be inferred without asking. */
export async function detectProject(fs: FileSystem, root: string): Promise<Detection> {
  const hints: Record<string, string | boolean> = {};
  const exists = async (relative: string): Promise<boolean> => (await fs.lstat(path.join(root, relative))) !== null;

  if (await exists('.gitlab-ci.yml')) hints['provider'] = 'gitlab';
  else if (await exists('.github')) hints['provider'] = 'github';

  if (await exists('Dockerfile')) {
    hints['docker'] = true;
    hints['dockerfile'] = 'Dockerfile';
  }
  if (await exists('pnpm-lock.yaml')) hints['package-manager'] = 'pnpm';
  else if (await exists('package-lock.json')) hints['package-manager'] = 'npm';

  const head = await readText(fs, path.join(root, '.git', 'HEAD'));
  const branch = head === null ? null : /^ref: refs\/heads\/([A-Za-z0-9._/-]+)\s*$/.exec(head)?.[1];
  if (branch !== null && branch !== undefined) hints['default-branch'] = branch;

  const pkg = await readJson(fs, path.join(root, 'package.json'));
  const nvmrc = await readText(fs, path.join(root, '.nvmrc'));
  const engines = (pkg?.['engines'] as { node?: unknown } | undefined)?.node;
  const nodeMajor = /^v?(\d{2})/.exec(nvmrc?.trim() ?? '')?.[1] ?? (typeof engines === 'string' ? /(\d{2})/.exec(engines)?.[1] : undefined);
  if (nodeMajor !== undefined) hints['node-version'] = nodeMajor;

  const packageName = typeof pkg?.['name'] === 'string' ? pkg['name'] : path.basename(path.resolve(root));
  return { name: sanitizeName(packageName), hints };
}
