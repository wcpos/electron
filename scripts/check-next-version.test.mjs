import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nextVersionProblem } from "./check-next-version.mjs";

const root = new URL("..", import.meta.url);

test("1.11.0 is ahead of 1.10.27", () => {
  assert.equal(nextVersionProblem("1.11.0", "1.10.27"), null);
});

test("1.10.28 is ahead of 1.10.27", () => {
  assert.equal(nextVersionProblem("1.10.28", "1.10.27"), null);
});

test("2.0.0 is ahead of 1.10.27", () => {
  assert.equal(nextVersionProblem("2.0.0", "1.10.27"), null);
});

test("1.10.27 equal to stable is a problem", () => {
  assert.equal(typeof nextVersionProblem("1.10.27", "1.10.27"), "string");
});

test("1.10.19 below stable is a problem (the bug #483 fixes)", () => {
  assert.equal(typeof nextVersionProblem("1.10.19", "1.10.27"), "string");
});

test("the below-stable message says how to fix it", () => {
  assert.ok(nextVersionProblem("1.10.19", "1.10.27").includes("bump next's version in package.json above main's"));
});

test("1.9.99 is below 1.10.27 (numeric, not string, comparison)", () => {
  assert.equal(typeof nextVersionProblem("1.9.99", "1.10.27"), "string");
});

test("a prerelease next version is a problem", () => {
  assert.equal(typeof nextVersionProblem("1.11.0-next.1", "1.10.27"), "string");
});

test("a two-part next version is a problem", () => {
  assert.equal(typeof nextVersionProblem("1.11", "1.10.27"), "string");
});

test("a malformed stable version is a problem", () => {
  assert.equal(typeof nextVersionProblem("1.11.0", "garbage"), "string");
});

test("the repo's package.json version is a plain x.y.z", () => {
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});
