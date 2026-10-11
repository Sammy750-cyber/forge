import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Find the directory of Forge's own package.json, whether running from src/ or from dist/. */
export function findPackageRoot(fromUrl: string): string {
  let current = path.dirname(fileURLToPath(fromUrl));
  for (;;) {
    const candidate = path.join(current, 'package.json');
    if (existsSync(candidate)) {
      const name = (JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }).name;
      if (name === 'forge-cli') return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Could not locate the forge-cli package root.');
    current = parent;
  }
}
