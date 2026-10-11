import { Document, isScalar, visit } from 'yaml';
import { DefinitionError, InternalError } from '../../errors/index.js';
import { shellQuote } from '../util/shell.js';
import { GENERATED_HEADER, type CheckKind, type PipelineIR, type Severity } from './ir.js';
import { ACTION_INPUTS, type Pins } from './pins.js';

type Json = string | number | boolean | Json[] | { [key: string]: Json };
type Step = { [key: string]: Json };

const TRIVY_SEVERITY: Record<Severity, string> = { MEDIUM: 'MEDIUM,HIGH,CRITICAL', HIGH: 'HIGH,CRITICAL', CRITICAL: 'CRITICAL' };
const SEMGREP_SEVERITY: Record<Severity, string[]> = { MEDIUM: ['WARNING', 'ERROR'], HIGH: ['ERROR'], CRITICAL: ['ERROR'] };
const TITLES: Record<CheckKind, string> = {
  secrets: 'Secret scan',
  dependencies: 'Dependency scan',
  sast: 'Static analysis',
  iac: 'Infrastructure-as-code scan',
  container: 'Container image scan',
  'node-ci': 'Build and test',
};

export function renderGithubWorkflow(ir: PipelineIR, pins: Pins): string {
  const used = new Map<string, string>(); // sha -> version, to annotate each pinned `uses`

  const action = (key: string, inputs: Record<string, Json> = {}): Step => {
    const pin = pins.actions[key];
    if (pin === undefined) throw new InternalError(`No pinned version for ${key}. Run scripts/update-pins.mjs.`);
    const allowed = ACTION_INPUTS[key] ?? [];
    for (const name of Object.keys(inputs)) {
      if (!allowed.includes(name)) throw new InternalError(`Input "${name}" is not on the verified list for ${key}.`);
    }
    used.set(pin.sha, pin.version);
    return { uses: `${key}@${pin.sha}`, ...(Object.keys(inputs).length > 0 ? { with: inputs } : {}) };
  };
  const checkout = (fetchDepth?: number): Step =>
    action('actions/checkout', { 'persist-credentials': false, ...(fetchDepth === undefined ? {} : { 'fetch-depth': fetchDepth }) });
  const run = (name: string, command: string): Step => ({ name, run: command });
  const job = (name: string, steps: Step[], minutes = 15): Json => ({ name, 'runs-on': 'ubuntu-latest', 'timeout-minutes': minutes, steps });

  const trivy = (inputs: Record<string, Json>): Step =>
    action('aquasecurity/trivy-action', { scanners: 'vuln', severity: TRIVY_SEVERITY[ir.severity], 'exit-code': '1', ...inputs });

  const jobs: Record<string, Json> = {};
  for (const kind of ir.checks) {
    switch (kind) {
      case 'secrets': {
        const truffle = pins.actions['trufflesecurity/trufflehog'];
        if (truffle === undefined) throw new InternalError('No pinned version for trufflesecurity/trufflehog.');
        jobs['secrets'] = job(TITLES.secrets, [
          checkout(0),
          action('trufflesecurity/trufflehog', { extra_args: '--results=verified,unknown', version: truffle.version.replace(/^v/, '') }),
        ]);
        break;
      }
      case 'dependencies':
        jobs['dependencies'] = job(TITLES.dependencies, [
          checkout(),
          trivy({ 'scan-type': 'fs', 'scan-ref': '.', 'ignore-unfixed': true }),
        ]);
        break;
      case 'iac': {
        const step = trivy({ 'scan-type': 'config', 'scan-ref': '.' });
        // Misconfiguration scanning has no "unfixed" concept and does not use the vulnerability scanner.
        delete (step['with'] as Record<string, Json>)['scanners'];
        jobs['iac'] = job(TITLES.iac, [checkout(), step]);
        break;
      }
      case 'sast': {
        const semgrep = pins.tools['semgrep'];
        if (semgrep === undefined) throw new InternalError('No pinned version for semgrep.');
        const severities = SEMGREP_SEVERITY[ir.severity].map((s) => `--severity ${s}`).join(' ');
        jobs['sast'] = job(TITLES.sast, [
          checkout(),
          action('actions/setup-python', { 'python-version': '3.12' }),
          run('Install Semgrep', `pip install semgrep==${semgrep.version}`),
          run('Run Semgrep', `semgrep scan --config p/default --error --metrics=off ${severities}`),
        ], 20);
        break;
      }
      case 'container': {
        const tag = `${ir.projectName}:ci`;
        jobs['container'] = job(TITLES.container, [
          checkout(),
          run('Build image', `docker build --file ${shellQuote(ir.dockerfile)} --tag ${shellQuote(tag)} .`),
          trivy({ 'scan-type': 'image', 'image-ref': tag, 'ignore-unfixed': true }),
        ], 30);
        break;
      }
      case 'node-ci': {
        const pnpm = ir.packageManager === 'pnpm';
        const steps: Step[] = [checkout()];
        if (pnpm) steps.push(action('pnpm/action-setup', { package_json_file: 'package.json' }));
        steps.push(action('actions/setup-node', { 'node-version': ir.nodeVersion, cache: ir.packageManager }));
        steps.push(run('Install dependencies', pnpm ? 'pnpm install --frozen-lockfile' : 'npm ci'));
        for (const script of ['typecheck', 'lint', 'test', 'build']) {
          steps.push(run(`Run ${script}`, `${ir.packageManager} run --if-present ${script}`));
        }
        jobs['ci'] = job(TITLES['node-ci'], steps, 20);
        break;
      }
      default:
        throw new DefinitionError(`Check "${String(kind)}" is not supported on GitHub Actions.`, { code: 'FORGE_E_UNSUPPORTED_CHECK' });
    }
  }

  const triggers: Record<string, Json> = {
    push: { branches: [ir.defaultBranch] },
    pull_request: { branches: [ir.defaultBranch] },
    ...(ir.schedule ? { schedule: [{ cron: '17 4 * * 1' }] } : {}),
    workflow_dispatch: {},
  };
  const doc = new Document({
    name: ir.title,
    on: triggers,
    permissions: { contents: 'read' },
    concurrency: { group: '${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true },
    jobs,
  });
  doc.commentBefore = ` ${GENERATED_HEADER}\n forge:checks ${ir.checks.join(',')}`;
  visit(doc, {
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === 'uses' && isScalar(pair.value) && typeof pair.value.value === 'string') {
        const version = used.get(pair.value.value.split('@')[1] ?? '');
        if (version !== undefined) pair.value.comment = ` ${version}`;
      }
    },
  });
  return doc.toString({ lineWidth: 0 });
}
