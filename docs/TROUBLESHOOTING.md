# Troubleshooting

Every error Forge prints ends with a `code:` line. Find it here. Add `--verbose` to see the underlying cause.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (for `doctor`: nothing at or above the fail threshold) |
| 1 | Unexpected internal error. Please report it. |
| 2 | Usage error: bad flag, missing argument, unknown rule |
| 3 | Invalid configuration, answers, state file, or pinned versions |
| 4 | Conflict: Forge would overwrite something it does not own |
| 5 | A template or feature definition is invalid or failed to render |
| 6 | `doctor` found problems at or above `--fail-on` |
| 7 | Filesystem or permission error |
| 8 | `forge update --check`: the project is behind what this Forge would generate |
| 130 | Interrupted (Ctrl-C) or cancelled. Nothing was left half-written. |

## Usage

**`FORGE_E_USAGE`**: a flag or argument is wrong. The message names it; `forge <command> --help` shows the syntax.

**`FORGE_E_BAD_NAME`**: project names are lowercase letters, digits and hyphens, starting with a letter (`my-api`). Pass a different name.

**`FORGE_E_UNKNOWN_RULE`**: `--rule` or `--skip` named a rule that does not exist. The hint lists every rule; `forge doctor --list-rules` shows them with descriptions.

## Configuration and answers

**`FORGE_E_CONFIG`**: a configuration problem not covered below. The message says where.

**`FORGE_E_CONFIG_INVALID`**: a config file, environment variable or flag has a bad value. The message names the file and key. Run `forge config` to see the effective configuration and the source of every value. Unknown keys are only warnings; wrong values are errors. A `doctor` waiver needs a `reason` of at least 10 characters.

**`FORGE_E_ANSWER_INVALID`**: an answer to a template question is missing, unknown, or does not fit (wrong choice, fails the pattern). Pass it with `--answer key=value`, or use `--yes` to accept defaults. Without a terminal (or with `--no-input`) Forge never prompts.

**`FORGE_E_PINS`**: `pins/pins.json` is missing or malformed, so pipelines cannot be generated. Regenerate it with `node scripts/update-pins.mjs`.

## Project state

**`FORGE_E_STATE`**: `.forge/state.json` is not a regular file. Restore it from version control.

**`FORGE_E_STATE_INVALID`**: the state file is not valid JSON, has the wrong shape, or lists an unsafe path. Restore it from version control, or delete `.forge/` (Forge will then treat existing files as unmanaged and ask before overwriting them).

**`FORGE_E_NOT_A_PROJECT`**: `forge update` needs `.forge/state.json` to know what the project was generated from, and there is none. To bring an existing repository under Forge, run `forge add <feature>`; after that, `forge update` works.

**`FORGE_E_DOWNGRADE`**: the project records a newer version of a template or feature than this Forge provides, so updating would silently regress its files. Upgrade Forge. Nothing was changed. See [UPDATE.md](UPDATE.md).

**`FORGE_E_STATE_NEWER`**: the project was last touched by a newer Forge. Upgrade Forge. It refuses to guess rather than corrupt your state.

## Conflicts

**`FORGE_E_CONFLICT`**: a file Forge wants to write already exists with content Forge did not generate, or you edited a generated file. Nothing was changed. Review the listed files, then re-run with `--force` to overwrite them (for `forge update`, `--dry-run --diff` shows the differences and `--partial` applies everything else); the previous contents are saved under `.forge/backup/<timestamp>/`. For files Forge can merge (`.gitignore`, `package.json`, YAML), conflicts only arise when the existing file cannot be parsed.

**`FORGE_E_NOT_EMPTY`**: `forge new` was pointed at a directory that has files in it (or at a file). Choose an empty directory, or use `--force` to write alongside existing files.

**`FORGE_E_BLOCKED_PATH`**: a symbolic link, or a directory, is in the way of a file Forge needs to write. `--force` never overrides this, because writing through a link could modify files outside your project. Remove or rename the offending path.

## Templates and features

**`FORGE_E_DEFINITION`**: a definition is the wrong kind (a feature where a template was expected, or the reverse).

**`FORGE_E_NOT_FOUND`**: no template or feature with that id. The hint lists what is installed.

**`FORGE_E_MANIFEST_INVALID`**: a `forge.template.json` / `forge.feature.json` is invalid. The message lists every problem with its path. See [AUTHORING.md](AUTHORING.md).

**`FORGE_E_RENDER_FAILED`**: a template file failed to render, usually because it uses a variable that no question declares. Forge renders in strict mode so typos fail loudly instead of producing empty text.

**`FORGE_E_DUPLICATE_OUTPUT`**: two source files render to the same output path (compared ignoring letter case, so projects work on macOS and Windows).

**`FORGE_E_PATH_UNSAFE`**: a rendered output path is absolute, contains `..`, or targets something reserved (`.git`, `.forge`, Windows device names). This also catches answers that try to smuggle a path (`../../etc`).

**`FORGE_E_PATH_TRAVERSAL`**: an internal safety net found a path resolving outside the project. It should be unreachable; please report it.

**`FORGE_E_TEMPLATE_SYMLINK`**: a template contains a symbolic link. Templates may not.

**`FORGE_E_TEMPLATE_TOO_LARGE`**: a template exceeds 5,000 files or 50 MB.

**`FORGE_E_QUESTION_MISMATCH`**: two definitions in one run declare the same question id differently. Shared ids must have the same type and choices.

**`FORGE_E_FEATURE_REQUIRES`**: a feature needs another feature that was not requested. The hint names it.

**`FORGE_E_FEATURE_CONFLICT`**: two features cannot be combined, or two definitions write the same file and the file is not mergeable. Shared files must declare a `mergeStrategy`.

**`FORGE_E_FEATURE_CYCLE`**: features require each other in a loop.

**`FORGE_E_UNSUPPORTED_CHECK`**: the pipeline asks for something the chosen CI provider cannot do (container scanning on GitLab, or a package manager other than npm or pnpm). Pick GitHub for that feature, or leave the check out.

## Filesystem

**`FORGE_E_FS`**: a filesystem operation failed. The message includes the OS error code (`EACCES`, `ENOSPC`, ...) and a hint. Forge rolls back, so the project is unchanged.

**`FORGE_E_ROLLBACK_INCOMPLETE`**: a write failed *and* Forge could not fully undo the earlier writes (for example the disk went read-only mid-run). This is the one case that can leave changes behind. Run `git status`; the hint gives the backup folder holding the original files.

## Interruptions and internal errors

**`FORGE_E_INTERRUPTED`** (exit 130): you pressed Ctrl-C or cancelled a prompt. Forge restored the previous state. If it happened during `--install`, the project was created and only the install is missing.

**`FORGE_E_INTERNAL`**: a bug. Re-run with `--verbose` and include the output in a report.

## `doctor` findings

Findings are not errors; they are listed per rule in [RULES.md](RULES.md). Exit code 6 means unwaived findings at or above `--fail-on` remain.
