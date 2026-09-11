#!/usr/bin/env node
// Clean-room verification of the published tarball.
//
// Everything here runs against an *installed* copy in a temp directory, never
// against the working tree. A test that imports "../src/index.js" proves the
// source is correct; it cannot prove the tarball carries the files that source
// needs, that the exports map resolves, or that a consumer can import it at all.
// Those are exactly the failures that only appear after an immutable publish.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const PUBLIC_MCPI_VERSION = "0.85.1";
const failures = [];
const notes = [];

function check(label, fn) {
  try {
    const detail = fn();
    console.log(`  ok  ${label}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failures.push(label);
    console.log(`FAIL  ${label}: ${error.message}`);
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function listRelativeFiles(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? listRelativeFiles(root, path) : path.replaceAll("\\", "/");
  });
}

function isTestFixturePath(path) {
  return path
    .split("/")
    .some((segment) => segment === "fixtures" || segment.startsWith("fixtures."));
}

function createIsolatedUserEnvironment(root) {
  const home = join(root, "home");
  const xdgConfig = join(root, "xdg-config");
  const xdgCache = join(root, "xdg-cache");
  const xdgData = join(root, "xdg-data");
  const xdgState = join(root, "xdg-state");
  const npmCache = join(root, "npm-cache");
  const npmUserConfig = join(root, "npmrc");

  for (const dir of [home, xdgConfig, xdgCache, xdgData, xdgState, npmCache]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(npmUserConfig, "", "utf8");

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key) || /^MCPI_/.test(key) || /^PI_/.test(key)) {
      delete env[key];
    }
  }
  delete env.NODE_OPTIONS;
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    NODE_PATH: "",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_cache: npmCache,
    npm_config_userconfig: npmUserConfig,
    npm_config_registry: "https://registry.npmjs.org/",
  });

  return { env, xdgConfig, xdgCache };
}

console.log(`Node ${process.version}\n`);

// ---------------------------------------------------------------------------
// Build and pack
// ---------------------------------------------------------------------------

console.log("Building release tree...");
run("node", ["--run", "build:release"], { cwd: repoRoot });
const releasePaths = listRelativeFiles(join(repoRoot, "dist"));

const packDir = mkdtempSync(join(tmpdir(), "mcpi-ext-pack-"));
const packJson = run("npm", ["pack", "--json", "--pack-destination", packDir], {
  cwd: repoRoot,
});
const packed = JSON.parse(packJson)[0];
const tarball = join(packDir, packed.filename);
const packedPaths = packed.files.map((file) => file.path);

console.log(`Packed ${packed.filename} — ${packed.entryCount} files, ${packed.size} bytes\n`);

// ---------------------------------------------------------------------------
// Tarball contents
// ---------------------------------------------------------------------------

check("release build emits no test fixture surface", () => {
  const leaked = releasePaths.filter(isTestFixturePath);
  assert(leaked.length === 0, `found ${leaked.join(", ")}`);
});

check("tarball ships no test files", () => {
  const leaked = packedPaths.filter((path) => /\.test\.(js|d\.ts)$/.test(path));
  assert(leaked.length === 0, `found ${leaked.join(", ")}`);
});

check("tarball ships no fixture servers", () => {
  const leaked = packedPaths.filter((path) => path.includes("test-servers/"));
  assert(leaked.length === 0, `found ${leaked.join(", ")}`);
});

check("tarball ships no test fixture surface", () => {
  const leaked = packedPaths.filter(isTestFixturePath);
  assert(leaked.length === 0, `found ${leaked.join(", ")}`);
});

check("tarball ships no source maps", () => {
  const leaked = packedPaths.filter((path) => path.endsWith(".map"));
  assert(leaked.length === 0, `found ${leaked.join(", ")}`);
});

check("tarball ships the entry point, types, license, and readme", () => {
  for (const required of ["dist/index.js", "dist/index.d.ts", "LICENSE", "README.md"]) {
    assert(packedPaths.includes(required), `missing ${required}`);
  }
});

check("package declares its managed extension entry point", () => {
  assert(
    JSON.stringify(packageManifest.pi?.extensions) === JSON.stringify(["./dist/index.js"]),
    `pi.extensions is ${JSON.stringify(packageManifest.pi?.extensions)}`,
  );
});

check("package excludes test fixture surface from publication", () => {
  for (const exclusion of [
    "!dist/**/fixtures.js",
    "!dist/**/fixtures.d.ts",
    "!dist/**/fixtures/**",
  ]) {
    assert(packageManifest.files?.includes(exclusion), `missing files rule ${exclusion}`);
  }
});

check("published JavaScript has no runtime reference to the mcpi peer", () => {
  const offenders = packedPaths
    .filter((path) => path.endsWith(".js"))
    .filter((path) =>
      /["']@sammorrowdrums\/mcpi["']/.test(readFileSync(join(repoRoot, path), "utf8")),
    );
  assert(
    offenders.length === 0,
    `${offenders.join(", ")} still references @sammorrowdrums/mcpi at runtime`,
  );
});

check("published type declarations do not reference the optional addon", () => {
  const declarations = packedPaths.filter((path) => path.endsWith(".d.ts"));
  const offenders = declarations.filter((path) => {
    const contents = readFileSync(join(repoRoot, path), "utf8");
    return /from ["']isolated-vm["']/.test(contents);
  });
  assert(
    offenders.length === 0,
    `${offenders.join(", ")} would make consumer type-checking fail without the optional addon`,
  );
});

// ---------------------------------------------------------------------------
// Clean-room install
// ---------------------------------------------------------------------------

const consumerDir = mkdtempSync(join(tmpdir(), "mcpi-ext-consumer-"));
writeFileSync(
  join(consumerDir, "package.json"),
  `${JSON.stringify({ name: "consumer", private: true, type: "module", version: "0.0.0" }, null, 2)}\n`,
);

// Managed mcpi installs deliberately omit peers so they cannot create a second
// host instance. The tarball therefore has to import successfully with the peer
// absent, not merely when a conventional consumer lets npm auto-install it.
console.log("\nInstalling tarball without its peer into a clean consumer project...");
run("npm", ["install", "--legacy-peer-deps", "--no-audit", "--no-fund", tarball], {
  cwd: consumerDir,
});

const installedRoot = join(consumerDir, "node_modules", "@sammorrowdrums", "mcpi-ext");

check("package resolves and exposes a default extension registrar", () => {
  const out = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import mod from "@sammorrowdrums/mcpi-ext";
       if (typeof mod !== "function") throw new Error("default export is " + typeof mod);
       process.stdout.write("ok");`,
    ],
    { cwd: consumerDir },
  );
  assert(out.trim() === "ok", out);
});

check("clean consumer contains no duplicate mcpi host", () => {
  const peerPath = join(consumerDir, "node_modules", "@sammorrowdrums", "mcpi");
  assert(!existsSync(peerPath), `peer was installed at ${peerPath}`);
});

check("exports map blocks deep imports into internals", () => {
  const blocked = [
    "@sammorrowdrums/mcpi-ext/dist/mcp/policy.js",
    "@sammorrowdrums/mcpi-ext/dist/code-mode/executor.js",
    "@sammorrowdrums/mcpi-ext/dist/index.js",
  ];
  for (const specifier of blocked) {
    let threw = false;
    try {
      run(
        process.execPath,
        ["--input-type=module", "-e", `await import(${JSON.stringify(specifier)});`],
        { cwd: consumerDir },
      );
    } catch (error) {
      threw = /ERR_PACKAGE_PATH_NOT_EXPORTED/.test(String(error.stderr ?? error.message));
    }
    assert(threw, `${specifier} is reachable and would become part of the public contract`);
  }
});

check("package.json subpath stays reachable", () => {
  const out = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { default: pkg } = await import("@sammorrowdrums/mcpi-ext/package.json", { with: { type: "json" } });
       process.stdout.write(pkg.version);`,
    ],
    { cwd: consumerDir },
  );
  assert(out.trim() === packed.version, `resolved ${out.trim()}, expected ${packed.version}`);
});

check("tool-cli v1 is installed as a real dependency", () => {
  const manifestPath = join(
    consumerDir,
    "node_modules",
    "@sammorrowdrums",
    "tool-cli",
    "package.json",
  );
  assert(existsSync(manifestPath), "@sammorrowdrums/tool-cli is not installed");
  const version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
  assert(version.startsWith("1."), `installed ${version}, expected a 1.x release`);
  notes.push(`tool-cli ${version}`);
  return version;
});

check("MCP client is installed at the exact pinned version", () => {
  const manifestPath = join(
    consumerDir,
    "node_modules",
    "@modelcontextprotocol",
    "client",
    "package.json",
  );
  assert(existsSync(manifestPath), "@modelcontextprotocol/client is not installed");
  const version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
  assert(version === "2.0.0", `installed ${version}, expected exactly 2.0.0`);
  return version;
});

// ---------------------------------------------------------------------------
// Runtime behaviour against the installed copy
// ---------------------------------------------------------------------------

const harness = String.raw`
import { writeFileSync } from "node:fs";
import registerExtension from "@sammorrowdrums/mcpi-ext";

const flags = JSON.parse(process.env.HARNESS_FLAGS ?? "{}");
const tools = [];
const handlers = new Map();
const logs = [];
const pi = {
  registerTool: (tool) => tools.push(tool),
  registerFlag: () => {},
  getFlag: (name) => flags[name],
  setEnv: () => {},
  unsetEnv: () => {},
  getActiveTools: () => ["bash"],
  getAllTools: () => tools.map((tool) => ({ name: tool.name })),
  on: (event, handler) => handlers.set(event, handler),
};

// The extension reports connection and discovery progress on stderr when no UI
// is attached. That narration is the only public evidence of which discovery
// contract was negotiated, so capture it rather than inspecting internals the
// exports map deliberately hides.
const stderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  logs.push(String(chunk));
  return stderrWrite(chunk, ...rest);
};

registerExtension(pi);

const sessionStart = handlers.get("session_start");
if (sessionStart) await sessionStart({}, { cwd: process.cwd(), hasUI: false });

const beforeAgent = handlers.get("before_agent_start");
const prompt = beforeAgent
  ? (await beforeAgent({ systemPrompt: "" }))?.systemPrompt ?? ""
  : "";

const codeExecute = tools.find((tool) => tool.name === "code_execute");
let execution = null;
if (codeExecute && flags["skip-execute"] !== true) {
  execution = await codeExecute.execute(
    "smoke",
    { code: "return [1, 2, 3].reduce((a, b) => a + b, 0);" },
    undefined,
    undefined,
    {},
  );
}

// Written to a file rather than stdout. The payload includes generated type
// hints for every discovered tool, so against a real server it runs well past
// a pipe buffer; process.exit() then drops whatever had not flushed and the
// reader sees truncated JSON. A file also removes the need to fish the payload
// out of the MCP SDK's stdout chatter.
writeFileSync(
  process.env.HARNESS_RESULT_PATH,
  JSON.stringify({
    toolNames: tools.map((tool) => tool.name),
    prompt,
    execution,
    logs: logs.join(""),
  }),
  "utf8",
);
process.exit(0);
`;

function runHarness(env = {}, flags = {}) {
  const token = Math.random().toString(36).slice(2);
  const harnessPath = join(consumerDir, `harness-${token}.mjs`);
  const resultPath = join(consumerDir, `harness-${token}.json`);
  writeFileSync(harnessPath, harness);
  try {
    const out = run(process.execPath, [harnessPath], {
      cwd: consumerDir,
      timeout: 90_000,
      env: {
        ...process.env,
        HARNESS_FLAGS: JSON.stringify(flags),
        HARNESS_RESULT_PATH: resultPath,
        ...env,
      },
    });
    assert(existsSync(resultPath), `harness produced no result payload:\n${out.slice(0, 500)}`);
    return JSON.parse(readFileSync(resultPath, "utf8"));
  } finally {
    rmSync(harnessPath, { force: true });
    rmSync(resultPath, { force: true });
  }
}

const withSandbox = runHarness();

check("zero-server session registers the code tools and emits execution routing", () => {
  assert(withSandbox.toolNames.includes("code_execute"), "code_execute was not registered");
  assert(withSandbox.toolNames.includes("code_search"), "code_search was not registered");
  assert(
    withSandbox.prompt.includes("<execution_routing>"),
    "execution routing section was not emitted with no MCP servers connected",
  );
  return `${withSandbox.toolNames.length} tools`;
});

const sandboxInstalled = existsSync(join(consumerDir, "node_modules", "isolated-vm"));

check("code execution reflects the sandbox that is actually installed", () => {
  const text = withSandbox.execution?.content?.[0]?.text ?? "";
  if (sandboxInstalled) {
    assert(text === "6", `expected the isolate to compute 6, got ${JSON.stringify(text)}`);
    notes.push("isolated-vm installed; code execution verified end to end");
    return "isolate executed";
  }
  assert(
    withSandbox.execution?.details?.error === "sandbox_unavailable",
    `expected sandbox_unavailable, got ${JSON.stringify(withSandbox.execution?.details)}`,
  );
  notes.push("isolated-vm absent on this platform; refusal path verified instead");
  return "refused without a sandbox";
});

// ---------------------------------------------------------------------------
// Degradation: the optional addon is gone
// ---------------------------------------------------------------------------

if (sandboxInstalled) {
  console.log("\nRemoving the optional addon to verify degradation...");
  await rm(join(consumerDir, "node_modules", "isolated-vm"), { recursive: true, force: true });
  // Leave an empty directory behind: this reproduces a partially-installed or
  // stripped addon, which fails at import rather than at resolution.
  await mkdir(join(consumerDir, "node_modules", "isolated-vm"), { recursive: true });

  const withoutSandbox = runHarness();

  check("skills, tool-cli, and routing survive a missing sandbox", () => {
    assert(
      withoutSandbox.prompt.includes("<execution_routing>"),
      "execution routing stopped being emitted when the addon disappeared",
    );
    assert(
      withoutSandbox.toolNames.includes("load_skill"),
      "load_skill was not registered without the addon",
    );
    return "extension still loads";
  });

  check("code mode reports itself unavailable with a specific reason", () => {
    // The section renders facility titles, not ids, and each facility ends with
    // an "Availability: <state> — <detail>" line. Read that line for the code
    // mode block specifically rather than pattern-matching the whole section,
    // which would happily pass on another facility's wording.
    const heading = "### Code mode";
    const start = withoutSandbox.prompt.indexOf(heading);
    assert(start !== -1, "code mode facility is missing from the routing section entirely");
    const block = withoutSandbox.prompt.slice(start);
    const availability = /^Availability: (\S+) — (.+)$/m.exec(block);
    assert(availability !== null, `no availability line found in:\n${block.slice(0, 400)}`);
    assert(
      availability[1] === "unavailable",
      `code mode reported "${availability[1]}" while the addon was missing`,
    );
    assert(/because .+/.test(availability[2]), `availability gave no cause: ${availability[2]}`);
    return availability[2].slice(0, 72);
  });

  check("code_execute refuses instead of falling back to node:vm", () => {
    const details = withoutSandbox.execution?.details ?? {};
    assert(
      details.error === "sandbox_unavailable",
      `expected sandbox_unavailable, got ${JSON.stringify(details)}`,
    );
    assert(
      Array.isArray(details.alternatives) && details.alternatives.length > 0,
      "refusal named no alternative execution surface",
    );
    const text = withoutSandbox.execution?.content?.[0]?.text ?? "";
    assert(text !== "6", "code ran anyway — a node:vm fallback would produce this");
    return details.alternatives.join(", ");
  });
}

// ---------------------------------------------------------------------------
// Discovery contracts, driven through the public entry point
// ---------------------------------------------------------------------------
//
// The fixture servers deliberately do not ship in the tarball, so they run from
// the repo's dev build and are reached the way a consumer reaches any MCP
// server: over stdio, named in an mcp config. That keeps the assertion honest —
// it exercises the installed package's discovery path against a server it has
// no privileged relationship with.

const fixtureRoot = join(repoRoot, "dist", "test-servers");
const legacyFixture = join(fixtureRoot, "weather-stdio.js");
const sepFixture = join(fixtureRoot, "skills-extension-stdio.js");

if (!existsSync(legacyFixture) || !existsSync(sepFixture)) {
  console.log("\nBuilding fixture servers for the discovery checks...");
  run("npx", ["tsc"], { cwd: repoRoot, timeout: 300_000 });
}

console.log("\nExercising discovery contracts against the installed package...");

const fixtureConfigPath = join(consumerDir, "mcp-servers.json");

function withFixture(server, flags) {
  writeFileSync(fixtureConfigPath, `${JSON.stringify({ mcpServers: server }, null, 2)}\n`, "utf8");
  return runHarness({}, { "mcp-config": fixtureConfigPath, "skip-execute": true, ...flags });
}

const legacyServer = {
  weather: { type: "stdio", command: process.execPath, args: [legacyFixture] },
};
const sepServer = {
  skills: { type: "stdio", command: process.execPath, args: [sepFixture] },
};

check("installed package completes legacy skill:// discovery", () => {
  const result = withFixture(legacyServer, {});
  assert(
    /1 server\(s\)/.test(result.logs),
    `fixture server did not connect:\n${result.logs.slice(0, 500)}`,
  );
  assert(
    /\b[1-9]\d* skill/i.test(result.logs),
    `no skills were discovered over the legacy contract:\n${result.logs.slice(0, 500)}`,
  );
  assert(result.toolNames.includes("load_skill"), "load_skill was not registered");
  return /(\d+ skill\(s\) discovered)/.exec(result.logs)?.[1] ?? "skills discovered";
});

check("installed package negotiates the draft SEP-2640 contract with no flags at all", () => {
  // Default-on. A server that declares the extension has already opted in;
  // requiring the user to opt in a second time is what made skills invisible.
  const byDefault = withFixture(sepServer, {});
  assert(
    /1 server\(s\)/.test(byDefault.logs),
    `fixture server did not connect:\n${byDefault.logs.slice(0, 500)}`,
  );
  assert(
    /declares the draft \(unratified\) SEP-2640 skills extension; negotiating it/.test(
      byDefault.logs,
    ),
    `draft extension was not negotiated by default:\n${byDefault.logs.slice(0, 800)}`,
  );
  assert(
    /\b[1-9]\d* skill/i.test(byDefault.logs),
    `no skills were discovered over the draft contract:\n${byDefault.logs.slice(0, 800)}`,
  );

  // Shipping an unratified spec on by default is only defensible if the
  // package says so where the user can see it, and names the way out.
  assert(
    /draft \(unratified\)/i.test(byDefault.logs) && /status=draft/.test(byDefault.logs),
    `draft status was negotiated silently:\n${byDefault.logs.slice(0, 800)}`,
  );
  assert(
    /--no-mcp-skills-extension/.test(byDefault.logs),
    `the opt-out was not surfaced alongside the draft warning:\n${byDefault.logs.slice(0, 800)}`,
  );

  // Same server, opt-out set. A default that cannot be turned off is not a default.
  const optedOut = withFixture(sepServer, { "no-mcp-skills-extension": true });
  assert(
    !/declares the draft \(unratified\)/.test(optedOut.logs),
    `draft extension negotiated despite the opt-out:\n${optedOut.logs.slice(0, 800)}`,
  );
  return "default-on, and the opt-out is honoured";
});

check("installed package leaves non-declaring servers alone", () => {
  // Default-on must not mean "probe everyone". A server that never declared
  // the extension must not be negotiated with, or a default-on draft becomes
  // a compatibility hazard for every server in the ecosystem.
  //
  // Asserted on the decision, not on the substring: the startup banner and the
  // negative diagnostic both legitimately name io.modelcontextprotocol/skills,
  // so grepping for the URI would fail on correct behaviour.
  const result = withFixture(legacyServer, {});
  assert(
    /does not declare .*io\.modelcontextprotocol\/skills.*using legacy skill:\/\/ discovery/.test(
      result.logs,
    ),
    `no record of declining to negotiate with a legacy server:\n${result.logs.slice(0, 800)}`,
  );
  assert(
    !/declares the draft \(unratified\)/.test(result.logs),
    `draft extension negotiated against a server that never declared it:\n${result.logs.slice(0, 800)}`,
  );
  return "no draft negotiation without a declaration";
});

// ---------------------------------------------------------------------------
// Real managed install through the current public mcpi
// ---------------------------------------------------------------------------

console.log(`\nExercising public mcpi ${PUBLIC_MCPI_VERSION} managed installation...`);

const managedDir = mkdtempSync(join(tmpdir(), "mcpi-ext-managed-"));
const cleanCwd = join(managedDir, "clean-cwd");
const hostPrefix = join(managedDir, "host-prefix");
mkdirSync(cleanCwd, { recursive: true });
mkdirSync(hostPrefix, { recursive: true });

const { env: managedEnv, xdgConfig, xdgCache } = createIsolatedUserEnvironment(managedDir);
const offlineManagedEnv = {
  ...managedEnv,
  MCPI_OFFLINE: "1",
  MCPI_SKIP_VERSION_CHECK: "1",
};

run(
  "npm",
  [
    "install",
    "--global",
    "--prefix",
    hostPrefix,
    "--no-audit",
    "--no-fund",
    `@sammorrowdrums/mcpi@${PUBLIC_MCPI_VERSION}`,
  ],
  { cwd: cleanCwd, env: managedEnv, timeout: 300_000 },
);

const mcpiBin =
  process.platform === "win32" ? join(hostPrefix, "mcpi.cmd") : join(hostPrefix, "bin", "mcpi");
const installedMcpiVersion = run(mcpiBin, ["--version"], {
  cwd: cleanCwd,
  env: offlineManagedEnv,
}).trim();
assert(
  installedMcpiVersion === PUBLIC_MCPI_VERSION,
  `installed mcpi ${installedMcpiVersion}, expected ${PUBLIC_MCPI_VERSION}`,
);

const managedSource = `npm:@sammorrowdrums/mcpi-ext@file:${tarball}`;
run(mcpiBin, ["install", managedSource], {
  cwd: cleanCwd,
  env: managedEnv,
  timeout: 300_000,
});

const managedRoot = join(xdgCache, "mcpi", "npm", "node_modules", "@sammorrowdrums", "mcpi-ext");
const managedPeer = join(xdgCache, "mcpi", "npm", "node_modules", "@sammorrowdrums", "mcpi");

check("mcpi list records the tarball and resolves its managed path", () => {
  const list = run(mcpiBin, ["list"], { cwd: cleanCwd, env: offlineManagedEnv });
  assert(list.includes(managedSource), `list omitted ${managedSource}:\n${list}`);
  assert(list.includes(managedRoot), `list omitted managed path ${managedRoot}:\n${list}`);

  const settingsPath = join(xdgConfig, "mcpi", "settings.json");
  assert(existsSync(settingsPath), `settings were not written to ${settingsPath}`);
  assert(
    readFileSync(settingsPath, "utf8").includes(managedSource),
    "settings do not contain the installed package source",
  );
});

check("managed entry imports directly with no workspace or peer resolution", () => {
  const entry = join(managedRoot, "dist", "index.js");
  assert(existsSync(entry), `managed entry is missing at ${entry}`);
  assert(!existsSync(managedPeer), `managed root contains a duplicate host at ${managedPeer}`);

  const out = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const mod = await import(${JSON.stringify(pathToFileURL(entry).href)});
       if (typeof mod.default !== "function") throw new Error("default export is " + typeof mod.default);
       process.stdout.write("ok");`,
    ],
    { cwd: cleanCwd, env: managedEnv },
  );
  assert(out.trim() === "ok", out);
});

check("managed direct proxy offloads a deterministic large result exactly", () => {
  const proxyEntry = join(managedRoot, "dist", "skills", "mcp-tool-proxy.js");
  const resultSessionDir = join(managedDir, "direct-result-session");
  const verification = JSON.parse(
    run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createHash } from "node:crypto";
         import { readFile } from "node:fs/promises";
         const { registerMcpToolProxies } = await import(${JSON.stringify(pathToFileURL(proxyEntry).href)});
         const output = Array.from(
           { length: 120 },
           (_, index) => \`job-\${String(index).padStart(3, "0")}: \${"deterministic log payload ".repeat(9)}\`,
         ).join("\\n");
         const terminal = { kind: "terminal", result: { content: [{ type: "text", text: output }] } };
         const tool = {
           name: "get_job_logs",
           serverName: "fixture",
           inputSchema: { type: "object", properties: {} },
           annotations: { readOnlyHint: true },
         };
         const manager = { getTools: () => [tool] };
         const policy = {
           callTool: async (request) => {
             if (request.source !== "proxy") throw new Error("unexpected source " + request.source);
             return terminal;
           },
         };
         const registered = [];
         const pi = {
           getAllTools: () => [],
           registerTool: (proxy) => registered.push(proxy),
         };
         registerMcpToolProxies(["get_job_logs"], manager, policy, pi);
         const result = await registered[0].execute(
           "managed-direct-call",
           { return_content: true, tail_lines: 120 },
           undefined,
           undefined,
           {
             sessionManager: {
               getSessionDir: () => ${JSON.stringify(resultSessionDir)},
               getSessionId: () => "managed-session",
             },
           },
         );
         if (result.details?.kind !== "direct-mcp-result-offload") {
           throw new Error("large direct result was not offloaded");
         }
         const stored = await readFile(result.details.output.path, "utf8");
         const expectedDigest = createHash("sha256").update(output).digest("hex");
         const pointer = result.content[0]?.text ?? "";
         process.stdout.write(JSON.stringify({
           exact: stored === output,
           bytes: Buffer.byteLength(output),
           digest: expectedDigest,
           recordedDigest: result.details.output.sha256,
           absolutePath: result.details.output.path.startsWith("/"),
           pointerBounded: Buffer.byteLength(pointer) < 2048,
           payloadAbsent: !pointer.includes(output) && !JSON.stringify(result.details).includes(output),
         }));`,
      ],
      { cwd: cleanCwd, env: managedEnv },
    ),
  );

  assert(verification.exact, "managed result file did not preserve the exact MCP output");
  assert(verification.bytes > 20_000, `managed fixture was only ${verification.bytes} bytes`);
  assert(
    verification.digest === verification.recordedDigest,
    `managed result digest mismatch: ${verification.recordedDigest} != ${verification.digest}`,
  );
  assert(verification.absolutePath, "managed result pointer was not absolute");
  assert(verification.pointerBounded, "managed result pointer exceeded the inline byte threshold");
  assert(
    verification.payloadAbsent,
    "managed result leaked the complete payload into model metadata",
  );
  return `${verification.bytes} bytes, sha256 ${verification.digest}`;
});

check("managed extension registers both flags in public mcpi help", () => {
  const help = run(mcpiBin, ["--offline", "--help"], {
    cwd: cleanCwd,
    env: offlineManagedEnv,
    timeout: 90_000,
  });
  assert(help.includes("--mcp-config <value>"), "--mcp-config is absent from help");
  assert(help.includes("--mcp-skills-extension"), "--mcp-skills-extension is absent from help");
});

check("public mcpi completes a zero-server startup through managed flags", () => {
  const emptyConfig = join(managedDir, "empty-mcp.json");
  writeFileSync(emptyConfig, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, "utf8");

  const output = run(
    mcpiBin,
    [
      "--offline",
      "--mode",
      "rpc",
      "--no-session",
      "--mcp-config",
      emptyConfig,
      "--mcp-skills-extension",
    ],
    {
      cwd: cleanCwd,
      env: offlineManagedEnv,
      input: '{"id":"state","type":"get_state"}\n',
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 90_000,
    },
  );

  assert(output.includes('"message":"mcpi-ext loaded"'), "session_start did not run");
  assert(
    output.includes('"command":"get_state","success":true'),
    `RPC session did not reach a usable state:\n${output.slice(0, 800)}`,
  );
  assert(!output.includes('"type":"extension_error"'), `extension error reported:\n${output}`);
  return `mcpi ${installedMcpiVersion}`;
});

// ---------------------------------------------------------------------------

rmSync(packDir, { recursive: true, force: true });
rmSync(consumerDir, { recursive: true, force: true });
rmSync(managedDir, { recursive: true, force: true });

if (notes.length > 0) console.log(`\n${notes.map((note) => `note: ${note}`).join("\n")}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} package check(s) failed.`);
  process.exit(1);
}
console.log("\nPackage verified.");
