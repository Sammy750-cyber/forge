import { UsageError } from '../errors/index.js';
import type { RawAnswers } from '../core/definition/answers.js';
import { generate, type GenerateDeps, type GenerateResult } from './generate.js';

const PROJECT_NAME = /^[a-z][a-z0-9-]{0,213}$/;

export type NewProjectDeps = GenerateDeps;
export type NewProjectResult = GenerateResult;

export interface NewProjectRequest {
  readonly name: string;
  readonly templateId: string;
  /** Directory the project is created in. */
  readonly targetDir: string;
  /** Features applied on top of the template. */
  readonly features?: readonly string[];
  readonly answers: RawAnswers;
  /** Accept defaults for unanswered questions. */
  readonly useDefaults: boolean;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly signal?: AbortSignal;
}

export function validateProjectName(name: string): void {
  if (!PROJECT_NAME.test(name)) {
    throw new UsageError(`"${name}" is not a valid project name.`, {
      code: 'FORGE_E_BAD_NAME',
      hint: 'Use lowercase letters, digits and hyphens, starting with a letter (for example "my-api").',
    });
  }
}

/** Plan (and unless `dryRun`, apply) the creation of a project from a template and optional features. */
export async function newProject(deps: NewProjectDeps, request: NewProjectRequest): Promise<NewProjectResult> {
  validateProjectName(request.name);
  return generate(deps, {
    mode: 'new',
    name: request.name,
    root: request.targetDir,
    templateId: request.templateId,
    featureIds: request.features ?? [],
    answers: request.answers,
    useDefaults: request.useDefaults,
    dryRun: request.dryRun,
    force: request.force,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}
