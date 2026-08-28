import fs from 'node:fs';
import path from 'node:path';
import { expandTree } from './expand.mjs';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/** All snapshots with a tree, component references expanded. Cached by mtime. */
const cache = new Map();
export function loadSnapshots(root) {
  const dir = path.join(root, 'snapshots');
  if (!fs.existsSync(dir)) return [];
  const project = readJson(path.join(dir, '_project.json'));
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_')).sort()) {
    const p = path.join(dir, f);
    const mtime = fs.statSync(p).mtimeMs;
    const c = cache.get(f);
    if (c && c.mtime === mtime) { out.push(c.snap); continue; }
    const j = readJson(p);
    if (!j?.tree) continue;
    const snap = { file: f, frameName: j.frameName, frameId: j.frameId, breakpoints: j.breakpoints ?? [], svgLib: j.svgLib ?? {},
      tree: project?.compLib ? expandTree(j.tree, project.compLib) : j.tree };
    cache.set(f, { mtime, snap });
    out.push(snap);
  }
  return out;
}

export function walk(node, fn, parent = null, depth = 0) {
  if (fn(node, parent, depth) === false) return;
  for (const c of node.children ?? []) walk(c, fn, node, depth + 1);
}

function findById(tree, id) {
  let hit = null;
  walk(tree, (n, parent) => { if (hit) return false; if (n.id === id) { hit = { node: n, parent }; return false; } });
  return hit;
}

/**
 * Resolve a Figma id, including instance paths from URLs: "I1310:27371;1310:27233"
 * means node 1310:27233 inside instance 1310:27371. Snapshots store the
 * component's children once under their own ids, so the path is walked
 * segment by segment; a segment not found narrows to the last one.
 */
export function resolveNode(root, id) {
  const snaps = loadSnapshots(root);
  const clean = String(id).trim().replace(/-/g, ':');
  const segs = clean.startsWith('I') ? clean.slice(1).split(';') : [clean];
  for (const s of snaps) {
    const direct = findById(s.tree, clean);
    if (direct) return { ...direct, snap: s, via: 'id' };
  }
  if (segs.length === 1) return null;

  // an id inside a subtree: exact, or the same id at the end of a nested instance path
  const findIn = (scope, seg) => {
    let hit = null;
    walk(scope, (n, parent) => {
      if (hit) return false;
      const nid = n.id ?? '';
      if (nid === seg || nid === `I${seg}` || nid.endsWith(`;${seg}`)) { hit = { node: n, parent }; return false; }
    });
    return hit;
  };

  // the tail is looked up ONLY inside the instance's subtree, in the snapshot
  // where the instance lives — a same-numbered node elsewhere is a different thing
  let instanceOnly = null;
  for (const s of snaps) {
    const inst = findIn(s.tree, segs[0]);
    if (!inst) continue;
    let scope = inst;
    let ok = true;
    for (const seg of segs.slice(1)) {
      const hit = findIn(scope.node, seg);
      if (!hit) { ok = false; break; }
      scope = hit;
    }
    if (ok) return { node: scope.node, parent: scope.parent, snap: s, via: 'instance-path' };
    if (!instanceOnly) instanceOnly = { node: inst.node, parent: inst.parent, snap: s, via: `instance-only (child ${segs[segs.length - 1]} is not inside — the snapshot may be older than the design)` };
  }
  if (instanceOnly) return instanceOnly;

  const last = segs[segs.length - 1];
  for (const s of snaps) {
    const hit = findIn(s.tree, last);
    if (hit) return { ...hit, snap: s, via: `last-segment (instance ${segs[0]} is not in any snapshot — this may be a different node)` };
  }
  return null;
}

const r1 = (v) => (v == null ? v : Math.round(v * 10) / 10);

/** Line height in px: Figma AUTO is not stored, so it is derived from the box. */
export function lineHeightPx(n) {
  const f = n.font;
  if (!f || f.size === 'mixed') return null;
  const lh = f.lineHeight;
  if (lh?.unit === 'PIXELS') return r1(lh.value);
  if (lh?.unit === 'PERCENT') return r1((lh.value / 100) * f.size);
  const lines = Math.max(1, Math.round((n.h ?? 0) / (f.size * 1.21)));
  return n.h ? r1(n.h / lines) : null;
}

export function letterSpacingPx(n) {
  const f = n.font; const ls = f?.letterSpacing;
  if (!ls || f.size === 'mixed') return null;
  if (ls.unit === 'PIXELS') return r1(ls.value);
  if (ls.unit === 'PERCENT') return r1((ls.value / 100) * f.size);
  return null;
}

const paint = (p) => (p ? `${p.color}${p.opacity != null && p.opacity < 1 ? ` @${p.opacity}` : ''}` : null);

/** One compact line per node: everything an agent needs to lay it out. */
export function describeNode(n) {
  const o = { id: n.id, name: n.name, type: n.type, x: r1(n.x), y: r1(n.y), w: r1(n.w), h: r1(n.h) };
  if (n.component) o.component = n.component;
  const fill = Array.isArray(n.fills) ? n.fills.filter(Boolean) : [];
  const solid = fill.find((p) => p.type === 'solid');
  if (solid) o.fill = paint(solid);
  if (fill.some((p) => p.type === 'image')) o.image = true;
  if (fill.some((p) => String(p.type).startsWith('gradient'))) o.gradient = true;
  if (n.strokes?.length) o.stroke = `${paint(n.strokes[0])} ${n.strokeWeight === 'mixed' ? '' : (n.strokeWeight ?? 1) + 'px'}`.trim();
  if (n.cornerRadius != null && n.cornerRadius !== 0) o.radius = n.cornerRadius;
  if (n.opacity != null && n.opacity !== 1) o.opacity = n.opacity;
  if (n.layout) {
    const l = n.layout;
    o.layout = `${l.mode === 'HORIZONTAL' ? 'row' : 'column'}${l.wrap ? ' wrap' : ''} gap ${l.gap ?? 0} pad ${(l.padding ?? []).join('/')} ${l.align ?? ''}/${l.counterAlign ?? ''}`.trim();
  }
  if (n.type === 'TEXT') {
    o.text = n.text;
    const f = n.font ?? {};
    o.font = `${f.family} ${f.size}px/${lineHeightPx(n) ?? 'auto'} ${f.weight}${f.style ? ' ' + f.style : ''}`;
    const ls = letterSpacingPx(n); if (ls) o.letterSpacing = ls;
    if (f.case && f.case !== 'ORIGINAL') o.case = f.case;
    if (f.decoration && f.decoration !== 'NONE') o.decoration = f.decoration;
    if (f.align && f.align !== 'LEFT') o.align = f.align;
    if (n.autoResize) o.autoResize = n.autoResize;
    if (Array.isArray(n.segments)) o.segments = n.segments.map((sg) => `"${sg.text}" ${sg.fill ?? '?'}${sg.fillOpacity != null && sg.fillOpacity < 1 ? ` @${sg.fillOpacity}` : ''} ${sg.weight}/${sg.size}`).join(' | ');
  }
  if (n.mask) o.mask = true;
  if (n.svgRef) o.svg = true;
  return o;
}

export function formatTree(node, depth = 3) {
  const lines = [];
  walk(node, (n, parent, d) => {
    if (d > depth) return false;
    const o = describeNode(n);
    const { id, name, type, x, y, w, h, ...rest } = o;
    const extra = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : v}`).join(' ');
    const kids = (n.children?.length && d === depth) ? ` …${n.children.length} children` : '';
    lines.push(`${'  '.repeat(d)}${id} ${type} "${name}" ${x},${y} ${w}×${h}${extra ? ' ' + extra : ''}${kids}`);
  });
  return lines.join('\n');
}

/** Search snapshots by text content (and name), optionally within one frame. */
export function searchNodes(root, { text, name, frame, limit = 40 }) {
  const snaps = loadSnapshots(root);
  const q = (text ?? name ?? '').toLowerCase();
  const out = [];
  for (const s of snaps) {
    if (frame && !(s.frameName?.toLowerCase().includes(frame.toLowerCase()) || s.frameId === frame || s.file.includes(frame))) continue;
    walk(s.tree, (n, parent) => {
      if (out.length >= limit) return false;
      const hay = text ? (n.text ?? '') : (n.name ?? '');
      if (!hay.toLowerCase().includes(q)) return;
      out.push({ ...describeNode(n), frame: s.frameName, file: s.file, parent: parent ? `${parent.id} "${parent.name}"` : null });
    });
  }
  return out;
}
