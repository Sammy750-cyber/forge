import { Document } from 'yaml';
import { DefinitionError } from '../../errors/index.js';
import { GENERATED_HEADER, type CheckKind, type PipelineIR } from './ir.js';

type Json = string | number | boolean | Json[] | { [key: string]: Json };

/** GitLab's own maintained templates. Findings are reported as job artifacts and in merge requests. */
const TEMPLATES: Partial<Record<CheckKind, string>> = {
  secrets: 'Jobs/Secret-Detection.gitlab-ci.yml',
  sast: 'Jobs/SAST.gitlab-ci.yml',
  dependencies: 'Jobs/Dependency-Scanning.gitlab-ci.yml',
  iac: 'Jobs/SAST-IaC.gitlab-ci.yml',
};

export function renderGitlabJobs(ir: PipelineIR): string {
  const includes: Json[] = [];
  const body: Record<string, Json> = {};
  for (const kind of ir.checks) {
    if (kind === 'node-ci') {
      const pnpm = ir.packageManager === 'pnpm';
      body['ci'] = {
        stage: 'test',
        image: `node:${ir.nodeVersion}-bookworm-slim`,
        script: [
          ...(pnpm ? ['corepack enable', 'pnpm install --frozen-lockfile'] : ['npm ci']),
          ...['typecheck', 'lint', 'test', 'build'].map((script) => `${ir.packageManager} run --if-present ${script}`),
        ],
      };
      continue;
    }
    const template = TEMPLATES[kind];
    if (template === undefined) {
      throw new DefinitionError(`The "${kind}" check is not supported on GitLab yet.`, {
        code: 'FORGE_E_UNSUPPORTED_CHECK',
        hint: 'Use provider=github for this feature, or leave the check out.',
      });
    }
    includes.push({ template });
  }
  const doc = new Document({ ...(includes.length > 0 ? { include: includes } : {}), ...body });
  doc.commentBefore =
    ` ${GENERATED_HEADER}\n forge:checks ${ir.checks.join(',')}\n` +
    ' GitLab security templates report findings but do not fail the pipeline by themselves.\n' +
    ' To block merges on severity, use a merge request approval policy (GitLab Ultimate) or add your own gating job.';
  return doc.toString({ lineWidth: 0 });
}

/** The root file only wires in the feature file, so several features can coexist. It is merged, never overwritten. */
export function renderGitlabRoot(ir: PipelineIR): string {
  const doc = new Document({
    stages: ['test'],
    workflow: {
      rules: [{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }, { if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' }],
    },
    include: [{ local: `.gitlab/ci/${ir.id}.yml` }],
  });
  return doc.toString({ lineWidth: 0 });
}
