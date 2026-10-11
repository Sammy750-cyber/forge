import Handlebars from 'handlebars';
import { DefinitionError } from '../../errors/index.js';
import { evaluateWhen, type Answers } from '../definition/answers.js';
import type { LoadedDefinition } from '../definition/loader.js';
import type { FileRule } from '../definition/manifest.js';
import { validateRelativePath } from '../util/safe-path.js';
import { buildPipelineFiles } from '../pipeline/build.js';
import type { Pins } from '../pipeline/pins.js';
import { registerHelpers } from './helpers.js';

export type { MergeStrategy } from '../merge/index.js';
import type { MergeStrategy } from '../merge/index.js';

export interface RenderedFile {
  /** Final project-relative path, "/"-separated and validated. */
  readonly path: string;
  readonly content: Uint8Array;
  readonly mode: number;
  readonly mergeStrategy: MergeStrategy;
  readonly sourcePath: string;
}

export interface SkippedFile {
  readonly sourcePath: string;
  readonly reason: string;
}

export interface RenderResult {
  readonly files: readonly RenderedFile[];
  readonly skipped: readonly SkippedFile[];
}

export interface RenderContext {
  readonly name: string;
  readonly answers: Answers;
  /** Pinned action and tool versions. Required only by definitions that declare a pipeline. */
  readonly pins?: Pins | undefined;
}

const TEMPLATE_SUFFIX = '.hbs';
const DOT_PREFIX = '_dot_';
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|eot|jar|wasm)$/i;

function looksBinary(content: Uint8Array): boolean {
  const sample = content.subarray(0, 8000);
  if (sample.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    return false;
  } catch {
    return true;
  }
}

/** LF line endings and exactly the trailing newline a text file should have. */
function normalizeText(text: string): string {
  const unix = text.replace(/\r\n/g, '\n');
  return unix.length === 0 || unix.endsWith('\n') ? unix : `${unix}\n`;
}

/** `_dot_gitignore` -> `.gitignore`. npm refuses to publish files literally named .gitignore. */
function restoreDots(sourcePath: string): string {
  return sourcePath
    .split('/')
    .map((segment) => (segment.startsWith(DOT_PREFIX) ? `.${segment.slice(DOT_PREFIX.length)}` : segment))
    .join('/');
}

/**
 * Render a definition to an in-memory set of files. Pure: no I/O, no clock, no randomness,
 * so identical inputs always produce byte-identical output.
 */
export function renderDefinition(definition: LoadedDefinition, context: RenderContext): RenderResult {
  const hb = Handlebars.create();
  registerHelpers(hb);
  for (const partial of definition.partials) hb.registerPartial(partial.name, partial.source);

  const scope = { ...context.answers, name: context.name };
  const evaluate = (source: string, label: string): string => {
    try {
      return hb.compile(source, { noEscape: true, strict: true })(scope);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new DefinitionError(`${definition.origin}: failed to render ${label}: ${detail}`, {
        code: 'FORGE_E_RENDER_FAILED',
        hint: 'Check the template syntax, and that every variable it uses is declared as a question.',
        cause: error,
      });
    }
  };

  const rules = new Map<string, FileRule>(definition.manifest.files.map((rule) => [rule.path, rule]));
  const sources = [...definition.files].sort((a, b) => (a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0));

  const files: RenderedFile[] = [];
  const skipped: SkippedFile[] = [];
  const claimed = new Map<string, string>();

  for (const source of sources) {
    const rule = rules.get(source.sourcePath);
    if (!evaluateWhen(rule?.when, context.answers)) {
      skipped.push({ sourcePath: source.sourcePath, reason: `condition on "${rule?.when?.answer}" not met` });
      continue;
    }

    const binary = rule?.binary === true || BINARY_EXTENSIONS.test(source.sourcePath) || looksBinary(source.content);
    const isTemplate = !binary && source.sourcePath.endsWith(TEMPLATE_SUFFIX);

    let relative = isTemplate ? source.sourcePath.slice(0, -TEMPLATE_SUFFIX.length) : source.sourcePath;
    relative = restoreDots(relative);
    if (relative.includes('{{')) relative = evaluate(relative, `the path of ${source.sourcePath}`);
    const outputPath = validateRelativePath(relative);

    const key = outputPath.toLowerCase();
    const previous = claimed.get(key);
    if (previous !== undefined) {
      throw new DefinitionError(`${definition.origin}: "${previous}" and "${source.sourcePath}" both produce "${outputPath}".`, {
        code: 'FORGE_E_DUPLICATE_OUTPUT',
        hint: 'Output paths must be unique, ignoring letter case, so projects work on every filesystem.',
      });
    }
    claimed.set(key, source.sourcePath);

    let content: Uint8Array = source.content;
    if (!binary) {
      const text = new TextDecoder().decode(source.content);
      content = new TextEncoder().encode(normalizeText(isTemplate ? evaluate(text, source.sourcePath) : text));
    }

    files.push({
      path: outputPath,
      content,
      mode: rule?.executable === true ? 0o755 : 0o644,
      mergeStrategy: rule?.mergeStrategy ?? 'overwrite',
      sourcePath: source.sourcePath,
    });
  }

  for (const generated of buildPipelineFiles(definition.manifest, context.answers, context.name, context.pins)) {
    const key = generated.path.toLowerCase();
    const previous = claimed.get(key);
    if (previous !== undefined) {
      throw new DefinitionError(`${definition.origin}: the generated pipeline file "${generated.path}" collides with "${previous}".`, {
        code: 'FORGE_E_DUPLICATE_OUTPUT',
      });
    }
    claimed.set(key, generated.sourcePath);
    files.push(generated);
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skipped };
}
