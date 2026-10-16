import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffLines, toLines, unifiedDiff } from '../src/core/util/diff.js';
import { compareVersions } from '../src/core/util/semver.js';

const rebuild = (edits: ReturnType<typeof diffLines>, keep: 'old' | 'new'): string[] =>
  (edits ?? []).filter((e) => e.op === 'eq' || e.op === (keep === 'old' ? 'del' : 'ins')).map((e) => e.line);

/** A minimal patch applier, so the unified diff is tested by what it DOES, not by what it looks like. */
function applyUnified(original: string[], diff: string): string[] {
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out: string[] = [];
  let cursor = 0;
  for (let i = 2; i < lines.length; ) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[i] ?? '');
    if (header === null) throw new Error(`bad hunk header: ${lines[i]}`);
    const oldStart = Number(header[2]) === 0 ? Number(header[1]) : Number(header[1]) - 1;
    out.push(...original.slice(cursor, oldStart));
    cursor = oldStart;
    i += 1;
    while (i < lines.length && !(lines[i] ?? '').startsWith('@@')) {
      const line = lines[i] as string;
      const text = line.slice(1);
      if (line.startsWith(' ')) {
        expect(original[cursor]).toBe(text);
        out.push(text);
        cursor += 1;
      } else if (line.startsWith('-')) {
        expect(original[cursor]).toBe(text);
        cursor += 1;
      } else out.push(text);
      i += 1;
    }
  }
  out.push(...original.slice(cursor));
  return out;
}

describe('diffLines', () => {
  it('finds no edits for identical input and handles empty sides', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])?.every((e) => e.op === 'eq')).toBe(true);
    expect(diffLines([], ['x'])).toEqual([{ op: 'ins', line: 'x' }]);
    expect(diffLines(['x'], [])).toEqual([{ op: 'del', line: 'x' }]);
    expect(diffLines([], [])).toEqual([]);
  });

  it('produces a minimal script for a known case', () => {
    const edits = diffLines(['a', 'b', 'c', 'a', 'b', 'b', 'a'], ['c', 'b', 'a', 'b', 'a', 'c']);
    expect(edits?.filter((e) => e.op !== 'eq')).toHaveLength(5); // the classic Myers example: D = 5
  });

  it('PROPERTY: the script always rebuilds both inputs exactly', () => {
    const lines = fc.array(fc.constantFrom('a', 'b', 'c', 'd', ''), { maxLength: 25 });
    fc.assert(
      fc.property(lines, lines, (a, b) => {
        const edits = diffLines(a, b);
        expect(edits).not.toBeNull();
        expect(rebuild(edits, 'old')).toEqual(a);
        expect(rebuild(edits, 'new')).toEqual(b);
      }),
      { numRuns: 400 },
    );
  });

  it('gives up cleanly instead of hanging when the files are wildly different', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
    expect(diffLines(a, b)).toBeNull();
    expect(unifiedDiff(a.join('\n'), b.join('\n'), { oldLabel: 'x', newLabel: 'y' })).toBeNull();
  });
});

describe('unifiedDiff', () => {
  it('is empty for equal text, ignoring line-ending style and the final newline', () => {
    expect(unifiedDiff('a\nb\n', 'a\r\nb', { oldLabel: 'x', newLabel: 'y' })).toBe('');
  });

  it('has the standard shape', () => {
    const diff = unifiedDiff('one\ntwo\nthree\n', 'one\n2\nthree\n', { oldLabel: 'yours', newLabel: 'template' });
    expect(diff).toBe('--- yours\n+++ template\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n');
  });

  it('splits distant changes into separate hunks and merges close ones', () => {
    const old = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const far = [...old];
    far[2] = 'CHANGED A';
    far[27] = 'CHANGED B';
    expect(unifiedDiff(old.join('\n'), far.join('\n'), { oldLabel: 'a', newLabel: 'b' })?.match(/^@@/gm)).toHaveLength(2);
    const near = [...old];
    near[2] = 'CHANGED A';
    near[6] = 'CHANGED B';
    expect(unifiedDiff(old.join('\n'), near.join('\n'), { oldLabel: 'a', newLabel: 'b' })?.match(/^@@/gm)).toHaveLength(1);
  });

  it('PROPERTY: applying the diff to the old text yields exactly the new text', () => {
    const lines = fc.array(fc.constantFrom('alpha', 'beta', 'gamma', 'delta', 'eps'), { maxLength: 30 });
    fc.assert(
      fc.property(lines, lines, (a, b) => {
        const diff = unifiedDiff(a.join('\n'), b.join('\n'), { oldLabel: 'a', newLabel: 'b' });
        if (diff === '') {
          expect(a).toEqual(b);
          return;
        }
        expect(applyUnified(a, diff as string)).toEqual(b);
      }),
      { numRuns: 400 },
    );
  });

  it('toLines treats a trailing newline as a terminator', () => {
    expect(toLines('a\nb\n')).toEqual(['a', 'b']);
    expect(toLines('a\r\nb')).toEqual(['a', 'b']);
    expect(toLines('')).toEqual([]);
  });
});

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0], ['1.0.0', '1.0.1', -1], ['1.10.0', '1.9.0', 1], ['2.0.0', '10.0.0', -1],
    ['1.0.0-alpha', '1.0.0', -1], ['1.0.0', '1.0.0-rc.1', 1], ['1.0.0-alpha.2', '1.0.0-alpha.10', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1], ['1.0.0-1', '1.0.0-a', -1], ['1.0.0+build1', '1.0.0+build2', 0],
  ] as const)('%s vs %s -> %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
    expect(compareVersions(b, a)).toBe(expected === 0 ? 0 : -expected);
  });
  it('returns null for things that are not versions', () => {
    expect(compareVersions('v1', '1.0.0')).toBeNull();
    expect(compareVersions('1.0.0', 'latest')).toBeNull();
  });
});
