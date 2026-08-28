# Architecture

## Why a custom tool

Uiprobe, Over.fig, Overlayly, OnePixel, PerfectPixel, Visualign were evaluated. None
covers the chain: no reliable "Figma block ↔ HTML element" binding, no per-element style
comparison (visual overlay only), they break on unfinished pages, do not understand
reusable blocks, depend on the rate-limited REST API, and give "93 % match" instead of
"font-size 46→48px on `.hero-title`" — the output an agent can act on.

Decisions: Plugin API only as the data source; bindings in an external map file (no
`data-figma` attributes in the site); CLI + `report.json` as the contract for Claude,
MCP on top.

## Parts

```
Figma
 └─ plugin/ (TypeScript)       walks frames → node tree; exportAsync() for PNG/SVG
        │ POST /ingest · SSE /bus (live mode)
server/ (Node)
 ├─ ingest.mjs                 HTTP 8971 + HTTPS 8972: snapshots, /overlay, /nodes,
 │                             /render (queue), /report, /map, SSE bus
 ├─ run.mjs · all.mjs          Playwright collector + comparator → reports/
 ├─ automap · verify · shots · patch · pixdiff · modules · import · repair
 ├─ lib/compare.mjs            comparison rules (shared with the extension logic)
 ├─ lib/inset.mjs              effective padding (runs inside the page)
 └─ mcp.mjs                    MCP tools for Claude
extension/ (Chrome MV3)
 ├─ background.js              server connection, allowed hosts, per-tab side panel,
 │                             CDP viewport emulation
 ├─ content.js                 overlay drawing, diff against the live DOM, picking
 └─ panel.js / options.js      side panel UI, hosts list
```

Data on disk: `snapshots/*.json` (+ `_project.json`, `shots/`), `maps/*.map.json`,
`config/pages.json`, `reports/*`. Only `*.example.*` are committed.

## Flows

- **Snapshot**: plugin → `/ingest` → `snapshots/<frame>.json`.
- **Check page**: panel → `/nodes?url&viewport` (nodes for the map keys) → content
  script diffs against the DOM → panel → `POST /report`.
- **Overlay**: panel → `/overlay?url&viewport` (boxes with anchors, svgLib, shots) →
  content script places blocks on their bound elements.
- **Live bridge**: plugin `POST /emit` → SSE → background → content → panel.
- **Render**: CLI/MCP → `/render` → bus → plugin `exportAsync` → `/render-result`.

## Known pitfalls

- Own plugin needs edit access to the file (use a copy in drafts).
- Browser Figma blocks `http://localhost` — hence the HTTPS listener and the
  download-JSON fallback.
- Site CSPs block `http://localhost` in `img-src` — renders reach the page as `data:` URIs.
- Auto-layout ↔ CSS: gap/padding map onto flex, but padding often sits on a nested
  container on the site — compared by effective inset.
- WordPress content differs from the design — text matching is partial, styles are
  compared regardless.
- Browser font metrics ≠ Figma by 1–2 px — tolerance, not a bug.
- Comparison runs against a live staging server — batch runs, no Playwright loops.

Not done from the original plan: side-by-side view inside `report.html`.
