import path from 'node:path';
import { Command, CommanderError } from 'commander';
import { createLogger } from '../adapters/logger.js';
import { addFeatures } from '../app/add-features.js';
import { collectAnswers } from '../app/collect-answers.js';
import { detectProject } from '../app/detect.js';
import { runDoctor } from '../app/doctor.js';
import { isWorkingTreeDirty, prepareUpdate, runUpdate } from '../app/update-project.js';
import { loadComposition, type GenerateResult } from '../app/generate.js';
import { newProject } from '../app/new-project.js';
import { runPostSteps, type PostStep, type PostStepResult } from '../app/post-steps.js';
import { loadConfigFile, findProjectConfig, loadEnvLayer, parseConfigObject } from '../core/config/load.js';
import { resolveConfig, type ConfigLayer, type ResolvedConfig } from '../core/config/resolve.js';
import type { RawAnswers } from '../core/definition/answers.js';
import type { DefinitionSource } from '../core/definition/loader.js';
import type { Pins } from '../core/pipeline/pins.js';
import { stableStringify } from '../core/util/stable-json.js';
import type { ForgeError} from '../errors/index.js';
import { EXIT, UsageError, toForgeError, type ExitCode } from '../errors/index.js';
import type { Clock, FileSystem, Logger, ProcessRunner, Prompter } from '../ports/index.js';
import { RULES } from '../core/doctor/rules.js';
import { toSarif } from '../core/doctor/sarif.js';
import { formatDoctorJson, formatDoctorText, formatRuleList } from './doctor-output.js';
import { formatUpdate, formatUpdateJson, summarizeUpdate } from './update-output.js';
import { formatError, formatPlan, formatPlanJson, formatSummary } from './render-output.js';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTTY: boolean;
}

export interface CliDeps {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly templates: DefinitionSource;
  readonly features: DefinitionSource;
  readonly pins?: Pins | undefined;
  readonly forgeVersion: string;
  readonly runner: ProcessRunner;
  /** Present only when a human is at a terminal. Without it Forge never prompts. */
  readonly prompter?: Prompter;
  readonly signal?: AbortSignal;
}

interface GlobalOptions {
  cwd?: string;
  config?: string;
  dryRun?: boolean;
  yes?: boolean;
  input?: boolean; // --no-input sets this to false
  force?: boolean;
  format: 'text' | 'json' | 'sarif';
  verbose?: boolean;
  quiet?: boolean;
  color?: boolean; // --no-color sets this to false
}

function collectAnswer(entry: string, previous: Record<string, string>): Record<string, string> {
  const index = entry.indexOf('=');
  if (index <= 0) throw new UsageError(`--answer expects key=value but got ${JSON.stringify(entry)}.`);
  const key = entry.slice(0, index);
  if (Object.hasOwn(previous, key)) throw new UsageError(`--answer ${key} was given more than once.`);
  return { ...previous, [key]: entry.slice(index + 1) };
}

const collectFeature = (id: string, previous: string[]): string[] => [...previous, id];

async function buildConfig(options: GlobalOptions, io: CliIo, deps: CliDeps, logger: Logger, local: { template?: string; ci?: string } = {}): Promise<ResolvedConfig> {
  const layers: ConfigLayer[] = [];
  const accept = (loaded: { layer: ConfigLayer; warnings: readonly string[] } | null): void => {
    if (loaded === null) return;
    for (const warning of loaded.warnings) logger.warn(warning);
    layers.push(loaded.layer);
  };

  const home = io.env['XDG_CONFIG_HOME'] ?? (io.env['HOME'] === undefined ? undefined : path.join(io.env['HOME'], '.config'));
  if (home !== undefined) accept(await loadConfigFile(deps.fs, path.join(home, 'forge', 'config.json')));

  const cwd = path.resolve(io.cwd, options.cwd ?? '.');
  const projectConfig = options.config === undefined ? await findProjectConfig(deps.fs, cwd) : path.resolve(io.cwd, options.config);
  if (projectConfig !== null) {
    const loaded = await loadConfigFile(deps.fs, projectConfig);
    if (loaded === null && options.config !== undefined) throw new UsageError(`Config file not found: ${projectConfig}`);
    accept(loaded);
  }
  accept(loadEnvLayer(io.env));

  const flags: Record<string, unknown> = {};
  if (local.template !== undefined) flags['template'] = local.template;
  if (local.ci !== undefined) flags['ci'] = local.ci;
  if (options.verbose) flags['logLevel'] = 'debug';
  else if (options.quiet) flags['logLevel'] = 'error';
  if (options.color === false) flags['color'] = false;
  if (options.input === false || !io.isTTY) flags['noInput'] = true;
  accept(parseConfigObject(flags, 'flags'));
  return resolveConfig(layers);
}

function describePostSteps(results: readonly PostStepResult[], name: string): string[] {
  const label: Record<PostStepResult['step'], string> = { 'git-init': 'git init', install: 'npm install' };
  return results.map((result) => {
    switch (result.status) {
      case 'planned':
        return `Would run: ${label[result.step]}`;
      case 'done':
        return `Ran: ${label[result.step]}`;
      case 'skipped':
        return `Skipped ${label[result.step]}: ${result.detail ?? 'not needed'}`;
      case 'failed':
        return `${label[result.step]} failed${result.detail ? `:\n${result.detail}` : ''}\nThe project was created. Run it yourself: cd ${name} && ${label[result.step]}`;
    }
  });
}

export async function run(argv: readonly string[], io: CliIo, deps: CliDeps): Promise<ExitCode> {
  const program = new Command();
  const verboseRequested = argv.includes('--verbose');
  let logger: Logger = createLogger({
    level: verboseRequested ? 'debug' : 'info',
    json: false,
    write: (line) => io.stderr(`${line}\n`),
  });

  program
    .name('forge')
    .description('Generate and maintain secure-by-default projects.')
    .version(deps.forgeVersion)
    .option('--cwd <dir>', 'run as if started in this directory')
    .option('--config <file>', 'use this config file')
    .option('--dry-run', 'show what would change without writing anything')
    .option('-y, --yes', 'accept default answers; never prompt')
    .option('--no-input', 'fail instead of prompting for missing answers')
    .option('--force', 'overwrite conflicting files (backups are kept)')
    .option('--format <format>', 'output format: text or json (sarif for doctor)', 'text')
    .option('--verbose', 'show debug output')
    .option('--quiet', 'only show errors')
    .option('--no-color', 'disable colored output')
    .showHelpAfterError(true)
    .exitOverride()
    .configureOutput({ writeOut: (text) => io.stdout(text), writeErr: (text) => io.stderr(text) });

  let finalCode: ExitCode = EXIT.OK;
  const options = (allowSarif = false): GlobalOptions => {
    const opts = program.opts<GlobalOptions>();
    const allowed = allowSarif ? ['text', 'json', 'sarif'] : ['text', 'json'];
    if (!allowed.includes(opts.format)) throw new UsageError(`--format must be ${allowed.map((a) => `"${a}"`).join(', ')}.`);
    return opts;
  };

  const newLogger = (config: ResolvedConfig, json: boolean): Logger =>
    createLogger({ level: config.values.logLevel, json, write: (line) => io.stderr(`${line}\n`) });

  /** Answers inferred from config and the repository fill in what flags did not say; prompts cover the rest. */
  const gatherAnswers = async (
    composition: Awaited<ReturnType<typeof loadComposition>>,
    flags: RawAnswers,
    inferred: RawAnswers,
    interactive: boolean,
  ): Promise<RawAnswers> => {
    const known = new Set(composition.questions.questions.map((q) => q.id));
    const soft = Object.fromEntries(Object.entries(inferred).filter(([key]) => known.has(key) && !(key in flags)));
    const provided = { ...soft, ...flags };
    return interactive && deps.prompter !== undefined ? collectAnswers(composition.questions, provided, deps.prompter) : provided;
  };

  const configHint = (config: ResolvedConfig): RawAnswers => (config.values.ci === 'none' ? {} : { provider: config.values.ci });

  const printResult = (result: GenerateResult, config: ResolvedConfig, opts: GlobalOptions, log: Logger, postSteps: readonly PostStepResult[], next: string[], name = ''): void => {
    if (opts.format === 'json') {
      io.stdout(formatPlanJson(result.plan, result.applied, result.dryRun, postSteps));
      return;
    }
    io.stdout(formatPlan(result.plan, { color: config.values.color && io.isTTY, verbose: opts.verbose === true }));
    log.info(formatSummary(result.plan, result.dryRun));
    for (const line of describePostSteps(postSteps, name)) log.info(line);
    if (!result.dryRun && next.length > 0) log.info(`Next: ${next.join(' && ')}`);
  };

  program
    .command('new')
    .description('create a project from a template')
    .argument('<name>', 'project name (also the directory name)')
    .option('--template <id>', 'template to use')
    .option('--feature <id>', 'also apply a feature, such as ci or scan (repeatable)', collectFeature, [])
    .option('--ci <provider>', 'CI provider for pipeline features: github, gitlab or none')
    .option('--answer <key=value>', 'answer a template question (repeatable)', collectAnswer, {})
    .option('--git', 'run "git init" after creating the project')
    .option('--install', 'run "npm install" after creating the project')
    .action(async (name: string, local: { template?: string; ci?: string; feature: string[]; answer: Record<string, string>; git?: boolean; install?: boolean }) => {
      const opts = options();
      const config = await buildConfig(opts, io, deps, logger, local);
      logger = newLogger(config, opts.format === 'json');
      const base = path.resolve(io.cwd, opts.cwd ?? '.');
      const dryRun = opts.dryRun === true;
      const prompter = deps.prompter;
      const interactive = prompter !== undefined && !config.values.noInput && opts.yes !== true;

      let templateId = config.values.template;
      let wantGit = local.git;
      let wantInstall = local.install;
      if (interactive && local.template === undefined && config.sources.template === 'default') {
        const ids = await deps.templates.list();
        if (ids.length > 1) templateId = await prompter.select('Template', ids, { default: ids.includes(templateId) ? templateId : (ids[0] ?? templateId) });
      }
      const composition = await loadComposition(deps, templateId, local.feature);
      const answers = await gatherAnswers(composition, local.answer, configHint(config), interactive);
      if (interactive && !dryRun) {
        if (wantGit === undefined) wantGit = await prompter.confirm('Initialize a git repository?', { default: true });
        if (wantInstall === undefined) wantInstall = await prompter.confirm('Install dependencies with npm?', { default: false });
      }

      const result = await newProject(
        { fs: deps.fs, templates: deps.templates, features: deps.features, pins: deps.pins, clock: deps.clock, logger, forgeVersion: deps.forgeVersion },
        {
          name,
          templateId,
          features: local.feature,
          targetDir: path.join(base, name),
          answers,
          useDefaults: opts.yes === true,
          dryRun,
          force: opts.force === true,
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        },
      );

      const steps: PostStep[] = [...(wantGit === true ? (['git-init'] as const) : []), ...(wantInstall === true ? (['install'] as const) : [])];
      const postSteps: PostStepResult[] = result.dryRun
        ? steps.map((step) => ({ step, status: 'planned' as const }))
        : await runPostSteps(steps, { fs: deps.fs, runner: deps.runner, logger }, path.join(base, name), deps.signal);
      const installed = postSteps.some((r) => r.step === 'install' && r.status === 'done');
      const needsInstall = result.plan.ops.some((op) => op.path === 'package.json') && !installed;
      printResult(result, config, opts, logger, postSteps, [`cd ${name}`, ...(needsInstall ? ['npm install'] : [])], name);
    });

  program
    .command('add')
    .description('add features (such as ci or scan) to an existing project')
    .argument('<feature...>', 'features to add')
    .option('--ci <provider>', 'CI provider for pipeline features: github, gitlab or none')
    .option('--answer <key=value>', 'answer a feature question (repeatable)', collectAnswer, {})
    .action(async (featureIds: string[], local: { ci?: string; answer: Record<string, string> }) => {
      const opts = options();
      const config = await buildConfig(opts, io, deps, logger, local);
      logger = newLogger(config, opts.format === 'json');
      const root = path.resolve(io.cwd, opts.cwd ?? '.');
      const interactive = deps.prompter !== undefined && !config.values.noInput && opts.yes !== true;
      const detection = await detectProject(deps.fs, root);
      logger.debug('detected', { name: detection.name, ...detection.hints });

      // An explicit --ci (or FORGE_CI / config) outranks what is detected; otherwise what the repo already uses wins.
      const inferred = config.sources.ci === 'default' ? { ...configHint(config), ...detection.hints } : { ...detection.hints, ...configHint(config) };
      const composition = await loadComposition(deps, null, featureIds);
      const answers = await gatherAnswers(composition, local.answer, inferred, interactive);

      const result = await addFeatures(
        { fs: deps.fs, templates: deps.templates, features: deps.features, pins: deps.pins, clock: deps.clock, logger, forgeVersion: deps.forgeVersion },
        {
          root,
          name: detection.name,
          featureIds,
          answers,
          useDefaults: opts.yes === true || !interactive,
          dryRun: opts.dryRun === true,
          force: opts.force === true,
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        },
      );
      printResult(result, config, opts, logger, [], []);
    });

  program
    .command('list')
    .description('list available templates (or features with --features)')
    .option('--features', 'list features instead of templates')
    .action(async (local: { features?: boolean }) => {
      const source = local.features === true ? deps.features : deps.templates;
      const ids = await source.list();
      if (options().format === 'json') io.stdout(stableStringify({ [local.features === true ? 'features' : 'templates']: ids }));
      else io.stdout(ids.length === 0 ? 'Nothing installed.\n' : `${ids.join('\n')}\n`);
    });

  program
    .command('update')
    .description('bring this project up to date with the templates and features it was generated from (not the Forge CLI itself)')
    .option('--check', 'change nothing; exit 8 if the project is behind (for CI)')
    .option('--diff', 'show what would change, line by line (use with --dry-run or --check)')
    .option('--partial', 'apply what is safe and leave conflicting files exactly as they are')
    .option('--prune', 'delete files the template no longer generates, if you never edited them')
    .option('--answer <key=value>', 'answer or change a question (repeatable)', collectAnswer, {})
    .action(async (local: { check?: boolean; diff?: boolean; partial?: boolean; prune?: boolean; answer: Record<string, string> }) => {
      const opts = options();
      const config = await buildConfig(opts, io, deps, logger);
      logger = newLogger(config, opts.format === 'json');
      const root = path.resolve(io.cwd, opts.cwd ?? '.');
      const updateDeps = { fs: deps.fs, templates: deps.templates, features: deps.features, pins: deps.pins, clock: deps.clock, logger, forgeVersion: deps.forgeVersion };
      const prepared = await prepareUpdate(updateDeps, root);

      const interactive = deps.prompter !== undefined && !config.values.noInput && opts.yes !== true;
      const answers: RawAnswers =
        interactive && deps.prompter !== undefined
          ? await collectAnswers(prepared.composition.questions, { ...prepared.storedAnswers, ...local.answer }, deps.prompter)
          : local.answer;
      const dryRun = opts.dryRun === true || local.check === true;
      if (!dryRun && (await isWorkingTreeDirty(deps.runner, deps.fs, root)) === true) {
        logger.warn('You have uncommitted changes. Forge keeps backups, but committing first makes this update easy to review and undo.');
      }

      const result = await runUpdate(updateDeps, prepared, {
        answers,
        useDefaults: opts.yes === true,
        dryRun,
        diff: local.diff === true,
        partial: local.partial === true,
        force: opts.force === true,
        prune: local.prune === true,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });

      if (opts.format === 'json') io.stdout(formatUpdateJson(result));
      else {
        io.stdout(formatUpdate(result, { color: config.values.color && io.isTTY, verbose: opts.verbose === true }));
        logger.info(summarizeUpdate(result));
        if (result.droppedAnswers.length > 0) logger.info(`Dropped answers that are no longer asked or no longer valid: ${result.droppedAnswers.join(', ')}.`);
        const realBackups = (result.applied?.backedUp ?? []).filter((p) => p !== '.forge/state.json');
        if (result.applied?.backupDir && realBackups.length > 0) logger.info(`Previous versions of changed files are in ${path.relative(root, result.applied.backupDir) || result.applied.backupDir}`);
      }
      if (local.check === true) {
        if (!result.upToDate) finalCode = EXIT.OUTDATED;
      } else if (result.conflictsRemaining > 0 && !dryRun) finalCode = EXIT.CONFLICT;
    });

  program
    .command('doctor')
    .description('check the project against security and hygiene standards')
    .option('--fix', 'repair what can be repaired safely (backups are kept)')
    .option('--rule <id>', 'run only this rule (repeatable)', collectFeature, [])
    .option('--skip <id>', 'skip this rule (repeatable)', collectFeature, [])
    .option('--fail-on <level>', 'exit 6 when findings reach this level: error or warn')
    .option('--list-rules', 'list the rules and exit')
    .action(async (local: { fix?: boolean; rule: string[]; skip: string[]; failOn?: string; listRules?: boolean }) => {
      const opts = options(true);
      if (local.listRules === true) {
        io.stdout(opts.format === 'json' ? stableStringify({ rules: RULES.map((r) => ({ id: r.id, severity: r.severity, title: r.title })) }) : formatRuleList(RULES));
        return;
      }
      if (local.failOn !== undefined && local.failOn !== 'error' && local.failOn !== 'warn') throw new UsageError('--fail-on must be "error" or "warn".');
      const config = await buildConfig(opts, io, deps, logger);
      logger = newLogger(config, opts.format !== 'text');
      const root = path.resolve(io.cwd, opts.cwd ?? '.');
      const result = await runDoctor(
        { fs: deps.fs, clock: deps.clock, logger },
        {
          root,
          only: local.rule,
          skip: local.skip,
          waivers: config.values.doctor.waivers,
          failOn: (local.failOn as 'error' | 'warn' | undefined) ?? config.values.doctor.failOn,
          fix: local.fix === true,
          dryRun: opts.dryRun === true,
          force: opts.force === true,
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        },
      );
      if (opts.format === 'sarif') io.stdout(toSarif(result.report.findings, RULES, deps.forgeVersion));
      else if (opts.format === 'json') io.stdout(formatDoctorJson(result));
      else {
        if (result.fixPlan !== null) {
          io.stdout(formatPlan(result.fixPlan, { color: config.values.color && io.isTTY, verbose: false }));
          logger.info(result.applied === null ? `${formatSummary(result.fixPlan, true)}` : formatSummary(result.fixPlan, false));
        }
        io.stdout(formatDoctorText(result, config.values.color && io.isTTY));
      }
      if (result.failed) finalCode = EXIT.DOCTOR;
    });

  program
    .command('config')
    .description('show the effective configuration and where each value comes from')
    .action(async () => {
      const opts = options();
      const config = await buildConfig(opts, io, deps, logger);
      if (opts.format === 'json') {
        io.stdout(stableStringify({ values: config.values, sources: config.sources }));
        return;
      }
      const lines = Object.entries(config.values).map(
        ([key, value]) => `${key.padEnd(10)} ${(typeof value === 'object' ? JSON.stringify(value) : String(value)).padEnd(10)} (${config.sources[key as keyof typeof config.sources]})`,
      );
      io.stdout(`${lines.join('\n')}\n`);
    });

  try {
    await program.parseAsync([...argv], { from: 'user' });
    return finalCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander has already printed its own message (help, version, or a usage problem).
      return error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
    }
    const forgeError: ForgeError = toForgeError(error);
    io.stderr(formatError(forgeError, verboseRequested));
    return forgeError.exitCode;
  }
}
