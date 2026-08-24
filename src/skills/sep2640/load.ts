import type { McpPolicy, McpResourceSource } from "../../mcp/policy.js";
import {
  base64ToBytes,
  SkillIntegrityError,
  textToBytes,
  verifyFrontmatter,
  verifyNamePath,
  verifyResourceRead,
} from "./integrity.js";
import type { SkillEntry } from "./protocol.js";

/** A verified read of one resource belonging to a skill. */
export interface VerifiedResource {
  readonly uri: string;
  /** Raw bytes exactly as digested. */
  readonly bytes: Uint8Array;
  /** UTF-8 decoding of {@link bytes}, for text resources. */
  readonly text: string;
}

/**
 * Tracks how many bytes a skill has actually pulled down.
 *
 * Only `"dynamic"` skills need this: a declared resource set is bounded before
 * the first fetch, but a dynamic one can only be bounded by watching what
 * arrives.
 */
export class SkillFetchBudget {
  private retrieved = 0;

  get bytesRetrieved(): number {
    return this.retrieved;
  }

  add(count: number): void {
    this.retrieved += count;
  }
}

export interface ReadSkillResourceOptions {
  readonly policy: McpPolicy;
  readonly entry: SkillEntry;
  readonly serverName: string;
  readonly uri: string;
  readonly budget?: SkillFetchBudget;
  readonly source?: McpResourceSource;
  readonly signal?: AbortSignal;
}

/**
 * Read one resource belonging to a skill and verify it before returning it.
 *
 * Verification happens on the raw bytes, on every read, with no cached
 * "already checked this" shortcut — a digest that was right last time says
 * nothing about the bytes that just arrived.
 *
 * Callers receive content only if it verifies. There is deliberately no way to
 * obtain the unverified bytes.
 */
export async function readSkillResource(
  options: ReadSkillResourceOptions,
): Promise<VerifiedResource> {
  const { policy, entry, serverName, uri, budget, signal } = options;

  const result = await policy.readResource({
    // SEP-2640 reads are authorized by exact membership in this entry's
    // `resources` set, which the policy indexes per skill. Defaulting to the
    // legacy `skill-load` source would consult the broader per-server skill
    // index instead, which does not contain supporting files at all and is
    // wider than the spec allows for the ones it does contain.
    source: options.source ?? "skills-extension",
    serverName,
    uri,
    skillUri: entry.uri,
    ...(signal ? { signal } : {}),
  });

  const content = result.contents.find((item) => item.uri === uri) ?? result.contents[0];
  if (!content) {
    throw new SkillIntegrityError(
      "no_text_content",
      `Read of ${uri} returned no content to verify.`,
      uri,
    );
  }

  const bytes = contentBytes(content, uri);
  verifyResourceRead(entry, uri, bytes, budget?.bytesRetrieved ?? 0);
  budget?.add(bytes.length);

  return { uri, bytes, text: new TextDecoder().decode(bytes) };
}

/**
 * Load a skill's SKILL.md and prove it is the document the listing described.
 *
 * Three separate checks have to pass, and each catches something the others
 * cannot: the digest proves the bytes are the advertised bytes, the
 * field-by-field frontmatter comparison proves the listing did not describe the
 * skill as one thing while serving another, and the name/path check proves the
 * skill is not impersonating a different slot in the namespace.
 *
 * Returns the full document text; stripping frontmatter is the caller's job,
 * because verification needs the document exactly as it was digested.
 */
export async function loadSkillDocument(options: {
  readonly policy: McpPolicy;
  readonly entry: SkillEntry;
  readonly serverName: string;
  readonly budget?: SkillFetchBudget;
  readonly signal?: AbortSignal;
}): Promise<VerifiedResource> {
  const { policy, entry, serverName, budget, signal } = options;

  verifyNamePath(entry);

  const resource = await readSkillResource({
    policy,
    entry,
    serverName,
    uri: entry.uri,
    ...(budget ? { budget } : {}),
    ...(signal ? { signal } : {}),
  });

  verifyFrontmatter(entry, resource.text);
  return resource;
}

/**
 * Recover the raw bytes a resource content block represents.
 *
 * Text blocks are re-encoded as UTF-8 because that is what the digest covered;
 * decoding and re-encoding is lossless for valid UTF-8 and any input that
 * survives that round trip differently would have failed the digest anyway.
 */
function contentBytes(content: { text?: string; blob?: string }, uri: string): Uint8Array {
  if (typeof content.text === "string") return textToBytes(content.text);
  if (typeof content.blob === "string") return base64ToBytes(content.blob);
  throw new SkillIntegrityError(
    "no_text_content",
    `Read of ${uri} returned neither text nor blob content.`,
    uri,
  );
}
