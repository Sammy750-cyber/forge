import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { resolveInside, validateRelativePath } from '../src/core/util/safe-path.js';
import { DefinitionError, FsError } from '../src/errors/index.js';

describe('validateRelativePath', () => {
  it.each(['a', 'src/index.ts', '.gitignore', '.github/workflows/ci.yml', 'a/b/c/d.txt', 'dir.with.dots/file'])('accepts %s', (p) => {
    expect(validateRelativePath(p)).toBe(p);
  });

  it.each([
    ['', 'empty'],
    ['/etc/passwd', 'absolute'],
    ['C:/Windows', 'drive letter'],
    ['c:foo', 'drive letter without slash'],
    ['../escape', 'parent'],
    ['a/../../escape', 'embedded parent'],
    ['a/./b', 'dot segment'],
    ['a//b', 'empty segment'],
    ['a/', 'trailing slash'],
    ['a\\b', 'backslash'],
    ['bad\u0000name', 'NUL'],
    ['bad\nname', 'newline'],
    ['file.txt:stream', 'alternate data stream'],
    ['trailing.', 'trailing dot'],
    ['trailing ', 'trailing space'],
    ['CON', 'windows reserved'],
    ['dir/nul.txt', 'windows reserved with extension'],
    ['.git/config', '.git'],
    ['sub/.GIT/hooks', '.git any case'],
    ['.forge/state.json', 'forge reserved'],
    ['x'.repeat(256), 'long segment'],
    [`${'a/'.repeat(600)}b`, 'long path'],
  ])('rejects %j (%s)', (p) => {
    expect(() => validateRelativePath(p)).toThrow(DefinitionError);
  });

  it('property: any accepted path resolves strictly inside the root', () => {
    const root = path.resolve('/tmp/forge-root');
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 80 }), (candidate) => {
        let accepted: string;
        try {
          accepted = validateRelativePath(candidate);
        } catch (error) {
          expect(error).toBeInstanceOf(DefinitionError);
          return;
        }
        const resolved = resolveInside(root, accepted);
        const rel = path.relative(root, resolved);
        expect(rel.startsWith('..')).toBe(false);
        expect(path.isAbsolute(rel)).toBe(false);
        expect(rel).not.toBe('');
      }),
      { numRuns: 2000 },
    );
  });

  it('property: path-like strings built from dangerous parts never escape', () => {
    const root = path.resolve('/tmp/forge-root');
    const part = fc.constantFrom('..', '.', 'a', 'b.txt', '', '...', '~', '%2e%2e', 'CON', ' ', '\\');
    fc.assert(
      fc.property(fc.array(part, { minLength: 1, maxLength: 6 }), (parts) => {
        try {
          const accepted = validateRelativePath(parts.join('/'));
          expect(path.relative(root, resolveInside(root, accepted)).startsWith('..')).toBe(false);
        } catch (error) {
          expect(error).toBeInstanceOf(DefinitionError);
        }
      }),
      { numRuns: 2000 },
    );
  });
});

describe('resolveInside', () => {
  it('refuses paths that escape or equal the root', () => {
    expect(() => resolveInside('/r', '../x')).toThrow(FsError);
    expect(() => resolveInside('/r', 'a/../../x')).toThrow(FsError);
    expect(() => resolveInside('/r', 'a/..')).toThrow(FsError);
  });
  it('joins normal paths', () => {
    expect(resolveInside('/r', 'a/b.txt')).toBe(path.resolve('/r', 'a', 'b.txt'));
  });
});
