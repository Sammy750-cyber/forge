import { DefinitionError } from '../../errors/index.js';
import { evaluateWhen, type Answers } from '../definition/answers.js';
import type { Manifest } from '../definition/manifest.js';
import type { RenderedFile } from '../render/renderer.js';
import { renderGithubWorkflow } from './github.js';
import { renderGitlabJobs, renderGitlabRoot } from './gitlab.js';
import type { PipelineIR, Provider, Severity } from './ir.js';
import type { Pins } from './pins.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

const text = (answers: Answers, key: string, fallback: string): string => {
  const value = answers[key];
  return typeof value === 'string' && value !== '' ? value : fallback;
};

/** Turn a manifest's declarative pipeline into the provider's files. Pure and deterministic. */
export function buildPipelineFiles(manifest: Manifest, answers: Answers, projectName: string, pins: Pins | undefined): RenderedFile[] {
  if (manifest.pipeline === undefined) return [];
  if (pins === undefined) {
    throw new DefinitionError(`${manifest.id}: pinned versions are required to generate a pipeline but none were loaded.`, { code: 'FORGE_E_PINS' });
  }
  const provider = text(answers, 'provider', 'github') as Provider;
  const packageManager = text(answers, 'package-manager', 'npm');
  if (packageManager !== 'npm' && packageManager !== 'pnpm') {
    throw new DefinitionError(`Package manager "${packageManager}" is not supported for CI generation (use npm or pnpm).`, { code: 'FORGE_E_UNSUPPORTED_CHECK' });
  }
  const ir: PipelineIR = {
    id: manifest.id,
    title: manifest.id === 'ci' ? 'CI' : manifest.id === 'scan' ? 'Security' : manifest.id,
    provider,
    defaultBranch: text(answers, 'default-branch', 'main'),
    severity: text(answers, 'severity', 'HIGH') as Severity,
    schedule: false,
    projectName,
    nodeVersion: text(answers, 'node-version', '22'),
    packageManager,
    dockerfile: text(answers, 'dockerfile', 'Dockerfile'),
    checks: manifest.pipeline.checks.filter((check) => evaluateWhen(check.when, answers)).map((check) => check.kind),
  };
  if (ir.checks.length === 0) return [];
  // A weekly run only makes sense when there is something that changes without code changes: the vulnerability databases.
  const scheduled = answers['schedule'] === true && ir.checks.some((kind) => kind !== 'node-ci');
  const final: PipelineIR = { ...ir, schedule: scheduled };

  const file = (path: string, content: string, mergeStrategy: RenderedFile['mergeStrategy']): RenderedFile => ({
    path,
    content: enc(content),
    mode: 0o644,
    mergeStrategy,
    sourcePath: `pipeline:${manifest.id}`,
  });
  return provider === 'github'
    ? [file(`.github/workflows/${ir.id}.yml`, renderGithubWorkflow(final, pins), 'overwrite')]
    : [file(`.gitlab/ci/${ir.id}.yml`, renderGitlabJobs(ir), 'overwrite'), file('.gitlab-ci.yml', renderGitlabRoot(ir), 'yaml-merge')];
}
