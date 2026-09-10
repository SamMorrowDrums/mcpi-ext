#!/usr/bin/env node
// Release preflight. Runs from prepublishOnly and from CI.
//
// Every check here encodes a mistake that is cheap to make and expensive to
// undo once a version is on the registry, because npm versions are immutable.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const offline = process.argv.includes("--offline");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const buildConfig = readFileSync(join(root, "tsconfig.build.json"), "utf8");

const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);
const ok = (msg) => notes.push(msg);

function check(name, fn) {
  try {
    fn();
  } catch (err) {
    fail(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
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

function isDevelopmentBuildPath(path) {
  return (
    /\.test\.(js|d\.ts)(\.map)?$/.test(path) ||
    path.startsWith("test-servers/") ||
    path.endsWith(".map")
  );
}

const distRoot = join(root, "dist");
const distFiles = existsSync(distRoot) ? listRelativeFiles(distRoot) : [];

check("client identity", () => {
  const src = readFileSync(join(root, "src/mcp/client-factory.ts"), "utf8");
  const match = /version:\s*"([^"]+)"/.exec(src);
  if (!match) throw new Error("could not find the MCP client identity version");
  if (match[1] !== pkg.version) {
    throw new Error(
      `MCP client identity is ${match[1]} but package.json is ${pkg.version}. ` +
        `Servers see the identity string, so a stale value misreports the client to every peer.`,
    );
  }
  ok(`client identity matches package version ${pkg.version}`);
});

check("license file", () => {
  if (!existsSync(join(root, "LICENSE"))) {
    throw new Error(`package.json declares "${pkg.license}" but no LICENSE file exists`);
  }
  ok("LICENSE present");
});

check("managed extension manifest", () => {
  const extensions = pkg.pi?.extensions;
  if (
    !Array.isArray(extensions) ||
    extensions.length !== 1 ||
    extensions[0] !== "./dist/index.js"
  ) {
    throw new Error(
      `pi.extensions must declare exactly "./dist/index.js", found ${JSON.stringify(extensions)}`,
    );
  }
  if (!existsSync(join(root, extensions[0]))) {
    throw new Error(`${extensions[0]} does not exist in the release build`);
  }
  ok("managed package declares ./dist/index.js");
});

check("test fixture exclusions", () => {
  const expectedPackageExclusions = [
    "!dist/**/fixtures.js",
    "!dist/**/fixtures.d.ts",
    "!dist/**/fixtures/**",
  ];
  const missingPackageExclusions = expectedPackageExclusions.filter(
    (pattern) => !pkg.files?.includes(pattern),
  );
  if (missingPackageExclusions.length > 0) {
    throw new Error(
      `package files must exclude the test-only fixture surface: ${missingPackageExclusions.join(", ")}`,
    );
  }
  const expectedBuildExclusions = ['"src/**/fixtures.ts"', '"src/**/fixtures/**"'];
  const missingBuildExclusions = expectedBuildExclusions.filter(
    (pattern) => !buildConfig.includes(pattern),
  );
  if (missingBuildExclusions.length > 0) {
    throw new Error(
      `tsconfig.build.json must exclude the test-only fixture surface: ${missingBuildExclusions.join(", ")}`,
    );
  }
  ok("test-only fixture surface excluded from the release build and tarball");
});

check("release build freshness", () => {
  const developmentOnly = distFiles.filter(isDevelopmentBuildPath);
  if (developmentOnly.length > 0) {
    throw new Error(
      `dist contains development-only output: ${developmentOnly.slice(0, 5).join(", ")}` +
        `${developmentOnly.length > 5 ? `, and ${developmentOnly.length - 5} more` : ""}. ` +
        "Run npm run build:release before npm run release:check.",
    );
  }
  ok("dist contains no development-only output");
});

check("release build fixture surface", () => {
  const leaked = distFiles.filter(isTestFixturePath);
  if (leaked.length > 0) {
    throw new Error(
      `release-shaped dist contains test-only fixture paths: ${leaked.join(", ")}. ` +
        "Remove any production import or release copy step that includes test fixtures.",
    );
  }
  ok("release build contains no test-only fixture surface");
});

check("pinned dependencies", () => {
  const deps = pkg.dependencies ?? {};
  if (deps["@modelcontextprotocol/client"] !== "2.0.0") {
    throw new Error(
      `@modelcontextprotocol/client must stay pinned to exactly 2.0.0, found ${deps["@modelcontextprotocol/client"]}`,
    );
  }
  if (!/^\^1\.0\./.test(deps["@sammorrowdrums/tool-cli"] ?? "")) {
    throw new Error(
      `@sammorrowdrums/tool-cli must stay on the v1 bridge contract, found ${deps["@sammorrowdrums/tool-cli"]}`,
    );
  }
  if (deps["isolated-vm"]) {
    throw new Error(
      "isolated-vm must stay in optionalDependencies. As a hard dependency it turns an " +
        "unsupported platform into a failed install instead of a degraded code mode.",
    );
  }
  if (!pkg.optionalDependencies?.["isolated-vm"]) {
    throw new Error("isolated-vm is missing from optionalDependencies");
  }
  if (deps.yaml !== "2.9.0") {
    throw new Error(
      `yaml must stay pinned to the vendored helper's tested version, found ${deps.yaml}`,
    );
  }
  ok(
    "dependency contracts intact (MCP client 2.0.0, tool-cli v1, yaml 2.9.0, isolated-vm optional)",
  );
});

check("packed contents", () => {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const files = JSON.parse(raw)[0].files.map((f) => f.path);
  const leaked = files.filter(
    (f) =>
      /\.test\.(js|d\.ts)$/.test(f) ||
      isTestFixturePath(f) ||
      f.startsWith("dist/test-servers/") ||
      f.endsWith(".map"),
  );
  if (leaked.length > 0) {
    throw new Error(`tarball would ship non-production files: ${leaked.join(", ")}`);
  }
  for (const required of ["dist/index.js", "dist/index.d.ts", "LICENSE", "README.md"]) {
    if (!files.includes(required)) throw new Error(`tarball is missing ${required}`);
  }
  ok(`tarball contents clean (${files.length} files)`);
});

check("peer availability", () => {
  const range = pkg.peerDependencies?.["@sammorrowdrums/mcpi"];
  if (!range) throw new Error("no @sammorrowdrums/mcpi peer range declared");
  if (offline) {
    ok(`peer range ${range} (registry check skipped: --offline)`);
    return;
  }
  const versions = JSON.parse(
    execFileSync("npm", ["view", "@sammorrowdrums/mcpi", "versions", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  const floor = /^>=\s*([\d.]+)/.exec(range)?.[1];
  if (!floor) throw new Error(`peer range ${range} has no >= floor to verify`);
  if (!versions.includes(floor)) {
    throw new Error(
      `peer floor @sammorrowdrums/mcpi@${floor} is not on the registry yet. ` +
        `Publishing mcpi-ext first would ship a package that cannot resolve its own peer. ` +
        `Release mcpi ${floor} before this package.`,
    );
  }
  ok(`peer floor @sammorrowdrums/mcpi@${floor} is published`);
});

check("production audit", () => {
  if (offline) {
    ok("production audit skipped: --offline");
    return;
  }
  let report;
  try {
    report = execFileSync("npm", ["audit", "--omit=dev", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    // npm audit exits non-zero when it finds anything; the JSON is still on stdout.
    report = err.stdout;
  }
  const total = JSON.parse(report).metadata?.vulnerabilities ?? {};
  const count = Object.entries(total)
    .filter(([severity]) => severity !== "info" && severity !== "total")
    .reduce((sum, [, n]) => sum + n, 0);
  if (count > 0) {
    throw new Error(`production dependency tree has ${count} advisories: ${JSON.stringify(total)}`);
  }
  ok("production dependency tree has no advisories");
});

for (const note of notes) console.log(`  ok  ${note}`);
for (const failure of failures) console.error(`FAIL  ${failure}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} release check(s) failed.`);
  process.exit(1);
}
console.log(`\nRelease checks passed for ${pkg.name}@${pkg.version}.`);
