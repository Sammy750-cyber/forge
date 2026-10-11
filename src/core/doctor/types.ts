import type { RenderedFile } from '../render/renderer.js';
import type { ForgeState } from '../state/state.js';

export type FindingSeverity = 'error' | 'warn' | 'info';

/** What a rule reports. The engine adds the rule id, severity and fixability. */
export interface Issue {
  readonly message: string;
  readonly path?: string;
  readonly line?: number;
  readonly hint?: string;
}

export interface Finding extends Issue {
  readonly ruleId: string;
  readonly severity: FindingSeverity;
  /** True when `doctor --fix` can repair it. */
  readonly fixable: boolean;
  /** Set when the rule itself crashed or timed out rather than judging the project. */
  readonly internal?: true;
  /** Present when a configured waiver covers this finding; the text is the stated justification. */
  readonly waived?: string;
}

/** A read-only view of the project under inspection. Rules never touch the filesystem directly. */
export interface ProjectView {
  readonly root: string;
  readonly state: ForgeState | null;
  exists(relative: string): Promise<boolean>;
  read(relative: string): Promise<string | null>;
  readJson(relative: string): Promise<Record<string, unknown> | null>;
  /** Entry names of a directory, or an empty list if it does not exist. */
  list(relative: string): Promise<string[]>;
  /** Project-relative paths of text files worth scanning, skipping dependencies, VCS data and build output. */
  walk(): Promise<string[]>;
  /** SHA-256 of a file, or null if it is missing. */
  hash(relative: string): Promise<string | null>;
}

export interface Rule {
  readonly id: string;
  readonly severity: FindingSeverity;
  /** One line, shown in docs and SARIF. */
  readonly title: string;
  /** Why it matters and how to satisfy it. */
  readonly description: string;
  check(project: ProjectView): Promise<Issue[]>;
  /** Files that repair the findings. Applied through the normal plan/apply engine, so they are safe and reversible. */
  fix?(project: ProjectView): Promise<RenderedFile[]>;
}

export interface Waiver {
  readonly rule: string;
  readonly reason: string;
}
