import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/adapters/memory-fs.js';
import { persistableAnswers, resolveAnswers, evaluateWhen } from '../src/core/definition/answers.js';
import { DirectoryDefinitionSource } from '../src/core/definition/loader.js';
import { parseManifest } from '../src/core/definition/manifest.js';
import { ConfigError, DefinitionError } from '../src/errors/index.js';
import { seedTemplate } from './helpers/fixtures.js';

const base = { id: 't', version: '1.0.0', kind: 'template', description: 'd' };
const manifest = (extra: Record<string, unknown>) => parseManifest({ ...base, ...extra }, 'test');

describe('parseManifest', () => {
  it('accepts a minimal manifest and defaults questions/files', () => {
    const m = manifest({});
    expect(m.questions).toEqual([]);
    expect(m.files).toEqual([]);
  });

  it.each([
    ['unknown top-level key', { surprise: true }],
    ['bad version', { version: 'one' }],
    ['bad id', { id: 'Not Valid' }],
    ['reserved question id', { questions: [{ id: 'name', type: 'string', message: 'm' }] }],
    ['duplicate question', { questions: [{ id: 'a', type: 'string', message: 'm' }, { id: 'a', type: 'string', message: 'm' }] }],
    ['forward reference in when', { questions: [{ id: 'a', type: 'string', message: 'm', when: { answer: 'b', equals: 'x' } }, { id: 'b', type: 'string', message: 'm' }] }],
    ['enum default not in choices', { questions: [{ id: 'a', type: 'enum', message: 'm', choices: ['x'], default: 'y' }] }],
    ['invalid regex pattern', { questions: [{ id: 'a', type: 'string', message: 'm', pattern: '(' }] }],
    ['unknown merge strategy', { files: [{ path: 'a', mergeStrategy: 'rot13' }] }],
    ['duplicate file rule', { files: [{ path: 'a' }, { path: 'a' }] }],
    ['file rule with unknown question', { files: [{ path: 'a', when: { answer: 'zzz', equals: true } }] }],
    ['shell hook smuggled in', { post: ['rm -rf /'] }],
  ])('rejects %s', (_label, extra) => {
    expect(() => manifest(extra)).toThrow(DefinitionError);
  });
});

describe('answers', () => {
  const m = manifest({
    questions: [
      { id: 'lang', type: 'enum', message: 'Language', choices: ['ts', 'js'], default: 'ts' },
      { id: 'docker', type: 'boolean', message: 'Docker?', default: false },
      { id: 'image', type: 'string', message: 'Image', pattern: '^[a-z]+$', when: { answer: 'docker', equals: true } },
      { id: 'token', type: 'string', message: 'Token', secret: true, required: false },
    ],
  });

  it('fills defaults only when allowed and nulls out skipped questions', () => {
    const answers = resolveAnswers(m, {}, { useDefaults: true });
    expect(answers).toEqual({ lang: 'ts', docker: false, image: null, token: null });
  });

  it('refuses to guess when defaults are not allowed', () => {
    expect(() => resolveAnswers(m, {}, { useDefaults: false })).toThrow(/Missing answer "lang"/);
  });

  it('coerces and validates supplied answers', () => {
    const answers = resolveAnswers(m, { lang: 'js', docker: 'true', image: 'node' }, { useDefaults: true });
    expect(answers).toMatchObject({ lang: 'js', docker: true, image: 'node' });
    expect(() => resolveAnswers(m, { lang: 'rust' }, { useDefaults: true })).toThrow(ConfigError);
    expect(() => resolveAnswers(m, { docker: 'yes' }, { useDefaults: true })).toThrow(/true or false/);
    expect(() => resolveAnswers(m, { docker: true, image: 'NOPE1' }, { useDefaults: true })).toThrow(/pattern/);
  });

  it('rejects unknown answers (typo guard) and lists the known ones', () => {
    try {
      resolveAnswers(m, { langg: 'ts' }, { useDefaults: true });
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigError).hint).toContain('lang');
    }
  });

  it('never persists secret answers', () => {
    const answers = resolveAnswers(m, { token: 's3cret' }, { useDefaults: true });
    expect(persistableAnswers(m, answers)).not.toHaveProperty('token');
  });

  it('evaluates when conditions', () => {
    expect(evaluateWhen(undefined, {})).toBe(true);
    expect(evaluateWhen({ answer: 'a', equals: 1 }, { a: 1 })).toBe(true);
    expect(evaluateWhen({ answer: 'a', in: ['x', 'y'] }, { a: 'y' })).toBe(true);
    expect(evaluateWhen({ answer: 'a', in: ['x'] }, { a: 'z' })).toBe(false);
    expect(evaluateWhen({ answer: 'a' }, { a: 'text' })).toBe(true);
    expect(evaluateWhen({ answer: 'a' }, { a: false })).toBe(false);
    expect(evaluateWhen({ answer: 'a', equals: 1, not: true }, { a: 1 })).toBe(false);
  });
});

describe('DirectoryDefinitionSource', () => {
  const load = (mem: MemoryFileSystem, id = 'one') => new DirectoryDefinitionSource(mem, '/tpl', 'template').load(id);

  it('loads manifest, files and partials in a stable order', async () => {
    const mem = new MemoryFileSystem();
    seedTemplate(mem, 'one', {}, { 'b.txt': 'B', 'a/z.txt': 'Z', 'a/y.txt': 'Y' }, { 'head.hbs': 'H' });
    const def = await load(mem);
    expect(def.files.map((f) => f.sourcePath).sort()).toEqual(['a/y.txt', 'a/z.txt', 'b.txt']);
    expect(def.partials).toEqual([{ name: 'head', source: 'H' }]);
  });

  it('lists only directories that contain a manifest', async () => {
    const mem = new MemoryFileSystem();
    seedTemplate(mem, 'one', {}, {});
    mem.seed({ '/tpl/stray/readme.txt': 'x' });
    expect(await new DirectoryDefinitionSource(mem, '/tpl', 'template').list()).toEqual(['one']);
    expect(await new DirectoryDefinitionSource(mem, '/nowhere', 'template').list()).toEqual([]);
  });

  it('gives a helpful error for unknown ids and blocks traversal-style ids', async () => {
    const mem = new MemoryFileSystem();
    seedTemplate(mem, 'one', {}, {});
    await expect(load(mem, 'two')).rejects.toThrow(/No template named "two"/);
    await expect(load(mem, '../etc')).rejects.toThrow(/not a valid template id/);
  });

  it('rejects symlinks inside a template', async () => {
    const mem = new MemoryFileSystem();
    seedTemplate(mem, 'one', {}, { 'a.txt': 'a' });
    mem.symlink('/tpl/one/files/link', '/etc/passwd');
    await expect(load(mem)).rejects.toThrow(/symbolic links/);
  });

  it('rejects an id/kind that does not match its location and rules for missing files', async () => {
    const mem = new MemoryFileSystem();
    seedTemplate(mem, 'one', { id: 'other' }, {});
    await expect(load(mem)).rejects.toThrow(/does not match its location/);

    const mem2 = new MemoryFileSystem();
    seedTemplate(mem2, 'one', { files: [{ path: 'ghost.txt' }] }, { 'a.txt': 'a' });
    await expect(load(mem2)).rejects.toThrow(/does not exist under files/);
  });

  it('reports invalid JSON', async () => {
    const mem = new MemoryFileSystem();
    mem.seed({ '/tpl/one/forge.template.json': '{oops' });
    await expect(load(mem)).rejects.toThrow(/not valid JSON/);
  });
});
