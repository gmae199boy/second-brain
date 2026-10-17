/**
 * Lowest node this build runs on, and the comparison that decides it.
 *
 * It is its own module because three things need it and two of them cannot
 * import each other: `doctor/checks.ts` reports on the node a shim names, and
 * `install/shim.ts` writes the `sh` that goes looking for one. A second
 * spelling of a floor is how an installer comes to accept a node the hooks then
 * fail on, and a test holds this one against the root `package.json`'s
 * `engines.node`.
 */

/** The floor, as `major.minor.patch`. */
export const NODE_FLOOR = '24.16.0';

/** Whether a version is at or above `NODE_FLOOR`. */
export function meetsNodeFloor(version: string): boolean {
  return atLeast(version, NODE_FLOOR);
}

/**
 * Whether `version` is at or above `floor`, comparing major, minor and patch as
 * numbers. Anything after the patch — `-nightly`, `+build` — is ignored: a
 * prerelease of a version at the floor is close enough for a check that is
 * about "is this node too old", and the alternative is semver's whole order for
 * one comparison.
 */
export function atLeast(version: string, floor: string): boolean {
  const left = parts(version);
  const right = parts(floor);
  if (left === undefined || right === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    const mine = left[index] ?? 0;
    const theirs = right[index] ?? 0;
    if (mine !== theirs) return mine > theirs;
  }
  return true;
}

/** The three numbers of a version, from text that may start with `v`. */
function parts(value: string): [number, number, number] | undefined {
  const matched = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  const [major, minor, patch] = [matched?.[1], matched?.[2], matched?.[3]];
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return [Number(major), Number(minor), Number(patch)];
}
