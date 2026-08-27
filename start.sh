#!/usr/bin/env bash
# pixel-guard: starts the server and opens Figma on the right design.
# One manual step remains — launching the plugin (Figma does not allow
# doing it programmatically), after which agents work without a human.
set -u
cd "$(dirname "$0")"

PORT=${PORT:-8971}
FILE_KEY=${PG_FILE_KEY:-$(sed -n 's/.*"fileKey"[: ]*"\([^"]*\)".*/\1/p' snapshots/_project.json 2>/dev/null | head -1)}
FIGMA_URL=${PG_FIGMA_URL:-}

say() { printf '\033[36m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }

# 1. server — leave it alone if already running
if curl -sf -m 2 "http://localhost:$PORT/ping" >/dev/null 2>&1; then
  say "✓ server already running on :$PORT"
else
  say "▶ starting ingest server…"
  nohup npm run server >/tmp/pixel-guard-server.log 2>&1 &
  for _ in $(seq 1 20); do
    curl -sf -m 1 "http://localhost:$PORT/ping" >/dev/null 2>&1 && break
    sleep 0.5
  done
  if curl -sf -m 2 "http://localhost:$PORT/ping" >/dev/null 2>&1; then
    say "✓ server started (log: /tmp/pixel-guard-server.log)"
  else
    warn "✗ server did not respond — see /tmp/pixel-guard-server.log"; exit 1
  fi
fi

# 2. plugin already connected? then nothing needs opening
if curl -sf -m 2 "http://localhost:$PORT/ping" | grep -q '"figma"'; then
  say "✓ Figma plugin already connected — all set, agents can work"
  exit 0
fi

# 3. open Figma on the right design
if [ -n "$FIGMA_URL" ]; then
  TARGET="$FIGMA_URL"
elif [ -n "$FILE_KEY" ]; then
  TARGET="figma://file/$FILE_KEY"
else
  TARGET=""
fi

if command -v figma-linux-next >/dev/null 2>&1; then
  if pgrep -f figma-linux-next >/dev/null; then
    say "✓ Figma already running"
  else
    say "▶ opening Figma${TARGET:+ on the design}…"
    nohup figma-linux-next ${TARGET:+"$TARGET"} >/dev/null 2>&1 &
    sleep 6
  fi
elif [ -n "$TARGET" ]; then
  xdg-open "$TARGET" >/dev/null 2>&1 &
else
  warn "Figma Desktop not found — open the design manually"
fi

cat <<'TXT'

One manual step remains (Figma does not allow launching plugins programmatically):
  Plugins → Development → pixel-guard → enable the "live mode" checkbox

After that, available without your involvement:
  curl "http://localhost:8971/render?id=<node-id>" -o pic.png   # image from the design
  curl "http://localhost:8971/find?q=<name>"                    # node search
  Claude agents — via MCP (figma_render_node, figma_find_nodes)

Check the connection:  curl -s http://localhost:8971/ping
TXT
