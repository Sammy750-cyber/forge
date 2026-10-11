# Security review: Forge 1.0.0

Scope: the CLI, the shipped templates and features, the pipelines they generate, and Forge's own release process. Method: threat model ([SECURITY-MODEL.md](SECURITY-MODEL.md)), a test for each mitigation, dependency audit, and end-to-end validation of generated output.

## Results at release

| Check | Result |
|---|---|
| Unit, integration, property and CLI tests | **303 passed** (21 files), including network checks of pinned actions |
| Coverage (statements / branches / functions / lines) | 96.7% / 89.9% / 96.5% / **98.1%** |
| TypeScript strict + ESLint (layering and I/O bans enforced) | clean |
| `pnpm audit` (all dependencies, including dev) | **no known vulnerabilities** |
| Production dependency tree | 5 direct, 15 total packages; **none run install-time scripts** |
| Generated projects (`pnpm validate:templates`): generate, idempotent, `doctor` zero errors, `actionlint`, `npm install`, typecheck, lint, test, build | **all pass**, with and without every feature |
| Forge's own five workflows | pass `actionlint`; Forge passes `forge doctor --fail-on warn` with **zero findings** |
| Packed tarball installed into a clean directory | works: `forge new`, `--feature`, `doctor` |

## Checklist

### Filesystem safety
- [x] Output paths validated after rendering; absolute, `..`, drive-letter, backslash, control-character, NUL, Windows-reserved, `.git` and `.forge` paths rejected. Property-tested over 4,000 generated inputs.
- [x] Second, independent containment proof (`resolveInside`) immediately before every write.
- [x] Symlinks never followed: planning inspects every ancestor with `lstat`; applying re-inspects (closes the check-then-write race, tested). `--force` cannot override.
- [x] Temp files are created exclusively (`wx`), so a pre-planted link at the temp name is not followed.
- [x] Failure or interrupt at **any** step restores the exact previous tree, including directories Forge created. Tested by injecting a failure (and an abort) at every filesystem call for `new`, `add` and `doctor --fix`.
- [x] If rollback itself fails, Forge says so loudly and names the backup folder.
- [x] Existing user files are never overwritten without `--force`; overwrites are backed up first.

### Templates and rendering
- [x] No code execution: Handlebars with an allow-listed helper set, prototype access off, strict mode. Manifests are strict, so no hook or shell field can exist.
- [x] Templates cannot contain symlinks; size limits (5,000 files, 50 MB).
- [x] Answers are validated against type, choices and patterns before use; unknown answers are rejected (typo guard).
- [x] Values destined for JSON, YAML or shell go through `json`, `yamlString`, `shellQuote`; CI YAML is built as data and serialized by a YAML library.
- [x] Secret answers are never written to state; logs redact sensitive keys.

### Generated pipelines
- [x] Every action pinned to a full 40-character commit SHA, with the version in a comment; pins resolved by script, not by hand, and at least 14 days old.
- [x] Every input Forge passes to a pinned action exists in that action's `action.yml` at the pinned commit (network test).
- [x] `permissions: contents: read` by default; `persist-credentials: false`; no `pull_request_target`; concurrency groups.
- [x] Scan jobs fail the pipeline at the configured severity on GitHub.
- [x] Containers: multi-stage, non-root user, version-pinned base, health check, `.dockerignore`.

### Process execution
- [x] `git` and `npm` run without a shell, with an allow-listed environment (tokens and cloud keys do not reach them). Shell metacharacters in arguments stay literal (tested).

### Forge's own supply chain
- [x] Lockfile committed; `pnpm audit` clean; one advisory (low, dev-only, `esbuild` via the test runner) fixed by an override rather than waived.
- [x] pnpm's default of not running dependency install scripts is left on.
- [x] Release workflow: tag must equal `package.json` version, `id-token: write` only in the publish job, `npm publish --provenance`, actions SHA-pinned.
- [x] Weekly audit workflow, plus a network check that pinned actions still accept Forge's inputs.

## Defects found and fixed during development

The test strategy (fault injection, convergence checks, running the tool on itself) found real bugs before release:

| Defect | Found by | Fix |
|---|---|---|
| A failed run left behind parent directories it had created | injected failure at every step | create the root component by component and track each directory |
| `doctor` crashed on `.forge/` paths because it reused the template path validator | rule-engine isolation reported an internal finding | a read-only project view with its own safe-path check |
| `doctor --fix` created `.forge/backup/` and then flagged it, so it never converged | convergence test | ignore the backup folder whenever a fix will create one |
| A project config that set only `doctor.waivers` reset `failOn`, so warnings failed builds | CLI test | nested settings merge per key |
| The weekly `schedule` set for `scan` also scheduled the plain CI workflow | reading generated output | schedule only workflows that contain a security check |
| Interactive mode asked about git and install before the template questions | CLI interactive test | answers first, then post-steps |
| Forge's own repo did not ignore `.env` | running `forge doctor` on Forge | `forge doctor --fix` |

## Residual risks and unverified items

Be aware of these; none is hidden.

1. **Windows is unverified.** The suite has not run there (the in-memory filesystem tests assume POSIX paths). The Windows CI job is allowed to fail. Do not rely on Windows support until it passes.
2. **TruffleHog `version` input.** Set to the pinned tag without the leading `v` (the action defaults to `latest`, which would unpin it). I could not verify the image tag format against the container registry from the build environment. Check the first pipeline run.
3. **GitLab template names** (`Jobs/SAST.gitlab-ci.yml` and friends) follow GitLab's documentation but could not be fetched offline. Check the first pipeline run. GitLab security templates report but do not gate; container scanning is rejected rather than approximated.
4. **Tools fetch data at run time.** Semgrep pulls its rule pack, Trivy its vulnerability database, and TruffleHog its image. The action and tool *versions* are pinned; the *content they fetch* is not. That is inherent to scanners (stale databases would defeat them).
5. **Semgrep is installed with `pip` by exact version, without hash pinning.**
6. **The `express-api` Dockerfile pins by version tag, not digest.** The `supply-chain/base-image-pinned` rule requires a tag; moving to digests needs an update bot to be useful.
7. **Generated `package.json` uses caret ranges** (a lockfile created at first install pins them). `supply-chain/lockfile` warns until it exists.
8. **`secrets/hardcoded` is a light check** for well-known formats, not a replacement for the `scan` feature's scanner.
9. **Pins age.** They were resolved on the release date; refresh with `node scripts/update-pins.mjs`.

## Sign-off criteria for 1.0

- [x] All milestone exit criteria met.
- [x] The six guarantees enforced in tests.
- [x] Every generated project passes `doctor` with zero errors, in CI.
- [x] Contracts (commands, exit codes, JSON, manifest, state schema) documented and tested.
- [x] A new contributor can add a template from [AUTHORING.md](AUTHORING.md) alone.
- [x] Release published with provenance: workflow in place and linted. **The first publish has not been performed**; it needs your npm token (`NPM_TOKEN` secret) and a `v1.0.0` tag.
