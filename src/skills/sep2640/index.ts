/**
 * Client for the **draft** MCP skills extension, SEP-2640.
 *
 * This is an unratified proposal. See {@link ./spec.ts} for the exact revision
 * this code was written against, and `docs/skills.md` for the negotiation,
 * integrity and fallback model.
 */
export {
  DIRECTORY_MIME_TYPE,
  HONOURED_CACHE_SCOPES,
  MAX_CACHE_TTL_MS,
  MAX_SKILL_LIST_PAGES,
  MAX_SKILL_RESOURCE_ENTRIES,
  MAX_SKILL_TOTAL_BYTES,
  SKILL_DIGEST_PATTERN,
  SKILLS_EXTENSION_NAME,
  SKILLS_EXTENSION_REVISION,
  SKILLS_EXTENSION_STATUS,
  SKILLS_METHODS,
  describeNegotiation,
  skillsExtensionDiagnostic,
} from "./spec.js";

export {
  declaredTotalBytes,
  DirectoryReadResultSchema,
  DirectoryResourceSchema,
  finalPathSegment,
  findResourceRef,
  frontmatterDescription,
  frontmatterName,
  isDirectoryResource,
  isValidDigest,
  resourceSetFingerprint,
  SkillEntrySchema,
  SkillResourceRefSchema,
  SkillsGetResultSchema,
  SkillsListResultSchema,
  skillPathOf,
  SkillValidationError,
  validateSkillEntry,
  type DirectoryReadResult,
  type DirectoryResource,
  type SkillEntry,
  type SkillResourceRef,
  type SkillsGetResult,
  type SkillsListResult,
  type SkillValidationCode,
} from "./protocol.js";

export {
  base64ToBytes,
  computeDigest,
  SkillIntegrityError,
  textToBytes,
  verifyBytes,
  verifyFrontmatter,
  verifyNamePath,
  verifyResourceRead,
  type IntegrityFailureCode,
} from "./integrity.js";

export {
  SkillsExtensionClient,
  type SkillsExtensionClientOptions,
  type SkillsListing,
} from "./client.js";

export { discoverSkillsViaExtension, type Sep2640DiscoveryResult } from "./discover.js";

export {
  loadSkillDocument,
  readSkillResource,
  SkillFetchBudget,
  type ReadSkillResourceOptions,
  type VerifiedResource,
} from "./load.js";
