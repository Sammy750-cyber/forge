# Implementation decisions (M0 - M5)

Where the implementation refines or deviates from `DESIGN.md`. Each is deliberate.

| # | Decision | Why |
|---|---|---|
| 1 | Only files ending in `.hbs` are rendered; the suffix is stripped. Everything else is copied verbatim. | Rendering everything breaks files that legitimately contain `{{ }}`, most importantly GitHub Actions `${{ secrets.X }}`. |
| 2 | A path segment starting with `_dot_` becomes a leading `.` (`_dot_gitignore` -> `.gitignore`). | npm never publishes files literally named `.gitignore`. |
| 3 | Handlebars runs with `strict: true` and `noEscape: true`. | Strict turns a typo'd variable into a loud error (determinism). Escaping is for HTML; we generate code and use `json`, `yamlString`, `shellQuote` instead. |
| 4 | Skipped questions (via `when`) resolve to `null`, not `undefined`. | Strict mode throws on missing keys; `null` keeps `{{#if x}}` usable. |
| 5 | The manifest is `strict`: unknown keys (including a `post` hook list) are errors. | No silent no-ops, and no path for shell strings to enter a manifest. `post` returns when `gitInit`/`install` exist. |
| 6 | Merge strategies are limited to `overwrite` and `none` for now. | `json-merge`, `yaml-merge`, `line-set` arrive with `forge add` (M4); rejecting them early beats half-supporting them. |
| 7 | `requires.engine` (a semver range) is not implemented yet. | Needs a semver dependency; deferred until there are multiple engine versions to guard against. |
| 8 | `.forge/state.json` goes through the same plan/apply transaction as every other file. | State can never disagree with disk after a failure. |
| 9 | Interactive prompts are not implemented (the `Prompter` port exists). Without `--yes`, unanswered questions are an error with a hint. | The prompt adapter is M2 UX work; the engine must not depend on it. |
| 10 | `--force` never overrides symlinks, directories in the way, or `.git`/`.forge` writes. | These are safety boundaries, not user conflicts. |
| 11 | TypeScript is pinned to 6.x. | `typescript-eslint` does not support TS 7 yet, and layering is enforced through ESLint. |
| 12 | Created directories (including missing ancestors of the target) are tracked and removed on rollback. | Found by the fault-injection test: a naive recursive `mkdir` left `/work` behind after a failed run. |

## M2 additions

| # | Decision | Why |
|---|---|---|
| 13 | `--git` and `--install` are opt-in flags (interactive mode asks). The design also mentioned `--no-git`; that is dropped. | Design principle: nothing runs unless asked. A default-on `git init` contradicts "opt-in post-steps". |
| 14 | A failing post step is reported with the exact command to retry, and does not change the exit code. Ctrl-C during a step exits 130. | The project already exists and is valid. Failing the command would imply nothing was created. JSON output carries each step's status for scripts. |
| 15 | Child processes use `node:child_process.spawn` (no shell, argument arrays, allow-listed environment) instead of execa. | One fewer dependency, same guarantees, and the behaviour is tested (shell metacharacters stay literal; secrets in env do not reach children). |
| 16 | The default template is now `express-api`. | `forge new my-api` should produce the real thing. `minimal` stays as an engine test fixture. |
| 17 | `express-api` supports npm only. | pnpm/yarn variants double the Dockerfile and README surface; add them as features, not template questions. |
| 18 | Docker base images are pinned by Node major + Debian release, not by digest. | A digest cannot be verified offline and would be stale quickly. The Dockerfile says how to pin one and `doctor` (M4) will flag unpinned images. |
| 19 | The Dockerfile requires `package-lock.json`. | Reproducible `npm ci` builds. Forge cannot ship a lockfile, so the README says to run `npm install` and commit it (or use `--install`). |
| 20 | The generated project pins `typescript ~6.0.3`. | Same reason as #11. Revisit when typescript-eslint supports TS 7. |
| 21 | Root lint ignores `templates/**`; they are validated by `pnpm validate:templates`, which generates each one, installs, and runs its own typecheck, lint, tests and build. | A template is only correct if the project it generates works. |

## M3 additions: composition, merging, pipelines

| # | Decision | Why |
|---|---|---|
| 22 | Questions are shared by id across a template and its features and asked once. Same id must mean the same type and choices. | One namespace is simple and predictable (`docker` answered once serves the template and `scan`). Per-feature namespaces would force users to answer the same thing twice. |
| 23 | Merge-strategy files are not recorded in `state.json`. | They are shared with the user; hash-based ownership would report drift on every user edit. |
| 24 | CI is generated from a declarative `pipeline.checks` list through an IR and per-provider adapters. Templates never contain CI YAML. | Correct quoting, SHA pins and least privilege live in one place. A new provider is one adapter. |
| 25 | Pins are resolved with `git ls-remote` plus commit dates (not the GitHub API), newest tag at least 14 days old. | The API rate-limits shared IPs, and the supply-chain policy needs a minimum-age rule, which commit dates give us. SHAs are never typed by hand. |
| 26 | Secret scanning uses TruffleHog, not Gitleaks. | `gitleaks-action` needs a paid license for organizations; TruffleHog's action does not, and it also handles scheduled and manual runs. |
| 27 | Weekly `schedule` is added only to workflows that contain a security check. | A weekly build with no vulnerability scan would be noise. Found by running the shared `schedule` answer through the CI workflow. |
| 28 | GitLab uses GitLab's own maintained security templates and does not gate on severity. Container scanning is rejected with advice. | Re-implementing scanners in GitLab YAML would be unverifiable here. The limit is stated in the generated file and in the docs. |
| 29 | The TruffleHog `version` input is set to the pinned tag without the leading `v`. | The action defaults to `latest`, which would silently unpin the tool. The tag format matches the project's release naming; it could not be verified against the container registry offline, so check the first pipeline run. |
| 30 | `state.json` allows `template: null` and records the project `name`. | `forge add` works on repositories Forge did not create. |

## M4 additions: doctor

| # | Decision | Why |
|---|---|---|
| 31 | Rules are read-only functions over a `ProjectView` that refuses `..` and never follows links; fixes return files that go through the normal plan/apply engine. | Fixes inherit backups, conflict detection and atomicity for free. |
| 32 | A crashing or hanging rule becomes a `warn` finding marked `internal`. | The design requires that one bad rule cannot take the run down. (This also caught a real bug during development.) |
| 33 | Waivers need a reason of 10+ characters, stay in the report, become SARIF suppressions, and unknown waiver ids are reported. | A waiver is an audit record, not a mute button. |
| 34 | `--fix` also ignores `.forge/backup/` whenever it will create a backup. | Found by the convergence test: otherwise the repair itself creates a new finding. |
| 35 | Nested config (`doctor`) merges per key across layers. | Found by a CLI test: setting only `waivers` in a project file reset `failOn`, so warnings failed builds. |
| 36 | `supply-chain/lockfile` is a warning, not an error. | A freshly generated project has no lockfile until `npm install`; "every generated project has zero errors" must hold. |

## M5 additions: release

| # | Decision | Why |
|---|---|---|
| 37 | Docs are checked by tests: `docs/RULES.md` is generated from the registry, and every `FORGE_E_*` code in the source must appear in `TROUBLESHOOTING.md` (and vice versa). | Documentation that can rot will. |
| 38 | `pnpm.overrides` for esbuild lives in `pnpm-workspace.yaml`. | pnpm 12 reads overrides there; it clears the only audit finding (a dev-only advisory). |
| 39 | The Windows CI job is `continue-on-error`. | The suite was never run on Windows (memory-fs tests assume POSIX paths); claiming support would be untrue. |
| 40 | `release.yml` verifies that the tag equals `package.json`'s version before publishing, with `id-token: write` only in the publish job. | Prevents publishing the wrong version and keeps the OIDC token scoped. |

## Handlebars gotcha for template authors

A partial tag alone on a line (`{{> head}}`) consumes its own line break, so partial files should end with a newline.
