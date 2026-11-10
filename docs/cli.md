# CLI

All commands run from the project root; `--page` is a key from `config/pages.json`,
`--viewport` is `desktop` / `tablet` / `mobile`.

| Command | What it does |
|---|---|
| `npm run server` | ingest server: HTTP 8971 + HTTPS 8972, SSE bus, `/overlay`, `/nodes`, `/render`, `/report` |
| `npm run qa -- --page home --viewport desktop [--fresh]` | headless comparison (Playwright, HTTP cache off; `--fresh` busts server-side caches too) → `reports/<page>-<viewport>.{json,html}`, exit 1 on mismatches |
| `npm run qa:all [-- --viewport desktop]` | all pages × breakpoints + summary |
| `npm run automap -- --page home [--min 80] [--write]` | pairs unbound nodes with DOM elements by text, size and selector uniqueness; `--write` appends `"source": "auto"` with its `score` (`suspect: true` under 80) |
| `npm run resync [-- --page X] [--write] [--verbose]` | the working layout was duplicated: finds the pages whose frame moved (by the snapshot's own `breakpoints`, falling back to the frame name), runs `remap --keep --cross` for each and rewrites `frames.<viewport>` in `pages.json` — one command instead of remap per page per viewport. Without `--write` it only prints the plan; frames it cannot resolve unambiguously are counted, not rebound (`--verbose` lists them with a ready `remap` line) |
| `npm run remap -- --page X --from OLD:ID --to NEW:ID [--write]` | the design got a new frame: carries the map's bindings to the new ids by structural path (name/type chain from the frame root, then text, then size); unsure pairs are marked `suspect`, unmatched keys are kept; then update `frames.<viewport>` in `pages.json` and run `verify` |
| `npm run remap -- --page X --from DESKTOP:ID --to TABLET:ID --keep --cross [--write]` | cross-viewport: carries the desktop bindings to the tablet/mobile frame of the same page — `--keep` adds the new ids next to the old ones (one map, all breakpoints), `--cross` trusts path/text matches regardless of the size delta (sizes differ by design); still proofread `suspect` entries |
| `npm run verify [-- --fix] [--page X]` | finds drifted bindings by block **order** (5th in the design, 40th on the page); `--fix` removes `auto` ones only |
| `npm run shots [-- --page X --viewport Y --blocksOnly --scale 2 --force --retries N]` | renders every bound block to PNG for the overlay → `snapshots/shots/` + `_shots.json` |
| `npm run patch -- --page home --viewport desktop` | CSS from the report's diffs → `reports/<page>-<viewport>.css` — a **proposal**, cascade not considered |
| `npm run pixdiff -- --page home --viewport desktop` | fullPage screenshot vs design PNG (pixelmatch): %, 10 horizontal bands, diff image |
| `npm run compare -- --page home --viewport tablet [--chunk 1600] [--fresh]` | visual review: the breakpoint frame rendered by the plugin through the running server (cached in `snapshots/frames/`) next to a full-page site screenshot (fixed layers hidden), sliced into `reports/compare/<page>-<viewport>-NN.png` (left = design, right = site) with pixelmatch % per chunk |
| `npm run sweep [-- --page X] [--widths 320,768] [--bp 576,768,992] [--all]` | adaptive sweep: every preset width plus each breakpoint ±1px; reports horizontal page scroll, elements out of the viewport, clipped and spilling text; each hit is re-checked on a page loaded fresh at that width (`--all` keeps unconfirmed) → `reports/sweep-*.json` |
| `npm run peek -- <url> <width> '<js expression>'` | quick live measurement: opens the page at that width and prints what the expression returns as JSON (`getBoundingClientRect`, `getComputedStyle`…) |
| `npm run overlay -- --page X --viewport tablet [--mode split\|diff\|outline\|render] [--opacity 0.5] [--from Y --to Y] [--chunk 1400]` | the panel's overlay without a human: loads the extension into Playwright (full Chromium, headless), sends it the server's `/overlay` for the page and screenshots it slice by slice → `reports/overlay/<page>-<viewport>-<mode>-NN.png` |
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


Behind HTTP basic auth (a dev copy): set `PG_HTTP_AUTH=user:password` for `qa`, `sweep`, `compare`, `peek` and `overlay`.
## rhythm — ритм блоков и отступы плашек

`npm run rhythm -- --page catalog [--widths 357,912,1100] [--shots]`

То, чего не видят qa и sweep: зазоры между блоками страницы (сверять с gap/padding фрейма в макете),
отступы плашек против их формы (вертикальная плашка — боковой отступ не больше вертикального,
горизонтальная — наоборот), метки и табы в несколько строк, заголовки длиннее трёх строк, текст мельче 12px.
`--shots` — по скриншоту вьюпорта на каждый блок в `reports/rhythm/` (смотреть глазами рядом с макетом).

## blocks — блок макета рядом с блоком сайта

`npm run blocks -- --page home --viewport mobile [--width 390] [--fresh]`

Режет кадр брейкпоинта из макета на блоки (по дереву снапшота), находит пару на сайте по общим словам и кладёт
по картинке на пару в `reports/blocks/<page>-<viewport>/NN.png` (слева макет, справа сайт) + `index.html` для
просмотра глазами + `report.json`. Для каждой пары — тексты макета, которых нет на сайте (кнопки, телефоны, подписи),
отдельно блоки без пары с обеих сторон. Рендер кадра берётся из кэша `snapshots/frames` (общий с compare);
без кэша нужен открытый Figma с плагином в live-режиме.
