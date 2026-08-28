# Getting started

Ten minutes from install to the first comparison.

## 1. Install

```bash
npm install
npm run build:plugin
npm run server   # creates config/pages.json and maps/home.map.json from *.example.*
```

`config/pages.json` and `maps/*.map.json` are local (not committed): they hold your
staging URL and node bindings for a specific design. Fill in `pages.json`: page key →
`url`, `frames` (Figma frame ids per breakpoint), `match` (URL patterns).

## 2. Figma plugin

**Plugins → Development → Import plugin from manifest…** → `plugin/manifest.json`.
Needs edit access to the file (or a copy in your drafts). Works in Desktop and in the
browser — see [plugin.md](plugin.md) for the HTTPS note.

Select the frame(s) → run **pixel-guard** → **Export snapshot** (or **Export whole
project**). Result: `snapshots/<frame>.json`.

## 3. Chrome extension

`chrome://extensions` → Developer mode → **Load unpacked** → the `extension/` folder.
The side panel opens only on the sites from `pages.json` (plus hosts added on the
extension's options page).

## 4. Bind and check

```bash
npm run automap -- --page home --min 80 --write   # auto-bind nodes to selectors
npm run verify -- --fix                            # drop drifted bindings
```

Open the page on the site → extension icon → **Check page**. The panel lists what
matches, what differs and what is missing; the same report lands in
`reports/<page>-<viewport>.{json,html}`.

Quick start button: `./start.sh` brings up the server and opens Figma on the design.
Only **live mode** in the plugin has to be enabled by hand, once per session.

Next: [panel.md](panel.md) · [cli.md](cli.md) · [comparison.md](comparison.md)
