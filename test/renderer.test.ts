import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/adapters/memory-fs.js';
import { DirectoryDefinitionSource } from '../src/core/definition/loader.js';
import { renderDefinition } from '../src/core/render/renderer.js';
import { DefinitionError } from '../src/errors/index.js';
import { seedTemplate } from './helpers/fixtures.js';

async function render(
  files: Record<string, string | Uint8Array>,
  manifest: Record<string, unknown> = {},
  answers: Record<string, string | boolean | null> = {},
  partials: Record<string, string> = {},
) {
  const mem = new MemoryFileSystem();
  const textFiles = Object.fromEntries(Object.entries(files).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  seedTemplate(mem, 't', manifest, textFiles, partials);
  for (const [name, value] of Object.entries(files)) {
    if (typeof value !== 'string') await mem.mkdir(`/tpl/t/files`).then(() => mem.writeFile(`/tpl/t/files/${name}`, value));
  }
  const def = await new DirectoryDefinitionSource(mem, '/tpl', 'template').load('t');
  return renderDefinition(def, { name: 'proj', answers });
}
const text = (f: { content: Uint8Array }) => new TextDecoder().decode(f.content);

describe('renderDefinition', () => {
  it('renders only .hbs files and strips the suffix', async () => {
    const { files } = await render({ 'a.txt.hbs': 'hi {{name}}', 'b.txt': 'raw {{name}}' });
    expect(files.map((f) => [f.path, text(f)])).toEqual([['a.txt', 'hi proj\n'], ['b.txt', 'raw {{name}}\n']]);
  });

  it('leaves GitHub Actions expressions untouched in non-template files', async () => {
    const yaml = 'token: ${{ secrets.NPM_TOKEN }}';
    const { files } = await render({ '_dot_github/workflows/ci.yml': yaml });
    expect(files[0]?.path).toBe('.github/workflows/ci.yml');
    expect(text(files[0]!)).toBe(`${yaml}\n`);
  });

  it('does not HTML-escape values', async () => {
    const { files } = await render({ 'a.hbs': '{{v}}' }, { questions: [{ id: 'v', type: 'string', message: 'm' }] }, { v: `<a href="x">&'` });
    expect(text(files[0]!)).toBe(`<a href="x">&'\n`);
  });

  it('renders placeholders in paths and restores leading dots', async () => {
    const { files } = await render({ 'src/{{name}}.ts.hbs': 'x', '_dot_gitignore': 'node_modules' });
    expect(files.map((f) => f.path)).toEqual(['.gitignore', 'src/proj.ts']);
  });

  it('supports partials and the helper set', async () => {
    const src = [
      '{{> head}}',
      '{{kebabCase title}}|{{pascalCase title}}|{{snakeCase title}}|{{camelCase title}}',
      '{{json title}}|{{yamlString title}}|{{shellQuote q}}',
      '{{#if (and a b)}}both{{/if}}{{#if (or a c)}}either{{/if}}{{#if (not c)}}notc{{/if}}{{#if (ne a b)}}ne{{/if}}',
      '{{indent 2 block}}',
    ].join('\n');
    const questions = ['title', 'q', 'block'].map((id) => ({ id, type: 'string', message: id }));
    // Handlebars consumes the line break after a standalone partial tag, so partials end with their own newline.
    const { files } = await render(
      { 'a.hbs': src },
      { questions },
      { title: 'My Cool App', q: "it's", block: 'l1\n\nl2', a: true, b: true, c: false },
      { 'head.hbs': '# header\n' },
    );
    expect(text(files[0]!)).toBe(
      [
        '# header',
        'my-cool-app|MyCoolApp|my_cool_app|myCoolApp',
        '"My Cool App"|"My Cool App"|\'it\'\\\'\'s\'',
        'botheithernotc',
        '  l1',
        '',
        '  l2',
        '',
      ].join('\n'),
    );
  });

  it('fails loudly on undeclared variables (strict mode)', async () => {
    await expect(render({ 'a.hbs': '{{missing}}' })).rejects.toThrow(DefinitionError);
    await expect(render({ 'a.hbs': '{{missing}}' })).rejects.toThrow(/failed to render a\.hbs/);
  });

  it('cannot call helpers the engine did not register', async () => {
    await expect(render({ 'a.hbs': '{{lookup this "constructor"}}{{#each this}}{{/each}}{{evil 1}}' })).rejects.toThrow(DefinitionError);
  });

  it('does not expose prototype properties', async () => {
    await expect(render({ 'a.hbs': '{{constructor.name}}' })).rejects.toThrow(DefinitionError);
  });

  it('rejects template paths that render to something unsafe', async () => {
    const q = { questions: [{ id: 'dir', type: 'string', message: 'm' }] };
    await expect(render({ '{{dir}}/x.txt': 'x' }, q, { dir: '..' })).rejects.toThrow(/Unsafe output path/);
    await expect(render({ '{{dir}}/x.txt': 'x' }, q, { dir: '/abs' })).rejects.toThrow(/Unsafe output path/);
    await expect(render({ '{{dir}}x.txt': 'x' }, q, { dir: '../' })).rejects.toThrow(/Unsafe output path/);
  });

  it('rejects two sources that produce the same output, including case-insensitively', async () => {
    await expect(render({ 'a.txt': '1', 'a.txt.hbs': '2' })).rejects.toThrow(/both produce/);
    await expect(render({ 'README.md': '1', 'readme.md': '2' })).rejects.toThrow(/both produce/);
  });

  it('normalizes line endings and trailing newlines for text, never for binary', async () => {
    const bytes = new Uint8Array([0, 1, 2, 13, 10, 255]);
    const { files } = await render({ 'crlf.txt': 'a\r\nb', 'empty.txt': '', 'blob.dat': bytes });
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(text(byPath['crlf.txt']!)).toBe('a\nb\n');
    expect(text(byPath['empty.txt']!)).toBe('');
    expect([...byPath['blob.dat']!.content]).toEqual([...bytes]);
  });

  it('applies file rules: executable bit and conditions', async () => {
    const { files, skipped } = await render(
      { 'run.sh': '#!/bin/sh', 'docker.txt': 'd' },
      { questions: [{ id: 'docker', type: 'boolean', message: 'm' }], files: [{ path: 'run.sh', executable: true }, { path: 'docker.txt', when: { answer: 'docker', equals: true } }] },
      { docker: false },
    );
    expect(files.map((f) => [f.path, f.mode.toString(8)])).toEqual([['run.sh', '755']]);
    expect(skipped.map((s) => s.sourcePath)).toEqual(['docker.txt']);
  });

  it('is deterministic regardless of input ordering (property)', async () => {
    const names = ['a.txt', 'b/c.txt', 'b/a.txt', 'z.hbs', 'm/n/o.txt'];
    await fc.assert(
      fc.asyncProperty(fc.shuffledSubarray(names, { minLength: 1 }), async (subset) => {
        const input = Object.fromEntries(subset.map((n) => [n, `content of ${n} {{name}}`.replace(/\{\{name\}\}/, n.endsWith('.hbs') ? '{{name}}' : 'x')]));
        const first = await render(input);
        const second = await render(Object.fromEntries([...Object.entries(input)].reverse()));
        expect(first.files.map((f) => [f.path, text(f)])).toEqual(second.files.map((f) => [f.path, text(f)]));
        expect(first.files.map((f) => f.path)).toEqual([...first.files.map((f) => f.path)].sort());
      }),
      { numRuns: 30 },
    );
  });
});
