/**
 * Test MCP server implementing the DRAFT skills extension (SEP-2640).
 *
 * Written against the specification text at revision
 * 753b9f2be43e07fdd070e535d75f190cff14beea, not against any shipping server.
 * At the time of writing no public server implements these methods, so copying
 * an existing implementation would have encoded its gaps instead of the spec.
 *
 * Serves:
 * - `skills/list` — paginated skill entries with `{uri, digest, size}` resources
 * - `skills/get` — a single entry by URI, `-32602` when unknown
 * - `resources/directory/read` — directory navigation, gated on `directoryRead`
 * - `resources/read` — the underlying bytes, so digests can be verified
 *
 * Faults are injectable so tests can exercise the negative paths (digest drift,
 * size drift, frontmatter drift, unlisted reads, rotation) against a real
 * transport rather than a stub.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { SKILLS_EXTENSION_NAME, SKILLS_METHODS } from "../skills/sep2640/spec.js";

export interface SkillsFixtureFile {
  uri: string;
  text: string;
}

export interface SkillsFixtureSkill {
  /** Skill path, e.g. `skill://weather` — the SKILL.md sits underneath it. */
  base: string;
  /** SKILL.md source, frontmatter included. */
  document: string;
  /** Frontmatter as the server reports it, verbatim YAML-as-JSON. */
  frontmatter: Record<string, unknown>;
  /** Supporting files beyond SKILL.md. */
  files?: SkillsFixtureFile[];
  /** Advertise `"dynamic"` instead of an enumerated resource set. */
  dynamic?: boolean;
  /** Directories reported by `resources/directory/read`, keyed by directory URI. */
  directories?: Record<string, { uri: string; name: string; mimeType?: string }[]>;
}

export interface SkillsFixtureFaults {
  /** Publish a digest that does not match the served bytes. */
  digestDrift?: Set<string>;
  /** Publish a size that does not match the served bytes. */
  sizeDrift?: Set<string>;
  /** Report frontmatter that disagrees with the served SKILL.md. */
  frontmatterDrift?: Set<string>;
  /** Omit these URIs from the published resource set but still serve them. */
  unlisted?: Set<string>;
  /** Publish an uppercase digest, which the spec forbids. */
  uppercaseDigest?: Set<string>;
}

export interface SkillsFixtureOptions {
  name?: string;
  skills: SkillsFixtureSkill[];
  /** Declare the extension capability at all. Default true. */
  declareExtension?: boolean;
  /**
   * Tool names the fixture server exposes.
   *
   * A real server that publishes a skill referencing a tool also serves that
   * tool, and activation only reveals definitions that actually exist, so the
   * fixture has to serve them for the skill to reveal anything.
   *
   * Defaults to `["check_weather"]`, the tool the shared weather skill names.
   */
  tools?: string[];
  /** Declare `directoryRead` support. Default false. */
  directoryRead?: boolean;
  /** Page size for `skills/list`. Default: all entries in one page. */
  pageSize?: number;
  /** Freshness hints echoed on page 1 of `skills/list`. */
  ttlMs?: number;
  cacheScope?: string;
  faults?: SkillsFixtureFaults;
}

interface ResourceRef {
  uri: string;
  digest: string;
  size: number;
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

const digestOf = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * Mutable fixture handle.
 *
 * `rotate` replaces a skill's content after the server is running, which is how
 * tests reproduce the spec's "a later entry advertising a different resource
 * set revokes prior approval" requirement without reconnecting.
 */
export interface SkillsExtensionFixture {
  server: McpServer;
  rotate(base: string, next: Partial<SkillsFixtureSkill>): void;
  setFaults(faults: SkillsFixtureFaults): void;
}

export function createSkillsExtensionServer(options: SkillsFixtureOptions): SkillsExtensionFixture {
  const skills = options.skills.map((skill) => ({ ...skill }));
  let faults: SkillsFixtureFaults = options.faults ?? {};

  const server = new McpServer(
    { name: options.name ?? "test-skills-extension-server", version: "0.1.0" },
    { capabilities: { resources: {}, tools: {} } },
  );

  for (const toolName of options.tools ?? ["check_weather"]) {
    server.registerTool(
      toolName,
      {
        description: `Fixture tool ${toolName}`,
        inputSchema: { city: z.string().describe("City name") },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async ({ city }) => ({ content: [{ type: "text" as const, text: `${toolName}:${city}` }] }),
    );
  }

  if (options.declareExtension !== false) {
    server.server.registerCapabilities({
      extensions: {
        [SKILLS_EXTENSION_NAME]: options.directoryRead ? { directoryRead: true } : {},
      },
    });
  }

  const skillUri = (skill: SkillsFixtureSkill) => `${skill.base}/SKILL.md`;

  const filesOf = (skill: SkillsFixtureSkill): SkillsFixtureFile[] => [
    { uri: skillUri(skill), text: skill.document },
    ...(skill.files ?? []),
  ];

  const findFile = (uri: string): SkillsFixtureFile | undefined => {
    for (const skill of skills) {
      const hit = filesOf(skill).find((file) => file.uri === uri);
      if (hit) return hit;
    }
    return undefined;
  };

  const refFor = (file: SkillsFixtureFile): ResourceRef => {
    const bytes = utf8(file.text);
    let digest = digestOf(bytes);
    if (faults.digestDrift?.has(file.uri)) {
      digest = `sha256:${"0".repeat(64)}`;
    }
    if (faults.uppercaseDigest?.has(file.uri)) {
      digest = digest.toUpperCase().replace("SHA256:", "sha256:");
    }
    const size = faults.sizeDrift?.has(file.uri) ? bytes.length + 1 : bytes.length;
    return { uri: file.uri, digest, size };
  };

  const entryFor = (skill: SkillsFixtureSkill) => {
    const frontmatter = faults.frontmatterDrift?.has(skillUri(skill))
      ? { ...skill.frontmatter, description: "drifted description" }
      : skill.frontmatter;
    return {
      uri: skillUri(skill),
      frontmatter,
      resources: skill.dynamic
        ? ("dynamic" as const)
        : filesOf(skill)
            .filter((file) => !faults.unlisted?.has(file.uri))
            .map(refFor),
    };
  };

  server.server.setRequestHandler(
    SKILLS_METHODS.list,
    {
      params: z.looseObject({ cursor: z.string().optional() }),
      result: z.looseObject({}),
    },
    (params: { cursor?: string }) => {
      const pageSize = options.pageSize ?? skills.length;
      const start = params.cursor ? Number(params.cursor) : 0;
      const page = skills.slice(start, start + Math.max(pageSize, 1));
      const next = start + page.length;
      const firstPage = start === 0;
      return {
        resultType: "complete",
        skills: page.map(entryFor),
        ...(next < skills.length ? { nextCursor: String(next) } : {}),
        ...(firstPage && options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
        ...(firstPage && options.cacheScope !== undefined
          ? { cacheScope: options.cacheScope }
          : {}),
      };
    },
  );

  server.server.setRequestHandler(
    SKILLS_METHODS.get,
    { params: z.looseObject({ uri: z.string() }), result: z.looseObject({}) },
    (params: { uri: string }) => {
      const skill = skills.find((candidate) => skillUri(candidate) === params.uri);
      if (!skill) {
        throw new Error(`Unknown skill: ${params.uri}`);
      }
      return { skill: entryFor(skill) };
    },
  );

  // Registered only when the capability is declared. A server that answers
  // `resources/directory/read` it never advertised is lying on the wire, and a
  // fixture that does so cannot prove the client honours the declaration.
  if (options.declareExtension !== false && options.directoryRead) {
    server.server.setRequestHandler(
      SKILLS_METHODS.directoryRead,
      {
        params: z.looseObject({ uri: z.string(), cursor: z.string().optional() }),
        result: z.looseObject({}),
      },
      (params: { uri: string }) => {
        for (const skill of skills) {
          const entries = skill.directories?.[params.uri];
          if (entries) {
            return { resources: entries };
          }
        }
        throw new Error(`Not a directory: ${params.uri}`);
      },
    );
  }

  server.server.setRequestHandler(
    "resources/read",
    { params: z.looseObject({ uri: z.string() }), result: z.looseObject({}) },
    (params: { uri: string }) => {
      const file = findFile(params.uri);
      if (!file) {
        throw new Error(`Unknown resource: ${params.uri}`);
      }
      return {
        contents: [{ uri: file.uri, mimeType: "text/markdown", text: file.text }],
      };
    },
  );

  return {
    server,
    rotate(base, next) {
      const index = skills.findIndex((skill) => skill.base === base);
      if (index >= 0) {
        skills[index] = { ...skills[index], ...next } as SkillsFixtureSkill;
      }
    },
    setFaults(nextFaults) {
      faults = nextFaults;
    },
  };
}

/** Digest helper so tests can assert against the same bytes the server serves. */
export function fixtureDigest(text: string): string {
  return digestOf(utf8(text));
}
