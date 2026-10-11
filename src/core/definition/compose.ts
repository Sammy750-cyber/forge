import { DefinitionError } from '../../errors/index.js';
import { isMergeable, mergeContent } from '../merge/index.js';
import { renderDefinition, type RenderContext, type RenderedFile, type RenderResult, type SkippedFile } from '../render/renderer.js';
import type { QuestionSet } from './answers.js';
import type { LoadedDefinition } from './loader.js';
import type { Question } from './manifest.js';

export interface Composition {
  /** Base template first (if any), then features in dependency order. */
  readonly definitions: readonly LoadedDefinition[];
  /** One question per id across all definitions, so each thing is asked (and answered) once. */
  readonly questions: QuestionSet;
}

const sameChoices = (a: Question, b: Question): boolean =>
  a.type !== 'enum' || b.type !== 'enum' || a.choices.join('\0') === b.choices.join('\0');

/** Order features so that required ones come first; ties are alphabetical, which keeps output deterministic. */
function orderFeatures(features: readonly LoadedDefinition[]): LoadedDefinition[] {
  const byId = new Map(features.map((f) => [f.manifest.id, f]));
  const ordered: LoadedDefinition[] = [];
  const visiting = new Set<string>();
  const visit = (feature: LoadedDefinition): void => {
    const id = feature.manifest.id;
    if (ordered.includes(feature)) return;
    if (visiting.has(id)) throw new DefinitionError(`Features require each other in a cycle at "${id}".`, { code: 'FORGE_E_FEATURE_CYCLE' });
    visiting.add(id);
    for (const required of feature.manifest.requires?.features ?? []) {
      const dependency = byId.get(required);
      if (dependency === undefined) {
        throw new DefinitionError(`Feature "${id}" requires "${required}".`, {
          code: 'FORGE_E_FEATURE_REQUIRES',
          hint: `Add it too: --feature ${required} (or "forge add ${required}").`,
        });
      }
      visit(dependency);
    }
    visiting.delete(id);
    ordered.push(feature);
  };
  for (const feature of [...features].sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : 1))) visit(feature);
  return ordered;
}

export function compose(base: LoadedDefinition | null, features: readonly LoadedDefinition[]): Composition {
  if (base !== null && base.manifest.kind !== 'template') {
    throw new DefinitionError(`"${base.manifest.id}" is a ${base.manifest.kind}, not a template.`, { code: 'FORGE_E_DEFINITION' });
  }
  const unique = [...new Map(features.map((f) => [f.manifest.id, f])).values()];
  for (const feature of unique) {
    if (feature.manifest.kind !== 'feature') {
      throw new DefinitionError(`"${feature.manifest.id}" is a ${feature.manifest.kind}, not a feature.`, { code: 'FORGE_E_DEFINITION' });
    }
  }
  const present = new Set(unique.map((f) => f.manifest.id));
  for (const feature of unique) {
    for (const conflict of feature.manifest.requires?.conflicts ?? []) {
      if (present.has(conflict)) {
        throw new DefinitionError(`Feature "${feature.manifest.id}" cannot be combined with "${conflict}".`, { code: 'FORGE_E_FEATURE_CONFLICT' });
      }
    }
  }
  const definitions = [...(base === null ? [] : [base]), ...orderFeatures(unique)];

  const questions = new Map<string, Question>();
  for (const definition of definitions) {
    for (const question of definition.manifest.questions) {
      const known = questions.get(question.id);
      if (known === undefined) questions.set(question.id, question);
      else if (known.type !== question.type || !sameChoices(known, question)) {
        throw new DefinitionError(`"${definition.manifest.id}" declares question "${question.id}" differently from an earlier definition.`, {
          code: 'FORGE_E_QUESTION_MISMATCH',
          hint: 'Questions that share an id must have the same type and choices.',
        });
      }
    }
  }
  return { definitions, questions: { id: definitions.map((d) => d.manifest.id).join('+') || 'none', questions: [...questions.values()] } };
}

export interface OwnedFile {
  readonly file: RenderedFile;
  /** Who produced it (a definition id or a doctor rule), for error messages. */
  readonly owner: string;
}

/** Combine files from several producers. Two may share a path only if they are identical or both declare the same merge strategy. */
export function combineFiles(entries: readonly OwnedFile[]): RenderedFile[] {
  const files = new Map<string, OwnedFile>();
  for (const { file, owner } of entries) {
    const key = file.path.toLowerCase();
    const existing = files.get(key);
    if (existing === undefined) {
      files.set(key, { file, owner });
      continue;
    }
    const clash = (detail: string): DefinitionError =>
      new DefinitionError(`"${existing.owner}" and "${owner}" both write ${file.path}: ${detail}.`, {
        code: 'FORGE_E_FEATURE_CONFLICT',
        hint: 'Features that share a file must declare a mergeStrategy (json-merge, yaml-merge or line-set) for it.',
      });
    const same = Buffer.from(existing.file.content).equals(Buffer.from(file.content)) && existing.file.mode === file.mode;
    if (same) continue;
    const strategy = existing.file.mergeStrategy;
    if (strategy !== file.mergeStrategy || !isMergeable(strategy)) throw clash('they differ and the file is not mergeable');
    const merged = mergeContent(strategy, new TextDecoder().decode(existing.file.content), new TextDecoder().decode(file.content));
    if (!merged.ok) throw clash(merged.reason);
    files.set(key, { file: { ...existing.file, content: new TextEncoder().encode(merged.content) }, owner: existing.owner });
  }
  return [...files.values()].map((entry) => entry.file).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Render every definition and combine the files. */
export function renderComposition(composition: Composition, context: RenderContext): RenderResult {
  const entries: OwnedFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const definition of composition.definitions) {
    const rendered = renderDefinition(definition, context);
    skipped.push(...rendered.skipped);
    for (const file of rendered.files) entries.push({ file, owner: definition.manifest.id });
  }
  return { files: combineFiles(entries), skipped };
}
