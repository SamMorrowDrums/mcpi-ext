import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { PUBLIC_REGISTRY, confirmPublishedVersion, npmViewArgs } from "./confirm-published.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = parse(readFileSync(join(root, ".github/workflows/publish.yml"), "utf8"));
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const packageName = "@sammorrowdrums/mcpi-ext";
const steps = workflow.jobs.publish.steps;
const step = (name) => {
  const match = steps.find((candidate) => candidate.name === name);
  if (!match) throw new Error(`workflow step ${JSON.stringify(name)} is missing`);
  return match;
};

describe("post-publish registry confirmation", () => {
  it("succeeds as confirmed when the exact version is immediately visible", async () => {
    const viewVersion = vi.fn().mockResolvedValue(`${packageVersion}\n`);
    const wait = vi.fn();
    const warn = vi.fn();

    const result = await confirmPublishedVersion({
      packageName,
      packageVersion,
      delaysMs: [0, 10],
      viewVersion,
      wait,
      warn,
      log: vi.fn(),
    });

    expect(result).toEqual({
      confirmed: true,
      attempts: 1,
      observedVersion: packageVersion,
      warning: undefined,
    });
    expect(wait).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("succeeds unconfirmed with an exact warning after the bounded wait", async () => {
    const viewVersion = vi
      .fn()
      .mockRejectedValueOnce(new Error("replica unavailable"))
      .mockResolvedValue("");
    const wait = vi.fn();
    const warn = vi.fn();

    const result = await confirmPublishedVersion({
      packageName,
      packageVersion,
      delaysMs: [0, 10, 20],
      viewVersion,
      wait,
      warn,
      log: vi.fn(),
    });

    expect(result.confirmed).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.observedVersion).toBeUndefined();
    expect(wait.mock.calls).toEqual([[10], [20]]);
    expect(warn).toHaveBeenCalledOnce();
    expect(result.warning).toContain(`${packageName}@${packageVersion}`);
    expect(result.warning).toContain("Do not rerun this release workflow or npm publish");
    expect(result.warning).toContain(
      `npm view "${packageName}@${packageVersion}" version --registry="${PUBLIC_REGISTRY}" --prefer-online`,
    );
  });

  it("keeps the legacy false-red behavior pinned as a failing mutant", async () => {
    const result = await confirmPublishedVersion({
      packageName,
      packageVersion,
      delaysMs: [0],
      viewVersion: async () => {
        throw new Error("not visible yet");
      },
      wait: vi.fn(),
      warn: vi.fn(),
      log: vi.fn(),
    });

    const legacyOutcome = () => {
      if (!result.confirmed) throw new Error("published version did not appear on the registry");
    };

    expect(result.confirmed).toBe(false);
    expect(legacyOutcome).toThrow("published version did not appear on the registry");
  });

  it("queries only the public registry with a fresh online cache", () => {
    expect(npmViewArgs("@scope/pkg@1.2.3", "/cache/attempt-2")).toEqual([
      "view",
      "@scope/pkg@1.2.3",
      "version",
      "--silent",
      `--registry=${PUBLIC_REGISTRY}`,
      "--prefer-online",
      "--fetch-retries=0",
      "--fetch-timeout=10000",
      "--cache=/cache/attempt-2",
    ]);
  });
});

describe("publish workflow failure boundaries", () => {
  it("records authoritative acceptance only after npm publish succeeds", () => {
    const publish = step("Publish");
    const run = publish.run
      .replaceAll("${{ steps.guard.outputs.dist_tag }}", "latest")
      .replaceAll("${{ steps.guard.outputs.name }}", packageName)
      .replaceAll("${{ steps.guard.outputs.version }}", packageVersion);
    const result = spawnSync("bash", ["-c", ['npm() { [ "$1" = "publish" ]; }', run].join("\n")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: "/dev/null",
        GITHUB_STEP_SUMMARY: "/dev/null",
      },
    });

    expect(result.status).toBe(0);
    expect(run.indexOf("npm publish")).toBeLessThan(run.indexOf('echo "accepted=true"'));
    expect(run).toContain(`echo "name=${packageName}"`);
    expect(run).toContain(`echo "version=${packageVersion}"`);
    expect(run).toContain("npm publication accepted");
  });

  it("still fails when npm publish fails and never records acceptance", () => {
    const publish = step("Publish");
    const run = publish.run.replaceAll("${{ steps.guard.outputs.dist_tag }}", "latest");
    const result = spawnSync(
      "bash",
      [
        "-c",
        ['npm() { if [ "$1" = "publish" ]; then return 37; fi; command npm "$@"; }', run].join(
          "\n",
        ),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: "/dev/null",
          GITHUB_STEP_SUMMARY: "/dev/null",
        },
      },
    );

    expect(result.status).toBe(37);
    expect(result.stdout).not.toContain("npm publication accepted");
  });

  it("fails an exact tag/version mismatch in the guard before publish", () => {
    const guard = step("Verify tag, version, and source agree");
    const publishIndex = steps.indexOf(step("Publish"));
    const guardIndex = steps.indexOf(guard);
    const run = guard.run
      .replaceAll("${{ github.event.release.draft }}", "false")
      .replaceAll("${{ github.event.release.prerelease }}", "false");
    const result = spawnSync(
      "bash",
      ["-c", ['npm() { echo "unexpected npm invocation" >&2; return 99; }', run].join("\n")],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: "/dev/null",
          RELEASE_TAG: "v9.9.9",
        },
      },
    );

    expect(guardIndex).toBeLessThan(publishIndex);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      `tag v9.9.9 does not match package.json version ${packageVersion}`,
    );
    expect(result.stderr).not.toContain("unexpected npm invocation");
  });
});
