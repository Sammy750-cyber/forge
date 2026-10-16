/** A small, dependency-free line diff (Myers' O(ND) algorithm) and unified-diff formatter. */

export type Edit = { readonly op: 'eq' | 'del' | 'ins'; readonly line: string };

/** Split into lines, treating a trailing newline as a terminator rather than an extra empty line. */
export function toLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * The shortest edit script turning `a` into `b`. Returns null when the files differ by more than `maxEdits`
 * lines, so a huge diff cannot hang the CLI.
 */
export function diffLines(a: readonly string[], b: readonly string[], maxEdits = 2000): Edit[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];

  let found = -1;
  for (let d = 0; d <= limit && found < 0; d += 1) {
    // Only the band k in [-d-1, d+1] can be read in this round, so that is all we keep.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0)) ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;

  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d -= 1) {
    const band = trace[d] as Int32Array;
    const at = (k: number): number => band[k + d + 1] ?? 0;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push({ op: 'eq', line: a[x - 1] as string });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) edits.push({ op: 'ins', line: b[y - 1] as string });
      else edits.push({ op: 'del', line: a[x - 1] as string });
    }
    x = prevX;
    y = prevY;
  }
  return edits.reverse();
}

export interface UnifiedOptions {
  readonly oldLabel: string;
  readonly newLabel: string;
  readonly context?: number;
}

/**
 * A unified diff, or '' when the texts have the same lines, or null if they differ too much to show.
 * (Line endings and a missing final newline are deliberately not distinguished.)
 */
export function unifiedDiff(oldText: string, newText: string, options: UnifiedOptions): string | null {
  const edits = diffLines(toLines(oldText), toLines(newText));
  if (edits === null) return null;
  if (edits.every((edit) => edit.op === 'eq')) return '';

  const context = options.context ?? 3;
  // Number every edit with its position in each file.
  const positioned = edits.map((edit, index) => ({ edit, index }));
  let oldLine = 1;
  let newLine = 1;
  const starts = positioned.map(({ edit }) => {
    const here = { oldLine, newLine };
    if (edit.op !== 'ins') oldLine += 1;
    if (edit.op !== 'del') newLine += 1;
    return here;
  });

  const changes = edits.flatMap((edit, index) => (edit.op === 'eq' ? [] : [index]));
  const hunks: { from: number; to: number }[] = [];
  for (const index of changes) {
    const from = Math.max(0, index - context);
    const to = Math.min(edits.length - 1, index + context);
    const last = hunks[hunks.length - 1];
    if (last !== undefined && from <= last.to + 1) last.to = Math.max(last.to, to);
    else hunks.push({ from, to });
  }

  const out = [`--- ${options.oldLabel}`, `+++ ${options.newLabel}`];
  for (const { from, to } of hunks) {
    const slice = edits.slice(from, to + 1);
    const oldCount = slice.filter((e) => e.op !== 'ins').length;
    const newCount = slice.filter((e) => e.op !== 'del').length;
    const start = starts[from] as { oldLine: number; newLine: number };
    out.push(`@@ -${oldCount === 0 ? start.oldLine - 1 : start.oldLine},${oldCount} +${newCount === 0 ? start.newLine - 1 : start.newLine},${newCount} @@`);
    for (const edit of slice) out.push(`${edit.op === 'eq' ? ' ' : edit.op === 'del' ? '-' : '+'}${edit.line}`);
  }
  return `${out.join('\n')}\n`;
}
