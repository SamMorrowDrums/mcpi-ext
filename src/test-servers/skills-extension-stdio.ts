/**
 * stdio entrypoint for the SEP-2640 skills-extension fixture.
 * Run with: node dist/test-servers/skills-extension-stdio.js
 *
 * The factory takes options, so a plain module-level `server` export like the
 * weather fixture has cannot express the variants. This wrapper reads them from
 * the environment instead, letting one built file stand in for a server that
 * declares the extension, one that withholds it, and one that additionally
 * claims `directoryRead`.
 */
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createSkillsExtensionServer } from "./skills-extension-server.js";

const skillBody = `---
name: tarball-fixture
description: A skill served over the draft skills extension.
---

# Tarball fixture

This skill exists to prove an installed mcpi-ext can still complete a
SEP-2640 discovery and activation round trip.
`;

const { server } = createSkillsExtensionServer({
  declareExtension: process.env.FIXTURE_DECLARE_EXTENSION !== "false",
  directoryRead: process.env.FIXTURE_DIRECTORY_READ === "true",
  skills: [
    {
      base: "skill://tarball-fixture",
      frontmatter: {
        name: "tarball-fixture",
        description: "A skill served over the draft skills extension.",
      },
      document: skillBody,
    },
  ],
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("SEP-2640 skills fixture running on stdio");
