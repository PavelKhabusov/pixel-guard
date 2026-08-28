<div align="center">

<img src="extension/icon.svg" width="96" alt="pixel-guard">

# pixel-guard

**Pixel-perfect QA of your markup against Figma designs** — compares the live page
with the design *element by element* (computed CSS + geometry), not as a picture.
No Figma REST API and its limits: the data is pulled by its own plugin via the Plugin API.

![Status](https://img.shields.io/badge/status-personal%20%2F%20WIP-orange)
![Platform](https://img.shields.io/badge/platform-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-1f1f1f)
![License](https://img.shields.io/badge/license-MIT-7ba7d4)

![Node](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Figma](https://img.shields.io/badge/Figma-Plugin%20API-F24E1E?logo=figma&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?logo=playwright&logoColor=white)
![Chrome](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)
![esbuild](https://img.shields.io/badge/esbuild-FFCF00?logo=esbuild&logoColor=black)

</div>

---

Three parts, one server:

- **Figma plugin** — exports frames to `snapshots/*.json` (styles, geometry, SVG icons)
  and renders nodes on request. Plugin API only, no tokens, no 429.
- **Chrome extension** — side panel on your site: design overlay on top of the page
  (colors + text / PNG / outlines, curtain), viewport emulation per breakpoint,
  **Check page** with a per-property diff, binding with the mouse.
- **CLI + MCP** — headless comparison (`npm run qa`), auto-binding, PNG export, CSS
  patch proposals, pixel diff; MCP tools so Claude Code reads the design through the plugin.

The report is machine-readable — selector + property + `figma → actual` — so a fix can
be made without opening the design.

## Why not an existing overlay tool

Uiprobe, Over.fig, Overlayly, OnePixel, PerfectPixel, Visualign were tried. They put a
picture on top of the page and stop there:

- no binding "this Figma block ↔ this HTML element", so a height change higher up the
  page shifts everything below;
- no per-element comparison — you see that *something* is off, not that
  `font-size` is `46px` instead of `48px` on `.hero-title`;
- they break on unfinished pages and do not understand reusable blocks;
- the Figma REST API is rate-limited (429) and needs a token;
- nothing an agent can act on.

pixel-guard binds design nodes to selectors, compares computed styles with tolerances
and writes a report Claude Code can fix from.

## How it works

```mermaid
flowchart LR
    F[Figma] -->|plugin: styles, geometry, SVG| S[(snapshots/*.json)]
    S --> SRV[server]
    M[(maps/*.map.json)] --> SRV
    SRV <--> E[Chrome extension<br>overlay · Check page]
    SRV --> Q[npm run qa<br>Playwright]
    E --> R[(reports/*.json + .html)]
    Q --> R
    R --> P[npm run patch → CSS]
    SRV --> MCP[MCP → Claude Code]
    F <-.->|live mode: clicks, renders| SRV
```

1. The plugin walks the frames and sends a node tree: fonts, colors with opacity,
   auto-layout padding/gap, radius, component names, SVG icons. One click exports the
   whole project and marks shared blocks (header, footer).
2. `maps/<page>.map.json` binds nodes to selectors — filled by `npm run automap`, with
   the mouse from the panel, or by hand. `@Component` keys cover every breakpoint and
   page with one line.
3. The extension (or `npm run qa`) reads the DOM: `getComputedStyle` + geometry per
   binding, compares with the design, lists mismatches.

## What you get

- **Overlay on the live site** — every bound block drawn on its element (colors + text
  from the snapshot, or pixel-exact PNG renders), opacity, curtain, difference blend.
  Viewport emulated to the design width per breakpoint.
- **Per-property diff** — `padding-left 140px → 120px`, `font-weight 700 → 600`, with
  rules that avoid false alarms: full-width blocks, padding on a nested container,
  hug-text, browser font metrics.
- **Reports** — `reports/<page>-<viewport>.json` (contract for agents) and `.html`
  (for people); `npm run patch` turns diffs into a CSS proposal; `npm run pixdiff`
  compares screenshots.
- **MCP** — `figma_render_node`, `figma_get_node_styles`, `pixel_guard_check_page`…:
  Claude Code reads the design and renders nodes through the plugin, no REST.
- **Live bridge** — click a node in Figma, see its element highlighted and compared in
  the browser.

## Quick start

```bash
npm install
npm run build:plugin
npm run server            # creates config/pages.json and maps/*.map.json from *.example.*
```

1. Figma: **Plugins → Development → Import plugin from manifest…** → `plugin/manifest.json`,
   select a frame → **Export snapshot** (or **Export whole project**).
2. Chrome: `chrome://extensions` → Load unpacked → `extension/`.
3. `npm run automap -- --page home --min 80 --write`, open the page on the site → icon →
   **Check page**.

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | install, first snapshot, first check |
| [Extension panel](docs/panel.md) | breakpoints, overlay modes, Check page, binding, allowed hosts |
| [Figma plugin](docs/plugin.md) | export, Figma in the browser, live mode, renders |
| [CLI](docs/cli.md) | every `npm run` command |
| [How the comparison works](docs/comparison.md) | maps format, rules and tolerances, report contract |
| [MCP for Claude](docs/mcp.md) | tools, queue, what works without Figma |
| [Architecture](docs/architecture.md) | parts, flows, known pitfalls |
| [Troubleshooting](docs/troubleshooting.md) | |

Local files not in git: `config/pages.json`, `maps/*.map.json`, `snapshots/`, `reports/`,
`config/cert/`. Only `*.example.*` are committed.
