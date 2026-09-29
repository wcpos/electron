import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("..", import.meta.url);

function setupNodeViolations(text, file) {
  const lines = text.split(/\r?\n/);
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const step = lines[i].match(/^(\s*)- /);
    if (!step) continue;
    const indent = step[1].length;
    let end = i + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() && !line.trimStart().startsWith("#") &&
          line.search(/\S/) <= indent) break;
      end++;
    }
    const block = lines.slice(i, end).map((line, index) =>
      index === 0 ? line.replace("- ", "  ") : line,
    );
    const uses = block.map((line) => line.slice(indent + 2))
      .find((line) => /^uses:\s*/.test(line));
    const action = uses?.match(/^uses:\s*["']?([^\s"']+)/)?.[1];
    if (!action) continue;

    const withIndex = block.findIndex((line) =>
      /^with:\s*(?:#.*)?$/.test(line.slice(indent + 2)),
    );
    const inputs = [];
    if (withIndex !== -1) {
      for (const line of block.slice(withIndex + 1)) {
        if (!line.trim() || line.trimStart().startsWith("#")) continue;
        if (line.search(/\S/) <= indent + 2) break;
        inputs.push(line);
      }
    }
    const disabled = inputs.some((line) =>
      /^\s+package-manager-cache:\s*false\s*(?:#.*)?$/.test(line),
    );
    const cache = inputs.some((line) => /^\s+cache:/.test(line));

    if (action.startsWith("actions/setup-node@") && (!disabled || cache)) {
      violations.push(`${file}:${i + 1}: setup-node requires package-manager-cache: false and no cache input`);
    }
    if (action.startsWith("actions/cache@") || action.startsWith("actions/cache/save@")) {
      violations.push(`${file}:${i + 1}: ${action} can save patched dependencies to the Actions cache`);
    }
    if (action.startsWith("pnpm/action-setup@") && cache) {
      violations.push(`${file}:${i + 1}: pnpm/action-setup must not have a cache input`);
    }
    i = end - 1;
  }
  return violations;
}

test("repo workflows and local actions keep patched dependencies out of caches", () => {
  const violations = [];
  let setupNodeCount = 0;
  for (const directory of [".github/workflows/", ".github/actions/"]) {
    for (const entry of readdirSync(new URL(directory, root), { recursive: true })) {
      const included = directory === ".github/workflows/"
        ? /\.ya?ml$/.test(entry)
        : /(?:^|\/)action\.ya?ml$/.test(entry);
      if (!included) continue;
      const file = directory + entry;
      const text = readFileSync(new URL(file, root), "utf8");
      violations.push(...setupNodeViolations(text, file));
      setupNodeCount += [...text.matchAll(/^\s*(?:- )?uses:\s*["']?actions\/setup-node@/gm)].length;
    }
  }
  assert.ok(setupNodeCount > 0, "expected at least one actions/setup-node step");
  assert.deepEqual(violations, []);
});

test(".npmrc disables pnpm's side-effects cache", () => {
  const lines = readFileSync(new URL(".npmrc", root), "utf8").split(/\r?\n/);
  assert.ok(lines.some((line) => line.trim() === "side-effects-cache=false"));
});

test("setup-node without with is rejected", () => {
  assert.equal(setupNodeViolations(`
- uses: actions/setup-node@v5
`, "fixture").length, 1);
});

test("setup-node without package-manager-cache is rejected", () => {
  assert.equal(setupNodeViolations(`
- uses: actions/setup-node@v5
  with:
    node-version: 22
`, "fixture").length, 1);
});

test("setup-node with package-manager-cache true is rejected", () => {
  assert.equal(setupNodeViolations(`
- uses: actions/setup-node@v5
  with:
    package-manager-cache: true
`, "fixture").length, 1);
});

test("setup-node with an explicit cache is rejected", () => {
  assert.equal(setupNodeViolations(`
- uses: actions/setup-node@v5
  with:
    package-manager-cache: false
    cache: pnpm
`, "fixture").length, 1);
});

test("cache-dependency-path is not a cache input", () => {
  assert.equal(setupNodeViolations(`
- uses: actions/setup-node@v5
  with:
    package-manager-cache: false
    cache-dependency-path: x
`, "fixture").length, 0);
});

test("named setup-node steps with caching disabled are allowed", () => {
  assert.equal(setupNodeViolations(`
- name: x
  uses: actions/setup-node@v5
  with:
    package-manager-cache: false
`, "fixture").length, 0);
});

test("actions/cache is rejected", () => {
  assert.equal(setupNodeViolations(`
- uses: actions/cache@v4
`, "fixture").length, 1);
});

test("actions/cache/restore is allowed", () => {
  assert.equal(setupNodeViolations(`
- uses: actions/cache/restore@v4
`, "fixture").length, 0);
});

test("a compliant setup-node step cannot hide a later violation", () => {
  assert.equal(setupNodeViolations(`
- uses: actions/setup-node@v5
  with:
    package-manager-cache: false
- uses: actions/setup-node@v5
`, "fixture").length, 1);
});

test("actions/cache/save is rejected", () => {
  assert.equal(setupNodeViolations(`
- uses: actions/cache/save@v4
`, "fixture").length, 1);
});

test("pnpm/action-setup with a cache input is rejected", () => {
  assert.equal(setupNodeViolations(`
- uses: pnpm/action-setup@v4
  with:
    cache: true
`, "fixture").length, 1);
});
