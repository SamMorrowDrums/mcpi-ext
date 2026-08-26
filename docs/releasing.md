# Releasing

`@sammorrowdrums/mcpi-ext` is published to npm by
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml) using npm
**trusted publishing**. There is no `NPM_TOKEN` in this repository, in its
secrets, or in the workflow. The registry authenticates the workflow itself via
a short-lived GitHub OIDC token, and provenance attestation is generated
automatically.

## One-time setup (human only, cannot be automated from here)

Trusted publishing is configured on npmjs.com, not in this repository. A
maintainer with **admin** rights on the npm package must do this once, before
the first release. It cannot be done by CI, by an agent, or by any code in this
repo — the whole point is that the trust anchor lives outside the artefact.

On <https://www.npmjs.com/package/@sammorrowdrums/mcpi-ext/access>, under
**Trusted Publisher**, choose **GitHub Actions** and enter these four values
**exactly**:

| Field                | Value            |
| -------------------- | ---------------- |
| Organization or user | `SamMorrowDrums` |
| Repository           | `mcpi-ext`       |
| Workflow filename    | `publish.yml`    |
| Environment name     | `npm publish`    |

All four are matched literally against the OIDC claims. `publish.yml` is the
filename only — not a path, and not `.github/workflows/publish.yml`. The
environment name contains a space and is `npm publish`, matching
`environment: npm publish` in the workflow; a mismatch here is the most common
cause of a `403` at publish time.

Because the package does not exist on the registry yet, the very first publish
needs one of:

- publishing `1.0.0` once manually from a maintainer's machine so the package
  exists, then configuring the trusted publisher and using the workflow for
  every subsequent release; or
- creating the package as a placeholder and configuring the trusted publisher
  before running the workflow.

Either way, after the trusted publisher is configured, **remove any classic
automation tokens** for the package so the OIDC path is the only way to publish.

### Recommended repository settings

- Create a GitHub environment named exactly `npm publish`
  (Settings → Environments) and add required reviewers. Trusted publishing
  authenticates the workflow, but the environment is what gives a human a
  chance to stop a release before it is irreversible.
- Restrict the environment to tags matching `v*` so a release cannot be
  published from an arbitrary branch.

## Cutting a release

1. Land every change on `main`. CI must be green on **both** Node 22 and 24.
2. Bump `version` in `package.json` and update `CHANGELOG.md`.
3. Run the full preflight locally:

   ```sh
   npm ci
   mise run lint && mise run format:check && mise run check && mise run test
   node scripts/release-check.mjs
   node scripts/verify-package.mjs
   ```

4. Commit, tag `vX.Y.Z` on that exact commit, and push both.
5. Publish a GitHub Release pointing at that tag. That — and only that —
   triggers `publish.yml`.

## What the workflow refuses to do

The publish job re-derives everything from the release tag rather than trusting
the trigger, and fails closed:

- the tag must look like `vMAJOR.MINOR.PATCH`;
- the tag version must equal `package.json`'s `version`;
- `HEAD` must be exactly the commit the tag names, so a moved or re-pointed tag
  cannot smuggle in different source;
- draft releases are rejected;
- the version must not already exist on the registry — releases are immutable;
- npm must be `>= 11.5.1`, the first version that can use trusted publishing.

Only after all of that does it run lint, format, type-check, tests, the full
`release-check.mjs`, and `verify-package.mjs` — which packs the tarball,
installs it into a throwaway project, and drives the installed artefact. The
package is published only if the thing a consumer would install has already
been proven to work. Publication is then confirmed by reading the version back
from the registry.

A prerelease GitHub Release publishes under the `next` dist-tag; a normal
release publishes under `latest`.
