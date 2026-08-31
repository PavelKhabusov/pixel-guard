# MCP server for Claude agents

Gives Claude Code the design **through the plugin** — no Figma REST API, no limits — and
a headless browser to measure the live page, so a block is verified in one call.

```bash
claude mcp add pixel-guard -- node ~/DEV/pixel-guard/server/mcp.mjs
```

| Tool | What it does | Needs |
|---|---|---|
| `figma_get_node_styles` | exact node values from the snapshot: fonts with `lineHeightPx` / `letterSpacingPx`, colours with opacity, auto-layout; `ids[]` batches several nodes in one call | disk |
| `figma_get_node_tree` | compact subtree (`depth`, default 3): one line per node — id, type, name, x/y/w/h, fill/stroke/radius, layout `row\|column gap pad align`, font, text | disk |
| `figma_find_nodes` | `text` — search text content in snapshots (with `frame` filter, returns position, font, parent); `query` — layer names via the plugin (falls back to the snapshots when the plugin is offline), or on disk with `in_snapshots` | disk / plugin |
| `pixel_guard_measure` | live page (headless Chromium): every visible element matching `selector` → rect, computed styles, effective inset, parent flex/grid gap and the `step` to the previous match; `sources: true` adds the rule that WON the cascade per property (`value ← selector (stylesheet)`, like DevTools Styles); hidden ones counted separately (`include_hidden`); `fresh` reloads | site |
| `pixel_guard_compare` | one design node ↔ one live element: every checked property as `figma → actual` with pass/fail, same rules as `qa`. `depth: 1` also pairs the node's direct children with the element's children (by text, then by order; a bare text node is compared against the element itself) and checks the auto-layout gap against the real distance. No map needed | disk + site |
| `pixel_guard_check_page` | the stored report `reports/<page>-<viewport>.json`; `only_failed: false` lists every checked property | disk |
| `pixel_guard_list_pages` | pages, URLs, templates, breakpoints | disk |
| `figma_render_node` | renders a node; `format: WEBP` and `width` downscale/convert on the server; `source: true` returns a photo node's raw image fill without exportAsync (seconds instead of a hung export); `ids[]` + `save_dir` batch to files; `timeout` up to 300 s | plugin |

## Ids

All tools accept ids as Figma shows them: `1310:27233`, `1310-27233` (from URLs) and
instance paths `I1310:27371;1310:27233` — the last one is walked segment by segment
(instance → child), since snapshots store a component's children once under their own ids.

## Typical flow for one block

1. `figma_find_nodes { text: "Хотите увидеть", frame: "Карта товара" }` → id of the text and its parent.
2. `figma_get_node_tree { id: <block>, depth: 2 }` → layout, paddings, fonts of the whole block.
3. `pixel_guard_compare { id: <block>, selector: "section.pr-pvis", page: "product" }` → diff.
4. `pixel_guard_measure { selector: ".pr-pvis li", page: "product" }` → all matches with rects, to check repeated-item spacing.

`page` is a key from `config/pages.json`; `url` overrides it. The browser is launched once
per MCP process and a page is loaded once per url × viewport.

## Renders

Agent → MCP → server → SSE bus → plugin `exportAsync()` → image back. Requires
`npm run server` and the plugin with **live mode** on. Renders are cached; requests go
through a queue (3 parallel by default, `PG_RENDER_PARALLEL`; `GET /render-queue` shows
the state; `&timeout=<sec>` default 90, failures return `504` with the stage
`sent` / `rendering` / `lost`).

Agents can also read `snapshots/*.json` and `reports/*.json` directly from disk —
`snapshots/_project.json` is the project summary with shared modules.
