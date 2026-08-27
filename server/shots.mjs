#!/usr/bin/env node
/**
 * Bulk PNG export from the design via the plugin.
 *
 * Renders not the whole page but EACH mapped block separately — then the
 * overlay lines up per container: footer on footer, header on header, and the
 * height of the page markup above does not shift everything else.
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
const scale = Number(args.scale ?? 1);  // 1:1 with the design — pixel comparison needs no more
const force = !!args.force;

const ping = await fetch(`${BASE}/ping`).then((r) => r.json()).catch(() => null);
if (!ping?.figmaAlive) {
  console.error('Figma plugin is not connected. Run ./start.sh, open the plugin and enable "live mode".');
  process.exit(2);
}
console.log(`server connected · parallel ${ping.render?.parallel ?? 1}\n`);

function snapshotFor(frameId) {
  const dir = path.join(ROOT, 'snapshots');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
    const j = readJson(path.join(dir, f));
    if (!j?.tree) continue;
    if (j.frameId === frameId || findNode(j.tree, frameId)) return j;
  }
  return null;
}

/** Nodes behind the map entries — these are rendered block by block. */
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
    if (!snap) { console.warn(`  ⚠ ${pageKey}/${vp}: no snapshot`); continue; }
    const root = findNode(snap.tree, frameId) ?? snap.tree;

      if (!args.blocksOnly) jobs.push({ pageKey, vp, id: frameId, name: 'FULL', full: true, w: root.w, h: root.h });
    for (const t of targets(root, pageKey)) jobs.push({ pageKey, vp, ...t });
  }
}

if (!jobs.length) { console.error('nothing to render — check config/pages.json and the maps'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const manifestPath = path.join(OUT, '_shots.json');
const manifest = readJson(manifestPath) ?? {};

const fileFor = (j) => `${j.pageKey}-${j.vp}-${j.full ? 'full' : j.id.replace(/[:;]/g, '_')}.png`;

let done = 0, skipped = 0, failed = 0;
const stale = [];
const hung = [];
const PARALLEL = Number(args.parallel ?? 1);

const RETRIES = Number(args.retries ?? 2);

async function renderOne(job, attempt = 1) {
  const file = fileFor(job);
  const dest = path.join(OUT, file);
  if (!force && fs.existsSync(dest)) { skipped++; return; }

  const url = `${BASE}/render?id=${encodeURIComponent(job.id)}&format=PNG&scale=${scale}&timeout=${args.timeout ?? 120}`;
  const r = await fetch(url).catch((e) => ({ ok: false, statusText: String(e) }));
  if (!r.ok) {
    const body = await r.text?.().catch(() => '') ?? '';
    let info = {};
    try { info = JSON.parse(body); } catch { /* not json */ }

    // Node does not exist in Figma: the snapshot was taken from an OLD copy of
    // the design, the id has changed. Retrying is pointless — re-export the project.
    if (/not found/.test(info.error ?? '')) {
      stale.push(`${job.pageKey}/${job.vp} ${job.name} (${job.id})`);
      return;
    }
    // Render hung — usually a lazy image, succeeds on the second attempt
    if (attempt <= RETRIES) {
      console.log(`  ↻ ${job.pageKey}/${job.vp} ${job.name} — retry ${attempt}/${RETRIES}`);
      await new Promise((res) => setTimeout(res, 2000));
      return renderOne(job, attempt + 1);
    }
    console.log(`  ✗ ${job.pageKey}/${job.vp} ${job.name} — ${(info.error ?? body).slice(0, 100) || r.statusText}`);
    hung.push(`${job.pageKey}/${job.vp} ${job.name} (${job.id})`);
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
  console.log(`  ✓ ${job.pageKey}/${job.vp} ${String(job.name).slice(0, 26).padEnd(28)} ${Math.round(buf.length / 1024)} KB`);
}

// quick freshness check: if half of the nodes cannot be found in Figma,
// the snapshot was taken from another copy of the design and the export is pointless
if (!args.noCheck && jobs.length > 4) {
  const probe = jobs.slice(0, 4);
  let miss = 0;
  for (const j of probe) {
    const r = await fetch(`${BASE}/render?id=${encodeURIComponent(j.id)}&format=PNG&scale=1&timeout=20`)
      .then((x) => (x.ok ? null : x.json().catch(() => ({}))))
      .catch(() => ({}));
    if (/not found/.test(r?.error ?? '')) miss++;
  }
  if (miss >= 3) {
    console.error(`\n⚠ ${miss} of ${probe.length} probe nodes are missing from the open design.`);
    console.error('  Snapshots were taken from a DIFFERENT copy of the file — run "Export whole project" first.');
    console.error('  Continue anyway: --noCheck\n');
    process.exit(3);
  }
}

console.log(`jobs: ${jobs.length} (${PARALLEL} in parallel)\n`);
for (let i = 0; i < jobs.length; i += PARALLEL) {
  await Promise.all(jobs.slice(i, i + PARALLEL).map(renderOne));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
}

console.log(`\ndone: ${done} new · ${skipped} already existed · ${failed} failed · ${stale.length} stale`);
console.log(`→ snapshots/shots/ (manifest _shots.json)`);

if (hung.length) {
  console.log(`\n${hung.length} nodes failed to render even after ${RETRIES} retries:`);
  for (const h of hung.slice(0, 10)) console.log(`   ${h}`);
  console.log('  These nodes have heavy image fills. Scroll to them on the Figma canvas');
  console.log('  (so the images load) and rerun the command — only they will be rendered.');
}

if (stale.length) {
  console.log(`\n${stale.length} nodes are MISSING from the current Figma design:`);
  for (const s of stale.slice(0, 10)) console.log(`   ${s}`);
  if (stale.length > 10) console.log(`   … and ${stale.length - 10} more`);
  console.log('  The snapshot was taken from another copy of the design — node ids diverged.');
  console.log('  Fix by re-exporting: the "Export whole project" button in the plugin,');
  console.log('  then npm run automap -- --page <name> --write for the new mappings.');
}
