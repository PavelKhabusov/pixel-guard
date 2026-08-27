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

The report is machine-readable: selector + property + `figma → actual`, so a fix
can be made without opening the design. Plan and architecture: [PLAN.md](PLAN.md).

## Installation

```bash
npm install
npm run build:plugin
npm run server   # creates config/pages.json and maps/home.map.json from *.example.*
```

Local `config/pages.json` and `maps/*.map.json` are not committed: they contain the
URL of your staging site and node bindings for a specific design. The repository only
ships `config/pages.example.json` and `maps/home.example.map.json` — they are copied
automatically on first run, then you fill them in for your project.

Plugin (requires edit access to the file, or a copy of it in your drafts):
**Plugins → Development → Import plugin from manifest…** → `plugin/manifest.json`.
Works in both Figma Desktop and Figma in the browser.

## Node id of the selected node

Click a node on the canvas — the panel shows a line with its **id** and size
(`539:7940 · 143×19`) and a **"copy id"** button. Works even with live mode
turned off.

## Transparent render background

Figma exports a node without the canvas background, so in a dark-themed viewer the
image looks "on black". `/render` and `figma_render_node` put a white background
underneath by default:

```
/render?id=482:3672            # white background
/render?id=482:3672&bg=none    # keep transparency
/render?id=482:3672&bg=%23202020
```

## Design snapshot

1. `npm run server` (or the "▶ Ingest server" button) — starts two listeners at once:
   `http://localhost:8971` for Desktop and `https://localhost:8972` for the browser.
2. In Figma select the frame(s) → run the **pixel-guard** plugin → Export snapshot.
3. Result: `snapshots/<frame>.json` (+ `.png` if the checkbox is enabled).

The plugin's send mode defaults to "auto": HTTPS in the browser, HTTP in Desktop.

### Export the whole project

The **"Export whole project"** button walks every page of the file, snapshots each
top-level frame and matches reusable blocks by Figma component: instances of the same
component collapse into a single module, and those that appear on more than one page
are marked as **shared** (header, footer, etc.).

Result: one snapshot per frame plus `snapshots/_project.json` with a summary.

```bash
npm run modules              # all modules of the project
npm run modules -- --shared  # shared only
```

```
⇄ footer
    instances: 6 · sizes: 1920x1045, 912x1352, 357x2840
    pages: Page 1/Home page, Page 1/Product card
```

Practical upshot: a shared module needs to be bound in the map only once — a mismatch
in it gets fixed on every page at the same time.

### Figma in the browser

The plugin page lives on `https://www.figma.com`, so the browser blocks requests to
`http://` as mixed content — hence the separate HTTPS listener on port 8972 with a
self-signed certificate (generated automatically in `config/cert/`, excluded from git).
Open <https://localhost:8972/ping> once (the "🔐 Accept certificate" button) and accept
the warning — after that Export snapshot works the same as in Desktop.

If the certificate does not work out — use the "download file only" mode (or the
"Download JSON" button): the plugin hands the snapshot over as a file, then

```bash
npm run import -- ~/Downloads/<frame>.pg.json
```

## How to use it

The extension panel is three steps, top to bottom:

1. **Breakpoint** — auto picks it from the window width; desktop/tablet/phone narrow the
   viewport via CDP (like the responsive mode in DevTools), the browser window itself
   does not change.
2. **Overlay design** — "PNG from design" places block renders on top of the page
   pixel-for-pixel; the curtain splits the screen: design on the left, site on the right.
3. **Compare styles** — a list of mismatches by property; clicking a row highlights
   the element and shows details.

Order for a clean result: `npm run shots` (export PNGs once) →
`npm run verify -- --fix` (check the maps) → work in the panel.

## Checking a page without Figma

Open any page of the site → extension icon → **"Check page"**.
The panel figures out which design corresponds to it (by URL via `match[]`),
takes the needed nodes from the snapshot on disk and shows a list: what matches,
what differs, what is missing from the DOM. Clicking a row highlights the element
and shows a detailed diff.

Figma does not need to be open for this — the snapshots are already in `snapshots/`.
The live bridge below is only needed when you want to click nodes right in the design.

## Live bridge Figma ↔ browser

The `extension/` extension connects to the same ingest server as the plugin
(SSE `/bus`), so the Figma REST API is not used at all — no limits.

1. `npm run server`.
2. Chrome → `chrome://extensions` → "Developer mode" → "Load unpacked"
   → the `extension/` folder.
3. Clicking the extension icon opens the **native Chrome side panel**
   (Side Panel API) — it squeezes the page rather than covering it.
4. In the plugin enable the **live mode** checkbox.
5. Click a node in Figma → the style comparison appears in the panel, and the element
   itself is highlighted with a frame on the page according to `maps/<page>.map.json`.

Flow: plugin → `POST /emit` → server → SSE → background.js → content.js
(computes the diff against the live DOM) → panel.js (displays it). The icon shows `on`/`off`.

## Shared modules: `maps/_shared.map.json`

Blocks that live on every page (header, footer, the Avito block) are bound
**once** in `maps/_shared.map.json` — it is merged into every page map,
with the page map taking priority.

An `@name` key looks the node up by Figma component name, not by id. This matters:
the same block has **different ids** on desktop/tablet/mobile but a common component —
so one line covers all three breakpoints on all pages at once.

```json
{
  "@header": { "selector": "div.header-wrap", "ignore": ["height"] },
  "@footer": { "selector": "footer.pr-footer", "ignore": ["height"] },
  "@menu":   { "skip": "opens on click, not present in the static DOM" }
}
```

Which modules are shared is shown by `npm run modules -- --shared` after a project export.

## Auto-matcher: `npm run automap`

To avoid binding every node by hand, the matcher pairs unbound design nodes with DOM
elements on its own — by text, size and selector uniqueness.

```bash
npm run automap -- --page home --viewport desktop            # show candidates
npm run automap -- --page home --min 80 --write              # append to the map
```

Each pair is printed with a score and a rationale; the selector is extended with
ancestors until it is unique:

```
 122  Turnkey installation    → li#menu-item-42690 a
      143x19 ↔ 143x20  (exact text, width, height)
```

With `--write` the findings are appended to the map with `"source": "auto"` — manual
bindings are left untouched. The `--min` threshold controls strictness: 80+ gives almost
no false pairs, 45 gives more matches but needs proofreading.

## Checking maps: `npm run verify`

The auto-matcher sometimes gets it wrong — on a text match it binds a header node to a
link in the footer. Such a binding breaks both the overlay and the comparison: the block
is drawn in the wrong place.

```bash
npm run verify                      # show problems
npm run verify -- --fix             # remove drifted auto-bindings
npm run verify -- --page product    # a single page only
```

The check compares the **order** of blocks: if a node is fifth from the top in the design
but its element is fortieth on the site, the binding has drifted. Height fractions do not
work here, since the design and the page have different lengths. `--fix` only touches
`source: auto` entries; manual bindings are not removed, a warning is printed for them.

## Binding with the mouse

When the panel says "no binding in the map", a binding block appears in it:
pick the page, press **"Bind with mouse"** and click the element you need — the selector
is computed automatically (extended with ancestors until unique) and written to the map
right away. Esc cancels, **"Mark as skip"** is for blocks that do not exist in the markup.

The map is re-read on the fly, no need to edit the JSON by hand. Entries get
`"source": "manual"` — the auto-matcher does not overwrite them.

## Design overlay

In PNG mode **only blocks with a finished render** are shown. The remaining anchors —
individual labels and small nodes — were drawn as text on top of the page without an
image and turned the overlay into a mess. Nested blocks are skipped too: if the header
is drawn as an image, its inner anchors would produce a second layer.

Hence the practice: **`npm run shots` first**, then the overlay. The more blocks are
captured, the fuller the picture.

In the extension panel: the **"overlay design"** checkbox, an opacity slider and two
modes: image (needs a PNG — the checkbox on export in the plugin) and block wireframe
(always works, draws node borders on top of the page). The `difference` mode
highlights mismatches.

## Bulk PNG export: `npm run shots`

There is no live Figma render in the browser — the engine is not exposed. So the pixel
comparison is built on PNGs rendered by the plugin **per block**:

```bash
npm run shots                                  # all pages × breakpoints
npm run shots -- --page home --viewport desktop
npm run shots -- --blocksOnly                  # without the full frame (it is heavy)
npm run shots -- --scale 2 --force             # re-render at 2x
```

It is not the whole page that gets rendered but **every bound block** — then the overlay
lands on containers (footer on footer, header on header) and a height difference higher
up the page does not shift anything. Result in `snapshots/shots/` + the `_shots.json` manifest.

The panel gains the **"PNG per block (pixel)"** mode: instead of redrawing nodes, each
anchor gets its image from Figma — a pixel-for-pixel comparison with all the photos,
text, shadows and gradients.

Images reach the page through the extension as `data:` URIs — site CSPs usually block
`http://localhost` in `img-src`, while `data:` is allowed.

Two categories of errors and what to do about them:

- **"plugin did not respond"** — a node with a heavy image fill, Figma did not manage to
  load the image. The script retries twice on its own (`--retries N`), and if that fails
  it prints a list: scroll to these nodes on the canvas and repeat the command — only
  they will be captured.
- **"node not found"** — the snapshot was taken from a DIFFERENT copy of the design, the
  ids diverged (this happens after duplicating the file). Retries won't help: you need
  "Export whole project" in the plugin, then `npm run automap -- --page X --write`.
  Before starting, the script checks 4 nodes and stops immediately if they are missing
  (`--noCheck` bypasses this).

Export goes **one job at a time**: `exportAsync` inside the plugin is single-threaded,
parallel calls compete and hit the timeout. Large blocks take tens of seconds to render —
this is normal; the command can be repeated, finished files are skipped
(`--force` overwrites).

## CSS patches from diffs

```bash
npm run patch -- --page home --viewport desktop
```

Builds ready-made CSS from the report: selector, properties from the design and the
previous values in comments. For tablet/mobile it is wrapped in `@media`. Written to
`reports/<page>-<viewport>.css` — this is a **proposal of fixes**, not auto-application:
cascade and specificity are not taken into account, review before pasting.

## Pixel diff

```bash
npm run pixdiff -- --page home --viewport desktop
```

Compares a fullPage screenshot of the site with the design PNG (needs an export with
the PNG checkbox): the percentage of differing pixels, a breakdown by 10 horizontal
bands top to bottom, and the image `reports/<page>-<viewport>-pixdiff.png`.

## Quick start: `./start.sh`

A single command (the "🚀 Start" button) brings up the ingest server and opens Figma
on the project's design. If the server is already running or the plugin is connected,
those steps are skipped.

One step remains manual: **Plugins → Development → pixel-guard → "live mode"**.
Figma does not allow launching plugins from the command line, and the Linux build does
not pass Electron flags through (`--remote-debugging-port` is rejected), so nobody can
click it for you. On the upside, it needs to be enabled **once per session** — after
that agents pull images and data without your involvement as long as the window is open.

If Figma is not needed — three of the five MCP tools and the whole comparison work from disk.

## MCP server for Claude agents

Gives Claude Code access to the design **through the plugin**, without the Figma REST
API and its limits.

```bash
claude mcp add pixel-guard -- node ~/DEV/pixel-guard/server/mcp.mjs
```

Tools:

| Tool | What it does | Needs plugin |
|---|---|---|
| `figma_render_node` | renders a node to PNG/JPG/SVG/PDF and returns it to the agent as an image (or saves a file via `save_to`) | yes |
| `figma_find_nodes` | searches nodes by part of the name → id, type, size, page | yes |
| `figma_get_node_styles` | exact node styles from the snapshot on disk | no |
| `pixel_guard_check_page` | comparison report: selector + property + `figma → actual` | no |
| `pixel_guard_list_pages` | list of pages, URLs, templates, breakpoints | no |

Where the plugin is needed, it works like this: the agent calls MCP → the server sends
a request to the bus → the plugin renders via `exportAsync()` → the image returns to the
agent. Requires `npm run server` and an open plugin with **live mode** enabled. Render
results are cached; a repeated request for the same node does not hit Figma.

Requests to the plugin go through a **queue with bounded concurrency** (3 at a time by
default, `PG_RENDER_PARALLEL`): several agents can use MCP simultaneously without
overwhelming the plugin. `GET /render-queue` shows what is in progress and how much is
waiting. The timeout is configured via `&timeout=<sec>` (90 by default); on failure a
`504` comes back with the stage `sent`/`rendering`/`lost`.

Inside the plugin `exportAsync` has its own 45s timeout: nodes with an **image fill**
whose image Figma has not loaded yet can hang forever regardless of size. Instead of
hanging you get a clear error — scroll to the node on the canvas so Figma loads the
image, and retry.

The plugin **reconnects on its own**: the SSE connection in the Figma iframe can drop
silently, so there is auto-reconnect with a growing backoff and a watchdog — if the server
stays silent for more than 70 seconds (heartbeat every 20), the connection is recreated.
The plugin panel shows the state: "connected" / "reconnecting". Liveness is visible from
outside too: `GET /ping` returns `figmaAlive`, the list of connections with their uptime
and the queue state, so there is no need to probe with a test render anymore.

## Running the comparison

```bash
npm run qa -- --page home --viewport desktop           # snapshot is looked up by frameId from config/pages.json
npm run qa -- --page home --snapshot snapshots/x.json  # or explicitly
npm run qa:all                                         # all pages × all breakpoints + summary
npm run qa:all -- --viewport desktop                   # a single breakpoint only
```

The binding map is `maps/<page>.map.json`: key = node name path (`hero/title`) or its id
(`994:13213`), value = `{ "selector": "...", "tolerance": {...}, "ignore": [...] }`
or `{ "skip": "reason" }`. Result: `reports/<page>-<viewport>.json` (for Claude)
and `.html` (for humans); exit 1 on mismatches.
