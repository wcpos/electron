import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rendererRxdbProblems } from "./check-renderer-rxdb.mjs";

const root = new URL("..", import.meta.url);
const pins = { rxdb: "17.5.0", "rxdb-premium": "17.5.0" };
const dep = (name, version) => ({ [name]: { from: name, version, resolved: "x", path: "x" } });
const matching = () => [
  { name: "@wcpos/monorepo", version: "1.11.0", path: "/r", private: true, devDependencies: dep("rxdb", "17.5.0") },
  { name: "@wcpos/database", version: "1.11.0", path: "/d", dependencies: { ...dep("rxdb", "17.5.0"), ...dep("rxdb-premium", "17.5.0") } },
  { name: "@wcpos/query", version: "1.11.0", path: "/q", dependencies: dep("rxdb", "17.5.0") },
  { name: "@wcpos/sync-engine", version: "1.11.0", path: "/s", dependencies: dep("rxdb", "17.5.0"), devDependencies: dep("rxdb-premium", "17.5.0") },
  { name: "@wcpos/utils", version: "1.11.0", path: "/u" },
];

test("(a) every project matching the pins, in dependencies and devDependencies, is fine", () => {
  assert.deepEqual(rendererRxdbProblems(matching(), pins), []);
});

test("(b) one project on rxdb 17.4.0 is exactly one problem naming it and both versions", () => {
  const projects = matching();
  projects[2].dependencies = dep("rxdb", "17.4.0");
  const problems = rendererRxdbProblems(projects, pins);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes("@wcpos/query") && problems[0].includes("17.4.0") && problems[0].includes("17.5.0"), problems[0]);
});

test("(c) a devDependencies rxdb-premium mismatch is caught", () => {
  const projects = matching();
  projects[3].devDependencies = dep("rxdb-premium", "17.6.0");
  const problems = rendererRxdbProblems(projects, pins);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes("@wcpos/sync-engine") && problems[0].includes("rxdb-premium") && problems[0].includes("17.6.0"), problems[0]);
});

test("(d) no project resolving rxdb-premium is a problem", () => {
  const projects = matching();
  delete projects[1].dependencies["rxdb-premium"];
  delete projects[3].devDependencies;
  const problems = rendererRxdbProblems(projects, pins);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes("no workspace package resolves rxdb-premium"), problems[0]);
});

test("(e) a missing pin is a problem", () => {
  assert.equal(rendererRxdbProblems(matching(), { rxdb: "17.5.0" }).length, 1);
  assert.equal(rendererRxdbProblems(matching(), { rxdb: "", "rxdb-premium": "17.5.0" }).length, 1);
  assert.ok(rendererRxdbProblems(matching(), undefined).length >= 1);
});

test("(f) projects that are not an array are a problem", () => {
  assert.equal(rendererRxdbProblems({ name: "@wcpos/database" }, pins).length, 1);
  assert.equal(rendererRxdbProblems(undefined, pins).length, 1);
});

test("(g) an optionalDependencies mismatch is caught", () => {
  const projects = matching();
  projects[4].optionalDependencies = dep("rxdb", "16.0.0");
  const problems = rendererRxdbProblems(projects, pins);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes("@wcpos/utils") && problems[0].includes("16.0.0"), problems[0]);
});

test("the CLI exits 0 with the success line on a match and 1 with ::error:: on a mismatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "renderer-rxdb-"));
  const script = fileURLToPath(new URL("./check-renderer-rxdb.mjs", import.meta.url));
  const pkg = join(dir, "package.json");
  writeFileSync(pkg, JSON.stringify({ name: "wcpos", dependencies: pins }));
  const run = (projects) => {
    const list = join(dir, "pnpm-list.json");
    writeFileSync(list, JSON.stringify(projects));
    return spawnSync(process.execPath, [script, list, pkg], { encoding: "utf8" });
  };
  const ok = run(matching());
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.stdout.trim(), "renderer rxdb 17.5.0 and rxdb-premium 17.5.0 match the main process in 4 workspace packages");
  const projects = matching();
  projects[1].dependencies.rxdb.version = "17.4.0";
  const bad = run(projects);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.ok(bad.stdout.includes("::error::"), bad.stdout);
});

test("build-expo checks the renderer rxdb after installing the monorepo and before building", () => {
  const text = readFileSync(new URL(".github/workflows/tag-and-release.yml", root), "utf8");
  const lines = text.split("\n");
  const jobs = [];
  let current = null;
  for (const line of lines.slice(lines.indexOf("jobs:") + 1)) {
    if (/^  [a-z0-9-]+:$/.test(line)) jobs.push((current = { name: line.trim(), body: "" }));
    else if (current) current.body += `${line}\n`;
  }
  const job = jobs.find(({ name }) => name === "build-expo:");
  assert.ok(job, "no build-expo job");
  const setup = job.body.indexOf("- name: 🏗 Setup Monorepo");
  const start = job.body.indexOf("- name: 🔒 Renderer rxdb matches the main process");
  const build = job.body.indexOf("- name: 🔨 Build Expo for Electron");
  assert.ok(setup >= 0 && build >= 0, "build-expo lost its Setup Monorepo or Build Expo step");
  assert.ok(start > setup, "the renderer rxdb check does not run after Setup Monorepo");
  assert.ok(build > start, "the renderer rxdb check does not run before Build Expo for Electron");
  const next = job.body.indexOf("\n      - name:", start);
  const step = job.body.slice(start, next < 0 ? undefined : next);
  assert.ok(step.includes("scripts/check-renderer-rxdb.mjs?ref=$GITHUB_SHA"), "the step does not fetch the check at the pushed commit");
  assert.ok(step.includes("pnpm list -r --depth 0 --json rxdb rxdb-premium"), "the step does not list the workspace rxdb packages");
});
