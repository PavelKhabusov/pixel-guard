# CLI

All commands run from the project root; `--page` is a key from `config/pages.json`,
`--viewport` is `desktop` / `tablet` / `mobile`.

| Command | What it does |
|---|---|
| `npm run server` | ingest server: HTTP 8971 + HTTPS 8972, SSE bus, `/overlay`, `/nodes`, `/render`, `/report` |
| `npm run qa -- --page home --viewport desktop [--fresh]` | headless comparison (Playwright, HTTP cache off; `--fresh` busts server-side caches too) → `reports/<page>-<viewport>.{json,html}`, exit 1 on mismatches |
| `npm run qa:all [-- --viewport desktop]` | all pages × breakpoints + summary |
| `npm run automap -- --page home [--min 80] [--write]` | pairs unbound nodes with DOM elements by text, size and selector uniqueness; `--write` appends `"source": "auto"` with its `score` (`suspect: true` under 80) |
| `npm run remap -- --page X --from OLD:ID --to NEW:ID [--write]` | the design got a new frame: carries the map's bindings to the new ids by structural path (name/type chain from the frame root, then text, then size); unsure pairs are marked `suspect`, unmatched keys are kept; then update `frames.<viewport>` in `pages.json` and run `verify` |
| `npm run remap -- --page X --from DESKTOP:ID --to TABLET:ID --keep --cross [--write]` | cross-viewport: carries the desktop bindings to the tablet/mobile frame of the same page — `--keep` adds the new ids next to the old ones (one map, all breakpoints), `--cross` trusts path/text matches regardless of the size delta (sizes differ by design); still proofread `suspect` entries |
| `npm run verify [-- --fix] [--page X]` | finds drifted bindings by block **order** (5th in the design, 40th on the page); `--fix` removes `auto` ones only |
| `npm run shots [-- --page X --viewport Y --blocksOnly --scale 2 --force --retries N]` | renders every bound block to PNG for the overlay → `snapshots/shots/` + `_shots.json` |
| `npm run patch -- --page home --viewport desktop` | CSS from the report's diffs → `reports/<page>-<viewport>.css` — a **proposal**, cascade not considered |
| `npm run pixdiff -- --page home --viewport desktop` | fullPage screenshot vs design PNG (pixelmatch): %, 10 horizontal bands, diff image |
| `npm run modules [-- --shared]` | reusable blocks found by the project export |
| `npm run import -- <file.pg.json>` | import a snapshot downloaded from the plugin |
| `npm run repair` | fill empty component references in old snapshots from other snapshots |
| `npm run build:plugin` | esbuild `plugin/code.ts` → `plugin/code.js` |
| `./start.sh` | server + open Figma on the design (live mode still by hand) |

## Notes

- `qa` looks the snapshot up by `frames.<viewport>` from `pages.json`; `--snapshot file`
  overrides. A frame width ≠ viewport width prints a warning.
- The extension's **Check page** writes the same report, so `qa` is for batch/headless runs.
- `shots` exports one job at a time (`exportAsync` is single-threaded). "plugin did not
  respond" — an image fill Figma has not loaded, scroll to the node and repeat (finished
  files are skipped). "node not found" — the snapshot is from another copy of the file:
  re-export the project, then `automap --write`.
- `automap --min`: 80+ is nearly false-positive-free, 45 needs proofreading.
