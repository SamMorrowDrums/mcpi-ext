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
```

## Project Structure

```
src/           TypeScript source
dist/          Compiled output (gitignored)
mise.toml      Tool versions and tasks
package.json   Dependencies and npm scripts
tsconfig.json  TypeScript configuration
```

## Conventions

- ESM (`"type": "module"`)
- Target: ES2022, module: Node16
- Strict TypeScript
- Tests with vitest (co-located `*.test.ts` files)
