const PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Parsed {
  readonly core: readonly [number, number, number];
  readonly pre: readonly string[];
}

function parse(version: string): Parsed | null {
  const match = PATTERN.exec(version);
  if (match === null) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] === undefined ? [] : match[4].split('.') };
}

const isNumeric = (id: string): boolean => /^\d+$/.test(id);

/** Compare two semantic versions. Returns null if either is not valid semver. Build metadata is ignored, as the spec says. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return null;
  for (let i = 0; i < 3; i += 1) {
    const diff = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  // A version without a prerelease is higher than the same version with one.
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (isNumeric(p) && isNumeric(q)) return Number(p) < Number(q) ? -1 : 1;
    if (isNumeric(p) !== isNumeric(q)) return isNumeric(p) ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
