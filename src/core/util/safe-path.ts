import path from 'node:path';
import { DefinitionError, FsError } from '../../errors/index.js';

const MAX_SEGMENT_LENGTH = 255;
const MAX_PATH_LENGTH = 1024;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function unsafe(input: string, reason: string): DefinitionError {
  return new DefinitionError(`Unsafe output path ${JSON.stringify(input)}: ${reason}.`, {
    code: 'FORGE_E_PATH_UNSAFE',
    hint: 'Output paths must be relative, use "/" separators, and stay inside the project directory.',
  });
}

/**
 * Validate a rendered, project-relative output path and return its normalized form.
 * Rules are intentionally stricter than any single OS so output is portable.
 */
export function validateRelativePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) throw unsafe(String(input), 'path is empty');
  if (input.length > MAX_PATH_LENGTH) throw unsafe(input.slice(0, 40) + '...', 'path is too long');
  if (CONTROL_CHARS.test(input)) throw unsafe(input, 'contains control characters');
  if (input.includes('\\')) throw unsafe(input, 'contains a backslash');
  if (input.startsWith('/') || /^[a-zA-Z]:/.test(input)) throw unsafe(input, 'path is absolute');

  const segments = input.split('/');
  segments.forEach((segment, index) => {
    if (segment === '') throw unsafe(input, 'contains an empty segment');
    if (segment === '.' || segment === '..') throw unsafe(input, 'contains "." or ".." segments');
    if (segment.length > MAX_SEGMENT_LENGTH) throw unsafe(input, 'a segment is too long');
    if (segment.includes(':')) throw unsafe(input, 'contains ":"');
    if (/[. ]$/.test(segment)) throw unsafe(input, 'a segment ends with "." or a space');
    if (WINDOWS_RESERVED.test(segment)) throw unsafe(input, `"${segment}" is a reserved name on Windows`);
    if (segment.toLowerCase() === '.git') throw unsafe(input, 'templates may not write into .git');
    if (index === 0 && segment.toLowerCase() === '.forge') {
      throw unsafe(input, '.forge is reserved for Forge state');
    }
  });
  return segments.join('/');
}

/** Defense in depth: join `relativePath` onto `root` and prove the result stays inside it. */
export function resolveInside(root: string, relativePath: string): string {
  const absolute = path.resolve(root, ...relativePath.split('/'));
  const rel = path.relative(path.resolve(root), absolute);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new FsError(`Refusing to touch ${JSON.stringify(relativePath)}: it resolves outside the project root.`, {
      code: 'FORGE_E_PATH_TRAVERSAL',
    });
  }
  return absolute;
}
