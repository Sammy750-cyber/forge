import { spawn } from 'node:child_process';
import type { ProcessResult, ProcessRunner } from '../ports/index.js';

/** Variables a package manager or git genuinely needs. Everything else (tokens, cloud keys) stays out. */
const PASS_THROUGH = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
]);
const MAX_OUTPUT = 64 * 1024;
const WINDOWS_SHIMS = new Set(['npm', 'pnpm', 'yarn']);

export function minimalEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (PASS_THROUGH.has(upper) || upper.startsWith('NPM_CONFIG_')) env[key] = value;
  }
  return env;
}

export function createProcessRunner(source: Readonly<Record<string, string | undefined>> = process.env): ProcessRunner {
  return {
    run(command, args, options) {
      return new Promise<ProcessResult>((resolve) => {
        let stdout = '';
        let stderr = '';
        // Windows cannot spawn .cmd shims without a shell. The arguments are fixed strings chosen by Forge,
        // never user input, so enabling the shell for these three names is safe.
        const needsShell = process.platform === 'win32' && WINDOWS_SHIMS.has(command);
        const child = spawn(command, [...args], {
          cwd: options.cwd,
          env: minimalEnv(source),
          shell: needsShell,
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
