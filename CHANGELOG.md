# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Code Mode discovery now describes the raw MCP `CallToolResult` envelope and types declared output
  schemas under optional `structuredContent`, preserving content blocks, resources, `_meta`,
  `isError`, text-only results, and falsey structured values without inventing a top-level result
  shape.
- Every successful `code_search` rendering now exposes the full executable `snapshotId`, clearly
  separates it from a tool's `schemaHash`, and gives bounded stale-snapshot recovery guidance.
- Execution routing now distinguishes direct one-call proxies, Code Mode calculations, tool-cli
  shell composition, and bash/external artifact pipelines without imposing a global precedence.
- Code Mode guidance now favors discovery followed by one execution, with at most a bounded
  inspect-and-correct retry for an unknown result shape rather than repeated runs around call limits.

## [1.1.0] — 2026-09-10

This is also the first published release to contain the `1.0.2` fixes below. `1.0.2`
was prepared in the repository but never tagged or published to npm, so the managed
install and peer-import fixes recorded under it reach the registry here.

### Changed

#### Code Mode no longer injects the whole tool catalog into every prompt

Every discovered MCP tool's full TypeScript signature was rendered into the system prompt,
and that section was re-rendered on every turn. Against the real 85-tool
`github-mcp-server` surface with `GITHUB_TOOLSETS=all` that was 33,133 tokens of
declarations resent each turn, growing with every server added — and because the section
changed whenever a server reconnected, it also defeated prompt-prefix caching.

Code Mode now renders a declaration-only namespace block once, at session start, and never
re-renders it. Namespaces come only from declared sources — server `_meta` or operator
configuration — never inferred from tool names. Servers that connect later stay fully
searchable and callable, but no longer mutate the prompt.

#### `code_search` is a structured discovery API rather than an arbitrary code entry point

It accepted free-form JavaScript and ran it through the full execution path, which made
"search" indistinguishable from "execute". It now takes an explicit `op` — `browse`,
`list`, `search`, or `describe` — with bounded paging, and answers without entering the
sandbox at all. `list` requires a namespace, server, or effect filter, since an unfiltered
list is the eager catalog through the back door.

`codemode.describeTools()` previously existed as a stub that returned nothing. Exact
schemas are now fetched on demand and returned into the conversation, not into the tool
definitions.

### Removed

#### The eager type-hint catalog renderer

`generateTypeHints` — the function that produced the 33,133-token `declare const codemode`
block — and `sanitizeToolName`, which existed only to turn tool names into JavaScript
identifiers for it, are gone rather than merely unused. Nothing called them once the pinned
namespace prompt landed, but a dead catalog renderer that still compiles is an invitation to
call it again.

The JSON Schema to TypeScript formatter they shared is still needed, since `describe` returns
compact signatures, so it now lives in `json-schema-to-ts.ts` under its own name. It has no
MCP imports and is not reachable from the prompt. Neither removed symbol was public API: the
package exports only the extension entry point.

### Fixed

#### A server could impersonate another server's tool through its tool name

Tools were addressed by the string `${server}/${tool}`, and tool names are chosen by the
server. A server registered as `a` shipping a tool named `b/echo` produced exactly the
reference that server `a/b` shipping `echo` produced. Authority now travels as a structured
identity record, index keys are length-prefixed, and any reference two identities could
produce resolves to neither — returning `ambiguous_tool` naming both candidates.

#### A script could describe one schema and call another

Discovery from inside a running script read the live catalog while dispatch had already
resolved against an older one. Each run now pins a single frozen catalog snapshot, and
`code_execute` accepts the `snapshotId` returned by `code_search`, refusing `stale_snapshot`
before the sandbox starts. A tool whose schema changed after it was described now fails as
`schema_changed` with instructions to re-describe, rather than inviting a retry that cannot
succeed.

### Added

- Per-server trust levels (`untrusted`, `reviewed`, `managed`; default `untrusted`) and a
  `definitionDigest` covering everything the model can read — descriptions and annotations
  included, not only schemas, since a server can rewrite a description into an instruction
  without touching a schema.
- A coarse run-level provenance record of which servers a run read before it wrote, so
  whoever approves a side effect can see whether the data came from somewhere unvetted.
- Discovery funnel counters, including a blind-call rate and a browse ratio, so the
  progressive-discovery claim is measurable rather than asserted.
- Operator-curated namespaces in `mcp.json`, for servers that declare no toolset metadata.

## [1.0.2] — 2026-09-08

Never published to npm. These fixes first reached the registry in `1.1.0`.

### Fixed

#### `mcpi install` now discovers the published extension

The npm package did not declare a `pi.extensions` resource. `mcpi install
npm:@sammorrowdrums/mcpi-ext` therefore installed and recorded the package successfully, but
managed resource discovery found no entry point and the extension flags never appeared. The
package now declares `./dist/index.js` explicitly.

#### The installed package no longer imports its peer host at runtime

mcpi intentionally installs managed packages with peer resolution disabled so it does not create
a second host copy with a different module identity. Three skill modules still imported
`parseFrontmatter` and `stripFrontmatter` as runtime values from `@sammorrowdrums/mcpi`, so a
native import of the managed entry failed with `ERR_MODULE_NOT_FOUND`. The compatible helpers now
live inside mcpi-ext, backed by a direct, pinned `yaml` dependency; every remaining mcpi import is
type-only.

### Added

The package verifier now installs the tarball without its peer and proves it imports independently.
It also installs public mcpi 0.85.1 into an isolated user prefix, runs the real managed
`mcpi install` flow, checks `mcpi list`, imports the exact managed entry, rejects a duplicate host
copy, verifies both extension flags in `mcpi --help`, and starts a zero-server RPC session through
those flags. CI runs the flow on Node 22 and Node 24.

## [1.0.1] — 2026-09-07

Documentation only. No runtime behaviour changes.

### Fixed

#### The install instructions now match the shipped CLI

The README led with a global install plus `--extension $(npm root -g)/…`. `mcpi install
npm:@sammorrowdrums/mcpi-ext@1.0.1` is the supported path: mcpi records the package in
`~/.config/mcpi/settings.json` and loads it on every run, so the flag is never needed.

#### Credentials are no longer described as inherited from the shell

An exported `GITHUB_PERSONAL_ACCESS_TOKEN` never reached a stdio MCP server. Children get
the MCP SDK's default environment — on POSIX just `HOME`, `LOGNAME`, `PATH`, `SHELL`,
`TERM`, `USER` — and `mcp.json` performs no `${VAR}` expansion. The Quick Start now uses a
`chmod 600` env file passed to `docker run --env-file`, which Docker itself reads, and no
token is ever written into `mcp.json`.

#### Removed references to things that do not exist

The `ghcr.io/github/github-mcp-server:skill-discovery` image tag was never published; the
documented tag is `:latest`. The link to mcpi's progressive tool discovery document 404s —
that repository has no `docs/` directory. The skills mechanism cited a stale
`experimental-ext-grouping` mirror instead of the live SEP-2640 draft.

#### Server support claims are now measured, not assumed

The official GitHub MCP server does not declare `io.modelcontextprotocol/skills`, so it
provides Code Mode and tool-cli but no skills. The README states this plainly and reports
the tool counts it was measured against.

### Changed

Persona artwork and story framing were removed from the README and docs, and the
mechanisms are no longer numbered as tiers — the numbering read as a routing order that
was never implemented.

### Added

Contributor guidance for building a compatible GitHub MCP server from a source checkout and
tagging it locally (`github-mcp-server-experimental:local`), with the draft skills feature flag
and the same `chmod 600` `--env-file` credential handling. It is deliberately outside the
official-server Quick Start: the tested eight-skill build is local-only, is not published to GHCR
or the MCP Registry, and cannot be reproduced from any public image.

`src/docs.test.ts` asserts the documentation against the manifest, the registered CLI
flags, the pinned SEP-2640 revision, and the negotiated protocol version, and rejects the
stale strings listed above so they cannot return unnoticed.

## [1.0.0] — 2026-09-07

First stable release. The changes below are breaking relative to `0.2.1`; each one is
listed with what moved and what to do about it. A step-by-step upgrade is in the
[migration guide](#migrating-from-021-to-100).

### Breaking

#### `isolated-vm` is now an optional dependency

It was a hard runtime dependency (`^6.1.2`), imported at module load. A native addon
that fails to build or has no prebuild for the platform therefore took down the whole
extension — skills, tool-cli, and execution routing included — even though none of
them need a sandbox.

It is now `optionalDependencies: "~6.2.0"`, loaded lazily on first use. Installation
succeeds without it and the extension still loads. Code Mode reports itself
unavailable with the specific cause, and every other facility keeps working.

The `~6.2.0` range is deliberate. `isolated-vm@7` declares `engines.node >=24.0.0`,
so a caret range would resolve on Node 24 to a major this package has not been
verified against, and would resolve on Node 22 to a version that only warns rather
than refusing to install — `engines` is advisory unless `engine-strict` is set. The
tilde range, not the `engines` field, is what actually keeps 7.x out.

**Code Mode does not fall back to `node:vm`.** A `node:vm` context is not a security
boundary: it shares the host realm and its escapes are well known. Substituting it
for an isolate would turn a visible unavailability into a silent downgrade of the
guarantee the sandbox exists to provide. When the isolate is unavailable,
`code_execute` refuses with a structured `sandbox_unavailable` error naming the cause
and pointing at tool-cli and the MCP tool proxies.

#### The `@sammorrowdrums/mcpi` peer range is now bounded

Was `>=0.70.9` — an open upper bound that would accept any future major of the host,
including majors that remove the extension APIs this package calls. It is now
`>=0.85.0 <1.0.0`.

The floor moves to the first release carrying the finalized extension API contract.
The ceiling refuses a major nobody has seen yet. Because mcpi is pre-1.0, minor
releases may still break, so the range is a considered compatibility statement rather
than a mechanical caret.

#### Deep imports are no longer reachable

The package had `main`/`types` and no `exports` map, so `dist/mcp/policy.js`,
`dist/code-mode/executor.js`, and every other internal module were importable.
Anything a consumer reached is something this project could not then change without
breaking them.

An `exports` map now publishes exactly two entries: the package root and
`./package.json`. Everything else is private.

#### Test files and fixture servers are no longer published

`files: ["dist"]` shipped compiled tests, fixture MCP servers, and source maps
pointing at a `src/` that is not in the tarball. The published tree is now built from
`tsconfig.build.json` and filtered by an allowlist: 85 files, no tests, no fixtures,
no maps.

If you were spawning `dist/test-servers/weather-stdio.js` from an installed copy,
clone the repository instead; those servers exist for this project's own integration
tests.

#### SEP-2640 `directoryRead` is implemented only where it is declared

The bundled skills-extension fixture server registered a `resources/directory/read`
handler unconditionally, including when it advertised no capability for it. Per
[SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol), clients
"MUST NOT call `resources/directory/read` against a server that has not declared
`directoryRead: true`" — but a server that answers a method it never declared lets a
non-conforming client appear to work, and hides the bug until it meets a server that
enforces the rule.

The handler is now registered only when the capability is declared. Client-side
behaviour is unchanged and was already correct.

### Added

- MIT `LICENSE`. The package had declared `"license": "MIT"` with no license text
  behind it.
- `repository`, `homepage`, `bugs`, `author`, `keywords`, and
  `publishConfig` (`access: public`, `provenance: true`) metadata.
- `scripts/release-check.mjs`, wired into `prepublishOnly`, covering the mistakes
  npm's immutable versions make unrecoverable: identity drift between the MCP client
  version and `package.json`, a missing LICENSE, a loosened MCP client pin,
  `isolated-vm` promoted back to a hard dependency, test files in the tarball,
  production advisories, and publishing ahead of the peer floor's own release.
- `tsconfig.build.json`, separating the published build from the development build
  that still compiles fixture servers for integration tests.
- `.github/workflows/publish.yml`, publishing through npm Trusted Publishing (OIDC)
  on a release event. No `NPM_TOKEN` exists in this repository.
- CI now runs on Node 22 and 24 with `npm ci`, and verifies tarball contents,
  installation from the tarball, and Code Mode's degradation path when the native
  addon is absent.

### Changed

- MCP client identity version reports `1.0.0`. Servers see this string, so a stale
  value misreports this client to every peer it connects to. The tool-cli provider
  test now reads the identity constant rather than duplicating the literal.
- README image and documentation links are absolute. npm serves the README detached
  from the repository, so the previous relative links produced broken images and 404s
  on the registry page.

### Fixed

- Production dependency tree has no known advisories. `fast-uri` is held at `^3.1.5`
  through an override, resolving three host-confusion advisories reaching the tree
  via `@sammorrowdrums/tool-cli → ajv`. `@sammorrowdrums/tool-cli` stays at `^1.0.2`.
- Three links in `docs/server-developer-guide.md` were written as `docs/skills.md`
  from a file already inside `docs/`, resolving to `docs/docs/`. Broken on GitHub as
  well as npm.

### Known issues

- `extract-zip` (GHSA-jmr9-qjv8-65gv, unvalidated symlink path traversal) has no
  fixed release. It reaches the tree only through the `@sammorrowdrums/mcpi`
  **development** dependency, is absent from the production tree, and is not
  installed by consumers of this package. Accepted for this release; it clears when
  the host package moves off it.
- `isolated-vm` publishes no `darwin-x64` prebuild, so Intel macOS compiles it from
  source and needs a C++ toolchain. Apple Silicon, Linux (x64 and arm64), and
  Windows x64 all install from prebuilds.

---

## Migrating from 0.2.1 to 1.0.0

### 1. Upgrade the host first

`@sammorrowdrums/mcpi` must be at `0.85.0` or later, and below `1.0.0`.

```sh
npm install @sammorrowdrums/mcpi@^0.85.0
npm install @sammorrowdrums/mcpi-ext@^1.0.0
```

Installing in the other order gives you an unsatisfiable peer dependency.
`npm run release:check` refuses to publish this package before its peer floor exists
on the registry, so the ordering is enforced at the source too.

### 2. Replace any deep imports

```js
// No longer resolvable
import { McpPolicy } from "@sammorrowdrums/mcpi-ext/dist/mcp/policy.js";

// Use the package root
import { McpPolicy } from "@sammorrowdrums/mcpi-ext";
```

If something you relied on is not exported from the root, open an issue rather than
pinning to `0.2.1` — the export surface is defined by what people demonstrably need.

### 3. Decide what Code Mode's availability means for you

Nothing to do if you want the default: `npm install` picks up the prebuilt addon on
supported platforms, and Code Mode behaves as before.

To skip the native addon deliberately — a minimal container, a platform with no
prebuild, or an environment with no C++ toolchain:

```sh
npm install --omit=optional
```

Skills, tool-cli, and execution routing are unaffected. Code Mode advertises itself
as unavailable with the reason, and `code_execute` refuses with `sandbox_unavailable`
rather than executing anywhere less isolated.

To confirm what happened at runtime, read the `<execution_routing>` prompt section:
every facility reports `available`, `unavailable`, or `unknown` with a non-empty
reason, and `unknown` means "not yet probed" rather than "absent".

### 4. Stop depending on published fixture servers

The `dist/test-servers/` entries are gone from the tarball. If you were pointing an
MCP config at one of them, clone the repository and build it there:

```sh
git clone https://github.com/SamMorrowDrums/mcpi-ext.git
cd mcpi-ext && npm install && npm run build
```

### 5. Check your Node version

`>=22.13.0`, unchanged from `0.2.1`. Node 22 and 24 are both covered by CI. The
`~6.2.0` isolated-vm range exists specifically to keep Node 22 working:
`isolated-vm@7` declares `engines.node >=24.0.0`, and because `engines` only
produces an `EBADENGINE` warning by default, the pinned range is the guard that
actually prevents it from being selected.

[1.0.0]: https://github.com/SamMorrowDrums/mcpi-ext/releases/tag/v1.0.0
