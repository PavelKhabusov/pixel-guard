#!/bin/bash
for p in catalog about contacts ukladka oplata garantiya obmen rekomendaczii zhaloby pravovaya privacy rekvizity cookies; do
  echo "=== $p ==="
  timeout 180 node server/automap.mjs --page $p --viewport desktop --min 80 --write 2>&1 | tail -3
done
