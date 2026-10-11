import path from 'node:path';
import { readState } from '../core/state/state.js';
import type { RawAnswers } from '../core/definition/answers.js';
import { UsageError } from '../errors/index.js';
import { generate, type GenerateDeps, type GenerateResult } from './generate.js';

export interface AddFeaturesRequest {
  readonly root: string;
  readonly featureIds: readonly string[];
  readonly answers: RawAnswers;
  readonly useDefaults: boolean;
  readonly dryRun: boolean;
  readonly force: boolean;
  /** The project name, from state or detection. */
  readonly name: string;
  readonly signal?: AbortSignal;
}

/** Add features to an existing project. Works with or without a prior `forge new`. */
export async function addFeatures(deps: GenerateDeps, request: AddFeaturesRequest): Promise<GenerateResult> {
  if (request.featureIds.length === 0) throw new UsageError('Name at least one feature to add.', { hint: 'Run "forge list --features" to see them.' });
  const root = path.resolve(request.root);
  const state = await readState(deps.fs, root);
  return generate(deps, {
    mode: 'add',
    name: state?.name ?? request.name,
    root,
    templateId: null,
    featureIds: request.featureIds,
    answers: request.answers,
    useDefaults: request.useDefaults,
    dryRun: request.dryRun,
    force: request.force,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}
