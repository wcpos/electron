#!/usr/bin/env bash
# Tests latest-flag.sh against a stubbed gh, and the publish-flag wiring in tag-and-release.yml.
# Run: bash .github/scripts/test-latest-flag.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
script="$here/latest-flag.sh"
workflow="$here/../workflows/tag-and-release.yml"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0

# The stub logs its argv and lists $GH_STUB_TAGS. Like the real gh, it also lists a 2.0
# prerelease and a 2.0 draft unless told to exclude them, so a dropped flag flips the verdict.
mkdir "$tmp/bin"
cat >"$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_STUB_LOG"
case "${GH_STUB_MODE:-}" in
  fail) echo "HTTP 502: Bad Gateway" >&2; exit 1 ;;
  empty) exit 0 ;;
esac
for tag in $GH_STUB_TAGS; do echo "$tag"; done
[[ " $* " == *" --exclude-pre-releases "* ]] || echo v2.0.0-beta.1
[[ " $* " == *" --exclude-drafts "* ]] || echo v2.0.0
EOF
chmod +x "$tmp/bin/gh"

pre_ga="v1.11.9 v1.11.8 v1.10.3"
post_ga="v2.0.1 v2.0.0 v1.11.9"

# run <stub mode> <stub tags> <script args...>: sets out, err, rc; the gh argv lands in $tmp/gh.log.
run() {
  local mode=$1 tags=$2
  shift 2
  : >"$tmp/gh.log"
  set +e
  out=$(GH_STUB_MODE=$mode GH_STUB_TAGS=$tags GH_STUB_LOG="$tmp/gh.log" PATH="$tmp/bin:$PATH" \
    bash "$script" "$@" 2>"$tmp/err")
  rc=$?
  set -e
  err=$(cat "$tmp/err")
}

pass() { echo "ok   $1"; }
fail() {
  echo "FAIL $1" >&2
  fails=$((fails + 1))
}

# check <name> <rc> <stdout> [stderr substrings...]: with no substrings, stderr must be empty.
check() {
  local name=$1 want_rc=$2 want_out=$3 sub
  shift 3
  if [ "$rc" != "$want_rc" ] || [ "$out" != "$want_out" ]; then
    fail "$name: rc=$rc (want $want_rc) stdout='$out' (want '$want_out') stderr='$err'"
    return
  fi
  if [ $# -eq 0 ] && [ -n "$err" ]; then
    fail "$name: unexpected stderr '$err'"
    return
  fi
  for sub in "$@"; do
    if [[ "$err" != *"$sub"* ]]; then
      fail "$name: stderr '$err' lacks '$sub'"
      return
    fi
  done
  pass "$name"
}

run "" "$pre_ga" 1.11.10 true
check "before GA, latest=true" 0 "--latest"
for want in --exclude-drafts --exclude-pre-releases "--limit 1000"; do
  if grep -q -e "$want" "$tmp/gh.log"; then pass "gh argv carries $want"; else fail "gh argv lacks $want: $(cat "$tmp/gh.log")"; fi
done

run "" "$pre_ga" 1.11.10 false
check "before GA, latest=false warns" 0 "--latest=false" "::warning::" "updates.wcpos.com keeps serving the previous release" \
  "until gh release edit v1.11.10 --latest"

run "" "$post_ga" 1.11.10 false
check "after GA, latest=false" 0 "--latest=false"

run "" "$post_ga" 1.11.10 true
check "after GA, latest=true is refused" 1 "" "::error::" "cannot take Latest after 2.0"

for v in 1.11.10-next.42 2.0.0-beta.3; do
  run fail "" "$v" true
  check "$v prints nothing" 0 ""
  if [ -s "$tmp/gh.log" ]; then fail "$v called gh: $(cat "$tmp/gh.log")"; else pass "$v never calls gh"; fi
done

run fail "" 1.11.10 true
check "gh failing fails closed" 1 "" "::error::"

run empty "" 1.11.10 false
check "an empty release list fails closed" 1 "" "::error::"

for args in "1.11.10 yes" "1.11.10 TRUE" "1.11.10" ""; do
  # shellcheck disable=SC2086 # split the argument list on purpose
  run "" "$pre_ga" $args
  check "invalid arguments '$args'" 1 "" "::error::"
done

# Workflow order: the monorepo checkout at the workspace root wipes .release-tooling.
line_of() { grep -n -m1 -e "$1" "$workflow" | cut -d: -f1; }
tooling=$(line_of 'path: .release-tooling')
flag=$(line_of 'name: Resolve the publish flag')
monorepo=$(line_of 'repository: wcpos/monorepo')
if [ -n "$tooling" ] && [ -n "$monorepo" ] && [ "$tooling" -lt "$monorepo" ]; then
  pass ".release-tooling checkout precedes the monorepo checkout"
else
  fail ".release-tooling checkout (line '$tooling') must precede the monorepo checkout (line '$monorepo')"
fi
if [ -n "$flag" ] && [ -n "$monorepo" ] && [ "$flag" -lt "$monorepo" ]; then
  pass "Resolve the publish flag precedes the monorepo checkout"
else
  fail "Resolve the publish flag (line '$flag') must precede the monorepo checkout (line '$monorepo')"
fi

# Dry run of the release-notes step that prints the publish command.
awk '
  /name: .*Print the publish command/ { step = 1; next }
  step && !body && /^ *run: \|$/ { match($0, /^ */); indent = RLENGTH; body = 1; next }
  body {
    if ($0 ~ /^ *$/) { print ""; next }
    match($0, /^ */)
    if (RLENGTH <= indent) exit
    print substr($0, indent + 3)
  }
' "$workflow" >"$tmp/step.sh"
summary="$tmp/summary.md"
: >"$summary"
if [ ! -s "$tmp/step.sh" ]; then
  fail "could not extract the Print the publish command run block"
else
  step_out=$(VERSION=1.11.10 LATEST_FLAG=--latest=false GITHUB_REPOSITORY=wcpos/electron GITHUB_STEP_SUMMARY="$summary" \
    bash -euo pipefail "$tmp/step.sh")
  for want in "::notice::" "gh release edit v1.11.10 -R wcpos/electron" "--draft=false --latest=false"; do
    if [[ "$step_out" == *"$want"* ]]; then pass "step output carries '$want'"; else fail "step output '$step_out' lacks '$want'"; fi
  done
  for want in "gh release edit v1.11.10 -R" "--draft=false --latest=false"; do
    if grep -q -F -e "$want" "$summary"; then pass "step summary carries '$want'"; else fail "step summary lacks '$want': $(cat "$summary")"; fi
  done
fi

if [ "$fails" -gt 0 ]; then
  echo "$fails check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
