import path from 'node:path';
import { InterruptedError } from '../errors/index.js';
import type { FileSystem, Logger, ProcessRunner } from '../ports/index.js';

/** The only post-generation steps that exist. Templates cannot add their own. */
export type PostStep = 'git-init' | 'install';

export interface PostStepResult {
  readonly step: PostStep;
  readonly status: 'done' | 'skipped' | 'failed' | 'planned';
  readonly detail?: string;
}

export interface PostStepDeps {
  readonly fs: FileSystem;
  readonly runner: ProcessRunner;
  readonly logger: Logger;
}

const tail = (text: string, lines = 4): string => text.trim().split('\n').slice(-lines).join('\n');

async function gitInit(deps: PostStepDeps, dir: string, signal?: AbortSignal): Promise<PostStepResult> {
  if ((await deps.fs.lstat(path.join(dir, '.git'))) !== null) {
    return { step: 'git-init', status: 'skipped', detail: 'already a git repository' };
  }
  const options = { cwd: dir, ...(signal === undefined ? {} : { signal }) };
  let result = await deps.runner.run('git', ['init', '--initial-branch=main'], options);
  // Git older than 2.28 does not know --initial-branch.
  if (result.code !== 0 && result.code !== null) result = await deps.runner.run('git', ['init'], options);
  return result.code === 0
    ? { step: 'git-init', status: 'done' }
    : { step: 'git-init', status: 'failed', detail: tail(result.stderr) || 'git could not be started. Is it installed?' };
}

async function install(deps: PostStepDeps, dir: string, signal?: AbortSignal): Promise<PostStepResult> {
  if ((await deps.fs.lstat(path.join(dir, 'package.json'))) === null) {
    return { step: 'install', status: 'skipped', detail: 'no package.json in this project' };
  }
  const result = await deps.runner.run('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, ...(signal === undefined ? {} : { signal }) });
  return result.code === 0
    ? { step: 'install', status: 'done' }
    : { step: 'install', status: 'failed', detail: tail(result.stderr) || 'npm could not be started. Is it installed?' };
}

/**
 * Run the requested steps in order. A failing step is reported, not thrown: the project already exists
 * and the user can retry the step by hand. An interrupt, however, stops everything.
 */
export async function runPostSteps(steps: readonly PostStep[], deps: PostStepDeps, dir: string, signal?: AbortSignal): Promise<PostStepResult[]> {
  const results: PostStepResult[] = [];
  for (const step of steps) {
    if (signal?.aborted) throw new InterruptedError('Interrupted. The project was created; remaining steps were not run.');
    deps.logger.debug('running post step', { step });
    results.push(step === 'git-init' ? await gitInit(deps, dir, signal) : await install(deps, dir, signal));
  }
  if (signal?.aborted) throw new InterruptedError('Interrupted. The project was created; remaining steps were not finished.');
  return results;
}
