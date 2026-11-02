// A next build with a plain x.y.z version is treated as stable and offered stable
// (#481), so Publish asserts package.json carries the lane version after it is applied (#483).
// Usage: node scripts/check-lane-version.mjs <expectedLaneVersion>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NEXT = /^\d+\.\d+\.\d+-next\.\d+$/;

export function laneVersionProblem(actual, expected) {
  if (actual !== expected) return `package.json version "${actual}" does not match the lane version "${expected}"`;
  if (!NEXT.test(actual)) return `version "${actual}" is not a next-lane version: a next-lane build must be x.y.z-next.N`;
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const problem = laneVersionProblem(version, process.argv[2]);
  if (problem) {
    console.log(`::error::${problem}`);
    process.exit(1);
  }
  console.log(`package.json version ${version} matches the lane version`);
}
