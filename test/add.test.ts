import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MemoryFileSystem } from '../src/adapters/memory-fs.js';
import { addFeatures, type AddFeaturesRequest } from '../src/app/add-features.js';
import { detectProject, sanitizeName } from '../src/app/detect.js';
import { newProject } from '../src/app/new-project.js';
import { readState } from '../src/core/state/state.js';
import { ConflictError, DefinitionError, UsageError } from '../src/errors/index.js';
import { depsFor, faultyFs } from './helpers/fixtures.js';

const ROOT = '/repo';
const req = (extra: Partial<AddFeaturesRequest> = {}): AddFeaturesRequest => ({
  root: ROOT, name: 'repo', featureIds: ['ci', 'scan'], answers: {}, useDefaults: true, dryRun: false, force: false, ...extra,
});
const legacyRepo = () => {
  const fs = new MemoryFileSystem();
  fs.seed({
    [`${ROOT}/package.json`]: JSON.stringify({ name: '@acme/Billing Service', engines: { node: '>=20' } }),
    [`${ROOT}/pnpm-lock.yaml`]: 'lockfileVersion: 9',
    [`${ROOT}/Dockerfile`]: 'FROM node:22-slim\nUSER node\n',
    [`${ROOT}/.git/HEAD`]: 'ref: refs/heads/trunk\n',
    [`${ROOT}/.nvmrc`]: 'v20.11.0\n',
    [`${ROOT}/src/index.ts`]: 'export {};\n',
  });
  return fs;
};

describe('detectProject', () => {
  it('reads facts from the repository instead of asking', async () => {
    const { name, hints } = await detectProject(legacyRepo(), ROOT);
    expect(name).toBe('billing-service');
    expect(hints).toEqual({ docker: true, dockerfile: 'Dockerfile', 'package-manager': 'pnpm', 'default-branch': 'trunk', 'node-version': '20' });
  });
  it('detects GitLab and GitHub, and survives a bare directory', async () => {
    const gl = new MemoryFileSystem();
    gl.seed({ [`${ROOT}/.gitlab-ci.yml`]: 'stages: [x]' });
    expect((await detectProject(gl, ROOT)).hints['provider']).toBe('gitlab');
    const gh = new MemoryFileSystem();
    gh.seed({ [`${ROOT}/.github/CODEOWNERS`]: '* @me' });
    expect((await detectProject(gh, ROOT)).hints['provider']).toBe('github');
    const bare = new MemoryFileSystem();
    await bare.mkdir('/some/Weird_Dir 2');
    expect(await detectProject(bare, '/some/Weird_Dir 2')).toEqual({ name: 'weird-dir-2', hints: {} });
  });
  it('sanitizes names into the allowed alphabet', () => {
    expect(sanitizeName('@scope/My_App')).toBe('my-app');
    expect(sanitizeName('123')).toBe('project');
    expect(sanitizeName('---')).toBe('project');
  });
});

describe('addFeatures on an existing, unmanaged repository', () => {
  it('adds CI and security scanning tailored to what the repo already uses', async () => {
    const fs = legacyRepo();
    const detection = await detectProject(fs, ROOT);
    const result = await addFeatures(depsFor(fs), req({ answers: detection.hints, name: detection.name }));
    expect(result.applied?.written).toEqual(expect.arrayContaining(['.github/workflows/ci.yml', '.github/workflows/scan.yml', '.trivyignore']));
    const ci = fs.text(`${ROOT}/.github/workflows/ci.yml`);
    expect(ci).toContain('pnpm install --frozen-lockfile');
    expect(ci).toContain('node-version: "20"');
    expect(ci).toContain('- trunk');
    const scan = fs.text(`${ROOT}/.github/workflows/scan.yml`);
    expect(scan).toContain('docker build --file');
    expect(scan).toContain("--tag 'billing-service:ci'");
    // Existing files are untouched.
    expect(fs.text(`${ROOT}/src/index.ts`)).toBe('export {};\n');
    const state = await readState(fs, ROOT);
    expect(state).toMatchObject({ template: null, name: 'billing-service' });
    expect(state?.features.map((f) => f.id)).toEqual(['ci', 'scan']);
  });

  it('is idempotent: adding again changes nothing', async () => {
    const fs = legacyRepo();
    await addFeatures(depsFor(fs), req());
    const before = fs.snapshot();
    const again = await addFeatures(depsFor(fs, '2031-01-01T00:00:00Z'), req());
    expect(again.applied).toBeNull();
    expect(fs.snapshot()).toEqual(before);
  });

  it('merges into the user\'s existing .trivyignore and keeps their entries', async () => {
    const fs = legacyRepo();
    fs.seed({ [`${ROOT}/.trivyignore`]: 'CVE-2024-1111 # accepted until 2027-01-01\n' });
    const result = await addFeatures(depsFor(fs), req({ featureIds: ['scan'] }));
    expect(result.plan.ops.find((o) => o.path === '.trivyignore')?.kind).toBe('merge');
    const text = fs.text(`${ROOT}/.trivyignore`);
    expect(text.startsWith('CVE-2024-1111 # accepted until 2027-01-01\n')).toBe(true);
    expect(text).toContain('Accepted risks for Trivy');
    expect(fs.text(`${result.applied?.backupDir}/.trivyignore`)).toBe('CVE-2024-1111 # accepted until 2027-01-01\n');
  });

  it('protects a hand-written workflow with the same name, and --force replaces it with a backup', async () => {
    const fs = legacyRepo();
    fs.seed({ [`${ROOT}/.github/workflows/ci.yml`]: 'name: mine\non: push\njobs: {}\n' });
    await expect(addFeatures(depsFor(fs), req({ featureIds: ['ci'] }))).rejects.toThrow(ConflictError);
    expect(fs.text(`${ROOT}/.github/workflows/ci.yml`)).toContain('name: mine');
    const forced = await addFeatures(depsFor(fs), req({ featureIds: ['ci'], force: true }));
    expect(fs.text(`${forced.applied?.backupDir}/.github/workflows/ci.yml`)).toContain('name: mine');
  });

  it('is atomic: a failure at any step leaves the repo untouched', async () => {
    const counted = faultyFs(legacyRepo(), 0);
    await addFeatures(depsFor(counted), req());
    for (let failAt = 1; failAt <= counted.mutations; failAt += 1) {
      const mem = legacyRepo();
      const before = mem.snapshot();
      await expect(addFeatures(depsFor(faultyFs(mem, failAt)), req()), `failAt ${failAt}`).rejects.toThrow();
      expect(mem.snapshot(), `failAt ${failAt}`).toEqual(before);
    }
  });

  it('validates input: needs features, a directory, and known feature ids', async () => {
    await expect(addFeatures(depsFor(legacyRepo()), req({ featureIds: [] }))).rejects.toThrow(UsageError);
    await expect(addFeatures(depsFor(new MemoryFileSystem()), req())).rejects.toThrow(/not a directory/);
    await expect(addFeatures(depsFor(legacyRepo()), req({ featureIds: ['nope'] }))).rejects.toThrow(DefinitionError);
  });
});

describe('GitLab', () => {
  it('merges into the user\'s .gitlab-ci.yml without disturbing their jobs or comments', async () => {
    const fs = new MemoryFileSystem();
    fs.seed({
      [`${ROOT}/package.json`]: '{"name":"x"}',
      [`${ROOT}/.gitlab-ci.yml`]: '# team pipeline\nstages: [build, test]\n\nbuild:\n  stage: build\n  script: make # compile\n',
    });
    await addFeatures(depsFor(fs), req({ featureIds: ['ci', 'scan'], answers: { provider: 'gitlab' } }));
    const root = fs.text(`${ROOT}/.gitlab-ci.yml`);
    expect(root).toContain('# team pipeline');
    expect(root).toContain('# compile');
    expect(root).toContain('script: make');
    const doc = parse(root) as { stages: string[]; include: { local: string }[]; build: unknown };
    expect(doc.stages).toEqual(['build', 'test']);
    expect(doc.include.map((i) => i.local)).toEqual(['.gitlab/ci/ci.yml', '.gitlab/ci/scan.yml']);
    expect(doc.build).toBeDefined();
    const again = depsFor(fs);
    const before = fs.snapshot();
    expect((await addFeatures(again, req({ featureIds: ['ci', 'scan'], answers: { provider: 'gitlab' } }))).applied).toBeNull();
    expect(fs.snapshot()).toEqual(before);
  });

  it('explains that container scanning is GitHub-only instead of generating a broken pipeline', async () => {
    const fs = legacyRepo();
    fs.seed({ [`${ROOT}/.gitlab-ci.yml`]: 'stages: [test]\n' });
    const before = fs.snapshot();
    await expect(addFeatures(depsFor(fs), req({ featureIds: ['scan'], answers: { provider: 'gitlab', docker: true } }))).rejects.toThrow(/not supported on GitLab/);
    expect(fs.snapshot()).toEqual(before);
  });
});

describe('forge new with features', () => {
  it('applies the template and features together, asking shared questions once', async () => {
    const fs = new MemoryFileSystem();
    const result = await newProject(depsFor(fs), {
      name: 'svc', templateId: 'express-api', features: ['scan', 'ci'], targetDir: '/work/svc', answers: {}, useDefaults: true, dryRun: false, force: false,
    });
    expect(result.applied?.written).toEqual(expect.arrayContaining(['Dockerfile', '.github/workflows/ci.yml', '.github/workflows/scan.yml']));
    // docker defaults to true in the template, so the scan feature picks it up without being asked.
    expect(fs.text('/work/svc/.github/workflows/scan.yml')).toContain('container:');
    expect((await readState(fs, '/work/svc'))?.features.map((f) => f.id)).toEqual(['ci', 'scan']);
    const before = fs.snapshot();
    const again = await newProject(depsFor(fs), {
      name: 'svc', templateId: 'express-api', features: ['scan', 'ci'], targetDir: '/work/svc', answers: {}, useDefaults: true, dryRun: false, force: false,
    });
    expect(again.applied).toBeNull();
    expect(fs.snapshot()).toEqual(before);
  });
});
