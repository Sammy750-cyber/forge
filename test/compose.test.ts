import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/adapters/memory-fs.js';
import { compose, renderComposition } from '../src/core/definition/compose.js';
import { DirectoryDefinitionSource, type LoadedDefinition } from '../src/core/definition/loader.js';
import { DefinitionError } from '../src/errors/index.js';
import { seedTemplate } from './helpers/fixtures.js';

async function load(defs: { id: string; kind: 'template' | 'feature'; manifest?: Record<string, unknown>; files?: Record<string, string> }[]) {
  const mem = new MemoryFileSystem();
  const out: LoadedDefinition[] = [];
  for (const def of defs) {
    const manifest = { kind: def.kind, ...def.manifest };
    if (def.kind === 'template') seedTemplate(mem, def.id, manifest, def.files ?? {});
    else {
      mem.seed({ [`/f/${def.id}/forge.feature.json`]: JSON.stringify({ id: def.id, version: '1.0.0', description: 'd', ...manifest }) });
      mem.seed(Object.fromEntries(Object.entries(def.files ?? {}).map(([name, content]) => [`/f/${def.id}/files/${name}`, content])));
    }
    out.push(await (def.kind === 'template' ? new DirectoryDefinitionSource(mem, '/tpl', 'template') : new DirectoryDefinitionSource(mem, '/f', 'feature')).load(def.id));
  }
  return out;
}
const q = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'string', message: id, ...extra });

describe('compose', () => {
  it('asks each shared question once, with the first definition winning', async () => {
    const [base, a, b] = await load([
      { id: 'base', kind: 'template', manifest: { questions: [q('docker', { type: 'boolean', default: true })] } },
      { id: 'a', kind: 'feature', manifest: { questions: [q('docker', { type: 'boolean', default: false }), q('only-a')] } },
      { id: 'b', kind: 'feature', manifest: { questions: [q('only-b')] } },
    ]);
    const { questions } = compose(base!, [b!, a!]);
    expect(questions.questions.map((x) => x.id)).toEqual(['docker', 'only-a', 'only-b']);
    expect(questions.questions[0]).toMatchObject({ default: true });
  });

  it('rejects the same id declared with a different type or different choices', async () => {
    const [x, y] = await load([
      { id: 'x', kind: 'feature', manifest: { questions: [q('k', { type: 'boolean' })] } },
      { id: 'y', kind: 'feature', manifest: { questions: [q('k')] } },
    ]);
    expect(() => compose(null, [x!, y!])).toThrow(/declares question "k" differently/);
    const [e1, e2] = await load([
      { id: 'e1', kind: 'feature', manifest: { questions: [q('k', { type: 'enum', choices: ['a'] })] } },
      { id: 'e2', kind: 'feature', manifest: { questions: [q('k', { type: 'enum', choices: ['a', 'b'] })] } },
    ]);
    expect(() => compose(null, [e1!, e2!])).toThrow(DefinitionError);
  });

  it('orders features so dependencies come first (alphabetical otherwise), and rejects missing, conflicting and cyclic ones', async () => {
    const [a, b, c] = await load([
      { id: 'a', kind: 'feature', manifest: { requires: { features: ['c'] } } },
      { id: 'b', kind: 'feature' },
      { id: 'c', kind: 'feature' },
    ]);
    expect(compose(null, [a!, b!, c!]).definitions.map((d) => d.manifest.id)).toEqual(['c', 'a', 'b']);
    expect(() => compose(null, [a!])).toThrow(/requires "c"/);

    const [p, r] = await load([
      { id: 'p', kind: 'feature', manifest: { requires: { conflicts: ['r'] } } },
      { id: 'r', kind: 'feature' },
    ]);
    expect(() => compose(null, [p!, r!])).toThrow(/cannot be combined/);

    const [m, n] = await load([
      { id: 'm', kind: 'feature', manifest: { requires: { features: ['n'] } } },
      { id: 'n', kind: 'feature', manifest: { requires: { features: ['m'] } } },
    ]);
    expect(() => compose(null, [m!, n!])).toThrow(/cycle/);
  });

  it('enforces kinds and de-duplicates repeated features', async () => {
    const [t, f] = await load([{ id: 't', kind: 'template' }, { id: 'f', kind: 'feature' }]);
    expect(() => compose(f!, [])).toThrow(/not a template/);
    expect(() => compose(null, [t!])).toThrow(/not a feature/);
    expect(compose(t!, [f!, f!]).definitions).toHaveLength(2);
  });
});

describe('renderComposition', () => {
  const ctx = { name: 'demo', answers: {} };

  it('merges a shared file when both sides declare a merge strategy', async () => {
    const rules = { files: [{ path: 'ignore', mergeStrategy: 'line-set' }] };
    const defs = await load([
      { id: 'one', kind: 'feature', manifest: rules, files: { ignore: 'a\nb\n' } },
      { id: 'two', kind: 'feature', manifest: rules, files: { ignore: 'b\nc\n' } },
    ]);
    const { files } = renderComposition(compose(null, defs), ctx);
    expect(new TextDecoder().decode(files[0]!.content)).toBe('a\nb\n\nc\n');
  });

  it('allows two definitions to write byte-identical files, but not different ones', async () => {
    const same = await load([
      { id: 'one', kind: 'feature', files: { 'x.txt': 'same' } },
      { id: 'two', kind: 'feature', files: { 'x.txt': 'same' } },
    ]);
    expect(renderComposition(compose(null, same), ctx).files).toHaveLength(1);
    const differ = await load([
      { id: 'one', kind: 'feature', files: { 'x.txt': 'A' } },
      { id: 'two', kind: 'feature', files: { 'x.txt': 'B' } },
    ]);
    expect(() => renderComposition(compose(null, differ), ctx)).toThrow(/both write x\.txt/);
  });

  it('reports a clash that cannot be merged', async () => {
    const rules = { files: [{ path: 'c.json', mergeStrategy: 'json-merge' }] };
    const defs = await load([
      { id: 'one', kind: 'feature', manifest: rules, files: { 'c.json': '{"a":1}' } },
      { id: 'two', kind: 'feature', manifest: rules, files: { 'c.json': 'not json' } },
    ]);
    expect(() => renderComposition(compose(null, defs), ctx)).toThrow(DefinitionError);
  });
});
