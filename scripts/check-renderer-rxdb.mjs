// storage-remote needs the renderer's rxdb to be exactly the main process's, but drift only checks
// .monorepo-ref, so Publish checks the monorepo it actually installed against our pins (#485).
// Usage: node scripts/check-renderer-rxdb.mjs <pnpm-list.json> <electron-package.json>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAMES = ["rxdb", "rxdb-premium"];
const KINDS = ["dependencies", "devDependencies", "optionalDependencies"];
const entries = (project, name) => KINDS.map((kind) => project?.[kind]?.[name]).filter(Boolean);

export function rendererRxdbProblems(projects, pins) {
  if (!Array.isArray(projects)) return ["pnpm list output is not an array of workspace projects"];
  const problems = [];
  for (const name of NAMES) {
    const pin = pins?.[name];
    if (typeof pin !== "string" || !pin) { problems.push(`the main process has no ${name} pin in package.json dependencies`); continue; }
    const found = projects.flatMap((project) => entries(project, name).map((entry) => ({ project, entry })));
    if (found.length === 0) problems.push(`no workspace package resolves ${name}`);
    for (const { project, entry } of found)
      if (entry.version !== pin) problems.push(`${project.name} resolves ${name} ${entry.version} but the main process pins ${pin}`);
  }
  return problems;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projects = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const pins = JSON.parse(readFileSync(process.argv[3], "utf8")).dependencies;
  const problems = rendererRxdbProblems(projects, pins);
  for (const problem of problems) console.log(`::error::${problem}`);
  if (problems.length) process.exit(1);
  const count = projects.filter((project) => NAMES.some((name) => entries(project, name).length)).length;
  console.log(`renderer rxdb ${pins.rxdb} and rxdb-premium ${pins["rxdb-premium"]} match the main process in ${count} workspace packages`);
}
