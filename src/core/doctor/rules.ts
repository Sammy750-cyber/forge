import { parse } from 'yaml';
import type { RenderedFile } from '../render/renderer.js';
import type { Issue, ProjectView, Rule } from './types.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (path: string, content: string, mergeStrategy: RenderedFile['mergeStrategy']): RenderedFile => ({
  path, content: enc(content), mode: 0o644, mergeStrategy, sourcePath: `doctor:${path}`,
});

// ---------- shared helpers ----------

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];
const DEFAULT_GITIGNORE = 'node_modules/\ndist/\ncoverage/\n.env\n.env.local\n*.log\n.forge/backup/\n';
const DEFAULT_DOCKERIGNORE = '.git\n.github\n.forge\n.env\n.env.*\n!.env.example\nnode_modules\ndist\ncoverage\ntest\nDockerfile\n.dockerignore\n*.log\n';

interface TextFile {
  readonly path: string;
  readonly text: string;
}

async function readAll(project: ProjectView, paths: readonly string[]): Promise<TextFile[]> {
  const out: TextFile[] = [];
  for (const path of paths) {
    const text = await project.read(path);
    if (text !== null) out.push({ path, text });
  }
  return out;
}

async function githubWorkflows(project: ProjectView): Promise<TextFile[]> {
  const names = (await project.list('.github/workflows')).filter((n) => /\.ya?ml$/.test(n));
  return readAll(project, names.map((n) => `.github/workflows/${n}`));
}

async function gitlabFiles(project: ProjectView): Promise<TextFile[]> {
  const nested = (await project.list('.gitlab/ci')).filter((n) => /\.ya?ml$/.test(n)).map((n) => `.gitlab/ci/${n}`);
  return readAll(project, ['.gitlab-ci.yml', ...nested]);
}

async function ciFiles(project: ProjectView): Promise<TextFile[]> {
  return [...(await githubWorkflows(project)), ...(await gitlabFiles(project))];
}

async function dockerfiles(project: ProjectView): Promise<TextFile[]> {
  const names = (await project.list('')).filter((n) => /^Dockerfile(\..+)?$|\.Dockerfile$/.test(n));
  return readAll(project, names);
}

interface Instruction {
  readonly op: string;
  readonly args: string;
  readonly line: number;
}

/** A small Dockerfile reader: comments skipped, backslash continuations joined. */
function instructions(text: string): Instruction[] {
  const out: Instruction[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    let current = (lines[i] ?? '').trim();
    if (current === '' || current.startsWith('#')) continue;
    const start = i + 1;
    while (current.endsWith('\\') && i + 1 < lines.length) {
      i += 1;
      current = `${current.slice(0, -1)} ${(lines[i] ?? '').trim()}`;
    }
    const [op = '', ...rest] = current.split(/\s+/);
    out.push({ op: op.toUpperCase(), args: rest.join(' '), line: start });
  }
  return out;
}

const isNode = (project: ProjectView): Promise<boolean> => project.exists('package.json');
const gitignorePatterns = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
const ignoresEnv = (text: string): boolean => gitignorePatterns(text).some((p) => ['.env', '.env*', '*.env', '/.env', '.env.*'].includes(p));

// ---------- rules ----------

const lockfile: Rule = {
  id: 'supply-chain/lockfile',
  severity: 'warn',
  title: 'A dependency lockfile is committed',
  description: 'Without a lockfile every install can resolve different versions, which makes builds irreproducible and lets a compromised release slip in unnoticed.',
  async check(project) {
    if (!(await isNode(project))) return [];
    for (const name of LOCKFILES) if (await project.exists(name)) return [];
    return [{ message: 'package.json has no lockfile next to it.', path: 'package.json', hint: 'Run "npm install" (or your package manager\'s install) and commit the lockfile.' }];
  },
};

const actionsPinned: Rule = {
  id: 'supply-chain/actions-pinned',
  severity: 'error',
  title: 'GitHub Actions are pinned to full commit SHAs',
  description: 'Tags and branches can be moved to malicious code after you reviewed them. A 40-character commit SHA cannot. Keep a "# vX.Y.Z" comment so humans and Dependabot/Renovate can read it.',
  async check(project) {
    const issues: Issue[] = [];
    for (const { path, text } of await githubWorkflows(project)) {
      text.split(/\r?\n/).forEach((line, index) => {
        const match = /^\s*(?:-\s*)?uses:\s*['"]?([^\s'"#]+)/.exec(line);
        const ref = match?.[1];
        if (ref === undefined || ref.startsWith('./') || ref.startsWith('docker://')) return;
        if (!/@[0-9a-f]{40}$/.test(ref)) {
          issues.push({ message: `"${ref}" is not pinned to a commit SHA.`, path, line: index + 1, hint: 'Replace the tag with the full commit SHA and keep the version in a trailing comment.' });
        }
      });
    }
    return issues;
  },
};

const baseImagePinned: Rule = {
  id: 'supply-chain/base-image-pinned',
  severity: 'error',
  title: 'Container base images use an explicit version',
  description: 'An untagged image or ":latest" changes underneath you. Pin a version tag at least, and ideally a digest.',
  async check(project) {
    const issues: Issue[] = [];
    for (const { path, text } of await dockerfiles(project)) {
      const stages = new Set<string>();
      for (const ins of instructions(text)) {
        if (ins.op !== 'FROM') continue;
        const tokens = ins.args.split(/\s+/).filter((t) => !t.startsWith('--'));
        const image = tokens[0] ?? '';
        const alias = tokens[1]?.toUpperCase() === 'AS' ? tokens[2] : undefined;
        const known = image.toLowerCase() === 'scratch' || stages.has(image.toLowerCase()) || image.includes('$');
        if (alias !== undefined) stages.add(alias.toLowerCase());
        if (known || image.includes('@sha256:')) continue;
        const lastSegment = image.slice(image.lastIndexOf('/') + 1);
        const tag = lastSegment.includes(':') ? lastSegment.slice(lastSegment.indexOf(':') + 1) : undefined;
        if (tag === undefined) issues.push({ message: `"${image}" has no tag, so it means :latest.`, path, line: ins.line, hint: 'Use a version tag such as node:22-bookworm-slim, or pin a digest.' });
        else if (tag === 'latest') issues.push({ message: `"${image}" uses the moving :latest tag.`, path, line: ins.line, hint: 'Pin a version tag or a digest.' });
      }
    }
    return issues;
  },
};

const nonRoot: Rule = {
  id: 'docker/non-root',
  severity: 'error',
  title: 'Containers do not run as root',
  description: 'If an attacker takes over a root process they own the container and have a much easier path to the host. The final stage must switch to an unprivileged USER.',
  async check(project) {
    const issues: Issue[] = [];
    for (const { path, text } of await dockerfiles(project)) {
      const all = instructions(text);
      const lastFrom = all.map((i) => i.op).lastIndexOf('FROM');
      if (lastFrom === -1) continue;
      const users = all.slice(lastFrom).filter((i) => i.op === 'USER');
      const user = users.at(-1)?.args.split(/[\s:]/)[0] ?? '';
      if (user === '' || user === 'root' || user === '0') {
        issues.push({ message: user === '' ? 'The final stage never sets USER, so it runs as root.' : `The final stage runs as ${user}.`, path, line: all[lastFrom]?.line, hint: 'Add "USER node" (or another unprivileged user) before CMD.' });
      }
    }
    return issues;
  },
};

const healthcheck: Rule = {
  id: 'docker/healthcheck',
  severity: 'warn',
  title: 'Containers declare a HEALTHCHECK',
  description: 'Orchestrators and "docker ps" can only restart or report a broken container if the image tells them how to check it.',
  async check(project) {
    const issues: Issue[] = [];
    for (const { path, text } of await dockerfiles(project)) {
      const all = instructions(text);
      const lastFrom = all.map((i) => i.op).lastIndexOf('FROM');
      const has = all.slice(Math.max(lastFrom, 0)).some((i) => i.op === 'HEALTHCHECK' && !/^NONE\b/i.test(i.args));
      if (!has) issues.push({ message: 'The final stage has no HEALTHCHECK.', path, hint: 'Add a HEALTHCHECK that calls your service\'s health endpoint.' });
    }
    return issues;
  },
};

const dockerignore: Rule = {
  id: 'docker/dockerignore',
  severity: 'warn',
  title: 'A .dockerignore keeps secrets and junk out of images',
  description: 'Without one, "COPY . ." can bake .env files, .git history and node_modules into the image.',
  async check(project) {
    return (await dockerfiles(project)).length > 0 && !(await project.exists('.dockerignore'))
      ? [{ message: 'There is a Dockerfile but no .dockerignore.', path: 'Dockerfile', hint: 'Run "forge doctor --fix" to create one.' }]
      : [];
  },
  async fix() {
    return [file('.dockerignore', DEFAULT_DOCKERIGNORE, 'none')];
  },
};

const ciPresent: Rule = {
  id: 'ci/present',
  severity: 'warn',
  title: 'The project has a CI pipeline',
  description: 'Checks that only run on a developer\'s machine are checks that sometimes do not run.',
  async check(project) {
    return (await ciFiles(project)).length === 0
      ? [{ message: 'No GitHub Actions workflow or GitLab CI file was found.', hint: 'Run "forge add ci scan" to add one.' }]
      : [];
  },
};

const permissions: Rule = {
  id: 'ci/permissions',
  severity: 'error',
  title: 'GitHub workflows declare least-privilege permissions',
  description: 'Without a permissions block the token may default to broad write access. Declare "permissions: contents: read" at the top and widen per job only where needed.',
  async check(project) {
    const issues: Issue[] = [];
    for (const { path, text } of await githubWorkflows(project)) {
      let doc: unknown;
      try {
        doc = parse(text);
      } catch {
        issues.push({ message: 'The workflow is not valid YAML.', path });
        continue;
      }
      const workflow = doc as { permissions?: unknown; jobs?: Record<string, { permissions?: unknown }> } | null;
      if (workflow === null || typeof workflow !== 'object' || workflow.permissions !== undefined) continue;
      const jobs = Object.values(workflow.jobs ?? {});
      if (jobs.length === 0 || !jobs.every((job) => job !== null && typeof job === 'object' && job.permissions !== undefined)) {
        issues.push({ message: 'No "permissions" at the top level, and not every job sets its own.', path, hint: 'Add "permissions:\\n  contents: read" at the top.' });
      }
    }
    return issues;
  },
};

async function pipelineMentions(project: ProjectView, marker: string, pattern: RegExp, extra: string[] = []): Promise<boolean> {
  const files = await ciFiles(project);
  if (files.some(({ text }) => new RegExp(`forge:checks[^\\n]*\\b${marker}\\b`).test(text) || pattern.test(text))) return true;
  for (const name of extra) if (await project.exists(name)) return true;
  return false;
}

const secretScan: Rule = {
  id: 'ci/secret-scan',
  severity: 'warn',
  title: 'CI scans for committed secrets',
  description: 'A leaked credential in git history stays valid until someone rotates it. Scanning every push catches it while it is still a one-line fix.',
  async check(project) {
    if ((await ciFiles(project)).length === 0) return [];
    return (await pipelineMentions(project, 'secrets', /trufflehog|gitleaks|secret-?detection/i))
      ? []
      : [{ message: 'No secret scanning step was found in your CI configuration.', hint: 'Run "forge add scan".' }];
  },
};

const dependencyScan: Rule = {
  id: 'ci/dependency-scan',
  severity: 'warn',
  title: 'Dependencies are scanned for known vulnerabilities',
  description: 'New vulnerabilities are published daily against code you did not change. Scan in CI, and keep automated update PRs flowing.',
  async check(project) {
    if ((await ciFiles(project)).length === 0) return [];
    return (await pipelineMentions(project, 'dependencies', /trivy|osv-scanner|dependency-?scanning|snyk|(?:npm|pnpm|yarn) audit/i, ['.github/dependabot.yml', '.github/dependabot.yaml', 'renovate.json', '.renovaterc', '.renovaterc.json']))
      ? []
      : [{ message: 'No dependency vulnerability scanning was found.', hint: 'Run "forge add scan", or enable Dependabot or Renovate.' }];
  },
};

const envIgnored: Rule = {
  id: 'secrets/env-ignored',
  severity: 'warn',
  title: '.env files are git-ignored',
  description: 'Local environment files hold real credentials. Ignore them so they cannot be committed by accident (keep a committed .env.example instead).',
  async check(project) {
    const text = await project.read('.gitignore');
    if (text === null || ignoresEnv(text)) return [];
    return (await isNode(project)) || (await project.exists('.env.example'))
      ? [{ message: '.gitignore does not ignore .env files.', path: '.gitignore', hint: 'Run "forge doctor --fix" to add them.' }]
      : [];
  },
  async fix() {
    return [file('.gitignore', '.env\n.env.local\n', 'line-set')];
  },
};

const envExposed: Rule = {
  id: 'secrets/env-file-exposed',
  severity: 'error',
  title: 'An existing .env file is not ignored by git',
  description: 'A .env file is present in the working tree and nothing stops "git add ." from committing it.',
  async check(project) {
    if (!(await project.exists('.env'))) return [];
    const text = await project.read('.gitignore');
    return text !== null && ignoresEnv(text) ? [] : [{ message: '.env exists but is not git-ignored.', path: '.env', hint: 'Run "forge doctor --fix", and rotate any secret that was ever committed.' }];
  },
  async fix() {
    return [file('.gitignore', '.env\n.env.local\n', 'line-set')];
  },
};

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Stripe live key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

const hardcodedSecrets: Rule = {
  id: 'secrets/hardcoded',
  severity: 'error',
  title: 'No obvious credentials in the working tree',
  description: 'A light built-in check for well-known credential formats. It is not a replacement for a real scanner (the "scan" feature adds one); it exists so the most obvious leaks are caught even without one. Add "forge:allow-secret" to a line to mark a deliberate test fixture.',
  async check(project) {
    const issues: Issue[] = [];
    for (const path of await project.walk()) {
      const text = await project.read(path);
      if (text === null) continue;
      text.split(/\r?\n/).forEach((line, index) => {
        if (line.includes('forge:allow-secret')) return;
        for (const { name, pattern } of SECRET_PATTERNS) {
          // The matched value is never printed, so the report cannot become a second leak.
          if (pattern.test(line)) issues.push({ message: `Looks like a ${name}.`, path, line: index + 1, hint: 'Remove it, rotate the credential, and load it from the environment instead.' });
        }
      });
    }
    return issues;
  },
};

const readme: Rule = {
  id: 'hygiene/readme',
  severity: 'warn',
  title: 'The project has a README',
  description: 'The README is where a new teammate, or you in six months, learns how to run the project.',
  async check(project) {
    return (await project.list('')).some((n) => /^readme(\.|$)/i.test(n)) ? [] : [{ message: 'No README found.' }];
  },
};

const license: Rule = {
  id: 'hygiene/license',
  severity: 'info',
  title: 'The project states its license',
  description: 'Without a license, nobody else may legally use the code. Private projects can ignore this.',
  async check(project) {
    return (await project.list('')).some((n) => /^(licen[cs]e|copying)(\.|$)/i.test(n)) ? [] : [{ message: 'No LICENSE file found.' }];
  },
};

const gitignore: Rule = {
  id: 'hygiene/gitignore',
  severity: 'warn',
  title: 'The project has a .gitignore',
  description: 'Without one, dependencies, build output and local secrets end up in version control.',
  async check(project) {
    return (await project.exists('.gitignore')) ? [] : [{ message: 'No .gitignore found.', hint: 'Run "forge doctor --fix" to create one.' }];
  },
  async fix() {
    return [file('.gitignore', DEFAULT_GITIGNORE, 'line-set')];
  },
};

const engines: Rule = {
  id: 'hygiene/engines',
  severity: 'warn',
  title: 'package.json declares the supported Node.js version',
  description: 'The "engines" field makes npm warn (or fail) on unsupported runtimes instead of failing mysteriously later.',
  async check(project) {
    const pkg = await project.readJson('package.json');
    if (pkg === null) return [];
    const node = (pkg['engines'] as { node?: unknown } | undefined)?.node;
    return typeof node === 'string' && node !== '' ? [] : [{ message: 'package.json has no engines.node.', path: 'package.json', hint: 'Run "forge doctor --fix" to add ">=22", then adjust if you support older versions.' }];
  },
  async fix() {
    return [file('package.json', `${JSON.stringify({ engines: { node: '>=22' } }, null, 2)}\n`, 'json-merge')];
  },
};

const backupIgnored: Rule = {
  id: 'hygiene/forge-backup-ignored',
  severity: 'warn',
  title: 'Forge backups are not committed',
  description: 'Forge saves overwritten files under .forge/backup/. They are a safety net, not source code.',
  async check(project) {
    if (!(await project.exists('.forge/backup'))) return [];
    const text = await project.read('.gitignore');
    return text !== null && gitignorePatterns(text).some((p) => p.replace(/^\//, '').replace(/\/$/, '') === '.forge/backup') ? [] : [{ message: '.forge/backup/ exists but is not git-ignored.', path: '.gitignore' }];
  },
  async fix() {
    return [file('.gitignore', '.forge/backup/\n', 'line-set')];
  },
};

const drift: Rule = {
  id: 'drift/modified',
  severity: 'info',
  title: 'Generated files that were edited or removed since generation',
  description: 'Informational: Forge compares files it generated with their recorded hashes. Editing them is fine; this just tells you what has diverged.',
  async check(project) {
    if (project.state === null) return [];
    const issues: Issue[] = [];
    for (const [path, expected] of Object.entries(project.state.files)) {
      const actual = await project.hash(path);
      if (actual === null) issues.push({ message: 'Generated file was removed.', path });
      else if (actual !== expected) issues.push({ message: 'Generated file was modified after generation.', path });
    }
    return issues;
  },
};

export const RULES: readonly Rule[] = [
  lockfile, actionsPinned, baseImagePinned, nonRoot, healthcheck, dockerignore, ciPresent, permissions, secretScan, dependencyScan,
  envIgnored, envExposed, hardcodedSecrets, readme, license, gitignore, engines, backupIgnored, drift,
];
