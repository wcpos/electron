// Runs every `test:*` script in package.json in file order, stopping at the first failure.
// A new suite needs only its own `"test:<name>"` entry; this file does not change.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Needs a packaged app (`pnpm make` output), so it is not part of `pnpm test`.
const excluded = new Set(["test:smoke-packaged"]);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const suites = Object.keys(pkg.scripts).filter((name) => name.startsWith("test:") && !excluded.has(name));

for (const name of suites) {
  const { status } = spawnSync("pnpm", ["run", name], { stdio: "inherit", shell: process.platform === "win32" });
  if (status !== 0) {
    console.error(`run-tests: ${name} failed (exit ${status ?? "null"})`);
    process.exit(status ?? 1);
  }
}
