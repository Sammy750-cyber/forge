# Doctor rules

_This file is generated from the rule registry by `test/docs.test.ts`. Do not edit it by hand (run the tests with `UPDATE_DOCS=1`)._

`forge doctor` exits 6 when unwaived findings at or above `--fail-on` (default `error`) remain. Waive a rule in `forge.config.json` with a stated reason:

```json
{ "doctor": { "waivers": [ { "rule": "docker/healthcheck", "reason": "health is checked by the orchestrator" } ] } }
```

Waived findings stay in the report (and in SARIF as suppressions) so the decision is auditable.

### `ci/permissions`

**error** — GitHub workflows declare least-privilege permissions

Without a permissions block the token may default to broad write access. Declare "permissions: contents: read" at the top and widen per job only where needed.

### `docker/non-root`

**error** — Containers do not run as root

If an attacker takes over a root process they own the container and have a much easier path to the host. The final stage must switch to an unprivileged USER.

### `secrets/env-file-exposed`

**error** — An existing .env file is not ignored by git

A .env file is present in the working tree and nothing stops "git add ." from committing it.

Fixable with `forge doctor --fix`.

### `secrets/hardcoded`

**error** — No obvious credentials in the working tree

A light built-in check for well-known credential formats. It is not a replacement for a real scanner (the "scan" feature adds one); it exists so the most obvious leaks are caught even without one. Add "forge:allow-secret" to a line to mark a deliberate test fixture.

### `supply-chain/actions-pinned`

**error** — GitHub Actions are pinned to full commit SHAs

Tags and branches can be moved to malicious code after you reviewed them. A 40-character commit SHA cannot. Keep a "# vX.Y.Z" comment so humans and Dependabot/Renovate can read it.

### `supply-chain/base-image-pinned`

**error** — Container base images use an explicit version

An untagged image or ":latest" changes underneath you. Pin a version tag at least, and ideally a digest.

### `ci/dependency-scan`

**warn** — Dependencies are scanned for known vulnerabilities

New vulnerabilities are published daily against code you did not change. Scan in CI, and keep automated update PRs flowing.

### `ci/present`

**warn** — The project has a CI pipeline

Checks that only run on a developer's machine are checks that sometimes do not run.

### `ci/secret-scan`

**warn** — CI scans for committed secrets

A leaked credential in git history stays valid until someone rotates it. Scanning every push catches it while it is still a one-line fix.

### `docker/dockerignore`

**warn** — A .dockerignore keeps secrets and junk out of images

Without one, "COPY . ." can bake .env files, .git history and node_modules into the image.

Fixable with `forge doctor --fix`.

### `docker/healthcheck`

**warn** — Containers declare a HEALTHCHECK

Orchestrators and "docker ps" can only restart or report a broken container if the image tells them how to check it.

### `hygiene/engines`

**warn** — package.json declares the supported Node.js version

The "engines" field makes npm warn (or fail) on unsupported runtimes instead of failing mysteriously later.

Fixable with `forge doctor --fix`.

### `hygiene/forge-backup-ignored`

**warn** — Forge backups are not committed

Forge saves overwritten files under .forge/backup/. They are a safety net, not source code.

Fixable with `forge doctor --fix`.

### `hygiene/gitignore`

**warn** — The project has a .gitignore

Without one, dependencies, build output and local secrets end up in version control.

Fixable with `forge doctor --fix`.

### `hygiene/readme`

**warn** — The project has a README

The README is where a new teammate, or you in six months, learns how to run the project.

### `secrets/env-ignored`

**warn** — .env files are git-ignored

Local environment files hold real credentials. Ignore them so they cannot be committed by accident (keep a committed .env.example instead).

Fixable with `forge doctor --fix`.

### `supply-chain/lockfile`

**warn** — A dependency lockfile is committed

Without a lockfile every install can resolve different versions, which makes builds irreproducible and lets a compromised release slip in unnoticed.

### `drift/modified`

**info** — Generated files that were edited or removed since generation

Informational: Forge compares files it generated with their recorded hashes. Editing them is fine; this just tells you what has diverged.

### `hygiene/license`

**info** — The project states its license

Without a license, nobody else may legally use the code. Private projects can ignore this.

