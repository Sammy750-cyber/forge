# Security model

Forge writes files into developer machines and CI runners, and the pipelines it generates run with access to your source. It is a supply-chain component, so it has a threat model.

## What Forge protects

1. **Your filesystem**, from templates, answers and Forge's own bugs.
2. **Your existing work**, from being overwritten.
3. **Your pipelines and images**, by generating secure defaults and checking for them afterwards.

## Threats and mitigations

| Threat | Mitigation | Evidence (tests) |
|---|---|---|
| A template or answer writes outside the project (`../`, absolute paths, drive letters, Windows device names, `.git/hooks`) | Every rendered path is validated, then re-proved inside the root before any write; `.git` and `.forge` are unwritable by templates | `safe-path.test.ts` (including property tests over 4,000 generated paths), `new-project.test.ts` "hostile definitions" |
| Writing through a symbolic link to reach files elsewhere | Every ancestor and the target are inspected with `lstat`, at plan time and again at apply time (closes the check-then-write race); `--force` cannot override | `applier.test.ts` (TOCTOU), `cli.test.ts` real symlink |
| A malicious template executes code | Templates are data. Handlebars has no code execution; only an allow-listed helper set exists; prototype access is off; manifests are strict so no `post`/shell field can exist; templates cannot contain symlinks | `renderer.test.ts`, `new-project.test.ts` "cannot execute code" |
| Template injection through answers into YAML/shell | CI files are built as structured data and serialized by a YAML library; values reaching `run:` lines are shell-quoted; answers are validated against patterns | `pipeline.test.ts` |
| A crash or Ctrl-C leaves a half-written project | Plan, then apply transactionally: temp file + atomic rename, backups first, full rollback including created directories | `applier.test.ts`: a failure injected at **every** step restores the exact tree |
| Overwriting user edits | Files are overwritten only when their hash equals what Forge last wrote; everything else is a conflict; overwrites keep a backup | `planner.test.ts`, `new-project.test.ts` conflict flow |
| Secrets leaking through Forge | Secret answers are never persisted; logs redact sensitive keys; `doctor` never prints a matched credential; `.env.example` holds placeholders | `util.test.ts`, `doctor.test.ts` |
| Child processes inheriting credentials | `git` and `npm` run without a shell, except that on Windows the npm/pnpm/yarn shims run through `cmd.exe` with a fixed argument list; arguments containing `cmd.exe` metacharacters are refused, with an allow-listed environment; tokens never reach them | `post-steps.test.ts` |
| Mutable CI dependencies | Generated workflows pin every action to a full commit SHA (version kept in a comment). Pins come from `scripts/update-pins.mjs`, never typed by hand, and are at least 14 days old | `pipeline.test.ts`, `network/pins.net.test.ts` |
| Over-privileged CI tokens | Workflows default to `permissions: contents: read`; checkout does not persist credentials; no `pull_request_target` | `pipeline.test.ts`; `doctor` rule `ci/permissions` |
| Forge's own supply chain | Few dependencies, lockfile, `pnpm audit` in CI, SHA-pinned actions, npm provenance on release | `SECURITY-REVIEW.md`, `.github/workflows/` |
| Corrupted or tampered state | State is strictly validated; unsafe paths and newer schemas are rejected | `state.test.ts` |
| Forge reading outside the project while inspecting | `doctor` reads through a view that refuses `..` and never follows links | `doctor.test.ts` |

## Known limits

- **Local trust.** Forge trusts the machine it runs on and the templates you install. Remote templates are not supported, so no code or data is fetched from the network when you generate a project.
- **Scanners are not omniscient.** Generated pipelines wire in secret, dependency, SAST, IaC and container scanning. Their findings depend on those tools' databases and rules. The built-in `secrets/hardcoded` rule is a light check for obvious formats only.
- **GitLab severity gating.** GitLab's security templates report findings but do not fail the pipeline; blocking on severity needs a merge request approval policy (Ultimate) or your own job. The generated file says so. GitHub pipelines fail at the configured severity.
- **Pins age.** Pinned versions are at least 14 days old when resolved, but they do get older. Run `node scripts/update-pins.mjs` regularly, or let Dependabot/Renovate update the generated workflows.
- **Windows.** The test suite has now been ruuned in windows and all tests passes without failure. Treat Windows support as unverified.
- **Docker base images** are pinned by tag, not digest, in the shipped template.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the maintainers rather than in a public issue.
