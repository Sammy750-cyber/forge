// Run with FORGE_NETWORK_TESTS=1. Verifies that every input Forge passes to a pinned action still exists
// in that action's action.yml at the pinned commit.
import { describe, expect, it } from 'vitest';
import { ACTION_INPUTS } from '../../src/core/pipeline/pins.js';
import { PINS } from '../helpers/fixtures.js';

const enabled = process.env['FORGE_NETWORK_TESTS'] === '1';

async function fetchActionYml(repo: string, sha: string): Promise<string> {
  for (const name of ['action.yml', 'action.yaml']) {
    const response = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${name}`);
    if (response.ok) return response.text();
  }
  throw new Error(`no action.yml for ${repo}@${sha}`);
}

describe.skipIf(!enabled)('pinned actions (network)', () => {
  for (const [key, inputs] of Object.entries(ACTION_INPUTS)) {
    it(`${key} still accepts every input Forge uses`, async () => {
      const pin = PINS.actions[key];
      expect(pin, `${key} must be pinned`).toBeDefined();
      const yml = (await fetchActionYml(key, pin!.sha)).replace(/\r/g, '');
      const block = /^inputs:\n([\s\S]*?)(?=^\S)/m.exec(yml)?.[1] ?? '';
      const declared = [...block.matchAll(/^ {2}([A-Za-z0-9_-]+):/gm)].map((m) => m[1]);
      for (const input of inputs) expect(declared, `${key} input ${input}`).toContain(input);
    }, 30_000);
  }
});
