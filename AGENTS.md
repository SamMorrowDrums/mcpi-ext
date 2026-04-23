# AGENTS.md

## Tooling

This project uses **non-standard but objectively better** dev tooling. If you are an AI agent or new contributor, read this first.

### mise (tool version manager)

- **What:** [mise](https://mise.jdx.dev/) manages tool versions (node, aube) and project tasks. Think asdf + direnv + make in one tool.
- **Why:** Reproducible dev environments. `mise.toml` pins exact tool versions so every contributor and CI run uses the same stack.
- **Install:** `curl https://mise.run | sh` then activate: `eval "$(~/.local/bin/mise activate bash)"`
- **Usage:**
  - `mise install` — install all tools from `mise.toml`
  - `mise run <task>` — run a project task (build, test, dev, check, start)
  - `mise use <tool>@<version>` — add/update a tool version

### aube (package manager)

- **What:** [aube](https://aube.en.dev/) is a fast Node.js package manager. 7x faster than pnpm, 3x faster than bun for installs.
- **Why:** Faster CI, content-addressable global store (less disk), secure defaults (lifecycle scripts blocked until approved), and it reads/writes any existing lockfile format.
- **Install:** `mise use -g aube` (or `mise use aube` to pin per-project, which is already done)
- **Usage:** Drop-in replacement for npm/pnpm commands:
  - `aube install` — install dependencies
  - `aube add <pkg>` / `aube add -D <pkg>` — add dependency
  - `aube run <script>` — run package.json script
  - `aube test` — shortcut for test script
  - `aube approve-builds` — review and approve dependency build scripts

### pi (coding agent)

- **What:** [pi](https://pi.dev/) is an extensible terminal coding agent. This project builds extensions for it.
- **Extension pattern:** Export a default function receiving `ExtensionAPI`, register tools/commands/hooks.
- **Load extension:** `pi --extension ./dist/index.js`

## Dev Loop

```sh
mise install         # one-time: install node + aube
aube install         # install npm dependencies
mise run build       # compile TypeScript
mise run test        # run tests
mise run dev         # watch mode for development
mise run check       # type-check only
mise run lint        # lint TypeScript files
mise run format      # auto-format code with Prettier
mise run format:check # check formatting (CI mode)
```

## Project Structure

```
src/           TypeScript source
dist/          Compiled output (gitignored)
mise.toml      Tool versions and tasks
package.json   Dependencies and npm scripts
tsconfig.json  TypeScript configuration
```

## Code Quality

- **ESLint** — flat config with `typescript-eslint` (strict + stylistic) and Prettier compat
- **Prettier** — auto-formatting (double quotes, semicolons, trailing commas, 100 char width)
- **CI** — GitHub Actions runs lint → format:check → type-check → build → test on every PR
- **Dependabot** — automated dependency updates (npm + GitHub Actions)

Run `mise run lint` and `mise run format` before committing. CI will reject PRs that fail any check.

## Decision Log

We maintain a [DECISIONS.md](DECISIONS.md) file recording key architectural and design decisions. Keep it up to date when making significant choices — add a new numbered entry with date, context, decision, and rationale.

## Conventions

- ESM (`"type": "module"`)
- Target: ES2022, module: Node16
- Strict TypeScript
- Tests with vitest (co-located `*.test.ts` files)
