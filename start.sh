#!/usr/bin/env bash
# pixel-guard: поднимает сервер и открывает Figma на нужном макете.
# Дальше остаётся один ручной шаг — запустить плагин (Figma не даёт
# сделать это программно), после чего агенты работают без участия человека.
set -u
cd "$(dirname "$0")"

PORT=${PORT:-8971}
FILE_KEY=${PG_FILE_KEY:-$(sed -n 's/.*"fileKey"[: ]*"\([^"]*\)".*/\1/p' snapshots/_project.json 2>/dev/null | head -1)}
FIGMA_URL=${PG_FIGMA_URL:-}

say() { printf '\033[36m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }

# 1. сервер — если уже поднят, не трогаем
if curl -sf -m 2 "http://localhost:$PORT/ping" >/dev/null 2>&1; then
  say "✓ сервер уже работает на :$PORT"
else
  say "▶ запускаю ingest-сервер…"
  nohup npm run server >/tmp/pixel-guard-server.log 2>&1 &
  for _ in $(seq 1 20); do
    curl -sf -m 1 "http://localhost:$PORT/ping" >/dev/null 2>&1 && break
    sleep 0.5
  done
  if curl -sf -m 2 "http://localhost:$PORT/ping" >/dev/null 2>&1; then
    say "✓ сервер поднят (лог: /tmp/pixel-guard-server.log)"
  else
    warn "✗ сервер не ответил — смотри /tmp/pixel-guard-server.log"; exit 1
  fi
fi

# 2. плагин уже на связи? тогда ничего открывать не нужно
if curl -sf -m 2 "http://localhost:$PORT/ping" | grep -q '"figma"'; then
  say "✓ плагин Figma уже на связи — всё готово, агенты могут работать"
  exit 0
fi

# 3. открываем Figma на нужном макете
if [ -n "$FIGMA_URL" ]; then
  TARGET="$FIGMA_URL"
elif [ -n "$FILE_KEY" ]; then
  TARGET="figma://file/$FILE_KEY"
else
  TARGET=""
fi

if command -v figma-linux-next >/dev/null 2>&1; then
  if pgrep -f figma-linux-next >/dev/null; then
    say "✓ Figma уже запущена"
  else
    say "▶ открываю Figma${TARGET:+ на макете}…"
    nohup figma-linux-next ${TARGET:+"$TARGET"} >/dev/null 2>&1 &
    sleep 6
  fi
elif [ -n "$TARGET" ]; then
  xdg-open "$TARGET" >/dev/null 2>&1 &
else
  warn "Figma Desktop не найдена — открой макет вручную"
fi

cat <<'TXT'

Остался один шаг вручную (Figma не позволяет запускать плагины программно):
  Plugins → Development → pixel-guard → включи чекбокс «живой режим»

После этого доступно без твоего участия:
  curl "http://localhost:8971/render?id=<node-id>" -o pic.png   # картинка из макета
  curl "http://localhost:8971/find?q=<имя>"                     # поиск нод
  агенты Claude — через MCP (figma_render_node, figma_find_nodes)

Проверить связь:  curl -s http://localhost:8971/ping
TXT
