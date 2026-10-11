import { describe, expect, it } from 'vitest';
import { camelCase, kebabCase, pascalCase, snakeCase, words } from '../src/core/util/case.js';
import { sha256Hex } from '../src/core/util/hash.js';
import { redact, REDACTED } from '../src/core/util/redact.js';
import { stableStringify } from '../src/core/util/stable-json.js';
import { ConfigError, EXIT, FsError, InternalError, toForgeError } from '../src/errors/index.js';
import { createLogger } from '../src/adapters/logger.js';

describe('case helpers', () => {
  it('splits identifiers into words', () => {
    expect(words('myApp_name-v2')).toEqual(['my', 'app', 'name', 'v2']);
    expect(words('HTTPServer')).toEqual(['http', 'server']);
  });
  it('converts between styles', () => {
    expect(kebabCase('My API Service')).toBe('my-api-service');
    expect(snakeCase('myApiService')).toBe('my_api_service');
    expect(pascalCase('my-api-service')).toBe('MyApiService');
    expect(camelCase('my-api-service')).toBe('myApiService');
    expect(camelCase('')).toBe('');
  });
});

describe('stableStringify', () => {
  it('sorts keys recursively, drops undefined, ends with a newline', () => {
    const out = stableStringify({ b: 1, a: { d: [3, { z: 1, y: undefined }], c: null } });
    expect(out).toBe('{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      {\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n');
  });
  it('is independent of key insertion order', () => {
    expect(stableStringify({ x: 1, y: 2 })).toBe(stableStringify({ y: 2, x: 1 }));
  });
});

describe('sha256Hex', () => {
  it('matches a known vector', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('redact', () => {
  it('masks sensitive keys at any depth without mutating input', () => {
    const input = { user: 'a', apiKey: 'k', nested: { password: 'p', list: [{ token: 't', ok: 1 }] } };
    const out = redact(input) as typeof input;
    expect(out.apiKey).toBe(REDACTED);
    expect(out.nested.password).toBe(REDACTED);
    expect((out.nested.list[0] as { token: string; ok: number }).token).toBe(REDACTED);
    expect(out.user).toBe('a');
    expect(input.apiKey).toBe('k');
  });
  it('truncates absurd depth and serialises errors safely', () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 20; i += 1) deep = (deep['c'] = {}) as Record<string, unknown>;
    expect(JSON.stringify(redact(root))).toContain('[truncated]');
    expect(redact(new Error('boom'))).toEqual({ name: 'Error', message: 'boom' });
  });
});

describe('errors', () => {
  it('maps to stable exit codes and keeps hints and causes', () => {
    const cause = new Error('root');
    const err = new ConfigError('bad', { hint: 'fix it', cause });
    expect(err.exitCode).toBe(EXIT.CONFIG);
    expect(err.code).toBe('FORGE_E_CONFIG');
    expect(err.hint).toBe('fix it');
    expect(err.cause).toBe(cause);
    expect(new FsError('x').exitCode).toBe(EXIT.FS);
  });
  it('wraps unknown throwables as InternalError', () => {
    const wrapped = toForgeError('weird');
    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.exitCode).toBe(EXIT.INTERNAL);
    expect(wrapped.hint).toMatch(/bug/i);
    const original = new FsError('kept');
    expect(toForgeError(original)).toBe(original);
  });
});

describe('logger', () => {
  const capture = (options: Partial<Parameters<typeof createLogger>[0]> = {}) => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', json: false, write: (l) => lines.push(l), now: () => new Date('2026-01-01T00:00:00Z'), ...options });
    return { lines, logger };
  };
  it('filters by level and formats text with redaction', () => {
    const { lines, logger } = capture();
    logger.debug('hidden');
    logger.info('hello', { path: 'a', token: 'secret' });
    logger.warn('careful');
    logger.error('bad');
    expect(lines).toEqual(['hello path=a token=[redacted]', 'warning: careful', 'error: bad']);
  });
  it('emits JSON lines', () => {
    const { lines, logger } = capture({ json: true, level: 'debug' });
    logger.debug('d', { password: 'x', n: 1 });
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({ time: '2026-01-01T00:00:00.000Z', level: 'debug', message: 'd', password: '[redacted]', n: 1 });
  });
  it('is silent when asked', () => {
    const { lines, logger } = capture({ level: 'silent' });
    logger.error('nope');
    expect(lines).toEqual([]);
  });
});
