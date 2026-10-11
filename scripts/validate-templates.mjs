#!/usr/bin/env node
// Generate every built-in template into a temp directory and run the project's own checks.
// Usage: node scripts/validate-templates.mjs [templateId ...]
// Requires `pnpm build` first and network access for `npm install`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'dist', 'bin.js');
if (!existsSync(bin)) {
  console.error('dist/bin.js not found. Run "pnpm build" first.');
  process.exit(2);
}

const forge = (args, cwd) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
const listed = JSON.parse(forge(['list', '--format', 'json'], root).stdout).templates;
const wanted = process.argv.slice(2);
const templates = wanted.length > 0 ? wanted : listed;

let failures = 0;
const step = (label, cwd, command, args, timeout = 240_000) => {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, env: process.env });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`  ok    ${label} (${seconds}s)`);
    return true;
  }
  failures += 1;
  console.log(`  FAIL  ${label} (${seconds}s)\n${(result.stdout + result.stderr).split('\n').slice(-25).join('\n')}`);
  return false;
};

const features = forge(['list', '--features', '--format', 'json'], root);
const featureIds = JSON.parse(features.stdout).features;
const actionlint = process.env.ACTIONLINT;

const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? `\n${detail}` : ''}`);
  }
  return ok;
};

for (const id of templates) {
  console.log(`\n${id}`);
  const work = mkdtempSync(path.join(tmpdir(), `forge-validate-${id}-`));
  try {
    // Every template, with and without every feature, must generate, be idempotent, and pass `doctor` with zero errors.
    for (const [label, flags] of [['plain', []], ['with all features', featureIds.flatMap((f) => ['--feature', f])]]) {
      const name = label === 'plain' ? 'sample-app' : 'sample-full';
      const created = forge(['new', name, '--template', id, '--yes', ...flags], work);
      if (!check(`generate (${label})`, created.status === 0, created.stderr)) continue;
      const dir = path.join(work, name);
      const again = JSON.parse(forge(['new', name, '--template', id, '--yes', '--format', 'json', ...flags], work).stdout);
      check(`idempotent (${label})`, again.summary.create + again.summary.update + again.summary.merge + again.summary.conflict === 0);
      const doctor = forge(['doctor', '--format', 'json'], dir);
      const errors = JSON.parse(doctor.stdout || '{"findings":[]}').findings.filter((f) => f.severity === 'error');
      check(`doctor reports zero errors (${label})`, doctor.status === 0 && errors.length === 0, JSON.stringify(errors, null, 2));
      const workflows = path.join(dir, '.github', 'workflows');
      if (actionlint && existsSync(workflows)) {
        const files = readdirSync(workflows).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join('.github', 'workflows', f));
        const lint = spawnSync(actionlint, ['-color=false', ...files], { cwd: dir, encoding: 'utf8' });
        check(`actionlint (${label})`, lint.status === 0, lint.stdout + lint.stderr);
      }
    }

    const dir = path.join(work, 'sample-full');
    const pkgPath = path.join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {};
    if (Object.keys(scripts).length === 0) continue;
    if (!step('npm install', dir, 'npm', ['install', '--no-audit', '--no-fund'], 280_000)) continue;
    for (const script of ['typecheck', 'lint', 'test', 'build']) {
      if (scripts[script]) step(`npm run ${script}`, dir, 'npm', ['run', script]);
    }
    const afterInstall = forge(['doctor', '--fail-on', 'warn'], dir);
    check('doctor is fully clean after npm install (zero warnings too)', afterInstall.status === 0, afterInstall.stdout);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\nAll templates validated.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
