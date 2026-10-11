#!/usr/bin/env node
// Resolve third-party CI actions and tools to immutable versions and write pins/pins.json.
//  - actions: newest vX.Y.Z tag whose commit is at least MIN_AGE_DAYS old, resolved to its commit SHA with
//    `git ls-remote` (annotated tags are peeled). SHAs are never typed by hand.
//  - tools: latest PyPI release at least MIN_AGE_DAYS old.
// Usage: node scripts/update-pins.mjs        (needs network)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_AGE_DAYS = 14;
const ACTIONS = [
  'actions/checkout',
  'actions/setup-node',
  'actions/setup-python',
  'pnpm/action-setup',
  'trufflesecurity/trufflehog',
  'aquasecurity/trivy-action',
];
const PYPI_TOOLS = ['semgrep'];

const cutoff = Date.now() - MIN_AGE_DAYS * 24 * 3600 * 1000;
async function json(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'forge-update-pins' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

const git = (args, cwd) => {
  const out = spawnSync('git', args, { encoding: 'utf8', cwd, timeout: 90_000 });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr.trim()}`);
  return out.stdout;
};

const semverKey = (tag) => tag.slice(1).split('.').map(Number);
const compareDesc = (a, b) => {
  const [x, y] = [semverKey(a), semverKey(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
};

/** Tags look like vMAJOR.MINOR.PATCH. Annotated tags are peeled to the commit they point at. */
function listTags(repo) {
  const lines = git(['ls-remote', '--tags', `https://github.com/${repo}.git`]).trim().split('\n').map((l) => l.split(/\s+/));
  const commits = new Map();
  for (const [sha, ref] of lines) {
    const name = ref.replace('refs/tags/', '').replace('^{}', '');
    if (!/^v\d+\.\d+\.\d+$/.test(name)) continue;
    if (ref.endsWith('^{}') || !commits.has(name)) commits.set(name, sha);
  }
  return [...commits.entries()].sort(([a], [b]) => compareDesc(a, b));
}

const scratch = mkdtempSync(path.join(tmpdir(), 'forge-pins-'));
git(['init', '--quiet', '--bare'], scratch);

function commitDate(repo, sha) {
  git(['fetch', '--quiet', '--depth=1', '--filter=blob:none', `https://github.com/${repo}.git`, sha], scratch);
  return new Date(git(['log', '-1', '--format=%cI', 'FETCH_HEAD'], scratch).trim());
}

const actions = {};
for (const repo of ACTIONS) {
  let chosen = null;
  for (const [tag, sha] of listTags(repo).slice(0, 12)) {
    const date = commitDate(repo, sha);
    if (date.getTime() <= cutoff) {
      chosen = { version: tag, sha, date };
      break;
    }
  }
  if (!chosen) throw new Error(`${repo}: no tag older than ${MIN_AGE_DAYS} days among the 12 newest`);
  actions[repo] = { version: chosen.version, sha: chosen.sha };
  console.log(`${repo.padEnd(30)} ${chosen.version.padEnd(10)} ${chosen.sha}  (commit ${chosen.date.toISOString().slice(0, 10)})`);
}
rmSync(scratch, { recursive: true, force: true });

const versionKey = (v) => v.split('.').map(Number);
const tools = {};
for (const name of PYPI_TOOLS) {
  const data = await json(`https://pypi.org/pypi/${name}/json`);
  const eligible = Object.entries(data.releases)
    .filter(([version, files]) => /^\d+\.\d+\.\d+$/.test(version) && files.length > 0 && files.every((f) => !f.yanked))
    .filter(([, files]) => Date.parse(files[0].upload_time_iso_8601) <= cutoff)
    .map(([version]) => version)
    .sort((a, b) => {
      const [x, y] = [versionKey(a), versionKey(b)];
      for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return y[i] - x[i];
      return 0;
    });
  if (!eligible[0]) throw new Error(`${name}: no eligible release`);
  tools[name] = { version: eligible[0] };
  console.log(`${name.padEnd(30)} ${eligible[0]}`);
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pins', 'pins.json');
writeFileSync(out, `${JSON.stringify({ minAgeDays: MIN_AGE_DAYS, actions, tools }, null, 2)}\n`);
console.log(`\nwrote ${out}`);
