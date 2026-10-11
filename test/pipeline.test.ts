import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MemoryFileSystem } from '../src/adapters/memory-fs.js';
import { buildPipelineFiles } from '../src/core/pipeline/build.js';
import { renderGithubWorkflow } from '../src/core/pipeline/github.js';
import { renderGitlabJobs } from '../src/core/pipeline/gitlab.js';
import type { PipelineIR } from '../src/core/pipeline/ir.js';
import { ACTION_INPUTS, loadPins } from '../src/core/pipeline/pins.js';
import { parseManifest } from '../src/core/definition/manifest.js';
import { ConfigError, DefinitionError, InternalError } from '../src/errors/index.js';
import { PINS } from './helpers/fixtures.js';

const ir = (extra: Partial<PipelineIR> = {}): PipelineIR => ({
  id: 'scan', title: 'Security', provider: 'github', defaultBranch: 'main', severity: 'HIGH', schedule: false,
  projectName: 'demo', nodeVersion: '22', packageManager: 'npm', dockerfile: 'Dockerfile',
  checks: ['secrets', 'dependencies', 'sast', 'iac', 'container'], ...extra,
});
const workflow = (extra: Partial<PipelineIR> = {}) => parse(renderGithubWorkflow(ir(extra), PINS)) as {
  on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, { steps: Record<string, unknown>[] }>;
};
const usesOf = (text: string): string[] => [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1] ?? '');

describe('pins', () => {
  it('pins.json has full 40-character SHAs, versions, and a minimum age policy', async () => {
    const mem = new MemoryFileSystem();
    mem.seed({ '/p.json': JSON.stringify(PINS) });
    const pins = await loadPins(mem, '/p.json');
    expect(pins.minAgeDays).toBeGreaterThanOrEqual(14);
    for (const key of Object.keys(ACTION_INPUTS)) expect(pins.actions[key]?.sha, key).toMatch(/^[0-9a-f]{40}$/);
    expect(pins.tools['semgrep']?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('rejects malformed pins with a pointer to the updater', async () => {
    const mem = new MemoryFileSystem();
    mem.seed({ '/bad.json': JSON.stringify({ minAgeDays: 14, actions: { 'a/b': { version: 'v1', sha: 'main' } }, tools: {} }) });
    await expect(loadPins(mem, '/bad.json')).rejects.toThrow(ConfigError);
    await expect(loadPins(mem, '/missing.json')).rejects.toMatchObject({ hint: expect.stringContaining('update-pins') });
  });
});

describe('GitHub adapter', () => {
  it('pins EVERY action to a full commit SHA and annotates the human-readable version', () => {
    const text = renderGithubWorkflow(ir(), PINS);
    const uses = usesOf(text);
    expect(uses.length).toBeGreaterThan(5);
    for (const use of uses) expect(use).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    for (const line of text.split('\n').filter((l) => l.includes('uses:'))) expect(line).toMatch(/# v\d+\.\d+\.\d+$/);
  });

  it('defaults to read-only permissions and never exposes secrets to pull requests', () => {
    const wf = workflow();
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(wf.on)).not.toContain('pull_request_target');
    for (const job of Object.values(wf.jobs)) {
      const checkout = job.steps.find((s) => String(s['uses']).startsWith('actions/checkout'));
      expect((checkout?.['with'] as Record<string, unknown>)['persist-credentials']).toBe(false);
    }
  });

  it('creates one job per requested check, with the container job only on request', () => {
    expect(Object.keys(workflow().jobs)).toEqual(['secrets', 'dependencies', 'sast', 'iac', 'container']);
    expect(Object.keys(workflow({ checks: ['secrets', 'sast'] }).jobs)).toEqual(['secrets', 'sast']);
  });

  it.each([
    ['MEDIUM', 'MEDIUM,HIGH,CRITICAL', ['WARNING', 'ERROR']],
    ['HIGH', 'HIGH,CRITICAL', ['ERROR']],
    ['CRITICAL', 'CRITICAL', ['ERROR']],
  ] as const)('maps severity %s consistently for Trivy and Semgrep', (severity, trivy, semgrep) => {
    const text = renderGithubWorkflow(ir({ severity }), PINS);
    expect(text).toContain(`severity: ${trivy}`);
    for (const level of semgrep) expect(text).toContain(`--severity ${level}`);
    expect(text).toContain('exit-code: "1"');
  });

  it('only schedules when asked, and always allows manual runs', () => {
    expect(workflow().on).not.toHaveProperty('schedule');
    expect(workflow({ schedule: true }).on).toHaveProperty('schedule');
    expect(workflow().on).toHaveProperty('workflow_dispatch');
  });

  it('shell-quotes values that reach a run: line', () => {
    const text = renderGithubWorkflow(ir({ dockerfile: "docker file's.name", projectName: 'x' }), PINS);
    expect(text).toContain(`--file 'docker file'\\''s.name'`.replace('--file', '--file'));
  });

  it('supports pnpm via pnpm/action-setup and the frozen lockfile', () => {
    const text = renderGithubWorkflow(ir({ checks: ['node-ci'], packageManager: 'pnpm' }), PINS);
    expect(text).toContain('pnpm/action-setup@');
    expect(text).toContain('pnpm install --frozen-lockfile');
    expect(text).toContain('cache: pnpm');
  });

  it('refuses to pass an input that is not on the verified list', () => {
    const pins = { ...PINS, actions: { ...PINS.actions } };
    delete (pins.actions as Record<string, unknown>)['trufflesecurity/trufflehog'];
    expect(() => renderGithubWorkflow(ir({ checks: ['secrets'] }), pins)).toThrow(InternalError);
    expect(Object.values(ACTION_INPUTS).every((inputs) => inputs.length > 0)).toBe(true);
  });
});

describe('GitLab adapter', () => {
  it('includes GitLab\'s own templates and a plain Node job, and says honestly that findings do not gate', () => {
    const text = renderGitlabJobs(ir({ provider: 'gitlab', checks: ['secrets', 'sast', 'dependencies', 'iac', 'node-ci'] }));
    const doc = parse(text) as { include: { template: string }[]; ci: { image: string; script: string[] } };
    expect(doc.include.map((i) => i.template)).toEqual([
      'Jobs/Secret-Detection.gitlab-ci.yml', 'Jobs/SAST.gitlab-ci.yml', 'Jobs/Dependency-Scanning.gitlab-ci.yml', 'Jobs/SAST-IaC.gitlab-ci.yml',
    ]);
    expect(doc.ci.image).toBe('node:22-bookworm-slim');
    expect(doc.ci.script[0]).toBe('npm ci');
    expect(text).toContain('do not fail the pipeline');
  });
  it('rejects the container check with advice instead of emitting something broken', () => {
    expect(() => renderGitlabJobs(ir({ provider: 'gitlab', checks: ['container'] }))).toThrow(DefinitionError);
  });
});

describe('buildPipelineFiles', () => {
  const manifest = (checks: unknown[]) => parseManifest({
    id: 'scan', version: '1.0.0', kind: 'feature', description: 'd',
    questions: [
      { id: 'provider', type: 'enum', message: 'p', choices: ['github', 'gitlab'], default: 'github' },
      { id: 'docker', type: 'boolean', message: 'd', default: false },
    ],
    pipeline: { checks },
  }, 'test');

  it('writes one workflow for GitHub and a feature file plus a MERGED root file for GitLab', () => {
    const m = manifest([{ kind: 'secrets' }]);
    const gh = buildPipelineFiles(m, { provider: 'github', docker: false }, 'demo', PINS);
    expect(gh.map((f) => [f.path, f.mergeStrategy])).toEqual([['.github/workflows/scan.yml', 'overwrite']]);
    const gl = buildPipelineFiles(m, { provider: 'gitlab', docker: false }, 'demo', PINS);
    expect(gl.map((f) => [f.path, f.mergeStrategy])).toEqual([['.gitlab/ci/scan.yml', 'overwrite'], ['.gitlab-ci.yml', 'yaml-merge']]);
  });
  it('drops checks whose condition is false and writes nothing when none remain', () => {
    const m = manifest([{ kind: 'container', when: { answer: 'docker', equals: true } }]);
    expect(buildPipelineFiles(m, { provider: 'github', docker: false }, 'demo', PINS)).toEqual([]);
  });
  it('requires pins and a supported package manager', () => {
    const m = manifest([{ kind: 'node-ci' }]);
    expect(() => buildPipelineFiles(m, { provider: 'github' }, 'demo', undefined)).toThrow(/pinned versions/);
    expect(() => buildPipelineFiles(m, { provider: 'github', 'package-manager': 'yarn' }, 'demo', PINS)).toThrow(/not supported/);
  });
  it('a manifest with a pipeline must declare a provider question', () => {
    expect(() => parseManifest({ id: 'x', version: '1.0.0', kind: 'feature', description: 'd', pipeline: { checks: [{ kind: 'secrets' }] } }, 't')).toThrow(/provider/);
  });
});
