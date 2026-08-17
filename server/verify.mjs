#!/usr/bin/env node
/**
 * Проверка качества карты: ловит привязки, которые «уехали» — нода из шапки
 * макета привязана к футеру, дубли на один селектор, элементы не в том
 * порядке. Именно такой мусор ломает наложение и сверку.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findNode } from './lib/resolve.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = (process.argv[i + 1] ?? '--').startsWith('--') ? true : process.argv[++i];
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const pages = readJson(path.join(ROOT, 'config/pages.json')) ?? {};
const viewports = readJson(path.join(ROOT, 'config/viewports.json')) ?? {};
const only = args.page ? String(args.page).split(',') : Object.keys(pages);
const viewport = args.viewport ?? 'desktop';
const fix = !!args.fix;

/**
 * Позиция ноды относительно корня. В снапшотах координаты неоднородны:
 * часть веток абсолютная (от канваса), часть относительная (от родителя) —
 * старый сериализатор считал от разных баз. Определяем по факту: если
 * координата ребёнка укладывается в бокс родителя, она уже абсолютная.
 */
function absPositions(root) {
  const map = new Map();
  const rootY = root.y ?? 0;
  const walk = (n, parentAbsY, depth) => {
    let absY;
    if (depth === 0) absY = rootY;
    else {
      const asAbsolute = n.y ?? 0;
      const asRelative = parentAbsY + (n.y ?? 0);
      // абсолютная координата не может быть меньше родительской
      absY = asAbsolute >= parentAbsY - 1 ? asAbsolute : asRelative;
    }
    map.set(n.id, { y: absY - rootY, w: n.w, h: n.h, name: n.name, type: n.type });
    for (const c of n.children ?? []) walk(c, absY, depth + 1);
  };
  walk(root, rootY, 0);
  return map;
}

let totalBad = 0;
const browser = await chromium.launch();

for (const pageKey of only) {
  const frameId = pages[pageKey]?.frames?.[viewport];
  const url = pages[pageKey]?.url;
  if (!frameId || !url) continue;

  let snap = null;
  for (const f of fs.readdirSync(path.join(ROOT, 'snapshots')).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
    const j = readJson(path.join(ROOT, 'snapshots', f));
    if (j?.tree && (j.frameId === frameId || findNode(j.tree, frameId))) { snap = j; break; }
  }
  if (!snap) { console.log(`${pageKey}: снапшота нет`); continue; }

  const root = findNode(snap.tree, frameId) ?? snap.tree;
  const positions = absPositions(root);

  const mapPath = path.join(ROOT, 'maps', `${pageKey}.map.json`);
  const pageMap = readJson(mapPath) ?? {};
  const shared = readJson(path.join(ROOT, 'maps', '_shared.map.json')) ?? {};
  const all = { ...shared, ...pageMap };

  const ctx = await browser.newContext({ viewport: { width: viewports[viewport] ?? 1920, height: 1000 } });
  const pg = await ctx.newPage();
  await pg.goto(url, { waitUntil: 'load', timeout: 60000 });
  await pg.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 800) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
    scrollTo(0, 0);
  });
  const pageH = await pg.evaluate(() => document.body.scrollHeight);

  const rows = [];
  for (const [key, entry] of Object.entries(all)) {
    if (key.startsWith('_') || !entry?.selector) continue;
    const node = findNode(root, key);
    if (!node) continue;
    const pos = positions.get(node.id);
    if (!pos) continue;

    const dom = await pg.evaluate((sel) => {
      const els = document.querySelectorAll(sel);
      if (!els.length) return null;
      const r = els[0].getBoundingClientRect();
      return { y: Math.round(r.top + scrollY), h: Math.round(r.height), count: els.length };
    }, entry.selector).catch(() => null);

    if (!dom) { rows.push({ key, name: pos.name, status: 'missing', selector: entry.selector }); continue; }

    rows.push({
      key, name: pos.name, selector: entry.selector,
      figY: Math.round(pos.y), domY: dom.y, dupes: dom.count, source: entry.source,
    });
  }
  await ctx.close();

  // Сравниваем не доли высоты (макет и сайт разной длины — доли врут),
  // а ПОРЯДОК блоков: если нода в макете 5-я сверху, а её элемент на
  // сайте 40-й — привязка уехала.
  const ranked = rows.filter((r) => r.domY != null);
  const byFig = [...ranked].sort((a, b) => a.figY - b.figY).map((r) => r.key);
  const byDom = [...ranked].sort((a, b) => a.domY - b.domY).map((r) => r.key);
  const n = ranked.length || 1;
  for (const r of ranked) {
    const rankGap = Math.abs(byFig.indexOf(r.key) - byDom.indexOf(r.key)) / n;
    r.gap = Math.round(rankGap * 100);
    r.status = rankGap > 0.45 ? 'moved' : rankGap > 0.25 ? 'suspect' : 'ok';
  }
  for (const r of rows) if (!r.status) r.status = 'missing';

  const moved = rows.filter((r) => r.status === 'moved');
  const suspect = rows.filter((r) => r.status === 'suspect');
  const missing = rows.filter((r) => r.status === 'missing');
  const ok = rows.filter((r) => r.status === 'ok');
  totalBad += moved.length;

  console.log(`\n${pageKey} @ ${viewport}: ${ok.length} ✓ · ${suspect.length} сомнительных · ${moved.length} уехавших · ${missing.length} нет в DOM`);
  for (const r of [...moved, ...suspect].slice(0, 12)) {
    const mark = r.status === 'moved' ? '✗' : '?';
    console.log(`  ${mark} ${(r.name || r.key).slice(0, 24).padEnd(26)} макет y=${String(r.figY).padStart(5)} ↔ сайт y=${String(r.domY).padStart(5)}  (${r.gap}%)`);
    console.log(`     ${r.selector.slice(0, 70)}${r.source ? `  [${r.source}]` : ''}`);
  }

  if (fix && moved.length) {
    const next = { ...pageMap };
    let removed = 0;
    for (const r of moved) {
      if (next[r.key] && next[r.key].source === 'auto') { delete next[r.key]; removed++; }
    }
    if (removed) {
      fs.writeFileSync(mapPath, JSON.stringify(next, null, 2));
      console.log(`  → удалено ${removed} авто-привязок из maps/${pageKey}.map.json`);
    }
    const manual = moved.filter((r) => next[r.key] && next[r.key].source !== 'auto');
    if (manual.length) console.log(`  ⚠ ${manual.length} ручных привязок тоже уехали — проверь их сам, я их не трогаю`);
  }
}

await browser.close();
if (!fix && totalBad) console.log(`\nЗапусти с --fix, чтобы убрать уехавшие авто-привязки.`);
process.exit(totalBad ? 1 : 0);
