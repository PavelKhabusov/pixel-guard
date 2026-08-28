# Troubleshooting

**"server not running"** in the panel — `npm run server` (or the ▶ button). The icon dot
turns green when connected.

**"Page not responding" / nothing happens after the extension was reloaded** — the
content script lives until the page reloads. Reload the tab.

**Panel does not open on my site** — the host is not allowed. Click the icon: the
options page opens, press "Add the current site" (or add the page to
`config/pages.json` and restart the server).

**Snapshot not found / no frame for page@viewport** — `frames.<viewport>` in
`config/pages.json` does not match an exported frame. Export the project from the
plugin; ids can be found with `figma_find_nodes` or in `snapshots/_project.json`.

**Browser Figma cannot send the snapshot** — accept the certificate at
<https://localhost:8972/ping>, or use "Download JSON" + `npm run import`.

**Overlay: blocks in the wrong place** — a drifted binding. `npm run verify -- --fix`.
Blocks scaled / a few px off — you are in `auto` mode; pick `desktop`.

**Overlay: "No bindings for this page" / few blocks** — fill the map:
`npm run automap -- --page X --min 75 --write`, or bind with the mouse.

**PNG mode is empty** — `npm run shots` first.

**Render hangs / "plugin did not respond"** — a node with an image fill Figma has not
loaded. Scroll to it on the canvas and retry; `shots` retries twice on its own.

**"node not found" in shots** — the snapshot is from another copy of the design.
Re-export the whole project, then `automap --write`.

**padding 50px → 0px although the site looks right** — fixed: padding is compared by
effective inset. If it still fails, the content really starts at a different offset.

**Icons on a black square in the overlay** — an SVG clip mask; re-export with the
current plugin (masks are flagged) or restart the server (old snapshots are handled
by name).
