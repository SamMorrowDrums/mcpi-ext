/**
 * SEP-2640 "Skills Extension" — pinned Draft constants.
 *
 * ⚠️ DRAFT. SEP-2640 is an Extensions-Track proposal that has **not** been
 * accepted into the MCP specification. Everything in this directory is written
 * against one immutable revision of the proposal and is gated off by default so
 * it can never be mistaken for final-spec support. See `docs/skills.md`.
 *
 * Source of truth for this implementation:
 *   repo:   modelcontextprotocol/modelcontextprotocol
 *   path:   docs/seps/2640-skills-extension.mdx
 *   commit: 753b9f2be43e07fdd070e535d75f190cff14beea
 *
 * If the proposal moves, this file — not the call sites — is what changes, and
 * the revision below is what makes the drift visible.
 */

/** The extension identifier negotiated in `initialize` capabilities (SEP-2133). */
export const SKILLS_EXTENSION_NAME = "io.modelcontextprotocol/skills";

/** Immutable Draft revision this client was written against. */
export const SKILLS_EXTENSION_REVISION = "753b9f2be43e07fdd070e535d75f190cff14beea";

/** Proposal status at the pinned revision. Never `"final"` while this reads `"draft"`. */
export const SKILLS_EXTENSION_STATUS = "draft";

/** JSON-RPC methods defined by the extension. */
export const SKILLS_METHODS = {
  list: "skills/list",
  get: "skills/get",
  directoryRead: "resources/directory/read",
} as const;

/**
 * Maximum number of resource entries a single skill may declare, SKILL.md
 * included. Hosts MUST support up to and including this; servers SHOULD NOT
 * exceed it. Checkable from the listing alone, before any fetch.
 */
export const MAX_SKILL_RESOURCE_ENTRIES = 512;

/**
 * Maximum total declared byte size across one skill's resource entries
 * (16 MiB). Also checkable before any fetch. For `"dynamic"` resource sets the
 * same ceiling applies to what is actually retrieved.
 */
export const MAX_SKILL_TOTAL_BYTES = 16 * 1024 * 1024;

/**
 * Digest wire format: exactly `sha256:` followed by 64 **lowercase** hex
 * characters. Uppercase hex, a different prefix, or a different length is
 * non-conforming and this client rejects it rather than normalising it.
 */
export const SKILL_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** MIME type a directory entry carries in `resources/directory/read` results. */
export const DIRECTORY_MIME_TYPE = "inode/directory";

/**
 * `cacheScope` values this client is willing to honour.
 *
 * SEP-2640 delegates `ttlMs`/`cacheScope` semantics to SEP-2549 and does not
 * enumerate the legal scopes itself. Rather than guess the full vocabulary we
 * honour only the two scopes that are unambiguously narrower than a shared
 * cache, and treat every other value — including values we simply have not
 * seen — as "do not cache". Caching is a freshness optimisation; being wrong
 * in the conservative direction only costs a round trip.
 */
export const HONOURED_CACHE_SCOPES: ReadonlySet<string> = new Set(["session", "connection"]);

/** Upper bound applied to any server-supplied `ttlMs`, so a server cannot pin stale data. */
export const MAX_CACHE_TTL_MS = 5 * 60_000;

/** Page cap for `skills/list` / `resources/directory/read` cursor pagination. */
export const MAX_SKILL_LIST_PAGES = 64;

/**
 * A single human-readable line naming the proposal, its status, and the exact
 * revision. Surfaced at discovery time so an operator can always tell that this
 * is draft behaviour and which revision produced it.
 */
export function skillsExtensionDiagnostic(): string {
  return (
    `[skills] SEP-2640 Skills Extension support is DRAFT ` +
    `(${SKILLS_EXTENSION_NAME}, status=${SKILLS_EXTENSION_STATUS}, ` +
    `revision=${SKILLS_EXTENSION_REVISION.slice(0, 12)}). ` +
    `Not final MCP specification; behaviour may change without notice.`
  );
}

/**
 * One-line summary of what a server declared, for logs.
 *
 * Always names the draft status and revision so an operator reading a log can
 * see they are looking at unratified behaviour rather than settled protocol.
 */
export function describeNegotiation(
  serverName: string,
  capability: Record<string, unknown> | undefined,
): string {
  const marker = `${SKILLS_EXTENSION_STATUS} ${SKILLS_EXTENSION_REVISION.slice(0, 12)}`;
  if (!capability) {
    return `skills extension (${marker}): "${serverName}" does not declare "${SKILLS_EXTENSION_NAME}" — using legacy skill:// discovery`;
  }
  const directoryRead = capability["directoryRead"] === true;
  return `skills extension (${marker}): "${serverName}" declares "${SKILLS_EXTENSION_NAME}" (directoryRead=${String(directoryRead)})`;
}
