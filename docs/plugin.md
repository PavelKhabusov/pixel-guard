# Figma plugin

Pulls design data through the Plugin API — no REST API, no rate limits.

## Export

- **Export snapshot** — the selected frames → `snapshots/<frame>.json` (+ `.png` with
  the checkbox). Breakpoints inside a section are labelled by width (1920 / 912 / 357).
- **Export whole project** — every page of the file; reusable blocks are matched by
  component, those on more than one page are marked **shared** (header, footer). Also
  writes `snapshots/_project.json`. `npm run modules -- --shared` lists them.

What goes into a snapshot: node tree with geometry, fills/strokes (with opacity), fonts,
auto-layout padding/gap, corner radius, component names. Vectors are exported as SVG
into a shared dictionary (`svgLib`, one copy per shape, up to 120 k chars each — enough
for a lettering logo). Mask nodes (`isMask`, clip paths from SVG imports) are flagged
and never drawn by the overlay.

## Figma in the browser

The plugin page lives on `https://www.figma.com`, so `http://localhost` is blocked as
mixed content. The server therefore also listens on `https://localhost:8972` with a
self-signed certificate (`config/cert/`, not in git). Open <https://localhost:8972/ping>
once ("🔐 Accept certificate") and accept the warning. Fallback: **Download JSON** →
`npm run import -- ~/Downloads/<frame>.pg.json`. Desktop uses plain HTTP on 8971.

## Live mode

Keeps an SSE connection to the server: node clicks go to the extension, render requests
come back from the CLI / MCP. Reconnects on its own (backoff + 70 s watchdog);
`GET /ping` shows `figmaAlive`.

## Renders

`/render?id=482:3672` renders a node via `exportAsync()`; `&bg=none` keeps transparency
(default is a white background — otherwise dark viewers show "on black"). The plugin
renders **one node at a time** (exportAsync is single-threaded; the server queue is
`PG_RENDER_PARALLEL`, default 1) and first scrolls the node into view on its page so
Figma loads its image fills — the reason big raster blocks used to hang. A render that
still exceeds the timeout (`&timeout=<sec>`, default 90) finishes in the background and
is served from the cache on retry.

`npm run shots` renders **every bound block** for the PNG overlay mode — see [cli.md](cli.md).

## Node id

Click a node on the canvas — the plugin panel shows its id and size with a copy button,
even with live mode off.
