import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Find the directory of Forge's own package.json, whether running from src/ or from dist/. */
export function findPackageRoot(fromUrl: string): string {
  let current = path.dirname(fileURLToPath(fromUrl));
  for (;;) {
    if (
      existsSync(path.join(current, 'package.json')) &&
      existsSync(path.join(current, 'templates')) &&
      existsSync(path.join(current, 'features')) &&
      existsSync(path.join(current, 'pins', 'pins.json'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Could not locate the Forge package root (templates/, features/ and pins/ were not found).');
    current = parent;
  }
}
