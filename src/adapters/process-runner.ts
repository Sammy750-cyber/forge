import { spawn } from 'node:child_process';
import type { ProcessResult, ProcessRunner } from '../ports/index.js';

/** Variables a package manager or git genuinely needs. Everything else (tokens, cloud keys) stays out. */
const PASS_THROUGH = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
]);
const MAX_OUTPUT = 64 * 1024;
const WINDOWS_SHIMS = new Set(['npm', 'pnpm', 'yarn']);
/** Characters that mean something to cmd.exe. None may appear in an argument we hand it. */
const CMD_METACHARACTERS = /[&|<>^"%\r\n]/;

export function minimalEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (PASS_THROUGH.has(upper) || upper.startsWith('NPM_CONFIG_')) env[key] = value;
  }
  return env;
}

export interface SpawnTarget {
  readonly file: string;
  readonly args: string[];
}

/**
 * Decide what to execute. Everything runs directly, with no shell, except the npm/pnpm/yarn `.cmd` shims on
 * Windows, which Node cannot start directly. Those go through cmd.exe explicitly with a fixed argument vector
 * (the `shell` option is never used), and any argument with a cmd.exe metacharacter is refused.
 */
export function resolveSpawn(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): SpawnTarget {
  if (platform !== 'win32' || !WINDOWS_SHIMS.has(command)) return { file: command, args: [...args] };
  for (const arg of args) {
    if (CMD_METACHARACTERS.test(arg)) throw new Error(`Refusing to pass an unsafe argument to cmd.exe: ${JSON.stringify(arg)}`);
  }
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] };
}

export function createProcessRunner(source: Readonly<Record<string, string | undefined>> = process.env): ProcessRunner {
  return {
    run(command, args, options) {
      return new Promise<ProcessResult>((resolve) => {
        let target: SpawnTarget;
        try {
          target = resolveSpawn(command, args);
        } catch (error) {
          resolve({ code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
          return;
        }
        let stdout = '';
        let stderr = '';
        const child = spawn(target.file, target.args, {
          cwd: options.cwd,
          env: minimalEnv(source),
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        child.stdout.on('data', (chunk: Buffer) => void (stdout = (stdout + chunk.toString()).slice(-MAX_OUTPUT)));
        child.stderr.on('data', (chunk: Buffer) => void (stderr = (stderr + chunk.toString()).slice(-MAX_OUTPUT)));
        child.on('error', (error) => resolve({ code: null, stdout, stderr: stderr || error.message }));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });
    },
  };
}