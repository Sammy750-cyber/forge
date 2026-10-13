# Forge

Generate projects that are **secure and operable by default**, add CI and security scanning to the ones you already have, and check that they stay that way.

```sh
forge new my-api --feature ci --feature scan   # a hardened Express API, with CI and scanning wired in
forge add ci scan                              # the same pipelines, for a repo you already have
forge doctor                                   # does the project still meet the standard?
```

## What you get

- **`forge new`**: a project from a template. The `express-api` template ships a TypeScript Express 5 service with validated config, security headers, a health check, tests, linting and an optional multi-stage, non-root Docker image with a health check.
- **`forge add`**: features (`ci`, `scan`) for any existing repo. Forge detects your package manager, default branch, Node version, CI provider and Dockerfile instead of asking. It merges into files you already have (`.gitignore`, `package.json`, `.gitlab-ci.yml`) and keeps your comments.
- **`forge doctor`**: 19 rules covering supply chain, containers, CI, secrets and hygiene. Findings can be waived with a stated reason, exported as JSON or SARIF, and the safe ones repaired with `--fix`.

The generated pipelines pin every GitHub Action to a full commit SHA, default to read-only permissions, and run secret, dependency, SAST, IaC and (optionally) container scanning that fails the build at a severity you choose. GitLab is supported through GitLab's own security templates.

## Install

```sh
npm install --global forge-secure      # or: npx forge-secure ...
forge --help
```

Requires Node.js 22 or newer.

## Commands

| Command | Purpose |
|---|---|
| `forge new <name>` | Create a project. Prompts in a terminal; pass `--yes` or `--answer key=value` to script it. |
| `forge add <feature...>` | Add features to the project in the current directory. |
| `forge doctor` | Check the project. Exit code 6 means findings at or above `--fail-on`. |
| `forge list [--features]` | List templates or features. |
| `forge config` | Show the effective configuration and where each value came from. |

Common flags: `--dry-run` (show the plan, write nothing), `--force` (overwrite conflicts; backups are kept), `--yes`, `--no-input`, `--format json`, `--verbose`, `--cwd`. For `new`: `--template`, `--feature`, `--ci github|gitlab`, `--git`, `--install`. For `doctor`: `--fix`, `--rule`, `--skip`, `--fail-on error|warn`, `--format sarif`, `--list-rules`.

Exit codes: `0` ok, `2` usage, `3` config/answers/state, `4` conflict, `5` template error, `6` doctor findings, `7` filesystem, `130` interrupted. See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Configuration

Highest wins: flags, `FORGE_*` environment variables, `forge.config.json` in the project (or a parent), `~/.config/forge/config.json`, defaults. `forge config` shows each value and its source.

```json
{
  "ci": "github",
  "doctor": {
    "failOn": "error",
    "waivers": [{ "rule": "docker/healthcheck", "reason": "health is checked by the orchestrator" }]
  }
}
```

A waiver without a real reason is rejected, waived findings stay visible in every report, and a waiver for a rule that does not exist is flagged.

## Guarantees (all tested)

1. **Idempotent**: running a command twice changes nothing the second time.
2. **Deterministic**: the same inputs give byte-identical output, anywhere, any time.
3. **Contained**: nothing is written outside the project, and symlinks are never followed.
4. **Atomic**: a failure or Ctrl-C at *any* filesystem step restores the exact previous tree. The tests inject a failure at every single step.
5. **Non-destructive**: files you edited are never overwritten without `--force`, which still saves a backup under `.forge/backup/`.
6. **Honest**: every generated project passes `forge doctor` with zero errors, and Forge's own repository passes it with zero findings.

## Documentation

- [docs/AUTHORING.md](docs/AUTHORING.md): write your own templates and features
- [docs/RULES.md](docs/RULES.md): every doctor rule and why it exists
- [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md): threats, mitigations, and known limits
- [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md): the v1.0 review and its evidence
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): every error code
- [docs/DESIGN.md](docs/DESIGN.md) and [docs/DECISIONS.md](docs/DECISIONS.md): the design, and where the code refines it

## Development

```sh
pnpm install
pnpm check                 # typecheck + lint + tests
pnpm validate:templates    # generate every template, install it, run ITS typecheck/lint/tests/build (needs network)
node scripts/update-pins.mjs                                  # refresh pinned action SHAs (needs network)
FORGE_NETWORK_TESTS=1 pnpm exec vitest run test/network       # verify pinned actions still accept the inputs Forge passes
```

Layering is enforced by ESLint: `core` depends only on ports and errors, `app` never imports adapters, and direct `fs`, `console` and `process.exit` are banned outside `src/adapters` and `src/bin.ts`.

## License

MIT
