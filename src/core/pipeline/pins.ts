import { z } from 'zod';
import { ConfigError } from '../../errors/index.js';
import type { FileSystem } from '../../ports/index.js';

const pinsSchema = z.strictObject({
  minAgeDays: z.number().int().min(0),
  actions: z.record(z.string(), z.strictObject({ version: z.string().min(1), sha: z.string().regex(/^[0-9a-f]{40}$/) })),
  tools: z.record(z.string(), z.strictObject({ version: z.string().min(1) })),
});
export type Pins = z.infer<typeof pinsSchema>;

/**
 * The inputs Forge passes to each pinned action. Tests check them against the action.yml at the pinned commit,
 * so a version bump that renames an input is caught before it reaches a generated pipeline.
 */
export const ACTION_INPUTS: Readonly<Record<string, readonly string[]>> = {
  'actions/checkout': ['fetch-depth', 'persist-credentials'],
  'actions/setup-node': ['node-version', 'cache'],
  'actions/setup-python': ['python-version'],
  'pnpm/action-setup': ['package_json_file'],
  'trufflesecurity/trufflehog': ['extra_args', 'version'],
  'aquasecurity/trivy-action': ['scan-type', 'scan-ref', 'image-ref', 'scanners', 'severity', 'exit-code', 'ignore-unfixed'],
};

export async function loadPins(fs: FileSystem, file: string): Promise<Pins> {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(await fs.readFile(file)));
  } catch (error) {
    throw new ConfigError(`Could not read pinned versions from ${file}.`, {
      code: 'FORGE_E_PINS',
      cause: error,
      hint: 'Run "node scripts/update-pins.mjs" to regenerate pins/pins.json.',
    });
  }
  const parsed = pinsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`${file} is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, {
      code: 'FORGE_E_PINS',
    });
  }
  return parsed.data;
}
