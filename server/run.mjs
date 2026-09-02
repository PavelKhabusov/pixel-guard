import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findNode } from './lib/resolve.mjs';
import { compareNode, DOM_PROPS } from './lib/compare.mjs';
import { effectivePadding } from './lib/inset.mjs';
import { runPrepare } from './lib/prepare.mjs';
import { renderHtml } from './report-html.mjs';
import { ensureLocalConfigs } from './lib/bootstrap.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
ensureLocalConfigs(ROOT);

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = (process.argv[i + 1] ?? '--').startsWith('--') ? true : process.argv[++i];
}
const page = args.page ?? 'home';
const viewport = args.viewport ?? 'desktop';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const pages = readJson(path.join(ROOT, 'config/pages.json'));
const viewports = readJson(path.join(ROOT, 'config/viewports.json'));
const pageCfg = pages[page];
if (!pageCfg) { console.error(`No page "${page}" in config/pages.json`); process.exit(2); }
const width = viewports[viewport];
if (!width) { console.error(`No viewport "${viewport}" in config/viewports.json`); process.exit(2); }

const frameId = pageCfg.frames?.[viewport];
let snapPath = args.snapshot;
if (!snapPath) {
  for (const f of fs.readdirSync(path.join(ROOT, 'snapshots')).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
    const p = path.join(ROOT, 'snapshots', f);
    const j = readJson(p);
    if (!j.tree) continue;
    const hasBp = j.breakpoints?.some((b) => b.viewport === viewport);
    if (frameId ? j.frameId === frameId || findNode(j.tree, frameId) : hasBp) { snapPath = p; break; }
  }
}
if (!snapPath || !fs.existsSync(snapPath)) {
  console.error(`Snapshot not found (page=${page}, viewport=${viewport}). Export the frame with the plugin or pass --snapshot <file>.`);
  process.exit(2);
}
const snapshot = readJson(snapPath);

const autoId = snapshot.breakpoints?.find((b) => b.viewport === viewport)?.id;
const rootId = frameId ?? autoId;
let root = snapshot.tree;
if (rootId && root.id !== rootId) {
  const sub = findNode(root, rootId);
  if (!sub) {
    console.error(`Snapshot ${path.relative(ROOT, snapPath)} has no frame ${rootId} (viewport=${viewport}).`);
    process.exit(2);
  }
  root = sub;
}
// a virtual page (modal, tab) is measured against a component frame — its width is not the viewport's
if (root.w && Math.abs(root.w - width) > 1 && !pageCfg.prepare?.length) {
  console.warn(`⚠ frame width ${root.w}px ≠ viewport ${width}px — check frames.${viewport} in config/pages.json`);
}

const mapPath = path.join(ROOT, 'maps', `${page}.map.json`);
if (!fs.existsSync(mapPath)) { console.error(`No map ${mapPath}`); process.exit(2); }
const sharedPath = path.join(ROOT, 'maps', '_shared.map.json');
const shared = fs.existsSync(sharedPath) ? readJson(sharedPath) : {};
const map = { ...shared, ...readJson(mapPath) };

const url = args.url ?? pageCfg.url;
console.log(`pixel-guard: ${page} @ ${viewport} (${width}px) → ${url}\n  snapshot: ${path.relative(ROOT, snapPath)} (${snapshot.frameName} → ${root.name} ${root.w}px)`);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width, height: 1000 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36 pixel-guard',
});
const pg = await ctx.newPage();
// dev servers and CDNs love to serve yesterday: no HTTP cache, and --fresh
// additionally busts any server-side cache with a throwaway query param
const cdp = await ctx.newCDPSession(pg);
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
const target = args.fresh ? `${url}${url.includes('?') ? '&' : '?'}pgfresh=${Date.now()}` : url;
const resp = await pg.goto(target, { waitUntil: 'load', timeout: 60000 });
if (resp && !resp.ok())
  throw new Error(`page responded with HTTP ${resp.status()} — nothing to compare: ${url}`);
// SPA / React: the markup appears after hydration and data fetches — wait for the
// network to settle and for the page's "ready" selector (config: "ready": "#root .hero")
if (pageCfg.spa || pageCfg.ready) await pg.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
if (pageCfg.ready) await pg.locator(pageCfg.ready).first().waitFor({ state: 'visible', timeout: 20000 });
await pg.evaluate(() => document.fonts?.ready).catch(() => {});
await pg.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}' });
await pg.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 800) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
  scrollTo(0, 0);
});
await pg.waitForTimeout(400);
// AJAX content (tabs, modals): page-level steps once, entry-level steps before that node
const log = (m) => console.log(`  ${m}`);
if (pageCfg.prepare) await runPrepare(pg, pageCfg.prepare, { log });

const results = [];
for (const [key, entry] of Object.entries(map)) {
  if (key.startsWith('_')) continue;
  if (entry.skip) { results.push({ key, status: 'skip', reason: entry.skip }); continue; }
  if (entry.prepare) {
    try { await runPrepare(pg, entry.prepare, { log }); }
    catch (e) { results.push({ key, selector: entry.selector, status: 'missing', reason: e.message }); continue; }
  }
  const fig = findNode(root, key);
  if (!fig) {
    results.push({ key, figmaId: key.startsWith('@') ? null : key, selector: entry.selector, name: entry.name ?? null, status: key.startsWith('@') ? 'absent' : 'map-error' });
    continue;
  }

  const dom = await pg.evaluate(([sel, props, insetSrc]) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const styles = {};
    for (const p of props) styles[p] = cs.getPropertyValue(p);
    const inset = new Function(`return ${insetSrc}`)()(el);
    return { rect: { width: r.width, height: r.height }, styles, inset };
  }, [entry.selector, DOM_PROPS, effectivePadding.toString()]);

  if (!dom) { results.push({ key, figmaId: fig.id, selector: entry.selector, status: 'missing' }); continue; }

  const checks = compareNode(fig, dom, { ...entry, frameW: root.w });
  const diffs = checks.filter((c) => !c.pass);
  results.push({
    key, figmaId: fig.id, selector: entry.selector,
    status: diffs.length ? 'failed' : 'pass',
    checked: checks.length, diffs, checks,
  });
}
await browser.close();

const score = { pass: 0, failed: 0, missing: 0, skip: 0, absent: 0, 'map-error': 0 };
for (const r of results) score[r.status]++;
const report = {
  page, viewport, url, frame: snapshot.frameName, frameId: root.id, generatedAt: new Date().toISOString(),
  score, nodes: results,
};

fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
const base = path.join(ROOT, 'reports', `${page}-${viewport}`);
fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 1));
fs.writeFileSync(`${base}.html`, renderHtml(report));

for (const r of results) {
  const mark = { pass: '✓', failed: '✗', missing: '⚠ missing', skip: '— skip', absent: '· not on page', 'map-error': '⚠ map' }[r.status];
  console.log(` ${mark} ${r.key}${r.status === 'map-error' ? ` (id ${r.key} is not in frame ${root.id} — re-export or remove from the map)` : ''}${r.diffs?.length ? ` — ${r.diffs.length} mismatches` : ''}`);
  for (const d of r.diffs ?? []) console.log(`     ${d.prop}: ${d.figma} → ${d.actual}${d.delta ? ` (${d.delta})` : ''}`);
}
console.log(`\n${score.pass} ✓ · ${score.failed} ✗ · ${score.missing} missing · reports/${page}-${viewport}.{json,html}`);
process.exit(score.failed + score.missing + score['map-error'] > 0 ? 1 : 0);
