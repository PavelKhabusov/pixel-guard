# Extension panel

The Chrome side panel (Side Panel API — it squeezes the page rather than covering it).

## Where it works

Only on allowed hosts: the hosts of the URLs in `config/pages.json` (refreshed on every
connection to the server) plus the ones added on the extension's **options page**. The
panel is bound to the tab, not the window, so it does not follow you to other tabs. On a
foreign site the icon opens the options page with **"Add the current site"**. No
debugger/emulation is attached outside the allowed hosts.

## Breakpoint

`desktop` by default: the page **viewport** is set to the design width via CDP (like
DevTools responsive mode) — the browser window does not change, blocks land on the
pixel. `tablet` / `phone` do the same. `auto` is the fourth mode: no emulation, the
design is picked by the window width and blocks get scaled. The choice is remembered;
emulation is removed when the panel closes.

## Overlay design

Three modes:

- **colors + text** — nodes redrawn from the snapshot: fills, text, SVG icons, dividers,
  with the paint opacity from Figma. Works with any snapshot.
- **PNG** — every bound block gets its render from Figma (`npm run shots` first). Only
  blocks with a finished render are shown; nested blocks are skipped so the header does
  not get a second layer.
- **outlines** — node borders only.

Controls: opacity, **curtain** (design on the left of the line, site on the right — drag
the line on the page), and under "more settings": auto-scale (fluid containers up to
12 % narrower than the design are scaled), difference blend, dim site, unbound nodes,
X/Y shift.

Blocks are placed on their **bound elements** (footer on footer), so a height difference
higher up the page does not shift anything. A small text node is never an anchor — its
whole subtree would move with it.

## Design selector

By default the overlay is in **auto** mode: it receives the page's design plus every
extra design that may appear on it — tabs and modals declared as virtual pages in
`pages.json`, and global modals marked `"anywhere": true` (header buttons: city, catalog,
visualisation). An extra is drawn the moment its root element (the map's binding for the
frame) becomes visible — open a tab or a modal on the site and its design lands on it; a
DOM observer redraws on changes. While a modal is open the page's own blocks are hidden
under it. The note under the switch lists what is currently shown.

The **design** dropdown forces one design instead (page or a specific modal); **open**
runs that design's `prepare[]` in the tab (click the trigger, wait for the modal). Check
page and Inspect use the selected design's map; in auto mode — the page's.

## Check page

Compares the page against the snapshot on disk — Figma does not need to be open. The
page is recognised by URL via `match[]`; each binding in the map gets a status:
`✓` / `✗` / not in DOM / not in design / skip. Clicking a row highlights the element
and shows the property diff. The report is written to `reports/<page>-<viewport>.{json,html}`
— the same format as `npm run qa`.

## Inspect

**🔍 Inspect** next to "Check page": hover highlights elements on the page, a click shows
a card — the Figma id bound to the element (or to its nearest bound ancestor, marked
"ancestor"), the design box under the cursor when the overlay is on, the unique CSS
selector, and a ready quote `1173:20486 ↔ aside.pr-phero__picker` — each with a copy
button — plus the property diff for that node. The mirror of clicking a node in Figma.
Esc exits.

## Live bridge

With **live mode** enabled in the plugin, clicking a node in Figma shows its comparison
in the panel and highlights the element on the page. Flow: plugin → `POST /emit` →
server → SSE → background → content script → panel.

## Binding with the mouse

When a node has no binding, the panel shows a bind block: pick the page, press
**With mouse**, click the element — a unique selector is computed (extended with
ancestors until unique) and written to the map as `"source": "manual"`. **Not on page**
writes a `skip`. The map is re-read on the fly.
