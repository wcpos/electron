#!/usr/bin/env bash
# Usage: latest-flag.sh <version> <true|false>
# Prints the `gh release edit` Latest flag for a 1.11 desktop release, and nothing else on stdout.
# updates.wcpos.com serves releases/latest, so once a stable v2+ release is published a 1.11
# release taking Latest would offer 2.0 users a downgrade: that request is refused. Fails closed
# when the release list cannot be read. A -next/-beta version is never Latest and prints nothing.
set -euo pipefail

version=${1:-}
latest=${2:-}
if [ -z "$version" ] || { [ "$latest" != true ] && [ "$latest" != false ]; }; then
  echo "::error::usage: latest-flag.sh <version> <true|false> (got '$version' '$latest')" >&2
  exit 1
fi

case "$version" in
  *-next* | *-beta*) exit 0 ;;
esac

if ! tags=$(gh release list --exclude-drafts --exclude-pre-releases --limit 1000 --json tagName --jq '.[].tagName'); then
  echo "::error::Could not list published releases, so cannot tell whether 2.0 is out; refusing to choose a Latest flag." >&2
  exit 1
fi
if [ -z "$tags" ]; then
  echo "::error::The published release list is empty, so cannot tell whether 2.0 is out; refusing to choose a Latest flag." >&2
  exit 1
fi

# A here-string, not a pipe: grep -q exiting early would SIGPIPE printf and, under pipefail,
# read as "2.0 is not out".
if grep -Eq '^v[2-9]\.' <<<"$tags"; then
  if [ "$latest" = true ]; then
    echo "::error::A 1.11 release cannot take Latest after 2.0: updates.wcpos.com serves releases/latest, so v$version would offer 2.0 users a downgrade. Re-run with latest=false." >&2
    exit 1
  fi
  echo "--latest=false"
elif [ "$latest" = true ]; then
  echo "--latest"
else
  echo "::warning::v$version will not be Latest: updates.wcpos.com keeps serving the previous release and desktop users will not get this build until gh release edit v$version --latest" >&2
  echo "--latest=false"
fi
