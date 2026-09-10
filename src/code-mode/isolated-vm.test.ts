import { afterEach, describe, expect, it } from "vitest";
import { CodeModeManager } from "./index.js";
import {
  loadIsolatedVm,
  peekIsolatedVm,
  resetIsolatedVmCacheForTests,
  setIsolatedVmForTests,
  type IsolatedVmModule,
} from "./isolated-vm.js";
import { SANDBOX_UNAVAILABLE_ERROR, executeInSandbox } from "./executor.js";

afterEach(() => {
  resetIsolatedVmCacheForTests();
});

/** A structurally valid stand-in; the adapter only checks the shape, never runs it. */
function fakeModule(): IsolatedVmModule {
  return {
    Isolate: function Isolate() {
      throw new Error("not executed in these tests");
    },
    Reference: function Reference() {
      throw new Error("not executed in these tests");
    },
    ExternalCopy: function ExternalCopy() {
      throw new Error("not executed in these tests");
    },
  } as unknown as IsolatedVmModule;
}

describe("loadIsolatedVm", () => {
  it("reports unavailable with a reason when the addon is missing", async () => {
    setIsolatedVmForTests({
      available: false,
      reason: "the optional isolated-vm native addon is not installed",
    });

    const load = await loadIsolatedVm();

    expect(load.available).toBe(false);
    if (!load.available) {
      expect(load.reason).toContain("isolated-vm");
      expect(load.reason.trim()).not.toBe("");
    }
  });

  it("caches the verdict so a failed load is never retried", async () => {
    setIsolatedVmForTests({ available: false, reason: "simulated absence" });

    const first = await loadIsolatedVm();
    const second = await loadIsolatedVm();

    expect(second).toBe(first);
  });

  it("exposes the cached verdict synchronously once resolved", async () => {
    expect(peekIsolatedVm()).toBeUndefined();

    setIsolatedVmForTests({ available: true, module: fakeModule() });
    await loadIsolatedVm();

    expect(peekIsolatedVm()?.available).toBe(true);
  });

  it("resets cleanly between tests", async () => {
    setIsolatedVmForTests({ available: true, module: fakeModule() });
    await loadIsolatedVm();
    resetIsolatedVmCacheForTests();

    expect(peekIsolatedVm()).toBeUndefined();
  });
});

describe("executeInSandbox without the native addon", () => {
  it("returns a structured refusal instead of throwing or downgrading", async () => {
    setIsolatedVmForTests({
      available: false,
      reason: "the optional isolated-vm native addon is not installed",
    });

    const result = await executeInSandbox({
      code: "1 + 1",
      aliases: {},
      dispatch: () => Promise.resolve(undefined),
      discover: () => Promise.resolve(undefined),
    });

    expect(result.result).toBeUndefined();
    expect(result.errorDetails?.error).toBe(SANDBOX_UNAVAILABLE_ERROR);
    expect(result.errorDetails?.reason).toContain("isolated-vm");
    // Never silently downgraded to node:vm, which shares the host realm.
    expect(result.errorDetails?.alternatives).toContain("tool-cli");
    expect(JSON.stringify(result)).not.toContain("node:vm");
  });
});

describe("CodeModeManager sandbox probing", () => {
  it("starts unknown and stays active until proven otherwise", () => {
    const manager = new CodeModeManager();

    expect(manager.getSandboxAvailability().state).toBe("unknown");
    expect(manager.isActive).toBe(true);
  });

  it("deactivates with a reason when the addon is unavailable", async () => {
    setIsolatedVmForTests({ available: false, reason: "simulated absence" });
    const manager = new CodeModeManager();

    const availability = await manager.probeSandbox();

    expect(availability.state).toBe("unavailable");
    expect(availability.reason).toBe("simulated absence");
    expect(manager.isActive).toBe(false);
  });

  it("stays active when the addon loads", async () => {
    setIsolatedVmForTests({ available: true, module: fakeModule() });
    const manager = new CodeModeManager();

    await manager.probeSandbox();

    expect(manager.getSandboxAvailability().state).toBe("available");
    expect(manager.isActive).toBe(true);
  });

  it("does not probe the addon when a sandbox executor is injected", async () => {
    setIsolatedVmForTests({ available: false, reason: "should not be consulted" });
    const manager = new CodeModeManager({
      sandboxExecutor: async () => ({ result: 42, logs: [] }),
    });

    const availability = await manager.probeSandbox();

    expect(availability.state).toBe("available");
    expect(manager.isActive).toBe(true);
  });

  it("shares a single probe between concurrent callers", async () => {
    setIsolatedVmForTests({ available: false, reason: "simulated absence" });
    const manager = new CodeModeManager();

    const [a, b] = await Promise.all([manager.probeSandbox(), manager.probeSandbox()]);

    expect(a).toBe(b);
  });
});
