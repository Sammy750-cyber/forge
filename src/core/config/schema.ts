import { z } from 'zod';

const waiverSchema = z.strictObject({
  rule: z.string().min(1),
  /** A waiver without a stated reason is just a silenced alarm, so a real sentence is required. */
  reason: z.string().min(10, 'must explain why the rule does not apply (at least 10 characters)'),
});

export const configSchema = z.strictObject({
  template: z.string().min(1).optional(),
  ci: z.enum(['github', 'gitlab', 'none']).optional(),
  cloud: z.enum(['aws', 'azure', 'gcp', 'none']).optional(),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).optional(),
  color: z.boolean().optional(),
  noInput: z.boolean().optional(),
  doctor: z
    .strictObject({ failOn: z.enum(['error', 'warn']).optional(), waivers: z.array(waiverSchema).optional() })
    .optional(),
});

export type PartialConfig = z.infer<typeof configSchema>;
export type ConfigKey = keyof PartialConfig;
export const CONFIG_KEYS = Object.keys(configSchema.shape) as ConfigKey[];

export interface ForgeConfig {
  readonly template: string;
  readonly ci: 'github' | 'gitlab' | 'none';
  readonly cloud: 'aws' | 'azure' | 'gcp' | 'none';
  readonly logLevel: 'error' | 'warn' | 'info' | 'debug';
  readonly color: boolean;
  readonly noInput: boolean;
  readonly doctor: { readonly failOn: 'error' | 'warn'; readonly waivers: readonly { readonly rule: string; readonly reason: string }[] };
}

export const DEFAULT_CONFIG: ForgeConfig = {
  template: 'express-api',
  ci: 'github',
  cloud: 'none',
  logLevel: 'info',
  color: true,
  noInput: false,
  doctor: { failOn: 'error', waivers: [] },
};
