#!/bin/bash
for p in home product catalog about contacts ukladka oplata garantiya obmen rekomendaczii zhaloby pravovaya privacy rekvizity cookies stati statya; do
  timeout 200 node server/automap.mjs --page $p --viewport desktop --min 75 --write 2>&1 | grep -E 'дописано|сопоставлено' | sed "s/^/[$p] /"
done
