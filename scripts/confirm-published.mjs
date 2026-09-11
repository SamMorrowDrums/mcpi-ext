#!/usr/bin/env node
import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

export const PUBLIC_REGISTRY = "https://registry.npmjs.org/";
export const DEFAULT_DELAYS_MS = [0, 5_000, 10_000, 20_000, 30_000, 45_000, 60_000, 60_000];

const execFileAsync = promisify(execFile);

function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").trim();
}

function verificationCommand(packageSpec) {
  return `npm view "${packageSpec}" version --registry="${PUBLIC_REGISTRY}" --prefer-online`;
}

export function npmViewArgs(packageSpec, cacheDirectory) {
  return [
    "view",
    packageSpec,
    "version",
    "--silent",
    `--registry=${PUBLIC_REGISTRY}`,
    "--prefer-online",
    "--fetch-retries=0",
    "--fetch-timeout=10000",
    `--cache=${cacheDirectory}`,
  ];
}

export async function confirmPublishedVersion({
  packageName,
  packageVersion,
  delaysMs = DEFAULT_DELAYS_MS,
  viewVersion,
  wait = sleep,
  log = console.log,
  warn = (message) => console.log(`::warning title=npm registry confirmation delayed::${message}`),
}) {
  const packageSpec = `${packageName}@${packageVersion}`;
  let lastObservation = "the registry request did not return a version";

  for (const [index, delayMs] of delaysMs.entries()) {
    if (delayMs > 0) await wait(delayMs);

    try {
      const observedVersion = (await viewVersion(index + 1)).trim();
      if (observedVersion === packageVersion) {
        log(
          `confirmed ${packageSpec} at ${PUBLIC_REGISTRY} after ${index + 1} ` +
            `${index === 0 ? "check" : "checks"}`,
        );
        return {
          confirmed: true,
          attempts: index + 1,
          observedVersion,
          warning: undefined,
        };
      }
      lastObservation = observedVersion
        ? `the registry returned version ${JSON.stringify(observedVersion)}`
        : "the registry returned an empty version";
    } catch (error) {
      lastObservation = `the registry request failed: ${errorMessage(error)}`;
    }

    log(`registry confirmation ${index + 1}/${delaysMs.length}: ${lastObservation}`);
  }

  const warning =
    `${packageSpec} was accepted by npm publish, but the exact version was not observed at ` +
    `${PUBLIC_REGISTRY} after ${delaysMs.length} checks (${lastObservation}). Do not rerun this ` +
    `release workflow or npm publish: npm versions are immutable and publication may already be ` +
    `complete. Verify with: ${verificationCommand(packageSpec)}`;
  warn(warning);

  return {
    confirmed: false,
    attempts: delaysMs.length,
    observedVersion: undefined,
    warning,
  };
}

async function appendIfConfigured(path, body) {
  if (path) await appendFile(path, body);
}

async function run() {
  const packageName = process.env.PACKAGE_NAME;
  const packageVersion = process.env.PACKAGE_VERSION;
  if (!packageName || !packageVersion) {
    throw new Error("PACKAGE_NAME and PACKAGE_VERSION are required");
  }

  const packageSpec = `${packageName}@${packageVersion}`;
  const cacheRoot = process.env.RUNNER_TEMP ?? process.cwd();
  const cacheKey = [
    "npm-registry-confirm",
    process.env.GITHUB_RUN_ID ?? "local",
    process.env.GITHUB_RUN_ATTEMPT ?? "1",
  ].join("-");

  const result = await confirmPublishedVersion({
    packageName,
    packageVersion,
    viewVersion: async (attempt) => {
      const cacheDirectory = join(cacheRoot, `${cacheKey}-${attempt}`);
      const { stdout } = await execFileAsync("npm", npmViewArgs(packageSpec, cacheDirectory), {
        encoding: "utf8",
      });
      return stdout;
    },
  });

  await appendIfConfigured(
    process.env.GITHUB_OUTPUT,
    `confirmed=${String(result.confirmed)}\nattempts=${result.attempts}\n`,
  );

  const summary = result.confirmed
    ? [
        "### npm registry confirmation",
        "",
        `Confirmed \`${packageSpec}\` is visible at ${PUBLIC_REGISTRY} after ${result.attempts} check(s).`,
        "",
      ].join("\n")
    : [
        "### npm registry confirmation delayed",
        "",
        `\`npm publish\` already exited successfully for \`${packageSpec}\`, but the exact version was not observed during the bounded registry checks.`,
        "",
        `Do not rerun this release workflow or publish again. Verify with \`${verificationCommand(packageSpec)}\`.`,
        "",
      ].join("\n");
  await appendIfConfigured(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
