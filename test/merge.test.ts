import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isMergeable, mergeContent } from '../src/core/merge/index.js';

const ok = (r: ReturnType<typeof mergeContent>): string => {
  if (!r.ok) throw new Error(`merge failed: ${r.reason}`);
  return r.content;
};

describe('line-set', () => {
  it('appends only missing lines and never reorders or removes', () => {
    expect(ok(mergeContent('line-set', 'node_modules/\nmine\n', 'node_modules/\n.env\n'))).toBe('node_modules/\nmine\n\n.env\n');
  });
  it('returns the existing text untouched when nothing is missing', () => {
    const existing = '  .env  \nnode_modules/';
    expect(ok(mergeContent('line-set', existing, '.env\nnode_modules/\n'))).toBe(existing);
  });
  it('handles empty and newline-less files', () => {
    expect(ok(mergeContent('line-set', '', 'a\nb\n'))).toBe('a\nb\n');
    expect(ok(mergeContent('line-set', 'a', 'b\n'))).toBe('a\n\nb\n');
  });
  it('property: idempotent, and keeps every existing line', () => {
    const line = fc.stringMatching(/^[a-z.!*/#-]{0,8}$/);
    fc.assert(
      fc.property(fc.array(line, { maxLength: 6 }), fc.array(line, { maxLength: 6 }), (a, b) => {
        const existing = a.length > 0 ? `${a.join('\n')}\n` : '';
        const once = ok(mergeContent('line-set', existing, b.join('\n')));
        expect(ok(mergeContent('line-set', once, b.join('\n')))).toBe(once);
        for (const kept of a.filter((l) => l.trim() !== '')) expect(once.split('\n')).toContain(kept);
      }),
    );
  });
});

describe('json-merge', () => {
  it('deep-merges objects, unions arrays, and lets the user win scalar conflicts', () => {
    const existing = JSON.stringify({ name: 'mine', engines: { node: '>=20' }, files: ['dist'], scripts: { test: 'jest' } }, null, 2);
    const incoming = JSON.stringify({ name: 'theirs', engines: { node: '>=22', npm: '>=10' }, files: ['dist', 'pins'], scripts: { lint: 'eslint .' } });
    const merged = JSON.parse(ok(mergeContent('json-merge', existing, incoming)));
    expect(merged).toEqual({ name: 'mine', engines: { node: '>=20', npm: '>=10' }, files: ['dist', 'pins'], scripts: { test: 'jest', lint: 'eslint .' } });
  });
  it('keeps the exact bytes when nothing changes, and preserves indentation when it does', () => {
    const tabs = '{\n\t"a": 1\n}\n';
    expect(ok(mergeContent('json-merge', tabs, '{"a":1}'))).toBe(tabs);
    expect(ok(mergeContent('json-merge', tabs, '{"b":2}'))).toBe('{\n\t"a": 1,\n\t"b": 2\n}\n');
  });
  it('refuses what it cannot merge safely', () => {
    expect(mergeContent('json-merge', '{ // comment\n}', '{}')).toMatchObject({ ok: false });
    expect(mergeContent('json-merge', '[]', '{}')).toMatchObject({ ok: false });
    expect(mergeContent('json-merge', '{}', 'nope')).toMatchObject({ ok: false });
  });
  it('property: idempotent and never loses existing keys', () => {
    const json = fc.dictionary(fc.constantFrom('a', 'b', 'c'), fc.oneof(fc.integer(), fc.string({ maxLength: 4 }), fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 3 })), { maxKeys: 3 });
    fc.assert(
      fc.property(json, json, (a, b) => {
        const existing = `${JSON.stringify(a, null, 2)}\n`;
        const once = ok(mergeContent('json-merge', existing, JSON.stringify(b)));
        expect(ok(mergeContent('json-merge', once, JSON.stringify(b)))).toBe(once);
        const parsed = JSON.parse(once) as Record<string, unknown>;
        for (const key of Object.keys(a)) expect(key in parsed).toBe(true);
      }),
    );
  });
});

describe('yaml-merge', () => {
  const existing = '# my pipeline\nstages: [build]\n\nbuild:\n  script: make # keep me\n';
  it('adds missing keys and list items while preserving comments and the user\'s values', () => {
    const merged = ok(mergeContent('yaml-merge', existing, 'stages: [build, test]\nbuild:\n  script: other\ninclude:\n  - local: a.yml\n'));
    expect(merged).toContain('# my pipeline');
    expect(merged).toContain('# keep me');
    expect(merged).toContain('script: make');
    expect(merged).not.toContain('other');
    expect(merged).toMatch(/stages:.*test/s);
    expect(merged).toContain('local: a.yml');
  });
  it('is idempotent and byte-stable when nothing is new', () => {
    const incoming = 'include:\n  - local: a.yml\nstages: [build]\n';
    const once = ok(mergeContent('yaml-merge', existing, incoming));
    expect(ok(mergeContent('yaml-merge', once, incoming))).toBe(once);
    expect(ok(mergeContent('yaml-merge', existing, 'stages: [build]\n'))).toBe(existing);
  });
  it('treats an empty file as create, and rejects invalid or non-mapping YAML', () => {
    expect(ok(mergeContent('yaml-merge', '', 'a: 1\n'))).toBe('a: 1\n');
    expect(mergeContent('yaml-merge', 'a: [unclosed', 'b: 1')).toMatchObject({ ok: false });
    expect(mergeContent('yaml-merge', '- a\n- b\n', 'b: 1')).toMatchObject({ ok: false });
    expect(mergeContent('yaml-merge', 'a: 1', '- x')).toMatchObject({ ok: false });
  });
});

describe('isMergeable', () => {
  it('recognises merge strategies only', () => {
    expect(['overwrite', 'none'].some((s) => isMergeable(s as never))).toBe(false);
    expect(['json-merge', 'yaml-merge', 'line-set'].every((s) => isMergeable(s as never))).toBe(true);
  });
});
