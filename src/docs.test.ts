import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Published-documentation contract.
 *
 * The README is the page npm renders and the first thing a new user follows. A
 * stale command there is not a cosmetic defect: it sends someone to a registry
 * tag that does not exist, or tells them to put a live credential somewhere it
 * should never go. npm versions are immutable, so a README shipped wrong stays
 * wrong for that version forever.
 *
 * These tests pin the claims that were actually verified against the published
 * packages and a real server, and reject the specific stale strings that were
 * found in the wild.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
  peerDependencies: Record<string, string>;
  dependencies: Record<string, string>;
  engines: { node: string };
  pi: { extensions: string[] };
};

const docsDir = join(root, "docs");
const docFiles = readdirSync(docsDir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ name: `docs/${f}`, body: readFileSync(join(docsDir, f), "utf8") }));
const publicDocs = [{ name: "README.md", body: readme }, ...docFiles];

/** Docs a new user reads. Contributor guidance is allowed to go deeper. */
const userFacingDocs = publicDocs.filter((d) => d.name !== "docs/server-developer-guide.md");

describe("stale strings never return", () => {
  // Each of these was live in published documentation and each one broke a real
  // step: a dead image tag, a dead link, a superseded proposal, persona prose.
  const banned: { pattern: RegExp; why: string }[] = [
    {
      pattern: /experimental-ext-grouping/,
      why: "superseded by SEP-2640; cite modelcontextprotocol#2640 instead",
    },
    {
      pattern: /progressive-tool-discovery\.md/,
      why: "that mcpi doc does not exist (the mcpi repo has no docs/ directory) and 404s",
    },
    { pattern: /Skill Dealer|Nuclear Football|Codey|Sandman/i, why: "persona framing" },
    { pattern: /Tier [123]\b/, why: "tier numbering implies a routing order that does not exist" },
  ];

  for (const doc of publicDocs) {
    for (const { pattern, why } of banned) {
      it(`${doc.name} contains no ${pattern.source} (${why})`, () => {
        expect(doc.body).not.toMatch(pattern);
      });
    }
  }

  // `skill-discovery` is also a legitimate audit source name, so it cannot be
  // banned outright. What must never come back is the dead *image tag*, and
  // prose may still name it to help someone migrating off the old README.
  for (const doc of publicDocs) {
    it(`${doc.name} never uses the dead skill-discovery image tag in an example`, () => {
      for (const block of doc.body.match(/```(?:json|sh|bash)\n[\s\S]*?```/g) ?? []) {
        expect(
          /github-mcp-server:skill-discovery/.test(block),
          `${doc.name} has a runnable example pulling a tag that does not exist`,
        ).toBe(false);
      }
    });
  }

  it("README warns that the skill-discovery tag does not exist", () => {
    expect(readme).toMatch(/`skill-discovery` tag[\s\S]{0,120}does not exist/);
  });
});

describe("quick start install flow", () => {
  it("pins the audited versions of every package a user installs", () => {
    // Derived, not literal: a hard-coded version here would silently drift away from the
    // peer range and let the README recommend a host the package refuses to run on.
    const floor = /^>=\s*([\d.]+)/.exec(pkg.peerDependencies["@sammorrowdrums/mcpi"])?.[1] ?? "";
    expect(floor).toBeTruthy();
    expect(readme).toContain(`npm install -g @sammorrowdrums/mcpi@${floor}`);
    expect(readme).toContain("@sammorrowdrums/tool-cli@1.0.2");
    expect(readme).toContain(`npm:@sammorrowdrums/mcpi-ext@${pkg.version}`);
  });

  it("explains why the host floor moved rather than just asserting it", () => {
    // The floor is not cosmetic. Below it, deferral and activation both silently
    // no-op, so a reader who treats the range as advisory gets a broken install.
    const floorParagraph = readme.slice(readme.indexOf("The floor is"), readme.indexOf("### 1."));
    expect(floorParagraph).toMatch(/registration-time `deferred`/);
    expect(floorParagraph).toMatch(/addedToolNames/);
  });

  it("offers @latest as the alternative to the pinned set", () => {
    expect(readme).toContain("@sammorrowdrums/mcpi@latest");
    expect(readme).toContain("@sammorrowdrums/tool-cli@latest");
  });

  it("installs the extension through mcpi rather than a global --extension path", () => {
    const installIndex = readme.indexOf("mcpi install npm:@sammorrowdrums/mcpi-ext");
    expect(installIndex).toBeGreaterThan(-1);

    // The old README led with this, which bypasses settings and cannot be updated
    // by `mcpi update`. It may only appear later, for local development.
    expect(readme).not.toContain("--extension $(npm root -g)");
    const localDevIndex = readme.indexOf("--extension ./dist/index.js");
    if (localDevIndex !== -1) {
      expect(localDevIndex).toBeGreaterThan(installIndex);
    }
  });

  it("tells the user to verify the install with mcpi list", () => {
    expect(readme).toContain("mcpi list");
  });

  it("declares the compiled entry point for managed package discovery", () => {
    expect(pkg.pi.extensions).toEqual(["./dist/index.js"]);
  });

  it("keeps the #quick-start anchor other repositories link to", () => {
    // tool-cli and mcpi link here directly; renaming this heading breaks them.
    expect(readme).toMatch(/^## Quick start$/m);
  });

  it("documents the extension-registered flags by their real names", () => {
    const index = readFileSync(join(root, "src/index.ts"), "utf8");
    for (const flag of ["mcp-config", "no-mcp-skills-extension"]) {
      expect(index).toContain(`pi.registerFlag("${flag}"`);
      expect(readme).toContain(`--${flag}`);
    }
  });

  it("does not tell the user to pass the deprecated opt-in", () => {
    // `--mcp-skills-extension` still registers as a no-op so an existing
    // command line does not fail, but documenting it would teach the opt-in
    // the correction removed. It must survive without being advertised.
    const index = readFileSync(join(root, "src/index.ts"), "utf8");
    expect(index).toContain(`pi.registerFlag("mcp-skills-extension"`);
    expect(readme).not.toMatch(/(?<!no-)-{2}mcp-skills-extension/);
  });

  it("explains /login for provider authentication", () => {
    expect(readme).toContain("/login");
  });

  it("documents the legacy path migration that blocks mcpi startup", () => {
    // mcpi >=0.85 refuses to start while ~/.pi/agent exists. A user upgrading
    // from pi hits this before anything else in the Quick Start works.
    expect(readme).toContain("~/.pi/agent");
    expect(readme).toContain("~/.local/state/mcpi");
    expect(readme).toContain("MCPI_CODING_AGENT_DIR");
  });
});

describe("credential handling", () => {
  // Verified: MCP stdio children inherit only the SDK's safe set plus explicit
  // config, and mcp.json performs no variable expansion. Any doc implying
  // otherwise sends the user to a server that silently has no credentials.
  it("never shows a literal token value inside a JSON config block", () => {
    for (const doc of publicDocs) {
      for (const block of doc.body.match(/```json\n[\s\S]*?```/g) ?? []) {
        expect(
          /"(GITHUB_PERSONAL_ACCESS_TOKEN|GITHUB_TOKEN)"\s*:\s*"(?!\.\.\.")\S+"/.test(block),
          `${doc.name} puts a token value in a JSON config block`,
        ).toBe(false);
        expect(
          /gh[pousr]_[A-Za-z0-9]{8}/.test(block),
          `${doc.name} contains something shaped like a real PAT`,
        ).toBe(false);
      }
    }
  });

  it("never suggests ${VAR} expansion in an MCP config, which is not supported", () => {
    for (const doc of publicDocs) {
      for (const block of doc.body.match(/```json\n[\s\S]*?```/g) ?? []) {
        expect(/\$\{[A-Za-z_]/.test(block), `${doc.name} implies mcp.json expands variables`).toBe(
          false,
        );
      }
    }
  });

  it("uses an absolute --env-file path, since args are not shell-expanded", () => {
    expect(readme).toContain("--env-file");
    const envFileLine = readme
      .split("\n")
      .find((line) => line.includes(".env") && line.includes("/") && line.trim().startsWith('"'));
    expect(envFileLine?.trim()).toMatch(/^"\//);
  });

  it("shows how to create the env file with restrictive permissions", () => {
    expect(readme).toContain("chmod 600");
    expect(readme).toMatch(/umask 077/);
  });

  it("states that a shell-exported token is not inherited", () => {
    expect(readme).toMatch(/never reaches the server|do not inherit your shell environment/);
    for (const name of ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]) {
      expect(readme).toContain(name);
    }
  });

  it("does not instruct the user to export a token as the way to supply it", () => {
    for (const doc of userFacingDocs) {
      expect(
        /^\s*export\s+(GITHUB_PERSONAL_ACCESS_TOKEN|GITHUB_TOKEN)=/m.test(doc.body),
        `${doc.name} tells the user to export a token, which stdio servers never receive`,
      ).toBe(false);
    }
  });
});

describe("server support claims", () => {
  it("uses an image tag that is actually published", () => {
    // Published tags at time of audit: latest, main, nightly, v0.1.0(+rc).
    const tags = readme.match(/ghcr\.io\/github\/github-mcp-server:([\w.-]+)/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag).toBe("ghcr.io/github/github-mcp-server:latest");
    }
  });

  it("keeps the trailing stdio argument that :latest requires", () => {
    // :latest has an entrypoint and takes `stdio` as its argument. (:v0.1.0 has
    // no entrypoint and already includes stdio in CMD, so it must not be passed.)
    expect(readme).toMatch(/"ghcr\.io\/github\/github-mcp-server:latest",\s*\n\s*"stdio"/);
  });

  it("does not claim the official server provides skills", () => {
    expect(readme).toContain("io.modelcontextprotocol/skills");
    expect(readme).toMatch(
      /does \*\*not\*\* declare|publishes none today|contributes \*\*no skills\*\*/,
    );
  });

  it("does not point users at the non-public reference server", () => {
    for (const doc of publicDocs) {
      expect(doc.body).not.toMatch(/9e7f9f88800b6a585d6e4cd503e6639222e624b6/);
      expect(doc.body).not.toMatch(/copilot-worktrees|\/home\/[a-z]+\/\.copilot/);
    }
  });

  it("cites the authoritative SEP-2640 pull request", () => {
    expect(readme).toContain("modelcontextprotocol/modelcontextprotocol/pull/2640");
  });

  it("pins the same SEP-2640 revision the client implements", () => {
    const spec = readFileSync(join(root, "src/skills/sep2640/spec.ts"), "utf8");
    const revision = /SKILLS_EXTENSION_REVISION = "([0-9a-f]+)"/.exec(spec)?.[1] ?? "";
    expect(revision).toBeTruthy();
    expect(readme).toContain(revision);
  });

  it("describes the skills extension as a draft that is negotiated by default", () => {
    expect(readme).toMatch(/Draft/);
    expect(readme).toMatch(/on by default/i);
    expect(readme).toContain("--no-mcp-skills-extension");
  });

  it("no longer claims the extension is off or opt-in", () => {
    // The whole point of the change: a server that advertises skills is asked
    // about them. Leaving the old sentence anywhere would send a reader
    // looking for a flag that no longer gates anything.
    expect(readme).not.toMatch(/gated \*\*off\*\*|off by default/i);
    expect(readme).not.toMatch(/skills extension is \*\*opt-in\*\*/i);
  });
});

describe("advanced local-image guidance stays local and stays out of the quick start", () => {
  // A contributor with a compatible checkout can build the reference server
  // themselves. That is legitimate, but it must never read as "a custom image
  // exists somewhere you can pull", because none does.
  const guide = docFiles.find((d) => d.name === "docs/server-developer-guide.md");
  const guideBody = guide?.body ?? "";
  const localImageTag = "github-mcp-server-experimental:local";

  it("keeps the local build example in the contributor guide", () => {
    expect(guide, "server-developer-guide.md is missing").toBeDefined();
    expect(guideBody).toContain(`docker build -t ${localImageTag} .`);
    expect(guideBody).toContain(localImageTag);
  });

  it("keeps the local build example out of the official-server quick start", () => {
    // The quick start runs from its heading to the next top-level section.
    const quickStart = /## Quick start([\s\S]*?)\n## /.exec(readme)?.[1] ?? "";
    expect(quickStart).toBeTruthy();
    expect(quickStart).not.toContain("docker build");
    expect(quickStart).not.toContain("experimental");
    expect(quickStart).not.toContain("GITHUB_FEATURES");
    // The quick start still configures the official published image.
    expect(quickStart).toContain("ghcr.io/github/github-mcp-server:latest");
  });

  it("never presents the custom image as a remote registry artifact", () => {
    for (const doc of publicDocs) {
      // No registry host may be prefixed onto the experimental image name.
      expect(doc.body, `${doc.name} advertises a remote custom image`).not.toMatch(
        /[\w.-]+\.[a-z]{2,}\/[\w./-]*github-mcp-server-experimental/,
      );
      expect(doc.body).not.toMatch(/docker pull[^\n]*experimental/);
      // The experimental image, wherever named, carries the :local tag.
      const experimentalRefs = doc.body.match(/github-mcp-server-experimental:[\w.-]+/g) ?? [];
      for (const ref of experimentalRefs) {
        expect(ref, `${doc.name} tags the custom image non-locally`).toBe(localImageTag);
      }
    }
  });

  it("states the reference build is local-only and not publicly distributed", () => {
    expect(readme).toMatch(/local-only/);
    expect(readme).toMatch(/not \*\*a public distribution\*\*|\*\*not a public distribution\*\*/);
    expect(readme).toMatch(/GHCR|MCP Registry/);
    expect(guideBody).toMatch(/local-only/);
    // No claim that the exact source can be obtained.
    expect(readme).toMatch(/no branch or SHA/i);
  });

  it("supplies credentials to the local image the same secure way", () => {
    const jsonBlocks = [...guideBody.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
    const block = jsonBlocks.find((b) => b.includes("github-mcp-server-experimental"));
    expect(block, "local image config block is missing").toBeTruthy();
    expect(block).toContain('"--env-file"');
    // Absolute path, because args are not shell-expanded.
    expect(block).toMatch(/"\/[^"]*github-mcp\.env"/);
    expect(block).not.toMatch(/~\/|\$HOME/);
    // No credential inline, and no token smuggled in as a -e pair.
    expect(block).not.toMatch(/gh[pousr]_[A-Za-z0-9]/);
    expect(block).not.toMatch(/(TOKEN|PAT|SECRET|PASSWORD)\s*=\s*\S/i);
  });

  it("enables the draft feature flag only in the contributor guide", () => {
    expect(guideBody).toContain("GITHUB_FEATURES=skills_extension_draft");
    for (const doc of userFacingDocs) {
      expect(doc.body, `${doc.name} leaks the server feature flag`).not.toContain(
        "GITHUB_FEATURES",
      );
    }
  });
});

describe("mechanisms, facilities, and degradation", () => {
  it("names the real tool call for each of the three mechanisms", () => {
    for (const call of ["load_skill", "code_execute", "code_search"]) {
      expect(readme).toContain(call);
    }
    // tool-cli is a program run through bash, never a registered tool.
    expect(readme).toMatch(/through mcpi's bash tool|through the host bash tool/);
    expect(readme).toMatch(/no `tool-cli` entry in the\s*\n?agent's tool registry/);
  });

  it("distinguishes four facilities from three MCP mechanisms", () => {
    expect(readme).toMatch(/## Four facilities, three MCP mechanisms/);
    expect(readme).toMatch(/substrate/);
  });

  it("keeps the facility list free of ranking language", () => {
    expect(readme).toMatch(/task shape, not by rank|None is a default/);
  });

  it("documents zero-server behaviour", () => {
    expect(readme).toMatch(/zero MCP servers/);
  });

  it("documents isolated-vm as optional with graceful degradation", () => {
    expect(readme).toContain("isolated-vm");
    expect(readme).toContain("--omit=optional");
    expect(readme).toMatch(/never falls back to `node:vm`/);
    // It must stay optional in the manifest for that claim to hold.
    expect(pkg.dependencies["isolated-vm"]).toBeUndefined();
  });

  it("states the security posture: HITL and no host execution from skills", () => {
    expect(readme).toMatch(/Nothing in a skill is executed/);
    // Confirmation is driven by annotations at execution, on every surface.
    expect(readme).toMatch(/gates\s+non-read-only calls through user confirmation/i);
    expect(readme).toMatch(/only at execution/i);
  });

  it("does not claim code mode refuses writes instead of asking", () => {
    // The corrected behaviour: a write from the sandbox pauses at the same
    // prompt any other surface raises. The old sentence described a policy
    // that took the decision away from the user, and it must not survive
    // anywhere in the published docs.
    for (const { name, body } of docFiles) {
      expect(body, `${name} still says code mode refuses rather than prompts`).not.toMatch(
        /refused, not prompted|dispatch-refused|denied\s+outright rather than escalated/i,
      );
    }
    expect(readme).toMatch(/pauses mid-script|asks rather than refusing/i);
  });

  it("does not describe skill exposure as an authorization grant", () => {
    // `allowed-tools` is an exposure list. Calling it a grant, or saying tools
    // are locked or inert until approval, is the precise error the correction
    // removes: it makes visibility look like permission.
    for (const { name, body } of docFiles) {
      expect(body, `${name} still describes skill loading as granting permission`).not.toMatch(
        /inert until (the user|you) (explicitly )?approve|stay locked until you approve|approve the skill's tool grant/i,
      );
    }
  });

  it("does not tell the agent to prefer skills over the other facilities", () => {
    // Routing is by task shape. A tool being available is not a reason to load
    // a skill, and any sentence that says otherwise thumbs the scale. The
    // patterns match directives only, so documenting the removed gate's own
    // error text does not count as issuing one.
    const skillFirst = [
      /call load_skill even if/i,
      /always (call|load|use) (the )?skill/i,
      /\b(try|prefer|use|reach for|check) (the )?skills? (first|before)\b/i,
      /skills? (should|must) be (tried|loaded|used) first/i,
      /proactively (call|load) (the )?skill/i,
    ];
    for (const { name, body } of docFiles) {
      for (const pattern of skillFirst) {
        expect(body, `${name} contains skill-first routing language`).not.toMatch(pattern);
      }
    }
  });

  it("describes tool-cli bridge credentials as session-scoped", () => {
    expect(readme).toContain("TOOL_CLI_PORT");
    expect(readme).toContain("TOOL_CLI_TOKEN");
    expect(readme).toMatch(/session_shutdown|session-scoped/);
  });
});

describe("versions and environment match the manifest", () => {
  it("states the Node floor from package.json engines", () => {
    const floor = pkg.engines.node.replace(/^>=/, "");
    expect(readme).toContain(floor);
    expect(readme).toMatch(/Node 22 and 24/);
  });

  it("states the mcpi peer floor the package actually declares", () => {
    const range = pkg.peerDependencies["@sammorrowdrums/mcpi"];
    const floor = /^>=\s*([\d.]+)/.exec(range)?.[1];
    expect(floor).toBeTruthy();
    expect(readme).toContain(`@sammorrowdrums/mcpi@${floor}`);
  });

  it("advertises a tool-cli version its dependency range accepts", () => {
    const range = pkg.dependencies["@sammorrowdrums/tool-cli"];
    const advertised = /@sammorrowdrums\/tool-cli@(\d+\.\d+\.\d+)/.exec(readme)?.[1] ?? "";
    expect(advertised).toBeTruthy();
    const [, minor, patch] = advertised.split(".").map(Number);
    const [rMinor, rPatch] = range.replace(/^\^/, "").split(".").slice(1).map(Number);
    expect(range.startsWith("^1.")).toBe(true);
    expect(minor > rMinor || (minor === rMinor && patch >= rPatch)).toBe(true);
  });

  it("names the negotiated protocol version the client actually supports", () => {
    const factory = readFileSync(join(root, "src/mcp/client-factory.ts"), "utf8");
    const version = /"(\d{4}-\d{2}-\d{2})"/.exec(factory)?.[1] ?? "";
    expect(version).toBe("2026-07-28");
    expect(readme).toContain(version);
  });
});

describe("links resolve from the npm tarball", () => {
  // On npm there is no repository context, so a relative link renders as a dead
  // path. Every link in the README must be absolute or an in-page anchor.
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;

  it("uses only absolute URLs and in-page anchors", () => {
    const bad: string[] = [];
    for (const [, target] of readme.matchAll(linkPattern)) {
      if (!/^https?:\/\//.test(target) && !target.startsWith("#")) bad.push(target);
    }
    expect(bad).toEqual([]);
  });

  /** Content images, excluding shields.io badges. */
  const contentImages = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
    .map(([, src]) => src)
    .filter((src) => !src.startsWith("https://img.shields.io/"));

  it("uses absolute image sources", () => {
    expect(contentImages.length).toBeGreaterThan(0);
    for (const src of contentImages) {
      expect(src).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
    }
  });

  it("references only images that exist in the repository", () => {
    for (const src of contentImages) {
      const name = src.split("/").pop() ?? "";
      expect(existsSync(join(root, "images", name)), `${name} is missing`).toBe(true);
    }
  });

  it("links only to docs that exist", () => {
    for (const [, target] of readme.matchAll(linkPattern)) {
      const match = /mcpi-ext\/blob\/main\/(docs\/[\w.-]+\.md|[A-Z]+\.md)$/.exec(target);
      if (match) {
        expect(existsSync(join(root, match[1])), `${match[1]} is linked but missing`).toBe(true);
      }
    }
  });

  it("resolves every relative link inside docs/", () => {
    for (const doc of docFiles) {
      for (const [, target] of doc.body.matchAll(linkPattern)) {
        if (/^https?:\/\//.test(target) || target.startsWith("#")) continue;
        const [path] = target.split("#");
        if (!path) continue;
        expect(existsSync(join(docsDir, path)), `${doc.name} links to missing ${path}`).toBe(true);
      }
    }
  });

  it("ships the README a consumer installs", () => {
    const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = (JSON.parse(raw) as [{ files: { path: string }[] }])[0].files.map((f) => f.path);
    expect(files).toContain("README.md");
  });
});
