# MCP server for Claude agents

Gives Claude Code the design **through the plugin** — no Figma REST API, no limits.

```bash
claude mcp add pixel-guard -- node ~/DEV/pixel-guard/server/mcp.mjs
```

| Tool | What it does | Needs plugin |
|---|---|---|
| `figma_render_node` | renders a node to PNG/JPG/SVG/PDF, returns it as an image or saves via `save_to` | yes |
| `figma_find_nodes` | searches nodes by part of the name → id, type, size, page | yes |
| `figma_get_node_styles` | exact node styles from the snapshot on disk | no |
| `pixel_guard_check_page` | comparison report: selector + property + `figma → actual` | no |
| `pixel_guard_list_pages` | pages, URLs, templates, breakpoints | no |

Where the plugin is needed: agent → MCP → server → SSE bus → plugin `exportAsync()` →
image back. Requires `npm run server` and the plugin with **live mode** on. Renders are
cached; several agents can call at once (queue, 3 parallel by default,
`PG_RENDER_PARALLEL`; `GET /render-queue` shows the state; `&timeout=<sec>` default 90,
failures return `504` with the stage `sent` / `rendering` / `lost`).

Agents can also read `snapshots/*.json` and `reports/*.json` directly from disk —
`snapshots/_project.json` is the project summary with shared modules.
