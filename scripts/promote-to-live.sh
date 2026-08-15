#!/bin/sh
# Promote staging's UI to live, with the check that matters done for you.
#
# The promote is "take staging's index.html wholesale" — NOT a branch merge,
# because staging deliberately lags main on scripts/ and data (data-only changes
# go straight to main). A merge would drag that staleness back.
#
# The danger that check exists for: if main's index.html has moved on since
# staging last took it, copying staging's copy over reverts that work silently.
# On 2026-08-15 the mirror image nearly happened — main's copy was pasted onto
# staging and would have wiped four commits. Both directions are unsafe unless
# one side is provably built on the other, so verify before writing anything.
#
# Usage:  ./scripts/promote-to-live.sh ["commit subject"]
set -e

cd "$(dirname "$0")/.."
SUBJECT=${1:-"Promote staging UI to live"}

git fetch -q origin

if git diff --quiet origin/main:public/index.html origin/staging:public/index.html; then
  echo "Nothing to promote — staging and main already have the same index.html."
  exit 0
fi

# The safety check. Walk back through staging's history to the most recent commit
# whose index.html matches main's current one. If none exists, staging never had
# main's current UI and promoting would drop whatever main gained.
echo "Verifying staging is a clean superset of main..."
BASE=""
for c in $(git rev-list -n 60 origin/staging); do
  if git diff --quiet "$c:public/index.html" origin/main:public/index.html 2>/dev/null; then
    BASE=$c
    break
  fi
done

if [ -z "$BASE" ]; then
  echo >&2
  echo >&2 "  ABORT: no commit in staging's recent history has main's current index.html."
  echo >&2 "  main has UI content staging never took, so promoting would silently revert it."
  echo >&2
  echo >&2 "  Compare them before going further:"
  echo >&2 "      git diff origin/main:public/index.html origin/staging:public/index.html"
  echo >&2
  exit 1
fi

echo "  OK — main's index.html matches staging at $(git log --oneline -1 "$BASE")"
echo "  Promoting these commits:"
git log --oneline "$BASE"..origin/staging -- public/index.html | sed 's/^/    /'

git checkout -q main
git pull -q --rebase origin main
git checkout origin/staging -- public/index.html

# node --check cannot parse HTML, so pull each inline <script> out and compile it.
# A promote that ships a syntax error takes the whole site down, not one panel.
node -e '
const fs=require("fs"), vm=require("vm");
const h=fs.readFileSync("public/index.html","utf8");
let bad=0;
for (const [i,m] of [...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].entries()) {
  try { new vm.Script(m[1]); } catch (e) { bad++; console.error("script block "+i+": "+e.message); }
}
for (const [i,m] of [...h.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].entries()) {
  const o=(m[1].match(/\/\*/g)||[]).length, c=(m[1].match(/\*\//g)||[]).length;
  if (o!==c) { bad++; console.error("style block "+i+": unbalanced comments ("+o+" open, "+c+" close)"); }
}
if (bad) { console.error("REFUSING TO PROMOTE: "+bad+" problem(s)"); process.exit(1); }
console.log("  index.html parses cleanly");
'

JD_PROMOTE=1 git commit -q -m "$SUBJECT" -m "Takes staging's index.html wholesale; verified as a clean superset of main."
git push -q origin main
echo "Promoted: $(git log --oneline -1)"
