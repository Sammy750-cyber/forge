# Authoring templates and features

A **template** is a base project (`forge new`). A **feature** is an overlay that can be applied at creation or later to an existing repo (`forge add`). They share one format: adding one means adding files, not writing TypeScript.

```
templates/my-template/
  forge.template.json     # manifest
  files/                  # everything that ends up in the project
  partials/               # reusable snippets ({{> name}})
features/my-feature/
  forge.feature.json
  files/
```

## Rendering rules

- Only files ending in **`.hbs`** are rendered (Handlebars). The suffix is removed. Everything else is copied byte for byte. This is why GitHub Actions' `${{ secrets.X }}` survives untouched in plain files.
- A path segment starting with **`_dot_`** becomes a leading dot: `_dot_gitignore` produces `.gitignore`. (npm will not publish files literally named `.gitignore`.)
- **`{{name}}`** works inside file and directory names: `src/{{name}}.ts.hbs`.
- Rendering is **strict**: using a variable no question declares is an error, not empty text. Output is never HTML-escaped.
- Line endings are normalized to LF and text files end with one newline. Binary files (by extension, null bytes, or invalid UTF-8) are copied as-is.
- Output is deterministic: no dates, no randomness. Two runs with the same answers are byte-identical, which is what makes `doctor` drift detection and idempotency possible.
- Paths are validated after rendering. Templates cannot write to `.git` or `.forge`, cannot escape the project, and cannot contain symlinks. Two outputs that differ only by letter case are rejected.

### Variables

`{{name}}` is always the project name. Every question id is a variable (`{{port}}`, `{{docker}}`). A question skipped by `when` is `null`, so `{{#if x}}` still works.

### Helpers (the complete list; templates cannot add their own)

| Helper | Example | Result |
|---|---|---|
| `eq`, `ne`, `not`, `and`, `or` | `{{#if (and docker (eq license "MIT"))}}` | conditions |
| `kebabCase`, `snakeCase`, `camelCase`, `pascalCase` | `{{pascalCase name}}` | `my-api` -> `MyApi` |
| `json` | `{{json description}}` or `{{json obj 2}}` | a correctly quoted JSON value |
| `yamlString` | `{{yamlString description}}` | a double-quoted YAML scalar |
| `shellQuote` | `{{shellQuote value}}` | a single-quoted POSIX shell word |
| `indent` | `{{indent 4 text}}` | indents every non-empty line |

Always use `json`, `yamlString` or `shellQuote` when an answer goes into JSON, YAML or a shell command. Never paste a raw answer there.

**Partial gotcha:** a partial tag alone on a line (`{{> head}}`) consumes its own line break, so end partial files with a newline.

## The manifest

```json
{
  "id": "my-template",
  "version": "1.0.0",
  "kind": "template",
  "description": "One sentence.",
  "requires": { "features": ["other"], "conflicts": ["incompatible"] },
  "questions": [ ... ],
  "files": [ ... ],
  "pipeline": { "checks": [ ... ] }
}
```

The manifest is strict: unknown keys are errors, so typos fail loudly. There is deliberately no field for running commands.

### Questions

| Field | Meaning |
|---|---|
| `id` | lowercase letters, digits, hyphens. `name` and `forge` are reserved |
| `type` | `string` (optional `pattern`), `boolean`, or `enum` (`choices`) |
| `message` | the prompt |
| `default` | used with `--yes` and as the prompt's default |
| `required` | `false` makes an unanswered question `null` instead of an error |
| `secret` | hidden when typed, never saved to `.forge/state.json` |
| `when` | `{ "answer": "docker", "equals": true }`, `{ "in": [...] }`, or presence; add `"not": true` to invert. May only refer to **earlier** questions |

Questions that share an id across a template and its features are asked **once** and answered once. They must have the same type and choices.

### File rules

Rules are keyed by the file's path under `files/` (before rendering).

| Field | Meaning |
|---|---|
| `when` | include the file only if the condition holds |
| `executable` | mode 755 instead of 644 |
| `binary` | never render, even if it looks like text |
| `mergeStrategy` | what happens if the file already exists (below) |

### Merge strategies

| Strategy | Use for | Behavior |
|---|---|---|
| `overwrite` (default) | files Forge owns | replaced only if unmodified since Forge wrote it; otherwise a conflict |
| `none` | create-only files | never replaced once they exist |
| `line-set` | `.gitignore`, `.dockerignore` | missing lines are appended; nothing removed or reordered |
| `json-merge` | `package.json`, `tsconfig.json` | deep merge; arrays are unioned; the user's scalar wins |
| `yaml-merge` | `.gitlab-ci.yml`, compose files | merge by key; comments and formatting preserved; the user's scalar wins |

If an existing file cannot be parsed (JSON with comments, invalid YAML), Forge reports a conflict. It never guesses. Two features may write the same path only if both declare the same merge strategy (or the content is identical).

### Pipelines

Never write CI YAML by hand in a template. Declare checks and Forge generates the provider's file, pinned and least-privilege:

```json
"pipeline": { "checks": [ { "kind": "secrets" }, { "kind": "container", "when": { "answer": "docker", "equals": true } } ] }
```

Kinds: `secrets`, `dependencies`, `sast`, `iac`, `container`, `node-ci`. The manifest must declare an enum question `provider` (`github`/`gitlab`). Optional questions that adjust the output: `default-branch`, `severity` (`MEDIUM`/`HIGH`/`CRITICAL`), `schedule`, `node-version`, `package-manager` (`npm`/`pnpm`), `docker`, `dockerfile`. Adding another provider means one adapter in `src/core/pipeline/`; no feature changes.

## Testing your template

1. `pnpm test` renders **every** template and feature with default answers, applies them twice (the second run must change nothing) and runs `doctor` on the result (it must report zero errors). A new template is covered automatically.
2. `pnpm validate:templates` generates each template, installs it, and runs the project's own typecheck, lint, tests and build, then checks idempotency and `doctor`. This is the real test: a template is only correct if the project it generates works.
3. Add focused tests when you add helpers, merge strategies or pipeline checks.

## Checklist

- [ ] Every answer that reaches JSON, YAML or a shell goes through `json` / `yamlString` / `shellQuote`.
- [ ] No timestamps, random values, or absolute paths in output.
- [ ] Secrets are `.env.example` placeholders only.
- [ ] Dependencies in generated `package.json` use ranges you have actually installed and tested.
- [ ] Containers run as a non-root user, pin a version tag, and define a `HEALTHCHECK`.
- [ ] `pnpm validate:templates` passes.
