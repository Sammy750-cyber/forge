# Forge: Engineering Design Document

**Status:** Draft v1 (pre-implementation)
**Audience:** Maintainers and contributors of Forge
**Scope:** CLI behavior, architecture, template system, safety model, quality strategy, delivery plan. No implementation code.

---

## 1. Purpose and Positioning

Forge is a CLI that generates and maintains projects that are **secure and operable by default**. It does three jobs:

1. **Create** a project from a template (`forge new`).
2. **Extend** an existing project with a capability such as CI, security scanning, or Docker (`forge add`).
3. **Verify** that a project still meets standards (`forge doctor`).

### 1.1 Goals

- A new service has CI, security scanning, a hardened Dockerfile, linting, tests, and a health endpoint within one command.
- Every operation is **previewable, idempotent, and reversible by git**.
- Teams can enforce org-wide defaults without forking Forge.
- Adding a template or feature requires adding files, not writing TypeScript.
- Works identically on a laptop and in CI (no TTY required).

### 1.2 Non-Goals (v1)

- Not a package manager, build tool, or deployment tool.
- Does not run arbitrary code from templates.
- Does not manage cloud infrastructure. It generates files only.
- No telemetry.
- No GUI or web UI.

### 1.3 Design Principles

| Principle | Consequence |
|---|---|
| Plan, then apply | No disk write happens before a full plan is computed and validated. |
| Never clobber user work | Overwrite only files Forge can prove it owns and the user has not modified. |
| Data over code | Templates are directories and JSON, not scripts. |
| Secure by default | Generated output follows least privilege, pinned dependencies, non-root containers. |
| Deterministic | Same inputs produce byte-identical output (enables snapshot tests and drift detection). |
| Explicit over magic | Every decision is visible via `--dry-run`, `--verbose`, and the state file. |

---

## 2. Users and Key Scenarios

| Persona | Need | Primary commands |
|---|---|---|
| Developer | Start a service quickly with the right defaults | `new` |
| Platform/DevOps engineer | Define and distribute org standards | config file, custom templates |
| Security engineer | Guarantee scanning and hardening exist everywhere | `add scan`, `doctor` |
| CI system | Fail builds on standards drift | `doctor --format json`, exit codes |

**Scenarios to design around:**

1. Interactive first-run: prompts guide the user, with sensible defaults.
2. Fully scripted: `forge new api --template express-api --ci github --yes` in a bootstrap script.
3. Retrofit: `forge add scan` in a 3-year-old repo with hand-edited workflows.
4. Audit: nightly job runs `forge doctor` across 200 repos.
5. Template update: Forge ships a better Dockerfile; teams adopt it safely (`forge update`, v1.1).

---

## 3. CLI Specification

### 3.1 Command Surface

```
forge new <name>        Create a project from a template
forge add <feature>     Add a feature to an existing project
forge doctor            Check project against standards
forge list              List templates and features
forge info <id>         Show details of a template or feature
forge config            Show effective configuration and its sources
forge update            (v1.1) Re-apply newer template versions safely
```

### 3.2 Global Flags

| Flag | Meaning |
|---|---|
| `--dry-run` | Compute and print the plan; write nothing. |
| `--yes`, `-y` | Accept defaults; never prompt. |
| `--no-input` | Fail instead of prompting if a required answer is missing (auto-enabled when not a TTY). |
| `--force` | Allow overwriting conflicting files (still writes a backup, see 6.4). |
| `--cwd <dir>` | Operate on a different directory. |
| `--config <file>` | Explicit config file. |
| `--format <text\|json>` | Output format for machine consumption. |
| `--verbose`, `--quiet` | Log verbosity. |
| `--no-color` | Disable color (also honors `NO_COLOR`). |
| `--version`, `--help` | Standard. |

### 3.3 Command Details

**`forge new <name>`**
- Flags: `--template`, `--ci <github|gitlab|none>`, `--cloud <aws|azure|gcp|none>`, `--feature <id>` (repeatable), `--no-git`, `--install`.
- Name validation: npm-safe, lowercase, no path separators.
- Refuses to write into a non-empty directory unless `--force`.
- `git init` and dependency install are **opt-in post-steps**, run as built-ins (never template-defined).

**`forge add <feature>`**
- Features: `ci`, `scan`, `docker`, `commitlint`, `release`, and more over time.
- Reads `.forge/state.json` if present; otherwise performs detection (package manager, language, existing CI) and asks for confirmation.
- Existing files: merge where a merge strategy exists, otherwise treat as a conflict.

**`forge doctor`**
- Runs rule checks, prints findings grouped by severity.
- Flags: `--fix` (apply safe auto-fixes via the same plan/apply engine), `--fail-on <error|warn>`, `--rule <id>`, `--skip <id>`.
- Output formats: text, JSON, and SARIF (v1.1) for code-scanning dashboards.

### 3.4 Exit Codes (stable contract)

| Code | Meaning |
|---|---|
| 0 | Success (for `doctor`: no findings at or above fail threshold) |
| 1 | Unexpected internal error |
| 2 | Usage error (bad flags, missing args) |
| 3 | Invalid configuration or answers |
| 4 | Conflicts detected and not resolved (aborted) |
| 5 | Template or feature definition invalid |
| 6 | `doctor` findings at or above fail threshold |
| 7 | Filesystem or permission error |
| 130 | Interrupted by user (SIGINT); no partial writes remain |

### 3.5 UX Rules

- Every error states **what happened, why, and what to do next**.
- Interactive prompts always show the equivalent flag, so users learn the scripted form.
- At the end of `new`/`add`, print a "next steps" list (3 items max).
- Output to stdout is data; logs and progress go to stderr, so `--format json` is pipe-safe.

---

## 4. Architecture

### 4.1 Layered Design

```
┌───────────────────────────────────────────────────────────┐
│ CLI layer        (commands, flag parsing, prompts, output)│
├───────────────────────────────────────────────────────────┤
│ Application layer (use cases: NewProject, AddFeature,     │
│                    RunDoctor) orchestrates the core       │
├───────────────────────────────────────────────────────────┤
│ Core domain                                               │
│  Template Registry · Config Resolver · Renderer ·         │
│  Planner · Merger · Applier · State Store · Rule Engine   │
├───────────────────────────────────────────────────────────┤
│ Ports (interfaces): FileSystem, Clock, Git, Prompter,     │
│                     Logger, PackageManager                │
├───────────────────────────────────────────────────────────┤
│ Adapters: real FS, in-memory FS (tests), execa, clack     │
└───────────────────────────────────────────────────────────┘
```

**Rules:**
- Dependencies point downward only. The core never imports a prompt library, `fs`, or `console`.
- All I/O goes through ports. This makes the engine fully testable with an in-memory filesystem.
- The CLI layer contains **no business logic**. It maps flags to a use-case request and renders the result.

### 4.2 Core Pipeline

Every mutating command runs the same pipeline:

```
Resolve inputs → Load definition → Render → Plan → Review → Apply → Record state
```

| Stage | Responsibility | Failure mode |
|---|---|---|
| Resolve inputs | Merge defaults, config files, env, flags, prompts into validated `Answers` | Exit 3 |
| Load definition | Locate template/feature, validate its manifest against schema | Exit 5 |
| Render | Produce an in-memory set of `{path, content, mode}` | Exit 5 |
| Plan | Compare against disk and state; classify each file | n/a |
| Review | Show plan (diff summary); confirm if needed | Exit 4 on abort |
| Apply | Write atomically with backup/rollback | Exit 7 |
| Record state | Write `.forge/state.json` | Exit 7 |

`--dry-run` stops after **Review**. `doctor --fix` reuses the same stages.

### 4.3 Plan Model

A plan is a list of **operations**, each with a classification:

| Op | Meaning | Default behavior |
|---|---|---|
| `create` | File does not exist | Write |
| `unchanged` | Disk content equals rendered content | Skip |
| `update` | Disk equals last-generated version (user never edited) | Write |
| `merge` | Mergeable file (JSON, YAML, line-set) | Merge, write |
| `conflict` | Disk differs from both last-generated and new | Stop, ask, or fail with exit 4 |
| `skip` | Excluded by user or condition | Skip |

This classification is possible because the state file stores a hash of every file Forge wrote (see 6.2).

### 4.4 Module Boundaries (key interfaces, described not coded)

- **TemplateSource**: lists and loads definitions (built-in, local path; git/npm in v2).
- **Renderer**: pure function from (definition, answers) to rendered files.
- **Merger**: strategy registry keyed by merge-strategy name.
- **Planner**: pure function from (rendered files, disk snapshot, state) to plan.
- **Applier**: executes a plan via the FileSystem port, with transactional semantics.
- **Rule**: `{ id, severity, appliesTo(project), check(project) → Finding[], fix?(project) → Plan }`.

Purity of Renderer and Planner is a deliberate choice: it gives cheap, exhaustive unit tests.

---

## 5. Template and Feature System

### 5.1 Core Idea

A **template** is a base project. A **feature** is an overlay that can be applied at creation or later. Both share one definition format, which keeps the engine simple: `new` is just "apply base template, then apply selected features".

### 5.2 On-Disk Layout

```
templates/
  express-api/
    forge.template.json      # manifest
    files/                   # files to render (paths may be templated)
    partials/                # reusable snippets
features/
  scan/
    forge.feature.json
    files/
  docker/
  ...
```

### 5.3 Manifest (conceptual fields)

- `id`, `version`, `description`, `kind` (`template` | `feature`)
- `requires`: engine version range, features it depends on, features it conflicts with
- `questions`: typed inputs (string, boolean, enum, multi-select) with defaults, validation, and `when` conditions
- `files`: per-path rules: `condition`, `mergeStrategy`, `executable`, `binary`
- `detect`: how `add` recognizes applicability (for example, "has package.json")
- `doctorRules`: rule IDs this definition contributes
- `post`: **allow-listed built-in steps only** (`gitInit`, `install`), never shell strings

The manifest is validated by a JSON Schema (generated from the Zod schema) so editors give completion to template authors.

### 5.4 Rendering Engine Decision

**Handlebars (logic-less), not EJS.**

| Option | Pro | Con |
|---|---|---|
| EJS | Familiar, flexible | Executes arbitrary JS: unacceptable if templates can come from third parties |
| Eta | Fast, small | Also allows JS expressions |
| **Handlebars** | No arbitrary code, partials, helpers are allow-listed | Less expressive, needs helpers for some logic |

Rules:
- Only Forge-provided helpers (`eq`, `and`, `or`, `kebabCase`, `pascalCase`, `json`, `indent`, `yamlString`).
- Prototype access disabled (Handlebars default); no custom helper loading from templates.
- Paths can contain placeholders (for example `src/{{name}}.ts`); the rendered path is validated (see 8.1).
- Binary files are copied, never rendered.
- Line endings normalized to LF (configurable); trailing newline enforced.

### 5.5 Structured Generation for CI Files

Text-templating YAML is fragile (indentation bugs, injection through values). For CI pipelines Forge uses a **Pipeline IR**:

```
Feature "scan"  ──►  Pipeline IR  ──►  GitHub Actions adapter  ──► .github/workflows/security.yml
(steps defined         (jobs, steps,       GitLab CI adapter      ──► .gitlab-ci.yml fragment
 once, abstract)        permissions)
```

- Security steps (secret scan, dependency scan, SAST, IaC scan, container scan) are defined **once** as IR nodes and rendered by each adapter.
- The IR is serialized with a YAML library, so values are always correctly quoted.
- Adding Jenkins or Azure Pipelines later means writing one adapter, not rewriting features.

### 5.6 Merge Strategies

| Strategy | Used for | Behavior |
|---|---|---|
| `overwrite` | Files fully owned by Forge | Replace if unmodified, else conflict |
| `json-merge` | `package.json`, `tsconfig.json` | Deep merge; arrays union by key; user values win on scalar conflict |
| `yaml-merge` | Workflow files, compose files | Merge by key; preserves comments where the library allows |
| `line-set` | `.gitignore`, `.dockerignore` | Append missing lines; never remove |
| `none` | Everything else | Create only; conflict if exists |

Unknown or unparseable existing content falls back to `conflict`, never to a guess.

### 5.7 Composition Rules

- Features declare `requires` and `conflicts`. The resolver computes a dependency-ordered list and fails fast on cycles or conflicts (exit 5).
- Two features writing the same path must use a mergeable strategy, or definition validation fails at load time (caught by tests, not by users).
- Order of application is deterministic: base, then features by dependency order, then alphabetical.

### 5.8 Template Versioning

- Templates use semver. Breaking changes to generated output bump the major version.
- State records the template version used, enabling `forge update` later.

---

## 6. Configuration, State, and Idempotency

### 6.1 Configuration Resolution

Precedence (highest wins):

1. CLI flags
2. Environment variables (`FORGE_*`)
3. Project config (`forge.config.json` in the project or ancestors)
4. User config (`~/.config/forge/config.json`, XDG-compliant)
5. Organization config (path or URL from user config; v1.1)
6. Built-in defaults

`forge config` prints each effective value **and where it came from**. All config is validated with Zod; unknown keys are warnings, invalid values are errors with a path to the bad key.

**Organization defaults example (conceptual):** default CI provider, required features list for `doctor`, allowed base images, internal template registry.

### 6.2 State File: `.forge/state.json`

Committed to the repository. Contains:

- Forge version and schema version of the state file
- Template id and version; list of applied features with versions
- The validated answers (never secrets; questions marked `secret` are not persisted)
- For each generated file: path and **SHA-256 of the content Forge last wrote**

This one file enables:
- Distinguishing user edits from pristine generated files (safe overwrite vs conflict)
- Drift detection in `doctor`
- Safe `forge update`

State schema is versioned with explicit migrations; an unknown newer schema version is a hard error rather than a best-effort guess.

### 6.3 Idempotency Contract

Running the same command twice with the same inputs results in **zero changes** the second time (all operations classify as `unchanged`). This is enforced by a test that runs every template twice and asserts an empty plan.

### 6.4 Applier Safety

- Writes are **atomic per file** (write temp file in same directory, then rename).
- The apply step is **all-or-nothing**: before writing, files to be changed are copied to `.forge/backup/<timestamp>/`; on any failure, Forge restores from backup and exits 7.
- `--force` still creates a backup. Backups are pruned to the last N runs.
- File modes are preserved or set explicitly (scripts executable, secrets files 0600).
- Symlinks in target paths are not followed for writes.
- Ctrl-C triggers the same rollback path.

---

## 7. `forge doctor` Design

### 7.1 Rule Model

Each rule has: stable `id` (for example `docker/non-root`), `severity` (`error` | `warn` | `info`), a human explanation, a documentation link, and optionally a **fix** expressed as a plan (so fixes get the same safety guarantees as `add`).

### 7.2 Initial Rule Set (v1)

| Area | Examples |
|---|---|
| Supply chain | Lockfile present; CI actions pinned to commit SHAs; base images pinned by tag or digest |
| Containers | Non-root `USER`; no `latest` tag; `HEALTHCHECK` present; `.dockerignore` present |
| CI | Workflow `permissions:` set to least privilege; secret scan step present; dependency scan step present |
| Secrets | `.env` ignored by git; no obvious credentials in tracked files (delegates to Gitleaks if available, built-in light check otherwise) |
| Hygiene | LICENSE, README, `.gitignore`, commit lint config, `engines` field set |
| Drift | Forge-owned files modified since generation (info only) |

### 7.3 Behavior

- Rules run in parallel, read-only, with per-rule timeouts.
- A crashing rule yields an `internal` finding for that rule, not a crash of `doctor`.
- Rules can be disabled per project in `forge.config.json` with a **required justification string** (surfaced in output, so waivers are auditable).
- Output is stable and sorted, so it diffs cleanly in CI.

---

## 8. Security Design

Forge writes files into developer machines and CI. It is itself a supply-chain component, so it gets a threat model.

### 8.1 Threats and Mitigations

| Threat | Mitigation |
|---|---|
| **Path traversal** via templated paths or template archive entries | Resolve every output path; reject if it escapes the target root, is absolute, or contains `..` after rendering; reject reserved names |
| **Malicious template** (third-party) | Templates are data only; no code execution; no shell in `post`; sandboxed helper set; remote templates require explicit opt-in and integrity pinning (v2) |
| **Template injection** (user answers rendered into YAML/shell) | Validate answers against schemas; IR-based YAML generation; context-aware escaping helpers (`yamlString`, `shellQuote`) |
| **Secrets leakage** | Never prompt-store secrets in state; redact known-secret keys in logs; generated `.env.example` has placeholders only |
| **Dependency compromise of Forge** | Few, well-known dependencies; lockfile; `npm audit` and Trivy in Forge's own CI; npm provenance on publish; 2FA/trusted publishing |
| **Dangerous overwrites** | Plan/apply, hash-based ownership, backups (section 6) |
| **Insecure generated output** | Secure defaults verified by `doctor` rules and by template tests (the generated project must pass Forge's own `doctor`) |
| **Update/network surprises** | No network calls by default; update checks are opt-in; fetches use timeouts and TLS verification, never disabled |

### 8.2 Generated-Pipeline Hardening Defaults

- Workflow `permissions` default to read-only; jobs request more only where needed.
- Third-party CI actions pinned to **full commit SHAs**, with a comment containing the human-readable version. Pins live in one maintained file (`pins.json`) updated by Dependabot/Renovate plus a verification script. **Pins are never hand-typed or generated from memory.**
- `pull_request` workflows never expose secrets to forks; no `pull_request_target` checkout of untrusted code.
- Dockerfile: multi-stage build, pinned base, non-root user, minimal runtime image, no secrets in layers, `HEALTHCHECK`.
- Scanner steps fail the build above a configurable severity threshold, with an explicit allowlist file for justified exceptions.

### 8.3 Privilege and Environment

- Forge never requires or requests elevated privileges.
- Child processes (`git`, package manager) are spawned without a shell, with argument arrays and a minimal environment.

---

## 9. Error Handling and Observability

### 9.1 Error Model

- A small hierarchy of typed errors: `UsageError`, `ConfigError`, `DefinitionError`, `ConflictError`, `FsError`, `InternalError`. Each maps to one exit code.
- Every error carries: `code` (stable string like `FORGE_E_CONFLICT`), message, cause, and a `hint`.
- Unknown exceptions are wrapped as `InternalError`, with a message asking for a bug report and a `--verbose` hint. Stack traces appear only with `--verbose`.
- A single top-level handler formats errors; nowhere else calls `process.exit`.

### 9.2 Logging

- Structured logger (levels: error, warn, info, debug) writing to stderr.
- Human text by default; JSON lines with `--format json`.
- Always logged at debug level: start time, duration, resolved config summary (redacted), plan summary, result.
- Optional `--log-file` for support cases.

### 9.3 Progress and Output

- Spinner/progress only when stderr is a TTY; plain lines otherwise.
- The plan is rendered as a tree with symbols plus text labels (`create`, `merge`, `conflict`), so it remains readable without color.

---

## 10. Quality Strategy

### 10.1 Test Pyramid

| Layer | What | Tools |
|---|---|---|
| Unit | Config resolver, planner, merger, path validation, helpers, rules | Vitest |
| Property-based | Path validation never escapes root; merge is idempotent; rendering is deterministic | fast-check |
| Snapshot | Rendered output of every template/feature combination | Vitest snapshots on in-memory FS |
| Integration | Real filesystem in temp dirs: `new`, `add`, conflict flows, rollback on injected failure | Vitest |
| Generated-project validation | Generate each template, then in a sandbox run install, lint, test, build, and `forge doctor` | CI matrix job |
| CLI e2e | Spawn built binary; assert stdout/stderr/exit codes | Vitest + execa |
| Cross-platform | Linux, macOS, Windows; path separator, line endings, file modes | CI matrix |

### 10.2 Invariants Checked by Tests

1. Running any command twice yields an empty second plan (idempotency).
2. Output is byte-identical across runs and platforms (determinism).
3. No operation writes outside the target root.
4. A failure injected at any apply step leaves the tree unchanged (atomicity).
5. Every generated project passes `forge doctor` with zero errors.
6. Definition validation rejects two features that write the same path without a merge strategy.

### 10.3 Static Quality

- TypeScript `strict`, `noUncheckedIndexedAccess`, ESM only.
- ESLint with type-aware rules; a lint rule banning direct `fs`, `console`, and `process.exit` outside adapters.
- Coverage target: 90 percent on core, tracked but not gamed.
- Forge's CI runs the same security scans it generates (dogfooding).

---

## 11. Repository and Tooling

### 11.1 Technology Decisions

| Concern | Choice | Reason |
|---|---|---|
| Runtime | Node 22 LTS or newer | Node 20 is past end-of-life; set in `engines` and CI matrix |
| Language | TypeScript, strict, ESM | Type-safe schemas and shared types |
| CLI parsing | Commander | Small, fast startup, no framework lock-in. oclif's plugin system is not needed in v1 |
| Prompts | `@clack/prompts` behind a `Prompter` port | Good UX; swappable |
| Schema validation | Zod (+ JSON Schema export) | One source of truth for runtime and editor tooling |
| Templating | Handlebars | See 5.4 |
| YAML | `yaml` package (comment-preserving) | Needed for merges |
| Process spawning | execa | No shell by default |
| Build | tsup | Single bundled ESM entry, fast |
| Tests | Vitest, fast-check | See 10 |
| Package manager | pnpm | Strict, fast, good lockfile |
| Releases | Changesets or semantic-release; npm provenance | Automated, auditable |

### 11.2 Repository Layout

```
forge/
  src/
    cli/            # commands, flag mapping, output renderers
    app/            # use cases (new, add, doctor)
    core/
      config/       # resolver, schemas
      definition/   # manifest schema, loader, dependency resolver
      render/       # handlebars setup, helpers, path validation
      pipeline-ir/  # CI IR and adapters (github, gitlab)
      plan/         # planner, plan types
      merge/        # strategies
      apply/        # applier, backup, rollback
      state/        # state store, migrations
      doctor/       # rule engine and rules
    ports/          # interfaces
    adapters/       # node-fs, memory-fs, git, prompter, logger
    errors/
  templates/        # built-in templates
  features/         # built-in features
  pins/             # pins.json for CI action SHAs and tool versions
  test/             # unit, integration, e2e, fixtures
  docs/             # user docs, template authoring guide, ADRs
  scripts/          # pin updater, schema generation, release helpers
```

### 11.3 Release and Compatibility

- Semver for the CLI. Public contract: command names, flags, exit codes, JSON output shapes, state schema, manifest schema.
- Each contract element is documented and covered by tests. Breaking any requires a major version.
- Template packs version independently from the CLI.
- `engines` declared; a startup check gives a clear message on unsupported Node.

---

## 12. Documentation Plan

- **README:** install, 60-second quickstart, command reference.
- **Template authoring guide:** manifest reference, helpers, merge strategies, testing a template.
- **Security model:** the threat table above, in user-facing language.
- **ADRs** for: Handlebars over EJS, Pipeline IR, state-file hashing, Commander over oclif, no code execution in templates.
- **Troubleshooting:** every error code has an entry.
- Docs are validated in CI (links, code samples) and updated in the same PR as behavior changes.

---

## 13. Delivery Plan

| Milestone | Deliverable | Exit criteria |
|---|---|---|
| M0: Foundations | Repo, tooling, ports/adapters, error model, logger, config resolver | Unit tests green; lint rules enforce layering |
| M1: Engine | Manifest loader, renderer, path validation, planner, applier with rollback | Invariants 1-4 pass on a toy template |
| M2: First template | `express-api` with Docker, tests, lint, health check | Generated project builds and passes tests on 3 OSes |
| M3: CI and scanning | Pipeline IR, GitHub adapter, `scan` feature | Generated workflow passes `actionlint`; scanners run on sample repo |
| M4: `add` and `doctor` | Merge strategies, detection, rule engine, initial rules | Retrofit e2e test on a legacy fixture repo |
| M5: Hardening | GitLab adapter, SARIF, docs, provenance publishing | Security review checklist complete; v1.0.0 tag |
| Later | `update`, org config, remote templates with integrity pinning, plugin API | Driven by real usage |

---

## 14. Risks and Open Questions

| Risk or question | Mitigation or next step |
|---|---|
| Merge logic corrupts hand-edited files | Conservative strategies; fall back to conflict; heavy fixture-based tests on real-world messy files |
| Template maintenance burden grows | Ship few templates, invest in feature overlays, test matrix automation |
| Pinned SHAs and scanner versions go stale | Automated update PRs plus a `doctor` rule that flags stale pins |
| Windows path and line-ending edge cases | Windows in CI matrix from M0; normalize at the renderer boundary |
| How much should `doctor` overlap with dedicated scanners? | Keep doctor focused on **configuration standards**, and delegate vulnerability scanning to the tools it wires up |
| Should org config be fetched remotely? | Defer to v1.1; if added, require pinned integrity and explicit opt-in |
| Support for non-Node templates (Python, Go)? | Engine is language-agnostic; confirm after v1 with at least one non-Node template to validate the abstraction |

---

## 15. Definition of Done for Forge v1.0

- All milestone exit criteria met.
- Invariants in 10.2 enforced in CI.
- Every generated template passes its own `doctor` and the security scans it configures.
- Contracts (commands, exit codes, JSON, manifest, state schema) documented and tested.
- A new contributor can add a template by following the authoring guide alone.
- Release is signed or published with provenance, and Forge's own pipeline passes its own standards.
