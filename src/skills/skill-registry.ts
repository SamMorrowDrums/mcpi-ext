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
  /** Tool names this skill gates via allowed-tools frontmatter. */
  allowedTools: string[];
}

/**
 * Registry for MCP-discovered skills.
 *
 * Holds skill metadata discovered from MCP servers. Skills are registered
 * during MCP connection and looked up when the model invokes load_skill.
 */
export class SkillRegistry {
  private skills = new Map<string, McpSkillMetadata>();

  /** Register a skill. Overwrites any existing skill with the same name. */
  register(skill: McpSkillMetadata): void {
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
    return [...this.skills.values()];
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
  }

  /** Remove all skills. */
  clear(): void {
    this.skills.clear();
  }

  /** Number of registered skills. */
  get size(): number {
    return this.skills.size;
  }
}
