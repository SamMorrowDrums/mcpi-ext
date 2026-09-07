import type { McpPolicy } from "../../mcp/policy.js";
import {
  SkillValidationError,
  validateSkillEntry,
  type DirectoryReadResult,
  type DirectoryResource,
  type SkillEntry,
} from "./protocol.js";
import { HONOURED_CACHE_SCOPES, MAX_CACHE_TTL_MS, MAX_SKILL_LIST_PAGES } from "./spec.js";

/** What a listing pass observed, including why it may be incomplete. */
export interface SkillsListing {
  /** Entries that passed pre-fetch validation. */
  readonly skills: SkillEntry[];
  /**
   * Entries the server returned that this host refused to consider, with the
   * reason. Surfaced rather than silently dropped so a malformed skill is
   * visible instead of just missing.
   */
  readonly rejected: { readonly uri: string; readonly reason: string }[];
  /**
   * True when the server had more pages than this host was willing to walk.
   *
   * SEP-2640 forbids treating a listing as proof of what a server has; this
   * flag is how that uncertainty travels with the data instead of being
   * flattened into "these are the skills".
   */
  readonly truncated: boolean;
  /** Whether this listing came from the in-memory freshness cache. */
  readonly fromCache: boolean;
}

interface CacheEntry {
  readonly listing: SkillsListing;
  readonly expiresAt: number;
}

export interface SkillsExtensionClientOptions {
  readonly policy: McpPolicy;
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * A client for the draft SEP-2640 skills extension.
 *
 * Every request goes through {@link McpPolicy}, which re-checks the negotiated
 * capability immediately before dispatch. This class therefore never caches
 * "server X supports skills" — it caches only listing *content*, and only when
 * the server asked it to with terms this host is willing to honour.
 */
export class SkillsExtensionClient {
  private readonly policy: McpPolicy;
  private readonly now: () => number;
  private readonly listCache = new Map<string, CacheEntry>();

  constructor(options: SkillsExtensionClientOptions) {
    this.policy = options.policy;
    this.now = options.now ?? (() => Date.now());
  }

  /** True when the server declared the extension on the live connection. */
  supports(serverName: string): boolean {
    return this.policy.getSkillsExtension(serverName) !== undefined;
  }

  /** True when the server additionally declared `directoryRead: true`. */
  supportsDirectoryRead(serverName: string): boolean {
    return this.policy.supportsSkillDirectoryRead(serverName);
  }

  /** The declared extension settings, for diagnostics. */
  capability(serverName: string): Record<string, unknown> | undefined {
    return this.policy.getSkillsExtension(serverName);
  }

  /**
   * Walk `skills/list` to completion, validating each entry before it is
   * admitted.
   *
   * Pagination stops at {@link MAX_SKILL_LIST_PAGES}; the result is then marked
   * `truncated` rather than presented as the whole set. A server that returns
   * the same cursor twice is also treated as truncated, which stops a cursor
   * loop from becoming an unbounded request stream.
   */
  async listSkills(serverName: string, signal?: AbortSignal): Promise<SkillsListing> {
    const cached = this.readCache(serverName);
    if (cached) return cached;

    const skills: SkillEntry[] = [];
    const rejected: SkillsListing["rejected"] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let truncated = false;
    let ttlMs: number | undefined;
    let cacheScope: string | undefined;

    for (;;) {
      const result = await this.policy.listMcpSkills(serverName, cursor, signal);
      pages += 1;

      for (const entry of result.skills) {
        try {
          validateSkillEntry(entry);
          skills.push(entry);
        } catch (error) {
          if (!(error instanceof SkillValidationError)) throw error;
          rejected.push({ uri: entry.uri, reason: error.message });
        }
      }

      // Freshness hints from the first page govern the whole listing; a later
      // page cannot extend the lifetime of data already collected.
      if (pages === 1) {
        ttlMs = result.ttlMs;
        cacheScope = result.cacheScope;
      }

      const next = result.nextCursor;
      if (!next) break;
      if (seenCursors.has(next) || pages >= MAX_SKILL_LIST_PAGES) {
        truncated = true;
        break;
      }
      seenCursors.add(next);
      cursor = next;
    }

    const listing: SkillsListing = { skills, rejected, truncated, fromCache: false };
    this.writeCache(serverName, listing, ttlMs, cacheScope);
    return listing;
  }

  /**
   * Fetch one skill's authoritative entry with `skills/get`.
   *
   * Always goes to the server: `skills/get` is what re-establishes current
   * digests after a verification failure, so serving it from cache would defeat
   * the recovery path the spec defines.
   */
  async getSkill(serverName: string, uri: string, signal?: AbortSignal): Promise<SkillEntry> {
    const result = await this.policy.getMcpSkill(serverName, uri, signal);
    validateSkillEntry(result.skill);
    return result.skill;
  }

  /**
   * Enumerate a skill directory, when the server declared `directoryRead`.
   *
   * Directory listings are navigational only. Nothing they return becomes
   * readable: a file is readable because the skill entry lists it with a
   * digest, and a directory cannot add entries to that list.
   */
  async readDirectory(
    serverName: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<DirectoryResource[]> {
    const resources: DirectoryResource[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    for (;;) {
      const result: DirectoryReadResult = await this.policy.readSkillDirectory(
        serverName,
        uri,
        cursor,
        signal,
      );
      pages += 1;
      resources.push(...result.resources);

      const next = result.nextCursor;
      if (!next || seenCursors.has(next) || pages >= MAX_SKILL_LIST_PAGES) break;
      seenCursors.add(next);
      cursor = next;
    }

    return resources;
  }

  /** Drop cached listings; call on disconnect or reset. */
  clearCache(serverName?: string): void {
    if (serverName === undefined) {
      this.listCache.clear();
      return;
    }
    this.listCache.delete(serverName);
  }

  private readCache(serverName: string): SkillsListing | undefined {
    const entry = this.listCache.get(serverName);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.listCache.delete(serverName);
      return undefined;
    }
    return { ...entry.listing, fromCache: true };
  }

  /**
   * Cache a listing only when the server asked for it in terms this host
   * understands.
   *
   * `cacheScope`'s value set is defined by SEP-2549, not SEP-2640, so an
   * unrecognised scope is treated as "do not cache" rather than guessed at. A
   * truncated listing is never cached, because caching an incomplete answer is
   * exactly the "empty listing means no skills" mistake the spec warns against,
   * just with a longer lifetime.
   */
  private writeCache(
    serverName: string,
    listing: SkillsListing,
    ttlMs: number | undefined,
    cacheScope: string | undefined,
  ): void {
    if (listing.truncated) return;
    if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) return;
    if (cacheScope === undefined || !HONOURED_CACHE_SCOPES.has(cacheScope)) return;

    const lifetime = Math.min(ttlMs, MAX_CACHE_TTL_MS);
    this.listCache.set(serverName, { listing, expiresAt: this.now() + lifetime });
  }
}
