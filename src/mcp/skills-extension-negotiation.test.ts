import { describe, it, expect, afterEach, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { McpClientManager } from "./client-manager.js";
import { McpPolicy } from "./policy.js";
import { isSkillsExtensionEnabled } from "./config.js";
import { createSkillsExtensionServer } from "../test-servers/skills-extension-server.js";
import { SKILLS_EXTENSION_NAME, skillsExtensionDiagnostic } from "../skills/sep2640/spec.js";

/**
 * SEP-2640 negotiation is default-on, and that is a deliberate reversal.
 *
 * Requiring `--mcp-skills-extension` made the out-of-the-box experience the
 * degraded one: a server could ship skills, declare the extension, and be met
 * with silence unless the user already knew a flag existed. Progressive
 * discovery is the product, not an experiment a user opts into.
 *
 * The safety that flag was standing in for is real, but it belongs somewhere
 * else. SEP-2640 is a draft, so what matters is (a) an operator can turn it
 * off explicitly, and (b) the draft status is stated wherever it is in use.
 * Neither requires making the good path opt-in.
 *
 * The invariant that does *not* relax: negotiation stays strictly per server.
 * Default-on decides whether we are willing to speak the extension at all; a
 * server that never declared it is still never spoken to in it.
 */
/**
 * The conjunction `src/index.ts` uses to pick a discovery contract: we asked,
 * and this particular server declared. Mirrored here so the per-server half
 * of the rule is asserted directly rather than inferred.
 */
function usesExtensionContract(manager: McpClientManager, serverName: string): boolean {
  return (
    manager.requestsSkillsExtension() &&
    manager.getExtensionCapability(serverName, SKILLS_EXTENSION_NAME) !== undefined
  );
}

describe("skills extension negotiation", () => {
  const servers: { close: () => Promise<void> }[] = [];
  const managers: McpClientManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.disconnectAll()));
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  describe("the configuration switch", () => {
    it("is on when nothing is configured", () => {
      expect(isSkillsExtensionEnabled({})).toBe(true);
      expect(isSkillsExtensionEnabled({ experimental: {} })).toBe(true);
    });

    it("is off only for an explicit false", () => {
      expect(isSkillsExtensionEnabled({ experimental: { skillsExtension: false } })).toBe(false);
      expect(isSkillsExtensionEnabled({ experimental: { skillsExtension: true } })).toBe(true);
      // Absent is not the same as off. This is the whole point of the
      // reversal, so it is pinned rather than left to `?? true` by accident.
      expect(isSkillsExtensionEnabled({ experimental: { skillsExtension: undefined } })).toBe(true);
    });
  });

  describe("the draft notice", () => {
    it("names the draft status and the way out", () => {
      const notice = skillsExtensionDiagnostic();
      expect(notice).toMatch(/draft/i);
      // An operator reading a log should not have to go looking for the
      // opt-out, because the draft status is the reason they would want it.
      expect(notice).toContain("--no-mcp-skills-extension");
    });
  });

  describe("per-server negotiation", () => {
    async function connect(options: {
      declareExtension: boolean;
      enabled: boolean;
    }): Promise<{ manager: McpClientManager; policy: McpPolicy }> {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const fixture = createSkillsExtensionServer({
        name: "sep-fixture",
        declareExtension: options.declareExtension,
        skills: [
          {
            base: "skill://fixture",
            document: "---\nname: fixture\ndescription: fixture skill\n---\n\n# fixture\n",
            frontmatter: { name: "fixture", description: "fixture skill" },
          },
        ],
      });
      await fixture.server.connect(serverTransport);
      servers.push({ close: () => fixture.server.close() });

      const manager = new McpClientManager({
        transportFactory: () => clientTransport,
        skillsExtension: options.enabled,
      });
      managers.push(manager);
      await manager.connectAll({
        mcpServers: {
          "sep-fixture": { type: "stdio", command: "node", args: ["fixture.js"] },
        },
      });
      return { manager, policy: new McpPolicy({ gateway: manager }) };
    }

    it("negotiates with a server that declares the extension", async () => {
      const { manager, policy } = await connect({ declareExtension: true, enabled: true });
      expect(manager.requestsSkillsExtension()).toBe(true);
      expect(policy.getSkillsExtension("sep-fixture")).toBeDefined();
    });

    it("stays silent toward a server that never declared it", async () => {
      // Default-on is about our willingness, never about presuming theirs.
      // A server that did not declare the extension must not see extension
      // methods, whatever our configuration says.
      const { policy } = await connect({ declareExtension: false, enabled: true });
      expect(policy.getSkillsExtension("sep-fixture")).toBeUndefined();

      await expect(policy.listMcpSkills("sep-fixture")).rejects.toThrow(
        new RegExp(SKILLS_EXTENSION_NAME.replace(/[/.]/g, "\\$&")),
      );
    });

    it("does not use the extension against a declaring server when opted out", async () => {
      const { manager } = await connect({ declareExtension: true, enabled: false });
      // The declaration is a fact about the server, and stays observable. It
      // is our side of the conjunction that closes: discovery picks the
      // extension contract only when we asked *and* they declared, so opting
      // out sends every server down the legacy skill:// scan.
      expect(manager.requestsSkillsExtension()).toBe(false);
      expect(usesExtensionContract(manager, "sep-fixture")).toBe(false);
    });

    it("uses the extension only where both sides agree", async () => {
      const declaring = await connect({ declareExtension: true, enabled: true });
      expect(usesExtensionContract(declaring.manager, "sep-fixture")).toBe(true);

      const silent = await connect({ declareExtension: false, enabled: true });
      expect(usesExtensionContract(silent.manager, "sep-fixture")).toBe(false);
    });

    it("does not advertise the extension in initialize when opted out", async () => {
      const requested = vi.fn();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const fixture = createSkillsExtensionServer({
        name: "sep-fixture",
        skills: [
          {
            base: "skill://fixture",
            document: "---\nname: fixture\ndescription: fixture skill\n---\n\n# fixture\n",
            frontmatter: { name: "fixture", description: "fixture skill" },
          },
        ],
      });
      fixture.server.server.oninitialized = () => requested();
      await fixture.server.connect(serverTransport);
      servers.push({ close: () => fixture.server.close() });

      const manager = new McpClientManager({
        transportFactory: () => clientTransport,
        skillsExtension: false,
      });
      managers.push(manager);
      await manager.connectAll({
        mcpServers: {
          "sep-fixture": { type: "stdio", command: "node", args: ["fixture.js"] },
        },
      });

      expect(requested).toHaveBeenCalled();
      expect(manager.requestsSkillsExtension()).toBe(false);
    });
  });
});
