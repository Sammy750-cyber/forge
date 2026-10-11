import path from 'node:path';
import { ConfigError } from '../../errors/index.js';
import type { FileSystem } from '../../ports/index.js';
import type { ConfigLayer } from './resolve.js';
import { CONFIG_KEYS, configSchema } from './schema.js';

export const PROJECT_CONFIG_NAME = 'forge.config.json';

export interface LoadedLayer {
  readonly layer: ConfigLayer;
  /** Non-fatal problems such as unknown keys. */
  readonly warnings: readonly string[];
}

/** Validate an untrusted object. Unknown keys become warnings; invalid values are errors. */
export function parseConfigObject(raw: unknown, source: string): LoadedLayer {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${source}: configuration must be a JSON object.`, { code: 'FORGE_E_CONFIG_INVALID' });
  }
  const input = raw as Record<string, unknown>;
  const known: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if ((CONFIG_KEYS as string[]).includes(key)) known[key] = value;
    else warnings.push(`${source}: ignoring unknown key "${key}".`);
  }
  const result = configSchema.safeParse(known);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new ConfigError(`${source}: invalid configuration (${details}).`, {
      code: 'FORGE_E_CONFIG_INVALID',
      hint: 'Run "forge config" to see the effective configuration and where each value comes from.',
    });
  }
  return { layer: { source, values: result.data }, warnings };
}

/** Read a JSON config file. Returns null when the file does not exist. */
export async function loadConfigFile(fs: FileSystem, file: string): Promise<LoadedLayer | null> {
  const stat = await fs.lstat(file);
  if (stat === null) return null;
  if (stat.kind !== 'file') throw new ConfigError(`${file}: expected a file.`, { code: 'FORGE_E_CONFIG_INVALID' });
  const text = new TextDecoder().decode(await fs.readFile(file));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file}: not valid JSON.`, { code: 'FORGE_E_CONFIG_INVALID', cause: error });
  }
  return parseConfigObject(parsed, file);
}

/** Walk up from `startDir` looking for forge.config.json. */
export async function findProjectConfig(fs: FileSystem, startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, PROJECT_CONFIG_NAME);
    const stat = await fs.lstat(candidate);
    if (stat?.kind === 'file') return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function parseBoolean(name: string, value: string): boolean {
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  throw new ConfigError(`${name}: expected 1, 0, true or false but got ${JSON.stringify(value)}.`, {
    code: 'FORGE_E_CONFIG_INVALID',
  });
}

/** Build a config layer from FORGE_* environment variables and the NO_COLOR convention. */
export function loadEnvLayer(env: Readonly<Record<string, string | undefined>>): LoadedLayer {
  const raw: Record<string, unknown> = {};
  const set = (variable: string, key: string, convert: (value: string) => unknown = (v) => v): void => {
    const value = env[variable];
    if (value !== undefined && value !== '') raw[key] = convert(value);
  };
  set('FORGE_TEMPLATE', 'template');
  set('FORGE_CI', 'ci');
  set('FORGE_CLOUD', 'cloud');
  set('FORGE_LOG_LEVEL', 'logLevel');
  set('FORGE_NO_INPUT', 'noInput', (v) => parseBoolean('FORGE_NO_INPUT', v));
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') raw['color'] = false;
  return parseConfigObject(raw, 'environment');
}
