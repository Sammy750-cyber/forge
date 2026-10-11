import path from 'node:path';
import { z } from 'zod';
import { StateError } from '../../errors/index.js';
import type { FileSystem } from '../../ports/index.js';
import { validateRelativePath } from '../util/safe-path.js';
import { stableStringify } from '../util/stable-json.js';

export const STATE_PATH = '.forge/state.json';
export const STATE_SCHEMA_VERSION = 1;

const answerValue = z.union([z.string(), z.boolean(), z.number(), z.null()]);

const stateSchema = z.strictObject({
  schemaVersion: z.literal(STATE_SCHEMA_VERSION),
  forgeVersion: z.string().min(1),
  /** Null for projects that were not created from a template (features were added to an existing repo). */
  template: z.strictObject({ id: z.string().min(1), version: z.string().min(1) }).nullable(),
  name: z.string().min(1).optional(),
  features: z.array(z.strictObject({ id: z.string().min(1), version: z.string().min(1) })),
  answers: z.record(z.string(), answerValue),
  /** project-relative path -> SHA-256 of the content Forge last wrote there. */
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
});

export type ForgeState = z.infer<typeof stateSchema>;

export function serializeState(state: ForgeState): Uint8Array {
  return new TextEncoder().encode(stableStringify(state));
}

/** Read `.forge/state.json`. Returns null if the project has none. */
export async function readState(fs: FileSystem, root: string): Promise<ForgeState | null> {
  const file = path.join(root, ...STATE_PATH.split('/'));
  const stat = await fs.lstat(file);
  if (stat === null) return null;
  if (stat.kind !== 'file') throw new StateError(`${file} exists but is not a file.`);

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(await fs.readFile(file)));
  } catch (error) {
    throw new StateError(`${file} is not valid JSON.`, {
      cause: error,
      hint: 'Restore it from version control, or delete .forge/ to start fresh (Forge will then treat existing files as unmanaged).',
    });
  }

  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version === 'number' && version > STATE_SCHEMA_VERSION) {
    throw new StateError(`${file} was written by a newer Forge (state schema ${version}; this Forge understands ${STATE_SCHEMA_VERSION}).`, {
      code: 'FORGE_E_STATE_NEWER',
      hint: 'Upgrade Forge to a version that supports this project.',
    });
  }

  const result = stateSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new StateError(`${file} is invalid (${details}).`, { code: 'FORGE_E_STATE_INVALID' });
  }
  for (const key of Object.keys(result.data.files)) {
    try {
      validateRelativePath(key);
    } catch (error) {
      throw new StateError(`${file} lists an unsafe path ${JSON.stringify(key)}.`, { code: 'FORGE_E_STATE_INVALID', cause: error });
    }
  }
  return result.data;
}
