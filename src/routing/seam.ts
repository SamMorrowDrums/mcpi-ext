import type { ExecutionFacility } from "./facilities.js";

/**
 * Narrow feature-detection seam for a future mcpi core capability.
 *
 * If mcpi core ever grows `registerExecutionFacility`, the host owns rendering
 * and ordering of execution-facility guidance and mcpi-ext should hand over
 * structured descriptors instead of appending its own prompt section. Until
 * then — and mcpi core does not expose this today — the fallback in
 * `before_agent_start` renders the same descriptors itself.
 *
 * The two paths are mutually exclusive by construction, so a host that gains
 * the API cannot end up with the section twice.
 *
 * This file deliberately contains no type assertions: the guard narrows with
 * `in` plus a `typeof` check, so a host that merely happens to carry a
 * non-function property of the same name is correctly rejected.
 */
export interface ExecutionFacilityRegistrar {
  registerExecutionFacility(facility: ExecutionFacility): void;
}

/**
 * True when the host implements the (not-yet-existing) registration API.
 *
 * Narrowing without a cast: `in` refines the object type, and the `typeof`
 * check proves the member is callable before we treat it as such.
 */
export function supportsExecutionFacilityRegistration<T extends object>(
  host: T,
): host is T & ExecutionFacilityRegistrar {
  if (!("registerExecutionFacility" in host)) {
    return false;
  }
  return typeof host.registerExecutionFacility === "function";
}

/**
 * Hand the facility descriptors to the host if it can take them.
 *
 * Returns `true` when the host consumed them — in which case the caller must
 * not also emit the fallback prompt section. Returns `false` when the API is
 * absent, which is the current state of every shipped mcpi core.
 */
export function publishExecutionFacilities(
  host: object,
  facilities: readonly ExecutionFacility[],
): boolean {
  if (!supportsExecutionFacilityRegistration(host)) {
    return false;
  }

  for (const facility of facilities) {
    host.registerExecutionFacility(facility);
  }
  return true;
}
