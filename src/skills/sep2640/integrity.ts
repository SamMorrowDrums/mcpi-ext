/**
 * SEP-2640 content verification.
 *
 * Everything a server hands back crosses this module before it is used. The
 * proposal is explicit that digests are *not* a security boundary — the same
 * party authors both the listing and the content, so a digest proves only that
 * the two agree. That is still worth enforcing: it is what makes silent
 * substitution, truncation, and listing/content drift detectable, and it is what
 * lets an approval be bound to exact bytes rather than to a name.
 *
 * Three independent checks apply to every retrieved file:
 *   1. byte length equals the declared `size`;
 *   2. SHA-256 over the raw bytes equals the declared `digest`;
 *   3. for SKILL.md only, the frontmatter reparsed from those bytes matches the
 *      listing's `frontmatter` field-by-field.
 *
 * A failure in any of them means the content MUST NOT be used.
 */
import { parseFrontmatter } from "@sammorrowdrums/mcpi";
import { createHash } from "node:crypto";
import {
  findResourceRef,
  frontmatterName,
  isValidDigest,
  skillPathOf,
  finalPathSegment,
  type SkillEntry,
  type SkillResourceRef,
} from "./protocol.js";
import { MAX_SKILL_TOTAL_BYTES } from "./spec.js";

export type IntegrityFailureCode =
  | "resource_not_listed"
  | "size_mismatch"
  | "digest_mismatch"
  | "malformed_digest"
  | "frontmatter_mismatch"
  | "name_path_mismatch"
  | "dynamic_budget_exceeded"
  | "no_text_content";

/** A refusal to use retrieved content. Distinct from a transport or policy error. */
export class SkillIntegrityError extends Error {
  readonly code: IntegrityFailureCode;
  readonly uri: string;

  constructor(code: IntegrityFailureCode, message: string, uri: string) {
    super(message);
    this.name = "SkillIntegrityError";
    this.code = code;
    this.uri = uri;
  }
}

/** SHA-256 over raw bytes, formatted the way SEP-2640 writes digests. */
export function computeDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * The exact bytes a digest covers.
 *
 * MCP text resources arrive as a JS string; the digest is over the file's raw
 * bytes, so the string is encoded back to UTF-8 — the encoding MCP uses on the
 * wire — before hashing. Binary resources arrive base64-encoded and are decoded
 * instead. Getting this wrong would make every digest comparison meaningless,
 * which is why it is one function used by every caller.
 */
export function textToBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

export function base64ToBytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

/**
 * Verify retrieved bytes against a declared resource reference.
 *
 * Size is checked first and treated as a verification failure in its own right,
 * exactly like a digest mismatch — a wrong length already proves the bytes are
 * not the declared file, and saying so names the cheaper, more legible failure.
 */
export function verifyBytes(ref: SkillResourceRef, bytes: Uint8Array): void {
  if (!isValidDigest(ref.digest)) {
    throw new SkillIntegrityError(
      "malformed_digest",
      `Resource ${ref.uri} declares a non-conforming digest "${ref.digest}"; content was discarded unverified.`,
      ref.uri,
    );
  }

  if (bytes.byteLength !== ref.size) {
    throw new SkillIntegrityError(
      "size_mismatch",
      `Resource ${ref.uri} was declared as ${ref.size} bytes but ${bytes.byteLength} bytes were returned. ` +
        `The content does not match the listing and was discarded.`,
      ref.uri,
    );
  }

  const actual = computeDigest(bytes);
  if (actual !== ref.digest) {
    throw new SkillIntegrityError(
      "digest_mismatch",
      `Resource ${ref.uri} hashed to ${actual} but the listing declared ${ref.digest}. ` +
        `The content does not match the listing and was discarded.`,
      ref.uri,
    );
  }
}

/**
 * Authorize and verify one retrieved file against its skill entry.
 *
 * A URI absent from the entry's `resources` is a verification failure, not a
 * permissive default: SEP-2640 requires reads to resolve only to listed URIs,
 * so an unlisted file is refused even though the server volunteered it.
 *
 * For `"dynamic"` sets there is nothing to compare against, so the only
 * enforceable constraint is the 16 MiB ceiling applied to what is actually
 * retrieved. `retrievedBytesSoFar` carries the running total for the skill.
 */
export function verifyResourceRead(
  entry: SkillEntry,
  uri: string,
  bytes: Uint8Array,
  retrievedBytesSoFar = 0,
): void {
  const ref = findResourceRef(entry, uri);

  if (ref === undefined) {
    throw new SkillIntegrityError(
      "resource_not_listed",
      `Resource ${uri} is not listed in skill ${entry.uri}'s resources, so there is no digest to verify it ` +
        `against. Reads must resolve only to listed URIs.`,
      uri,
    );
  }

  if (ref === "dynamic") {
    const total = retrievedBytesSoFar + bytes.byteLength;
    if (total > MAX_SKILL_TOTAL_BYTES) {
      throw new SkillIntegrityError(
        "dynamic_budget_exceeded",
        `Skill ${entry.uri} declares a dynamic resource set and has now retrieved ${total} bytes, above the ` +
          `SEP-2640 ceiling of ${MAX_SKILL_TOTAL_BYTES} bytes (16 MiB).`,
        uri,
      );
    }
    return;
  }

  verifyBytes(ref, bytes);
}

/**
 * Reparse SKILL.md's own frontmatter and compare it field-by-field with the
 * listing's `frontmatter`.
 *
 * The listing and the file are two independent claims about the same thing;
 * this is what stops a server advertising a benign description and a benign
 * tool grant while shipping a file that says something else. Comparison is
 * exact and symmetric — a field present in one and absent from the other is a
 * mismatch, and so is a differing value.
 */
export function verifyFrontmatter(entry: SkillEntry, skillMarkdown: string): void {
  const parsed = parseFrontmatter(skillMarkdown);
  const actual = parsed.frontmatter;
  const declared = entry.frontmatter;

  const keys = new Set([...Object.keys(declared), ...Object.keys(actual)]);
  const differences: string[] = [];

  for (const key of [...keys].sort()) {
    const inDeclared = Object.hasOwn(declared, key);
    const inActual = Object.hasOwn(actual, key);

    if (!inActual) {
      differences.push(`"${key}" was advertised in the listing but is absent from SKILL.md`);
      continue;
    }
    if (!inDeclared) {
      differences.push(`"${key}" is present in SKILL.md but was not advertised in the listing`);
      continue;
    }
    if (!deepEqual(declared[key], actual[key])) {
      differences.push(
        `"${key}" differs: listing has ${preview(declared[key])}, SKILL.md has ${preview(actual[key])}`,
      );
    }
  }

  if (differences.length > 0) {
    throw new SkillIntegrityError(
      "frontmatter_mismatch",
      `Skill ${entry.uri} was not loaded: its SKILL.md frontmatter does not match the listing. ` +
        differences.join("; "),
      entry.uri,
    );
  }
}

/**
 * Re-check the name/path agreement against the *parsed file*, not just the
 * listing. `validateSkillEntry` already checked the listing's copy; this closes
 * the case where the two disagree about which one the path is supposed to match.
 */
export function verifyNamePath(entry: SkillEntry): void {
  const name = frontmatterName(entry);
  const skillPath = skillPathOf(entry.uri);
  if (name === undefined || skillPath === undefined || finalPathSegment(skillPath) !== name) {
    throw new SkillIntegrityError(
      "name_path_mismatch",
      `Skill ${entry.uri} does not agree with its declared name "${name ?? "(none)"}".`,
      entry.uri,
    );
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }

  if (typeof left === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    if (!leftKeys.every((key, index) => key === rightKeys[index])) return false;
    return leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
  }

  return false;
}

function preview(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = "(unserializable)";
  }
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}
