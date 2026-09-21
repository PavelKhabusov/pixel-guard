import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSnapshots, walk } from './lib/snap.mjs';

/**
 * Pavel duplicates the working layout in Figma, so every id changes at once while
 * the frames keep their names. `remap` already carries the bindings over, but it
 * wants both frame ids, runs per page AND per viewport, and leaves pages.json to
 * be edited by hand — 123 invocations for a full pass.
 *
 * This finds the new frames BY NAME in the fresh snapshots, calls remap for every
 * page/viewport that actually moved and rewrites config/pages.json itself.
 *
 *   npm run resync                      # show what would change (all pages)
 *   npm run resync -- --write           # do it
 *   npm run resync -- --page stati --write
 *
 * A frame is only taken when the name matches exactly one new frame; ambiguous
 * and missing ones are printed and left alone, so nothing is silently rebound.
 */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = (process.argv[i + 1] ?? '--').startsWith('--') ? true : process.argv[++i];
}

const cfgPath = path.join(ROOT, 'config/pages.json');
const cfgRaw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const pages = cfgRaw.pages ?? cfgRaw;

const snaps = loadSnapshots(ROOT);

/** id → {name, snapshot} for every frame-level node we know about. */
const frames = new Map();
for (const s of snaps) {
  if (s.frameId) frames.set(s.frameId, { name: s.frameName ?? '', snap: s, type: s.tree?.id === s.frameId ? (s.tree.type ?? 'FRAME') : 'FRAME' });
  for (const b of s.breakpoints ?? []) {
    if (b.id) frames.set(b.id, { name: b.name ?? s.frameName ?? '', snap: s, viewport: b.viewport, type: 'FRAME' });
  }
  // top-level children of the tree are frames too (a page exported as one tree)
  walk(s.tree, (n, parent, depth) => {
    if (depth > 1) return false;
    if (depth === 1 && n.id && !frames.has(n.id)) frames.set(n.id, { name: n.name ?? '', snap: s, type: n.type });
  });
  if (s.tree?.id && !frames.has(s.tree.id)) frames.set(s.tree.id, { name: s.tree.name ?? s.frameName ?? '', snap: s, type: s.tree.type });
}

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** name → ids, to resolve a duplicated frame by its (stable) name.
 *  SECTIONs are skipped: a section groups the three breakpoints under the page
 *  name, so matching one would point the desktop run at tablet+mobile nodes. */
const byName = new Map();
for (const [id, f] of frames) {
  if (f.type === 'SECTION') continue;
  const k = norm(f.name);
  if (!k) continue;
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push(id);
}

/** Figma ids grow over time: "1310:32918" is newer than "645:9440". */
const idNum = (id) => String(id).split(':').map((x) => parseInt(x, 10) || 0);
const newer = (a, b) => { const [a1, a2] = idNum(a), [b1, b2] = idNum(b); return a1 !== b1 ? a1 > b1 : a2 > b2; };

/** The plugin exports a page as one snapshot whose `breakpoints` already name the
 *  frame for every viewport. When the layout is duplicated Pavel re-exports it, so
 *  this list is the truth — and it beats guessing by name. */
const bpIndex = new Map(); // "<snapshot file>|<viewport>" → id
const snapOf = new Map();  // any frame id → snapshot file it belongs to
for (const s of snaps) {
  // One viewport may list several frames: the page itself plus fragments
  // ("Frame 137") or inner blocks ("main"). The page sits directly under the
  // section root — deeper nodes are parts of it, not alternatives.
  const depthOf = new Map();
  const pageLike = new Set();
  walk(s.tree, (n, parent, depth) => {
    if (!n.id) return;
    depthOf.set(n.id, depth);
    // a page frame is a FRAME as wide as the breakpoint and taller than one screen;
    // header/footer instances and inner blocks fail one of the two
    if (n.type === 'FRAME' && (n.w ?? 0) >= 320 && (n.h ?? 0) >= 600) pageLike.add(n.id);
  });
  for (const b of s.breakpoints ?? []) {
    if (!b.id || !b.viewport) continue;
    snapOf.set(b.id, s.file);
    const k = `${s.file}|${b.viewport}`;
    const prev = bpIndex.get(k);
    const d = depthOf.get(b.id) ?? 99;
    // Only frames sitting directly under the section root are pages; "main" and
    // other inner blocks live deeper and must not replace the page.
    if (!pageLike.has(b.id) || d !== 1) continue;
    if (!prev || d < (depthOf.get(prev) ?? 99)) bpIndex.set(k, b.id);
  }
  if (s.frameId) snapOf.set(s.frameId, s.file);
}

const plan = [];
for (const [page, cfg] of Object.entries(pages)) {
  if (args.page && page !== args.page) continue;
  for (const [viewport, oldId] of Object.entries(cfg.frames ?? {})) {
    // 1) the same snapshot re-exported: take the id it now lists for this viewport.
    // If the configured id IS the snapshot root, the page did not move — the
    // breakpoints list then describes its inner blocks, not alternatives.
    const file = snapOf.get(oldId);
    if (file && snaps.find((x) => x.file === file)?.tree?.id === oldId) {
      plan.push({ page, viewport, oldId, status: 'current' });
      continue;
    }
    if (file) {
      const fresh = bpIndex.get(`${file}|${viewport}`);
      if (fresh && fresh !== oldId) { plan.push({ page, viewport, oldId, newId: fresh, name: `${file} → ${viewport}`, status: 'move' }); continue; }
      if (fresh === oldId) { plan.push({ page, viewport, oldId, status: 'current' }); continue; }
    }
    const known = frames.get(oldId);
    if (!known) { plan.push({ page, viewport, oldId, status: 'no-snapshot' }); continue; }
    // Generic frame names ("2", "V", "1920x1080 (product) v1") repeat all over the
    // file — binding by such a name would be a coin flip, so they never match.
    const nm = norm(known.name);
    const generic = nm.length < 4 || (byName.get(nm) ?? []).length > 3;
    const cands = generic ? [] : (byName.get(nm) ?? []).filter((id) => id !== oldId);
    if (generic && (byName.get(nm) ?? []).length > 1) {
      plan.push({ page, viewport, oldId, name: known.name, status: 'ambiguous', cands: byName.get(nm).filter((i) => i !== oldId) });
      continue;
    }
    if (!cands.length) { plan.push({ page, viewport, oldId, name: known.name, status: 'current' }); continue; }
    if (cands.length > 1) { plan.push({ page, viewport, oldId, name: known.name, status: 'ambiguous', cands }); continue; }
    // A duplicate is always drawn later, so its id sorts above the original.
    // Without this two frames sharing a name just swap ids on every run.
    if (!newer(cands[0], oldId)) { plan.push({ page, viewport, oldId, name: known.name, status: 'current' }); continue; }
    plan.push({ page, viewport, oldId, newId: cands[0], name: known.name, status: 'move' });
  }
}

const pad = (s, n) => String(s ?? '').padEnd(n);
const moves = plan.filter((p) => p.status === 'move');
for (const p of plan) {
  if (p.status === 'move') console.log(` → ${pad(p.page, 22)} ${pad(p.viewport, 8)} ${pad(p.oldId, 14)} → ${pad(p.newId, 14)} ${p.name}`);
  else if (p.status === 'ambiguous' && args.verbose) console.log(` ? ${pad(p.page, 22)} ${pad(p.viewport, 8)} ${pad(p.oldId, 14)} "${p.name}" matches ${p.cands.length} frames — remap by hand: npm run remap -- --page ${p.page} --from ${p.oldId} --to <newId> --keep --cross --write`);
  else if (p.status === 'no-snapshot' && args.verbose) console.log(` · ${pad(p.page, 22)} ${pad(p.viewport, 8)} ${pad(p.oldId, 14)} not in snapshots (export the frame or leave as is)`);
}

const amb = plan.filter((p) => p.status === 'ambiguous').length;
const nosnap = plan.filter((p) => p.status === 'no-snapshot').length;
if (amb || nosnap) console.log(`${amb} frame(s) need a manual remap, ${nosnap} not in snapshots${args.verbose ? '' : ' — add --verbose to list them'}`);

if (!moves.length) {
  console.log('\nNothing to re-point: config/pages.json already points at the current frames.');
  process.exit(0);
}
console.log(`\n${moves.length} frame(s) moved${args.write ? '' : ' — run with --write to apply'}`);
if (!args.write) process.exit(0);

// remap carries the bindings; --keep because one map holds all three viewports
for (const m of moves) {
  const a = ['server/remap.mjs', '--page', m.page, '--from', m.oldId, '--to', m.newId, '--keep', '--cross', '--write'];
  console.log(`\n$ node ${a.join(' ')}`);
  try {
    console.log(execFileSync('node', a, { cwd: ROOT, encoding: 'utf8' }));
  } catch (e) {
    console.log(e.stdout ?? '');
    console.error(` remap failed for ${m.page}/${m.viewport}: ${e.message}`);
    process.exit(1);
  }
  pages[m.page].frames[m.viewport] = m.newId;
}

fs.writeFileSync(cfgPath, JSON.stringify(cfgRaw, null, 2) + '\n');
console.log(`\n→ config/pages.json: ${moves.length} frame(s) re-pointed`);
console.log(`→ check the result: npm run qa:all   (or npm run qa -- --page <key> --viewport <vp>)`);
