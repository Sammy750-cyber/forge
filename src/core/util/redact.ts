const SENSITIVE_KEY = /(secret|token|passw(or)?d|api[-_]?key|authorization|credential|private[-_]?key)/i;
const MAX_DEPTH = 6;
export const REDACTED = '[redacted]';

/** Returns a deep copy of `value` with the values of sensitive-looking keys replaced. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(child, depth + 1);
    }
    return out;
  }
  return value;
}
