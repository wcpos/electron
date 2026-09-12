#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ref=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' .monorepo-ref)
readonly pairs=(
  "src/main/opfs-targeted-recovery.mjs:scripts/opfs-targeted-recovery.mjs"
  "src/main/opfs-targeted-recovery.test.mjs:scripts/opfs-targeted-recovery.test.mjs"
  "scripts/patch-rxdb-premium-changes-file-salvage.mjs:scripts/patch-rxdb-premium-changes-file-salvage.mjs"
  "scripts/rxdb-premium-changes-file-salvage.test.mjs:scripts/rxdb-premium-changes-file-salvage.test.mjs"
  "scripts/patch-rxdb-premium-task-queue-containment.mjs:scripts/patch-rxdb-premium-task-queue-containment.mjs"
  "scripts/rxdb-premium-task-queue-containment.test.mjs:scripts/rxdb-premium-task-queue-containment.test.mjs"
  "scripts/patch-rxdb-premium-changelog-replay-safety.mjs:scripts/patch-rxdb-premium-changelog-replay-safety.mjs"
  "scripts/patch-rxdb-premium-changelog-identity.mjs:scripts/patch-rxdb-premium-changelog-identity.mjs"
  "scripts/rxdb-premium-changelog-identity.test.mjs:scripts/rxdb-premium-changelog-identity.test.mjs"
)
# scripts/patch-rxdb-premium-resurrection-leak.mjs differs intentionally; excluded.
readonly fix="copy the monorepo file over the local one, or bump .monorepo-ref"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
mismatches=0

for pair in "${pairs[@]}"; do
  local_path=${pair%%:*}
  monorepo_path=${pair#*:}
  gh api "repos/wcpos/monorepo/contents/$monorepo_path?ref=$ref" \
    -H "Accept: application/vnd.github.raw" > "$tmp"
  local_sha=$(shasum -a 256 "$local_path" | cut -d ' ' -f 1)
  monorepo_sha=$(shasum -a 256 "$tmp" | cut -d ' ' -f 1)
  if [ "$local_sha" != "$monorepo_sha" ]; then
    echo "$local_path != wcpos/monorepo/$monorepo_path at $ref: $fix"
    mismatches=1
  fi
done

gh api "repos/wcpos/monorepo/contents/package.json?ref=$ref" \
  -H "Accept: application/vnd.github.raw" > "$tmp"
for dependency in rxdb rxdb-premium; do
  local_version=$(jq -r --arg dep "$dependency" '.dependencies[$dep]' package.json)
  monorepo_version=$(jq -r --arg dep "$dependency" '.devDependencies[$dep]' "$tmp")
  if [ "$local_version" != "$monorepo_version" ]; then
    echo "package.json (dependencies.$dependency=$local_version) != wcpos/monorepo/package.json (devDependencies.$dependency=$monorepo_version) at $ref: $fix"
    mismatches=1
  fi
done

exit "$mismatches"
