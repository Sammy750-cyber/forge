import path from 'node:path';
import process from 'node:process';
import pkg from '../package.json' with { type: 'json' };
import { systemClock } from './adapters/clock.js';
import { createClackPrompter } from './adapters/clack-prompter.js';
import { createNodeFileSystem } from './adapters/node-fs.js';
import { findPackageRoot } from './adapters/package-root.js';
import { createProcessRunner } from './adapters/process-runner.js';
import { run } from './cli/main.js';
import { DirectoryDefinitionSource } from './core/definition/loader.js';
import { loadPins } from './core/pipeline/pins.js';
import { EXIT } from './errors/index.js';

const fs = createNodeFileSystem();
const packageRoot = findPackageRoot(import.meta.url);
const controller = new AbortController();
let interrupted = false;
process.on('SIGINT', () => {
  // The applier checks this signal between steps and rolls back, so nothing is left half-written.
  interrupted = true;
  controller.abort();
});

const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true;
const code = await run(
  process.argv.slice(2),
  {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    cwd: process.cwd(),
    env: process.env,
    isTTY: interactive,
  },
  {
    fs,
    clock: systemClock,
    templates: new DirectoryDefinitionSource(fs, path.join(packageRoot, 'templates'), 'template'),
    features: new DirectoryDefinitionSource(fs, path.join(packageRoot, 'features'), 'feature'),
    pins: await loadPins(fs, path.join(packageRoot, 'pins', 'pins.json')),
    forgeVersion: pkg.version,
    runner: createProcessRunner(process.env),
    ...(interactive ? { prompter: createClackPrompter() } : {}),
    signal: controller.signal,
  },
);
process.exitCode = interrupted ? EXIT.INTERRUPTED : code;
