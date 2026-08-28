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
