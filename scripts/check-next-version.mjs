// main→next syncs are hand-made merges that carry main's package.json version
// across. A next base version at or below stable ranks the development lane
// below the release, so CI on next requires a plain x.y.z strictly above main.
// Usage: node scripts/check-next-version.mjs <nextVersion> <stableVersion>
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLAIN = /^\d+\.\d+\.\d+$/;

export function nextVersionProblem(nextVersion, stableVersion) {
  if (!PLAIN.test(nextVersion)) return `next version "${nextVersion}" is not a plain x.y.z (Publish adds -next.N)`;
  if (!PLAIN.test(stableVersion)) return `stable version "${stableVersion}" is not a plain x.y.z`;
  const [a, b] = [nextVersion, stableVersion].map((v) => v.split(".").map(Number));
  const order = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return order > 0 ? null : `next version ${nextVersion} must be above stable ${stableVersion}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [nextVersion, stableVersion] = process.argv.slice(2);
  const problem = nextVersionProblem(nextVersion, stableVersion);
  if (problem) {
    console.log(`::error::${problem}`);
    process.exit(1);
  }
  console.log(`next version ${nextVersion} is ahead of stable ${stableVersion}`);
}
