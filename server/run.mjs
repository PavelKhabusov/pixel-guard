import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findNode } from './lib/resolve.mjs';
import { compareNode, DOM_PROPS } from './lib/compare.mjs';
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
if (!pageCfg) { console.error(`Нет страницы "${page}" в config/pages.json`); process.exit(2); }
const width = viewports[viewport];
if (!width) { console.error(`Нет viewport "${viewport}" в config/viewports.json`); process.exit(2); }

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
  console.error(`Снапшот не найден (page=${page}, viewport=${viewport}). Экспортируй frame плагином или укажи --snapshot <file>.`);
  process.exit(2);
}
const snapshot = readJson(snapPath);

const autoId = snapshot.breakpoints?.find((b) => b.viewport === viewport)?.id;
const rootId = frameId ?? autoId;
let root = snapshot.tree;
if (rootId && root.id !== rootId) {
  const sub = findNode(root, rootId);
  if (!sub) {
    console.error(`В снапшоте ${path.relative(ROOT, snapPath)} нет frame ${rootId} (viewport=${viewport}).`);
    process.exit(2);
  }
  root = sub;
}
if (root.w && Math.abs(root.w - width) > 1) {
  console.warn(`⚠ ширина frame ${root.w}px ≠ viewport ${width}px — проверь frames.${viewport} в config/pages.json`);
}

const mapPath = path.join(ROOT, 'maps', `${page}.map.json`);
if (!fs.existsSync(mapPath)) { console.error(`Нет карты ${mapPath}`); process.exit(2); }
const sharedPath = path.join(ROOT, 'maps', '_shared.map.json');
const shared = fs.existsSync(sharedPath) ? readJson(sharedPath) : {};
const map = { ...shared, ...readJson(mapPath) };

const url = args.url ?? pageCfg.url;
console.log(`pixel-guard: ${page} @ ${viewport} (${width}px) → ${url}\n  снапшот: ${path.relative(ROOT, snapPath)} (${snapshot.frameName} → ${root.name} ${root.w}px)`);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width, height: 1000 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36 pixel-guard',
});
const pg = await ctx.newPage();
await pg.goto(url, { waitUntil: 'load', timeout: 60000 });
await pg.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}' });
await pg.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 800) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
  scrollTo(0, 0);
});
await pg.waitForTimeout(400);

const results = [];
for (const [key, entry] of Object.entries(map)) {
  if (key.startsWith('_')) continue;
  if (entry.skip) { results.push({ key, status: 'skip', reason: entry.skip }); continue; }
  const fig = findNode(root, key);
  if (!fig) {
    results.push({ key, selector: entry.selector, status: key.startsWith('@') ? 'absent' : 'map-error' });
    continue;
  }

  const dom = await pg.evaluate(([sel, props]) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const styles = {};
    for (const p of props) styles[p] = cs.getPropertyValue(p);
    return { rect: { width: r.width, height: r.height }, styles };
  }, [entry.selector, DOM_PROPS]);

  if (!dom) { results.push({ key, figmaId: fig.id, selector: entry.selector, status: 'missing' }); continue; }

  const checks = compareNode(fig, dom, entry);
  const diffs = checks.filter((c) => !c.pass);
  results.push({
    key, figmaId: fig.id, selector: entry.selector,
    status: diffs.length ? 'failed' : 'pass',
    checked: checks.length, diffs,
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
  const mark = { pass: '✓', failed: '✗', missing: '⚠ missing', skip: '— skip', absent: '· нет на странице', 'map-error': '⚠ map' }[r.status];
  console.log(` ${mark} ${r.key}${r.diffs?.length ? ` — ${r.diffs.length} расхождений` : ''}`);
  for (const d of r.diffs ?? []) console.log(`     ${d.prop}: ${d.figma} → ${d.actual}${d.delta ? ` (${d.delta})` : ''}`);
}
console.log(`\n${score.pass} ✓ · ${score.failed} ✗ · ${score.missing} missing · reports/${page}-${viewport}.{json,html}`);
process.exit(score.failed + score.missing + score['map-error'] > 0 ? 1 : 0);
