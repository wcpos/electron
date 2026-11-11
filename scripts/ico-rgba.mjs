// Re-encode every RGB PNG entry of an .ico as RGBA (alpha 255, same pixels), then check it.
// Usage: node scripts/ico-rgba.mjs <in.ico> <out.ico>   (in and out may be the same file)
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { icoProblems, icoWithRgbaPngs, readIco } from "./ico.mjs";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error("usage: node scripts/ico-rgba.mjs <in.ico> <out.ico>");
    process.exit(2);
  }
  const [input, output] = args;
  const fixed = icoWithRgbaPngs(readFileSync(input));
  writeFileSync(output, fixed);
  const problems = icoProblems(fixed);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`ok ${output} ${readIco(fixed).entries.length} entries`);
}
