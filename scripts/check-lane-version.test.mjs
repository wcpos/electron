import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { laneVersionProblem } from "./check-lane-version.mjs";

const root = new URL("..", import.meta.url);

test("1.11.0-next.671 matching itself is fine", () => {
  assert.equal(laneVersionProblem("1.11.0-next.671", "1.11.0-next.671"), null);
});

test("a plain 1.11.0 is a problem even when it matches (the bug #481)", () => {
  assert.equal(typeof laneVersionProblem("1.11.0", "1.11.0"), "string");
});

test("a mismatch is a problem and names both values", () => {
  const problem = laneVersionProblem("1.11.0-next.671", "1.11.0-next.672");
  assert.equal(typeof problem, "string");
  assert.ok(problem.includes("1.11.0-next.671") && problem.includes("1.11.0-next.672"));
});

test("a non-next prerelease is a problem", () => {
  assert.equal(typeof laneVersionProblem("1.11.0-beta.1", "1.11.0-beta.1"), "string");
});

test("a non-numeric next suffix is a problem", () => {
  assert.equal(typeof laneVersionProblem("1.11.0-next.x", "1.11.0-next.x"), "string");
});

test("every publish job checks the lane version after applying it", () => {
  const text = readFileSync(new URL(".github/workflows/tag-and-release.yml", root), "utf8");
  const lines = text.split("\n");
  const jobs = [];
  let current = null;
  for (const line of lines.slice(lines.indexOf("jobs:") + 1)) {
    if (/^  [a-z0-9-]+:$/.test(line)) jobs.push((current = { name: line.trim(), body: "" }));
    else if (current) current.body += `${line}\n`;
  }
  const publishJobs = jobs.filter((job) => job.body.includes("pnpm run publish-app"));
  assert.ok(publishJobs.length >= 4, `expected at least 4 publish jobs, found ${publishJobs.length}`);
  for (const { name, body } of publishJobs) {
    const apply = body.indexOf('npm version --no-git-tag-version "$LANE_VERSION"');
    const check = body.indexOf('node scripts/check-lane-version.mjs "$LANE_VERSION"');
    const publish = body.indexOf("pnpm run publish-app");
    assert.ok(apply >= 0, `${name} does not apply the lane version`);
    assert.ok(check > apply, `${name} does not check the lane version after applying it`);
    assert.ok(publish > check, `${name} publishes before applying and checking the lane version`);
  }
});
