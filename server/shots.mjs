#!/usr/bin/env node
/**
 * Массовый экспорт PNG из макета через плагин.
 *
 * Рендерит не страницу целиком, а КАЖДЫЙ привязанный блок отдельно — тогда
 * наложение садится по контейнерам: футер на футер, шапка на шапку, и высота
 * вёрстки выше по странице не сдвигает всё остальное.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNode } from './lib/resolve.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.PG_BASE || 'http://localhost:8971';
const OUT = path.join(ROOT, 'snapshots', 'shots');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = (process.argv[i + 1] ?? '--').startsWith('--') ? true : process.argv[++i];
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const pages = readJson(path.join(ROOT, 'config/pages.json')) ?? {};
const only = args.page ? String(args.page).split(',') : Object.keys(pages);
const viewports = args.viewport ? [args.viewport] : ['desktop', 'tablet', 'mobile'];
const scale = Number(args.scale ?? 1);  // 1:1 c макетом — для пиксельной сверки больше не нужно
const force = !!args.force;

const ping = await fetch(`${BASE}/ping`).then((r) => r.json()).catch(() => null);
if (!ping?.figmaAlive) {
  console.error('Плагин Figma не на связи. Запусти ./start.sh, открой плагин и включи «живой режим».');
  process.exit(2);
}
console.log(`сервер на связи · параллельно ${ping.render?.parallel ?? 1}\n`);

function snapshotFor(frameId) {
  const dir = path.join(ROOT, 'snapshots');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
    const j = readJson(path.join(dir, f));
    if (!j?.tree) continue;
    if (j.frameId === frameId || findNode(j.tree, frameId)) return j;
  }
  return null;
}

/** Ноды под привязками карты — их и рендерим поблочно. */
function targets(root, pageKey) {
  const map = { ...(readJson(path.join(ROOT, 'maps', '_shared.map.json')) ?? {}),
                ...(readJson(path.join(ROOT, 'maps', `${pageKey}.map.json`)) ?? {}) };
  const out = [];
  for (const [key, entry] of Object.entries(map)) {
    if (key.startsWith('_') || !entry?.selector) continue;
    const node = findNode(root, key);
    if (!node?.id || (node.w ?? 0) < 8 || (node.h ?? 0) < 8) continue;
    if (node.type === 'TEXT') continue;
    out.push({ key, id: node.id, name: node.name, w: node.w, h: node.h, selector: entry.selector });
  }
  return out;
}

const jobs = [];
for (const pageKey of only) {
  for (const vp of viewports) {
    const frameId = pages[pageKey]?.frames?.[vp];
    if (!frameId) continue;
    const snap = snapshotFor(frameId);
    if (!snap) { console.warn(`  ⚠ ${pageKey}/${vp}: снапшота нет`); continue; }
    const root = findNode(snap.tree, frameId) ?? snap.tree;

      if (!args.blocksOnly) jobs.push({ pageKey, vp, id: frameId, name: 'FULL', full: true, w: root.w, h: root.h });
    for (const t of targets(root, pageKey)) jobs.push({ pageKey, vp, ...t });
  }
}

if (!jobs.length) { console.error('нечего рендерить — проверь config/pages.json и карты'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const manifestPath = path.join(OUT, '_shots.json');
const manifest = readJson(manifestPath) ?? {};

const fileFor = (j) => `${j.pageKey}-${j.vp}-${j.full ? 'full' : j.id.replace(/[:;]/g, '_')}.png`;

let done = 0, skipped = 0, failed = 0;
const PARALLEL = Number(args.parallel ?? 1);

async function renderOne(job) {
  const file = fileFor(job);
  const dest = path.join(OUT, file);
  if (!force && fs.existsSync(dest)) { skipped++; return; }

  const url = `${BASE}/render?id=${encodeURIComponent(job.id)}&format=PNG&scale=${scale}&timeout=120`;
  const r = await fetch(url).catch((e) => ({ ok: false, statusText: String(e) }));
  if (!r.ok) {
    const body = await r.text?.().catch(() => '') ?? '';
    console.log(`  ✗ ${job.pageKey}/${job.vp} ${job.name} — ${body.slice(0, 120) || r.statusText}`);
    failed++;
    return;
  }
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  manifest[`${job.pageKey}|${job.vp}|${job.key ?? 'FULL'}`] = {
    file, id: job.id, name: job.name, selector: job.selector ?? null,
    w: job.w, h: job.h, scale, bytes: buf.length,
  };
  done++;
  console.log(`  ✓ ${job.pageKey}/${job.vp} ${String(job.name).slice(0, 26).padEnd(28)} ${Math.round(buf.length / 1024)} КБ`);
}

console.log(`заданий: ${jobs.length} (по ${PARALLEL} параллельно)\n`);
for (let i = 0; i < jobs.length; i += PARALLEL) {
  await Promise.all(jobs.slice(i, i + PARALLEL).map(renderOne));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
}

console.log(`\nготово: ${done} новых · ${skipped} уже были · ${failed} с ошибкой`);
console.log(`→ snapshots/shots/ (манифест _shots.json)`);
if (failed) console.log('Повтори команду — ноды с image-заливкой часто отдаются со второго раза.');
