import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/adapters/memory-fs.js';
import { readState, serializeState, STATE_PATH, type ForgeState } from '../src/core/state/state.js';
import { StateError } from '../src/errors/index.js';

const valid: ForgeState = {
  schemaVersion: 1,
  forgeVersion: '0.1.0',
  template: { id: 'minimal', version: '0.1.0' },
  features: [],
  answers: { a: 'x', b: true, c: null },
  files: { 'README.md': 'a'.repeat(64) },
};
const at = (fs: MemoryFileSystem, content: string) => fs.seed({ [`/p/${STATE_PATH}`]: content });

describe('state store', () => {
  it('returns null when there is no state', async () => {
    expect(await readState(new MemoryFileSystem(), '/p')).toBeNull();
  });

  it('round-trips and serializes deterministically', async () => {
    const fs = new MemoryFileSystem();
    at(fs, new TextDecoder().decode(serializeState(valid)));
    expect(await readState(fs, '/p')).toEqual(valid);
    expect(serializeState(valid)).toEqual(serializeState({ ...valid, answers: { c: null, b: true, a: 'x' } }));
  });

  it.each([
    ['invalid JSON', '{nope', /not valid JSON/],
    ['wrong shape', '{"schemaVersion":1}', /invalid/],
    ['unknown field', JSON.stringify({ ...valid, extra: 1 }), /invalid/],
    ['bad hash', JSON.stringify({ ...valid, files: { 'a.txt': 'zzz' } }), /invalid/],
    ['unsafe path', JSON.stringify({ ...valid, files: { '../escape': 'a'.repeat(64) } }), /unsafe path/],
  ])('rejects %s', async (_label, content, pattern) => {
    const fs = new MemoryFileSystem();
    at(fs, content);
    await expect(readState(fs, '/p')).rejects.toThrow(StateError);
    await expect(readState(fs, '/p')).rejects.toThrow(pattern);
  });

  it('hard-fails on a newer schema instead of guessing', async () => {
    const fs = new MemoryFileSystem();
    at(fs, JSON.stringify({ ...valid, schemaVersion: 99 }));
    await expect(readState(fs, '/p')).rejects.toMatchObject({ code: 'FORGE_E_STATE_NEWER' });
  });

  it('rejects a state path that is not a file', async () => {
    const fs = new MemoryFileSystem();
    fs.seed({ [`/p/${STATE_PATH}/child`]: 'x' });
    await expect(readState(fs, '/p')).rejects.toThrow(/not a file/);
  });
});
