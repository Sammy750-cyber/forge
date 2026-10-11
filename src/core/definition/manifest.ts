import { z } from 'zod';
import { DefinitionError } from '../../errors/index.js';

const ID = /^[a-z][a-z0-9-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RESERVED_QUESTION_IDS = new Set(['name', 'forge']);

const scalar = z.union([z.string(), z.boolean(), z.number()]);

/** A condition on an earlier answer. A tiny declarative form, not an expression language. */
export const whenSchema = z.strictObject({
  answer: z.string().regex(ID),
  equals: scalar.optional(),
  in: z.array(scalar).min(1).optional(),
  not: z.boolean().optional(),
});
export type When = z.infer<typeof whenSchema>;

const questionBase = {
  id: z.string().regex(ID, 'must be lowercase letters, digits and hyphens, starting with a letter'),
  message: z.string().min(1),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
  when: whenSchema.optional(),
};

export const questionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...questionBase,
    type: z.literal('string'),
    default: z.string().optional(),
    pattern: z.string().optional(),
  }),
  z.strictObject({ ...questionBase, type: z.literal('boolean'), default: z.boolean().optional() }),
  z.strictObject({
    ...questionBase,
    type: z.literal('enum'),
    choices: z.array(z.string().min(1)).min(1),
    default: z.string().optional(),
  }),
]);
export type Question = z.infer<typeof questionSchema>;

/** Per-file rules, keyed by the file's path under files/ (before any rendering). */
export const fileRuleSchema = z.strictObject({
  path: z.string().min(1),
  mergeStrategy: z.enum(['overwrite', 'none', 'json-merge', 'yaml-merge', 'line-set']).optional(),
  executable: z.boolean().optional(),
  binary: z.boolean().optional(),
  when: whenSchema.optional(),
});
export type FileRule = z.infer<typeof fileRuleSchema>;

export const CHECK_KINDS = ['secrets', 'dependencies', 'sast', 'iac', 'container', 'node-ci'] as const;

export const checkSchema = z.strictObject({ kind: z.enum(CHECK_KINDS), when: whenSchema.optional() });
export type Check = z.infer<typeof checkSchema>;

/** Declarative CI pipeline. Forge generates the provider's file from these checks; templates never supply CI code. */
export const pipelineSchema = z.strictObject({ checks: z.array(checkSchema).min(1) });

export const manifestSchema = z.strictObject({
  id: z.string().regex(ID),
  version: z.string().regex(SEMVER, 'must be a semantic version such as 1.2.3'),
  kind: z.enum(['template', 'feature']),
  description: z.string().min(1),
  requires: z
    .strictObject({
      features: z.array(z.string().regex(ID)).optional(),
      conflicts: z.array(z.string().regex(ID)).optional(),
    })
    .optional(),
  questions: z.array(questionSchema).default([]),
  files: z.array(fileRuleSchema).default([]),
  pipeline: pipelineSchema.optional(),
});
export type Manifest = z.infer<typeof manifestSchema>;

/** Parse and cross-validate a manifest. `origin` is used in error messages. */
export function parseManifest(raw: unknown, origin: string): Manifest {
  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new DefinitionError(`${origin}: invalid manifest (${details}).`, { code: 'FORGE_E_MANIFEST_INVALID' });
  }
  const manifest = result.data;
  const seen = new Set<string>();
  for (const question of manifest.questions) {
    const where = `${origin}: question "${question.id}"`;
    if (RESERVED_QUESTION_IDS.has(question.id)) {
      throw new DefinitionError(`${where} uses a reserved id.`, { code: 'FORGE_E_MANIFEST_INVALID' });
    }
    if (question.when !== undefined && !seen.has(question.when.answer)) {
      throw new DefinitionError(`${where} has a "when" that refers to "${question.when.answer}", which is not an earlier question.`, {
        code: 'FORGE_E_MANIFEST_INVALID',
      });
    }
    if (seen.has(question.id)) {
      throw new DefinitionError(`${where} is declared twice.`, { code: 'FORGE_E_MANIFEST_INVALID' });
    }
    if (question.type === 'enum' && question.default !== undefined && !question.choices.includes(question.default)) {
      throw new DefinitionError(`${where} has a default that is not one of its choices.`, { code: 'FORGE_E_MANIFEST_INVALID' });
    }
    if (question.type === 'string' && question.pattern !== undefined) {
      try {
        new RegExp(question.pattern);
      } catch (error) {
        throw new DefinitionError(`${where} has an invalid pattern.`, { code: 'FORGE_E_MANIFEST_INVALID', cause: error });
      }
    }
    seen.add(question.id);
  }
  if (manifest.pipeline !== undefined) {
    const provider = manifest.questions.find((q) => q.id === 'provider');
    if (provider?.type !== 'enum' || !provider.choices.every((c) => c === 'github' || c === 'gitlab')) {
      throw new DefinitionError(`${origin}: a pipeline needs an enum question "provider" whose choices are github and/or gitlab.`, {
        code: 'FORGE_E_MANIFEST_INVALID',
      });
    }
    for (const check of manifest.pipeline.checks) {
      if (check.when !== undefined && !seen.has(check.when.answer)) {
        throw new DefinitionError(`${origin}: pipeline check "${check.kind}" refers to unknown question "${check.when.answer}".`, {
          code: 'FORGE_E_MANIFEST_INVALID',
        });
      }
    }
  }
  const rulePaths = new Set<string>();
  for (const rule of manifest.files) {
    if (rulePaths.has(rule.path)) {
      throw new DefinitionError(`${origin}: file rule for "${rule.path}" is declared twice.`, { code: 'FORGE_E_MANIFEST_INVALID' });
    }
    rulePaths.add(rule.path);
    if (rule.when !== undefined && !seen.has(rule.when.answer)) {
      throw new DefinitionError(`${origin}: file rule "${rule.path}" refers to unknown question "${rule.when.answer}".`, {
        code: 'FORGE_E_MANIFEST_INVALID',
      });
    }
  }
  return manifest;
}
