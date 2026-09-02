import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshots, walk } from './lib/snap.mjs';

/**
 * The design got a new frame (a redraw, a duplicated page): every id in the map
 * changes, the blocks do not. Carry the bindings over by structural path —
 * the DFS chain of (name, type) from the frame root, then size — and report
 * what could not be paired.
 *
 *   npm run remap -- --page ukladka --from 738:9485 --to 1909:14938 [--write]
 *
 * Cross-viewport (desktop map → tablet/mobile frame of the same page): sizes differ by
 * design, so `--keep` adds the new ids next to the old ones instead of replacing them and
 * `--cross` trusts path/text matches regardless of the size delta.
 *
 *   npm run remap -- --page catalog --from 512:6014 --to 1111:35016 --keep --cross --write
 */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = (process.argv[i + 1] ?? '--').startsWith('--') ? true : process.argv[++i];
}
if (!args.page || !args.from || !args.to) {
  console.error('usage: npm run remap -- --page <key> --from <oldFrameId> --to <newFrameId> [--keep] [--cross] [--write]');
  process.exit(2);
}
const mapPath = path.join(ROOT, 'maps', `${args.page}.map.json`);
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

const findFrame = (id) => {
  for (const s of loadSnapshots(ROOT)) {
    let hit = null;
    walk(s.tree, (n) => { if (hit) return false; if (n.id === id) { hit = n; return false; } });
    if (hit) return { node: hit, snap: s };
  }
  return null;
};
const from = findFrame(args.from);
const to = findFrame(args.to);
if (!from || !to) { console.error(`frame not found: ${!from ? args.from : args.to}`); process.exit(2); }

// index by structural path: name/type chain below the frame; several nodes may share one
const index = (frame) => {
  const byPath = new Map();
  const byId = new Map();
  walk(frame, (n, parent, depth) => {
    if (depth === 0) return;
    const parentPath = parent === frame ? '' : byId.get(parent.id)?.path ?? '';
    const seg = `${(n.name ?? '').trim().toLowerCase()}|${n.type}`;
    const p = parentPath ? `${parentPath}/${seg}` : seg;
    byId.set(n.id, { node: n, path: p, parent });
    if (!byPath.has(p)) byPath.set(p, []);
    byPath.get(p).push(n);
  });
  return { byPath, byId };
};
const A = index(from.node);
const B = index(to.node);
const sizeDist = (a, b) => Math.abs((a.w ?? 0) - (b.w ?? 0)) + Math.abs((a.h ?? 0) - (b.h ?? 0));
const text = (n) => (n.text ?? '').trim().toLowerCase();

const out = { ...map };
const rows = [];
const used = new Set();
for (const [key, entry] of Object.entries(map)) {
  if (key.startsWith('_') || key.startsWith('@')) continue;
  const old = A.byId.get(key);
  if (!old) { rows.push({ key, status: 'not-in-old', entry }); continue; }
  let cands = (B.byPath.get(old.path) ?? []).filter((n) => !used.has(n.id));
  let how = 'path';
  if (!cands.length) {
    // same name+type anywhere, ranked by size — the block moved to another wrapper
    const seg = old.path.split('/').pop();
    cands = [...B.byPath.entries()].filter(([p]) => p.endsWith(seg)).flatMap(([, v]) => v).filter((n) => !used.has(n.id));
    how = 'name+type';
  }
  if (old.node.type === 'TEXT' && text(old.node)) {
    const byText = cands.filter((n) => text(n) === text(old.node));
    if (byText.length) { cands = byText; how += '+text'; }
  }
  cands.sort((a, b) => sizeDist(a, old.node) - sizeDist(b, old.node));
  const best = cands[0];
  if (!best) { rows.push({ key, status: 'unmatched', entry, old: old.node }); continue; }
  const dist = sizeDist(best, old.node);
  const byPath = how === 'path' || how === 'path+text';
  // cross-viewport: the same block is a different size by design — trust the structure/text
  const sure = args.cross ? (byPath || how === 'name+type+text') : (dist <= 4 && byPath);
  used.add(best.id);
  rows.push({ key, status: sure ? 'ok' : 'check', to: best.id, how, dist, entry, old: old.node, neu: best });
  if (best.id !== key) {
    if (!args.keep) delete out[key];
    const { suspect: _s, migratedFrom: _m, ...clean } = entry;
    out[best.id] = { ...clean, ...(sure ? {} : { suspect: true }), migratedFrom: key };
  }
}

const pad = (s, n) => String(s).padEnd(n);
for (const r of rows) {
  const name = (r.entry.name ?? r.old?.name ?? '').slice(0, 24);
  if (r.status === 'ok' || r.status === 'check') console.log(` ${r.status === 'ok' ? '✓' : '?'} ${pad(r.key, 14)} → ${pad(r.to, 14)} ${pad(name, 26)} ${r.how}${r.dist ? ` Δ${r.dist}px` : ''}  ${r.entry.selector ?? 'skip'}`);
  else console.log(` ✗ ${pad(r.key, 14)} ${pad(name, 26)} ${r.status === 'not-in-old' ? 'not in the old frame (kept as is)' : 'no counterpart in the new frame (kept as is)'}`);
}
const n = (st) => rows.filter((r) => r.status === st).length;
console.log(`\n${n('ok')} ✓ · ${n('check')} ? (marked suspect) · ${n('unmatched')} ✗ · ${n('not-in-old')} not in old frame`);
if (args.write) {
  fs.writeFileSync(mapPath, JSON.stringify(out, null, 2) + '\n');
  console.log(args.keep
    ? `→ maps/${args.page}.map.json: ${rows.filter((r) => r.to).length} bindings added for ${args.to} (old ones kept); run npm run qa -- --page ${args.page} --viewport <tablet|mobile>`
    : `→ maps/${args.page}.map.json rewritten; update frames.<viewport> in config/pages.json to ${args.to} and run npm run verify -- --page ${args.page}`);
} else console.log('\nRun with --write to rewrite the map.');
