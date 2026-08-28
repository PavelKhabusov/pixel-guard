#!/usr/bin/env bash
# Mirrors docs/*.md into the GitHub wiki (a separate git repo <repo>.wiki.git).
# docs/README.md becomes Home, relative links between pages are rewritten to wiki names.
# The wiki must exist: create the first page once on GitHub (Wiki → Create → Save).
set -euo pipefail
cd "$(dirname "$0")"

WIKI_URL=$(git remote get-url origin | sed -E 's#(\.git)?$#.wiki.git#')
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git clone -q "$WIKI_URL" "$WORK" || { echo "wiki repo not found — create the first page on GitHub, then rerun"; exit 1; }
find "$WORK" -maxdepth 1 -name '*.md' -delete

# page name = H1 title ("Extension panel" → Extension-panel); README → Home
declare -A PAGE
for f in docs/*.md; do
  base=$(basename "$f" .md)
  if [ "$base" = README ]; then PAGE[$base]=Home
  else PAGE[$base]=$(grep -m1 '^# ' "$f" | sed 's/^# //; s/ /-/g'); fi
done

SED=''
for base in "${!PAGE[@]}"; do SED+="s#\]\($base\.md\)#](${PAGE[$base]})#g;"; done

for f in docs/*.md; do
  base=$(basename "$f" .md)
  sed -E "$SED" "$f" > "$WORK/${PAGE[$base]}.md"
done

{
  echo "**pixel-guard**"
  echo
  for f in docs/*.md; do
    base=$(basename "$f" .md); [ "$base" = README ] && continue
    echo "- [${PAGE[$base]//-/ }](${PAGE[$base]})"
  done
} > "$WORK/_Sidebar.md"

cd "$WORK"
git add -A
if git diff --cached --quiet; then echo "wiki is up to date"; exit 0; fi
git -c user.name="$(git -C "$OLDPWD" config user.name)" -c user.email="$(git -C "$OLDPWD" config user.email)" \
  commit -q -m "docs sync $(date +%F)"
git push -q
echo "wiki updated: ${WIKI_URL%.git}"
