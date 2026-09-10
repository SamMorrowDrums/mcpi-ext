/** Metadata for a skill discovered from an MCP server. */
export interface McpSkillMetadata {
  /** Skill name from SKILL.md frontmatter. */
  name: string;
  /** Short description from SKILL.md frontmatter. */
  description: string;
  /** The skill:// URI for the SKILL.md resource. */
  uri: string;
  /** Which MCP server this skill came from. */
  serverName: string;
  /**
   * Tool definitions this skill references via its frontmatter.
   *
   * These names decide which deferred tool *schemas* activating the skill
   * reveals to the model. They are not an authorization list: a tool named here
   * is no more callable than one that is not, and every surface can already
   * dispatch both subject to the server's own annotations.
   */
  referencedTools: string[];
  /**
   * Which contract this skill was discovered over.
   *
   * `"sep2640"` skills were negotiated through the draft skills extension and
   * carry verifiable digests; `"legacy"` skills came from plain `skill://`
   * resource listing and have no integrity metadata at all. Loading code needs
   * to tell them apart because only the former can be verified.
   *
   * Absent means legacy, so existing callers keep working unchanged.
   */
  origin?: "sep2640" | "legacy";
  /**
   * Digest of the skill's declared resource set, when known.
   *
   * SEP-2640 makes activation content-bound: if a later listing advertises a
   * different resource set, the definitions that activate come from the new
   * listing rather than the old one. This value is what the policy hashes into
   * the activation key to make that happen.
   */
  contentFingerprint?: string;
}

/**
 * Registry for MCP-discovered skills.
 *
 * Holds skill metadata discovered from MCP servers. Skills are registered
 * during MCP connection and looked up when the model invokes load_skill.
 *
 * Names live in a per-origin namespace. Re-registering the same skill (same
 * server and URI) replaces it, but a *different* origin claiming an
 * already-taken name never silently wins: the newcomer is kept under a
 * server-qualified name so both stay reachable. SEP-2640 requires collisions to
 * be disambiguated rather than dropped or preferred.
 */
export class SkillRegistry {
  private skills = new Map<string, McpSkillMetadata>();
  private collisions: SkillNameCollision[] = [];

  /**
   * Register a skill.
   *
   * Replaces an entry from the same origin. On a cross-origin name collision
   * the incumbent keeps the bare name and this skill is stored under
   * `<serverName>/<name>`; the collision is recorded for reporting.
   */
  register(skill: McpSkillMetadata): void {
    const existing = this.skills.get(skill.name);
    if (existing && !isSameOrigin(existing, skill)) {
      const qualified = qualifiedName(skill);
      this.collisions.push({
        name: skill.name,
        incumbent: { serverName: existing.serverName, uri: existing.uri },
        challenger: { serverName: skill.serverName, uri: skill.uri },
        registeredAs: qualified,
      });
      this.skills.set(qualified, { ...skill, name: qualified });
      return;
    }
    this.skills.set(skill.name, skill);
  }

  /** Register multiple skills at once. */
  registerAll(skills: McpSkillMetadata[]): void {
    for (const skill of skills) {
      this.register(skill);
    }
  }

  /** Get a skill by name. */
  get(name: string): McpSkillMetadata | undefined {
    return this.skills.get(name);
  }

  /** Get all registered skills. */
  getAll(): McpSkillMetadata[] {
    return [...this.skills.values()].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  }

  /** Name collisions resolved by qualification, oldest first. */
  getCollisions(): SkillNameCollision[] {
    return [...this.collisions];
  }

  /** Remove a skill by name. */
  unregister(name: string): boolean {
    return this.skills.delete(name);
  }

  /** Remove all skills from a specific MCP server. */
  unregisterByServer(serverName: string): void {
    for (const [name, skill] of this.skills) {
      if (skill.serverName === serverName) {
        this.skills.delete(name);
      }
    }
    this.collisions = this.collisions.filter(
      (collision) =>
        collision.incumbent.serverName !== serverName &&
        collision.challenger.serverName !== serverName,
    );
  }

  /** Remove all skills. */
  clear(): void {
    this.skills.clear();
    this.collisions = [];
  }

  /** Number of registered skills. */
  get size(): number {
    return this.skills.size;
  }
}

/** A name claimed by two different origins, and how it was resolved. */
export interface SkillNameCollision {
  readonly name: string;
  readonly incumbent: { readonly serverName: string; readonly uri: string };
  readonly challenger: { readonly serverName: string; readonly uri: string };
  readonly registeredAs: string;
}

function isSameOrigin(left: McpSkillMetadata, right: McpSkillMetadata): boolean {
  return left.serverName === right.serverName && left.uri === right.uri;
}

function qualifiedName(skill: McpSkillMetadata): string {
  return `${skill.serverName}/${skill.name}`;
}
