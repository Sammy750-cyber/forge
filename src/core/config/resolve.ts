import { CONFIG_KEYS, DEFAULT_CONFIG, type ConfigKey, type ForgeConfig, type PartialConfig } from './schema.js';

export interface ConfigLayer {
  /** Human-readable origin, for example "flag", "env", or a file path. */
  readonly source: string;
  readonly values: PartialConfig;
}

export interface ResolvedConfig {
  readonly values: ForgeConfig;
  /** Where each effective value came from. */
  readonly sources: Readonly<Record<ConfigKey, string>>;
}

/**
 * Merge layers into one effective config. `layers` are ordered lowest to highest precedence;
 * built-in defaults sit beneath all of them.
 */
export function resolveConfig(layers: readonly ConfigLayer[]): ResolvedConfig {
  const values: Record<string, unknown> = { ...DEFAULT_CONFIG };
  const sources = Object.fromEntries(CONFIG_KEYS.map((key) => [key, 'default'])) as Record<ConfigKey, string>;
  for (const layer of layers) {
    for (const key of CONFIG_KEYS) {
      const value = layer.values[key];
      if (key === 'doctor') {
        // Nested settings merge key by key, so setting only `waivers` cannot silently reset `failOn`.
        if (layer.values.doctor !== undefined) {
          values['doctor'] = { ...(values['doctor'] as object), ...layer.values.doctor };
          sources[key] = layer.source;
        }
        continue;
      }
      if (value !== undefined) {
        values[key] = value;
        sources[key] = layer.source;
      }
    }
  }
  return { values: values as unknown as ForgeConfig, sources };
}
