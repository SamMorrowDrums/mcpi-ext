/**
 * SEP-2640 wire schemas and entry-level validation.
 *
 * Everything here is pure: it turns an untrusted JSON-RPC result into a typed
 * value, or refuses. No network, no filesystem, no policy decisions. The checks
 * that SEP-2640 says are computable "from the listing alone, before any fetch"
 * live here so they can run before a single byte is retrieved.
 */
import { z } from "zod";
import {
  DIRECTORY_MIME_TYPE,
  MAX_SKILL_RESOURCE_ENTRIES,
  MAX_SKILL_TOTAL_BYTES,
  SKILL_DIGEST_PATTERN,
} from "./spec.js";

// -----------------------------------------------------------------------------
// Wire schemas
// -----------------------------------------------------------------------------

/**
 * One declared supporting file. `digest` is the SHA-256 of the file's raw
 * bytes; `size` is the count of those same bytes.
 */
export const SkillResourceRefSchema = z.looseObject({
  uri: z.string().min(1),
  digest: z.string().min(1),
  size: z.number().int().nonnegative(),
});

/**
 * A skill as advertised by `skills/list` / `skills/get`.
 *
 * `frontmatter` is the verbatim YAML-as-JSON the author wrote — not a curated
 * subset — so it is typed as an open record and never narrowed on ingest.
 * `resources` is either the complete declared set or the literal `"dynamic"`.
 */
export const SkillEntrySchema = z.looseObject({
  uri: z.string().min(1),
  frontmatter: z.record(z.string(), z.unknown()),
  resources: z.union([z.array(SkillResourceRefSchema), z.literal("dynamic")]),
});

/**
 * SEP-2549 cache attributes. Advisory freshness metadata only — never an
 * integrity property, and never a substitute for re-verifying bytes.
 */
const CacheAttributes = {
  ttlMs: z.number().int().nonnegative().optional(),
  cacheScope: z.string().optional(),
};

export const SkillsListResultSchema = z.looseObject({
  // `resultType` appears in the proposal's examples but not its normative field
  // table, so it is tolerated and never required.
  resultType: z.string().optional(),
  skills: z.array(SkillEntrySchema),
  nextCursor: z.string().optional(),
  ...CacheAttributes,
});

export const SkillsGetResultSchema = z.looseObject({
  resultType: z.string().optional(),
  // Note the singular key: `skills/get` returns `skill`, not `skills`.
  skill: SkillEntrySchema,
  ...CacheAttributes,
});

export const DirectoryResourceSchema = z.looseObject({
  uri: z.string().min(1),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});

export const DirectoryReadResultSchema = z.looseObject({
  resources: z.array(DirectoryResourceSchema),
  nextCursor: z.string().optional(),
});

export type SkillResourceRef = z.infer<typeof SkillResourceRefSchema>;
export type SkillEntry = z.infer<typeof SkillEntrySchema>;
export type SkillsListResult = z.infer<typeof SkillsListResultSchema>;
export type SkillsGetResult = z.infer<typeof SkillsGetResultSchema>;
export type DirectoryResource = z.infer<typeof DirectoryResourceSchema>;
export type DirectoryReadResult = z.infer<typeof DirectoryReadResultSchema>;

// -----------------------------------------------------------------------------
// Failures
// -----------------------------------------------------------------------------

export type SkillValidationCode =
  | "malformed_result"
  | "malformed_digest"
  | "resource_limit_exceeded"
  | "size_limit_exceeded"
  | "duplicate_resource_uri"
  | "skill_md_not_listed"
  | "missing_frontmatter_field"
  | "name_path_mismatch"
  | "dynamic_resources";

/** A refusal to accept server-supplied skill metadata. Never a fetch failure. */
export class SkillValidationError extends Error {
  readonly code: SkillValidationCode;
  readonly skillUri: string | undefined;

  constructor(code: SkillValidationCode, message: string, skillUri?: string) {
    super(message);
    this.name = "SkillValidationError";
    this.code = code;
    this.skillUri = skillUri;
  }
}

// -----------------------------------------------------------------------------
// Entry validation
// -----------------------------------------------------------------------------

/** True only for exactly `sha256:` + 64 lowercase hex characters. */
export function isValidDigest(digest: string): boolean {
  return SKILL_DIGEST_PATTERN.test(digest);
}

/** True when a `resources/directory/read` entry describes a directory. */
export function isDirectoryResource(resource: DirectoryResource): boolean {
  return resource.mimeType === DIRECTORY_MIME_TYPE;
}

/**
 * The `<skill-path>` an entry URI addresses, i.e. everything up to but not
 * including the trailing `/SKILL.md`. Returns `undefined` when the URI does not
 * end in `/SKILL.md`.
 */
export function skillPathOf(uri: string): string | undefined {
  const suffix = "/SKILL.md";
  if (!uri.endsWith(suffix)) return undefined;
  return uri.slice(0, -suffix.length);
}

/** The final path segment of a skill path — the segment that must equal `frontmatter.name`. */
export function finalPathSegment(skillPath: string): string {
  const trimmed = skillPath.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * A skill's declared name, or `undefined` when frontmatter omits it or it is
 * not a string. `name` and `description` are the two fields SEP-2640 requires.
 */
export function frontmatterName(entry: SkillEntry): string | undefined {
  const value = entry.frontmatter["name"];
  return typeof value === "string" ? value : undefined;
}

export function frontmatterDescription(entry: SkillEntry): string | undefined {
  const value = entry.frontmatter["description"];
  return typeof value === "string" ? value : undefined;
}

/**
 * Validate one listing entry using only information the listing itself carries.
 *
 * This runs before any content is fetched, and every failure means the skill is
 * not loadable — never that it should be silently downgraded or retried against
 * a different contract.
 *
 * Checks, in order:
 *  1. every declared digest is well-formed (`sha256:` + 64 lowercase hex);
 *  2. no duplicate resource URIs within the entry (a duplicate would let one
 *     declaration shadow another and make "which digest applies" ambiguous);
 *  3. at most {@link MAX_SKILL_RESOURCE_ENTRIES} entries;
 *  4. at most {@link MAX_SKILL_TOTAL_BYTES} declared bytes in total;
 *  5. the entry's own `uri` appears in its `resources` (SKILL.md counts, and it
 *     is the file we are about to fetch — it must carry a digest);
 *  6. `name` and `description` are present;
 *  7. the final `<skill-path>` segment equals `frontmatter.name`.
 *
 * `"dynamic"` resource sets skip 2–5: nothing is declared up front, so the
 * ceilings are enforced against what is actually retrieved instead.
 */
export function validateSkillEntry(entry: SkillEntry): void {
  const uri = entry.uri;

  if (entry.resources !== "dynamic") {
    const seen = new Set<string>();
    let totalBytes = 0;

    for (const resource of entry.resources) {
      if (!isValidDigest(resource.digest)) {
        throw new SkillValidationError(
          "malformed_digest",
          `Skill ${uri} declares resource ${resource.uri} with a non-conforming digest ` +
            `"${resource.digest}". SEP-2640 requires exactly "sha256:" followed by 64 lowercase hex characters.`,
          uri,
        );
      }
      if (seen.has(resource.uri)) {
        throw new SkillValidationError(
          "duplicate_resource_uri",
          `Skill ${uri} declares resource ${resource.uri} more than once, so which digest applies is ambiguous.`,
          uri,
        );
      }
      seen.add(resource.uri);
      totalBytes += resource.size;
    }

    if (entry.resources.length > MAX_SKILL_RESOURCE_ENTRIES) {
      throw new SkillValidationError(
        "resource_limit_exceeded",
        `Skill ${uri} declares ${entry.resources.length} resources, above the SEP-2640 ceiling of ` +
          `${MAX_SKILL_RESOURCE_ENTRIES}. The skill was not loaded and nothing was fetched.`,
        uri,
      );
    }

    if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
      throw new SkillValidationError(
        "size_limit_exceeded",
        `Skill ${uri} declares ${totalBytes} bytes across its resources, above the SEP-2640 ceiling of ` +
          `${MAX_SKILL_TOTAL_BYTES} bytes (16 MiB). The skill was not loaded and nothing was fetched.`,
        uri,
      );
    }

    if (!seen.has(uri)) {
      throw new SkillValidationError(
        "skill_md_not_listed",
        `Skill ${uri} does not list its own SKILL.md in its resources, so the content this host would ` +
          `fetch carries no digest to verify against.`,
        uri,
      );
    }
  }

  const name = frontmatterName(entry);
  if (!name) {
    throw new SkillValidationError(
      "missing_frontmatter_field",
      `Skill ${uri} has no string "name" in its frontmatter.`,
      uri,
    );
  }
  if (!frontmatterDescription(entry)) {
    throw new SkillValidationError(
      "missing_frontmatter_field",
      `Skill ${uri} has no string "description" in its frontmatter.`,
      uri,
    );
  }

  const skillPath = skillPathOf(uri);
  if (skillPath === undefined) {
    throw new SkillValidationError(
      "name_path_mismatch",
      `Skill URI ${uri} does not address a SKILL.md, so its <skill-path> cannot be compared to "${name}".`,
      uri,
    );
  }
  const segment = finalPathSegment(skillPath);
  if (segment !== name) {
    throw new SkillValidationError(
      "name_path_mismatch",
      `Skill ${uri} declares name "${name}" but its final path segment is "${segment}". ` +
        `SEP-2640 requires them to match.`,
      uri,
    );
  }
}

/**
 * Total declared bytes for an entry, or `undefined` for a `"dynamic"` set where
 * nothing is declared in advance.
 */
export function declaredTotalBytes(entry: SkillEntry): number | undefined {
  if (entry.resources === "dynamic") return undefined;
  return entry.resources.reduce((total, resource) => total + resource.size, 0);
}

/** Look up an entry's declaration for one URI. `undefined` means "not listed". */
export function findResourceRef(
  entry: SkillEntry,
  uri: string,
): SkillResourceRef | "dynamic" | undefined {
  if (entry.resources === "dynamic") return "dynamic";
  return entry.resources.find((resource) => resource.uri === uri);
}

/**
 * A stable digest over an entry's declared resource set, used to bind an
 * approval to exact content. Any rotation — a changed digest, an added file, a
 * removed file, or a switch to/from `"dynamic"` — produces a different value,
 * which is what makes a prior approval fall away instead of silently carrying
 * over to different bytes.
 */
export function resourceSetFingerprint(entry: SkillEntry): string {
  if (entry.resources === "dynamic") return "dynamic";
  return [...entry.resources]
    .map((resource) => `${resource.uri}\u0000${resource.digest}\u0000${resource.size}`)
    .sort()
    .join("\u0001");
}
