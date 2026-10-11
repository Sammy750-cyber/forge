import { isMap, isSeq, parse, parseDocument, type Document } from 'yaml';

export const MERGE_STRATEGIES = ['json-merge', 'yaml-merge', 'line-set'] as const;
export type MergeStrategyName = (typeof MERGE_STRATEGIES)[number];
export type MergeStrategy = 'overwrite' | 'none' | MergeStrategyName;

export type MergeResult = { readonly ok: true; readonly content: string } | { readonly ok: false; readonly reason: string };

export const isMergeable = (strategy: MergeStrategy): strategy is MergeStrategyName =>
  (MERGE_STRATEGIES as readonly string[]).includes(strategy);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}

/** Append lines that are not already present. Never removes or reorders anything. */
function mergeLines(existing: string, incoming: string): MergeResult {
  const have = new Set(existing.split('\n').map((line) => line.trim()));
  const additions = incoming
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !have.has(line.trim()));
  if (additions.length === 0) return { ok: true, content: existing };
  const separator = existing.trim() === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return { ok: true, content: `${existing}${separator}${additions.join('\n')}\n` };
}

function mergeJsonValues(existing: unknown, incoming: unknown): unknown {
  if (isPlainObject(existing) && isPlainObject(incoming)) {
    const out: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(incoming)) out[key] = key in existing ? mergeJsonValues(existing[key], value) : value;
    return out;
  }
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    return [...existing, ...incoming.filter((item) => !existing.some((have) => deepEqual(have, item)))];
  }
  return existing; // a conflicting scalar: the user's value wins
}

/** Deep-merge JSON objects. Arrays are unioned, user scalars win, and untouched files keep their exact bytes. */
function mergeJson(existing: string, incoming: string): MergeResult {
  let current: unknown;
  let next: unknown;
  try {
    current = JSON.parse(existing);
  } catch {
    return { ok: false, reason: 'the existing file is not strict JSON (comments or trailing commas?)' };
  }
  try {
    next = JSON.parse(incoming);
  } catch {
    return { ok: false, reason: 'the incoming content is not valid JSON' };
  }
  if (!isPlainObject(current) || !isPlainObject(next)) return { ok: false, reason: 'both sides must be JSON objects' };
  const merged = mergeJsonValues(current, next);
  if (deepEqual(merged, current)) return { ok: true, content: existing };
  const indentMatch = /^([ \t]+)"/m.exec(existing);
  const indent = indentMatch?.[1]?.startsWith('\t') ? '\t' : (indentMatch?.[1]?.length ?? 2);
  return { ok: true, content: `${JSON.stringify(merged, null, indent)}\n` };
}

function mergeYamlNode(node: unknown, value: unknown, doc: Document): boolean {
  if (isMap(node) && isPlainObject(value)) {
    let changed = false;
    for (const [key, child] of Object.entries(value)) {
      if (node.has(key)) changed = mergeYamlNode(node.get(key, true), child, doc) || changed;
      else {
        node.set(key, doc.createNode(child));
        changed = true;
      }
    }
    return changed;
  }
  if (isSeq(node) && Array.isArray(value)) {
    const have = node.toJSON() as unknown[];
    let changed = false;
    for (const item of value) {
      if (have.some((existing) => deepEqual(existing, item))) continue;
      node.add(doc.createNode(item));
      have.push(item);
      changed = true;
    }
    return changed;
  }
  return false; // a conflicting scalar: the user's value wins
}

/** Merge YAML while preserving the existing file's comments and formatting. */
function mergeYaml(existing: string, incoming: string): MergeResult {
  const doc = parseDocument(existing);
  if (doc.errors.length > 0) return { ok: false, reason: `the existing file is not valid YAML (${doc.errors[0]?.message ?? 'parse error'})` };
  let next: unknown;
  try {
    next = parse(incoming);
  } catch {
    return { ok: false, reason: 'the incoming content is not valid YAML' };
  }
  if (!isPlainObject(next)) return { ok: false, reason: 'the incoming YAML must be a mapping' };
  if (doc.contents === null) return { ok: true, content: incoming };
  if (!isMap(doc.contents)) return { ok: false, reason: 'the existing YAML must be a mapping at the top level' };
  return mergeYamlNode(doc.contents, next, doc) ? { ok: true, content: doc.toString({ lineWidth: 0 }) } : { ok: true, content: existing };
}

export function mergeContent(strategy: MergeStrategyName, existing: string, incoming: string): MergeResult {
  switch (strategy) {
    case 'line-set':
      return mergeLines(existing, incoming);
    case 'json-merge':
      return mergeJson(existing, incoming);
    case 'yaml-merge':
      return mergeYaml(existing, incoming);
  }
}
