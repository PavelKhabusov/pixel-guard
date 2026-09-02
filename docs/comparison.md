# How the comparison works

The same rules run in the extension (`Check page`, live bridge) and in `npm run qa`.

## Maps

`maps/<page>.map.json` binds design nodes to selectors. `maps/_shared.map.json` is
merged into every page map (page map wins) for blocks that live everywhere.

```json
{
  "994:13213":            { "selector": ".pr-hero h1", "source": "auto" },
  "@footer":              { "selector": "footer.pr-footer", "ignore": ["height"] },
  "@Card~400x600":        { "selector": ".product-card" },
  "@menu":                { "skip": "opens on click, not in the static DOM" }
}
```

- key = node id, or `@ComponentName` — looked up by Figma **component** name, so one
  line covers all breakpoints and pages (ids differ, the component does not).
  `@A|B` matches either name; `~WxH` limits the node size (a 393 px mobile header
  must not swallow the desktop one).
- `ignore: [props]`, `tolerance: { px, geo, textHeight }`, `skip: reason`.
- `source: auto` entries may be removed by `verify --fix`; `manual` never.

## What is compared

| Node | Properties |
|---|---|
| any | width (unless full-width or hug text), height (text: `renderH…h` range ±10) |
| TEXT | font-family (first in the stack), font-size, font-weight, line-height, letter-spacing, text-transform, text-align, color |
| other | background-color (with alpha), border-radius, border-width/color, padding ×4, gap (flex/grid) |

Rules that avoid false failures:

- **Full-width block** (as wide as the frame) — width is skipped: the difference is the
  window, not the markup.
- **Padding by effective inset** — Figma keeps padding on the section frame, the site
  often on a nested centered `.container`. The check accepts the element's own padding
  OR the distance from its edge to the content (walking single-child wrappers).
- Colors normalised to hex + alpha; line-height % → px; tolerance ±1 px (geometry ±2).
- Font rendering legitimately differs by 1–2 px — that is tolerance, not a bug.

## AJAX content: tabs, modals, virtual pages

The comparison measures whatever is in the DOM, so content that arrives on click has to
be brought in first. `prepare[]` does that — a list of Playwright steps executed before
the measurement:

```json
{ "click": "#tab-reviews" }  { "hover": ".menu" }  { "waitFor": ".panel" }
{ "scrollTo": ".faq" }  { "fill": "input[name=qty]", "value": "120" }  { "wait": 500 }
```

Where it goes:

- **page level** — `config/pages.json` → `"prepare": [...]`, runs once after load;
- **entry level** — `maps/<page>.map.json` → `"prepare": [...]` on a binding, runs before
  that node (identical step lists run once per page);
- **MCP** — `pixel_guard_measure` / `pixel_guard_compare` take `prepare` directly.

A tab or a modal whose design lives in its own Figma frame is a **virtual page**: an
entry in `pages.json` whose `url` is the real page, `frames` point at the component's
frame (any snapshot), `prepare` opens the tab, and `match` is empty so URL matching keeps
picking the base page; `"anywhere": true` marks a modal reachable from every page (header
buttons), so the extension offers its design on any URL. `qa`, `qa:all`, `automap` and the
MCP tools treat a virtual page like any other page; in the extension a **design** dropdown lists the virtual pages of the current URL —
open the modal by hand and pick it. `automap` runs the page's `prepare[]`, scopes its
candidates to the bound frame root (positions relative to it, selectors prefixed with it)
and pairs containers by the text they carry — a menu item frame ↔ the `<a>` with that label.
Same-named frames no longer overwrite each other's snapshot (`name-<id>.json`).

## React / SPA

- `"spa": true` on a page waits for the network to settle after `load`; `"ready": "<selector>"`
  waits for that element to be visible (hydration, data fetch) before measuring.
  `pixel_guard_measure` / `compare` accept `ready` too.
- Selectors skip generated classes (CSS modules `Button_root__x8f2a`, styled-components
  `sc-…`, emotion `css-…`, `jsx-…`, MUI hashes) and ids like `:r3:`; `data-testid`,
  `data-test`, `data-cy`, `data-qa` win when present. Applies to Inspect, "With mouse"
  and `automap`.
- Client-side navigation (pushState / popstate / hash) reloads the page map in the
  extension and re-applies the overlay — no page reload needed.
- Dev servers: add `http://localhost:5173/...` pages to `pages.json`; the host becomes
  an allowed site for the extension.

## Report

`reports/<page>-<viewport>.json` — the contract for Claude: every diff is enough to fix
without opening Figma.

```json
{
  "page": "home", "viewport": "desktop", "url": "…", "frame": "…", "frameId": "445:3377",
  "score": { "pass": 41, "failed": 12, "missing": 3, "skip": 1, "absent": 0, "map-error": 0 },
  "nodes": [{
    "key": "994:13213", "selector": ".pr-hero h1", "status": "failed", "checked": 9,
    "diffs": [{ "prop": "font-size", "figma": "48px", "actual": "46px", "delta": "-2px", "pass": false }]
  }]
}
```

Statuses: `pass`, `failed`, `missing` (selector not in DOM), `absent` (`@`-node not in
this design), `skip`, `map-error`. `.html` next to it is for humans; `npm run patch`
turns the diffs into a CSS proposal.
