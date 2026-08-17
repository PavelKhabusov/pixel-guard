import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findNode } from './lib/resolve.mjs';
import { collectFigmaNodes, matchNodes, CANDIDATE_JS } from './lib/match.mjs';
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
const min = Number(args.min ?? 45);
const write = !!args.write;
const depth = Number(args.depth ?? 5);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const pages = readJson(path.join(ROOT, 'config/pages.json'));
const viewports = readJson(path.join(ROOT, 'config/viewports.json'));
const pageCfg = pages[page];
if (!pageCfg) { console.error(`Нет страницы "${page}" в config/pages.json`); process.exit(2); }
const width = viewports[viewport];

const frameId = pageCfg.frames?.[viewport];
let snapPath = null;
for (const f of fs.readdirSync(path.join(ROOT, 'snapshots')).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
  const p = path.join(ROOT, 'snapshots', f);
  const j = readJson(p);
  if (!j.tree) continue;
  if (frameId ? j.frameId === frameId || findNode(j.tree, frameId) : j.breakpoints?.some((b) => b.viewport === viewport)) { snapPath = p; break; }
}
if (!snapPath) { console.error(`Снапшот не найден (page=${page}, viewport=${viewport}).`); process.exit(2); }

const snapshot = readJson(snapPath);
const rootId = frameId ?? snapshot.breakpoints?.find((b) => b.viewport === viewport)?.id;
const root = rootId && snapshot.tree.id !== rootId ? findNode(snapshot.tree, rootId) : snapshot.tree;
if (!root) { console.error(`В снапшоте нет frame ${rootId}`); process.exit(2); }

const mapPath = path.join(ROOT, 'maps', `${page}.map.json`);
const existing = fs.existsSync(mapPath) ? readJson(mapPath) : {};
const sharedPath = path.join(ROOT, 'maps', '_shared.map.json');
const shared = fs.existsSync(sharedPath) ? readJson(sharedPath) : {};

console.log(`automap: ${page} @ ${viewport} (${width}px) → ${pageCfg.url}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
const pg = await ctx.newPage();
await pg.goto(pageCfg.url, { waitUntil: 'load', timeout: 60000 });
await pg.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
await pg.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 800) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 50)); }
  scrollTo(0, 0);
});
await pg.waitForTimeout(400);
const domNodes = await pg.evaluate(CANDIDATE_JS);
const domRootW = await pg.evaluate(() => document.body.getBoundingClientRect().width);
const domRootH = await pg.evaluate(() => document.body.scrollHeight);
await browser.close();

const figNodes = collectFigmaNodes(root, { maxDepth: depth })
  .filter((n) => !existing[n.id] && !Object.keys(shared).some((k) => k.startsWith('@') && k.slice(1).split('~')[0].split('|').some((nm) => nm.toLowerCase() === (n.component ?? n.name).toLowerCase())));

console.log(`  нод в макете: ${figNodes.length} (не привязано) · кандидатов в DOM: ${domNodes.length}\n`);

const matched = matchNodes(figNodes, domNodes, { rootW: root.w, domRootW, rootH: root.h, domRootH, rootY: root.y, min });
const hits = matched.filter((m) => m.selector);
const miss = matched.filter((m) => !m.selector);

for (const m of hits.sort((a, b) => b.score - a.score)) {
  console.log(` ${String(m.score).padStart(3)}  ${(m.name || m.figmaId).slice(0, 26).padEnd(28)} → ${m.selector}`);
  console.log(`      ${m.figSize} ↔ ${m.domSize}  (${m.why.join(', ')})`);
}
console.log(`\nсопоставлено ${hits.length}, без пары ${miss.length} (порог ${min})`);

// Порог ниже 70 даёт мусорные пары (нода шапки → элемент футера).
// Не запрещаем, но предупреждаем и советуем проверку.
if (write && min < 70) {
  console.log(`\n⚠ порог ${min} низкий — часть пар может быть ошибочной.`);
  console.log('  После записи обязательно: npm run verify -- --page ' + page + ' --fix');
}

if (write && hits.length) {
  const next = { ...existing };
  for (const m of hits) next[m.figmaId] = { selector: m.selector, source: 'auto', name: m.name };
  fs.writeFileSync(mapPath, JSON.stringify(next, null, 2));
  console.log(`\n→ дописано в maps/${page}.map.json (${hits.length} привязок, source: auto)`);
  console.log('  Проверь прогоном; лишнее удали или замени на { "skip": "…" }.');
} else if (hits.length) {
  console.log('\nЗапусти с --write, чтобы дописать в карту.');
}
