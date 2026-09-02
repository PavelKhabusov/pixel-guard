#!/usr/bin/env node
/**
 * pixel-guard MCP server: gives Claude agents access to the Figma design
 * through our plugin, without the Figma REST API and its rate limits.
 *
 * Transport is JSON-RPC over stdio (MCP spec), so no SDK is needed.
 * ONLY the protocol goes to stdout; everything else goes to stderr.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNode, formatTree, describeNode, searchNodes, lineHeightPx, letterSpacingPx } from './lib/snap.mjs';
import { measure, probe, shot, closeBrowser } from './lib/measure.mjs';
import { compareNode } from './lib/compare.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.PG_BASE || 'http://localhost:8971';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

async function api(pathname, { raw = false } = {}) {
  const r = await fetch(`${BASE}${pathname}`);
  if (raw) return { ok: r.ok, status: r.status, buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type'), fallback: r.headers.get('x-render-fallback') ? decodeURIComponent(r.headers.get('x-render-fallback')) : null };
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, json: j };
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

const TOOLS = [
  {
    name: 'figma_render_node',
    description: 'Render a Figma design node to an image via the pixel-guard plugin (no REST API, no rate limits). '
      + 'Returns the image. By default the transparent Figma background is filled with white (bg), '
      + 'otherwise it looks black on a dark theme. Requires a running npm run server and the plugin open with "live mode" enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Figma node id, e.g. 445:3377' },
        format: { type: 'string', enum: ['PNG', 'JPG', 'SVG', 'PDF', 'WEBP'], description: 'format, default PNG; WEBP is converted on the server — the cheap way to pull photos' },
        scale: { type: 'number', description: 'scale for PNG/JPG, default 2' },
        save_to: { type: 'string', description: 'if set, save the file to this path instead of returning the image' },
        bg: { type: 'string', description: 'background under PNG transparency: a hex like #ffffff (default) or "none" to keep it transparent' },
        timeout: { type: 'number', description: 'seconds to wait for the plugin, default 180, max 300 — big raster blocks take minutes' },
        width: { type: 'number', description: 'downscale to this width on the server (keeps aspect)' },
        source: { type: 'boolean', description: 'for a photo node: return its raw image fill WITHOUT exportAsync — seconds instead of a hung export; combine with width/format WEBP' },
        ids: { type: 'array', items: { type: 'string' }, description: 'several nodes in one call; requires save_dir' },
        save_dir: { type: 'string', description: 'directory for batch renders; files are named <id>.<ext>' },
      },
    },
  },
  {
    name: 'figma_find_nodes',
    description: 'Find design nodes. With `text` — searches the TEXT CONTENT in the snapshots on disk (no Figma needed), '
      + 'returns id, position, size, font and parent. With `query` only — searches layer names via the plugin (needs live mode); '
      + 'add `in_snapshots: true` to search names on disk instead.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'part of the layer name' },
        text: { type: 'string', description: 'part of the text content (snapshots only)' },
        frame: { type: 'string', description: 'limit to a frame: part of its name, its id, or the snapshot file name' },
        in_snapshots: { type: 'boolean', description: 'search layer names in snapshots instead of asking the plugin' },
        limit: { type: 'number', description: 'max results, default 40' },
      },
    },
  },
  {
    name: 'figma_get_node_styles',
    description: 'Exact node values from the snapshot on disk: fonts (with line-height and letter-spacing resolved to px), '
      + 'colours with opacity, sizes, padding/gap from auto-layout. Accepts instance-path ids from Figma URLs '
      + '(I1310:27371;1310:27233) and ids with a dash (1310-27233). Works without Figma.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Figma node id' },
        ids: { type: 'array', items: { type: 'string' }, description: 'several ids at once — one round-trip instead of N' },
      },
    },
  },
  {
    name: 'figma_get_node_tree',
    description: 'Compact subtree of a design node: one line per child with id, type, name, x/y/w/h, fill/stroke/radius, '
      + 'auto-layout (row|column gap pad align), font (family size/lineHeight weight), text. From the snapshot on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Figma node id (instance paths accepted)' },
        depth: { type: 'number', description: 'levels below the node, default 3' },
      },
      required: ['id'],
    },
  },
  {
    name: 'pixel_guard_measure',
    description: 'Measure the LIVE page by CSS selector — no Figma node needed (headless Chromium): every matching element → '
      + 'document rect, computed styles (font, line-height, color with alpha, padding, gap, border, radius, margin…), effective '
      + 'content inset. `sources: true` = the rule that won each property; `cascade: true` = EVERY competing rule per property '
      + 'in cascade order (winner first, then the losers with their files) — who overrides what. `page` is a key from config/pages.json, or pass `url`.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        page: { type: 'string', description: 'page key from config/pages.json' },
        url: { type: 'string', description: 'page URL (overrides page)' },
        viewport: { type: 'string', enum: ['desktop', 'tablet', 'mobile'], description: 'default desktop' },
        props: { type: 'array', items: { type: 'string' }, description: 'CSS properties to return (default: the comparison set)' },
        include_hidden: { type: 'boolean', description: 'also list display:none / zero-size matches (default false)' },
        fresh: { type: 'boolean', description: 'reload the page instead of reusing the one loaded in the last 60 s' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'pixel_guard_probe',
    description: '"Click and tell": run prepare steps on the live page and report what happened — XHR/fetch requests '
      + '(method, url, POST body, status, ms), console errors / uncaught exceptions, and what appeared or disappeared in the DOM '
      + '(element count, page height, added/removed nodes). The way to find "click ✓ but zero requests" bugs.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'object' }, description: '[{click: "#tab"}, {waitFor: ".panel"}, {fill, value}, {wait: ms}]' },
        page: { type: 'string' }, url: { type: 'string' },
        viewport: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] },
        ready: { type: 'string', description: 'SPA: selector to wait for before the steps' },
      },
      required: ['steps'],
    },
  },
  {
    name: 'pixel_guard_shot',
    description: 'Screenshot of an element (selector) or the page after optional prepare steps. `freeze` aborts requests whose '
      + 'URL contains any of the given substrings, so a skeleton / loading state can be captured. Returns the image or saves it (save_to).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'element to shoot; omit for the viewport, full_page for the whole page' },
        page: { type: 'string' }, url: { type: 'string' },
        viewport: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] },
        prepare: { type: 'array', items: { type: 'object' } },
        freeze: { type: 'array', items: { type: 'string' }, description: 'abort requests containing these substrings, e.g. ["admin-ajax.php"]' },
        full_page: { type: 'boolean' },
        save_to: { type: 'string', description: 'file path; otherwise the PNG is returned inline' },
        ready: { type: 'string' },
      },
    },
  },
  {
    name: 'pixel_guard_compare',
    description: 'Compare one design node with one live element: resolves the node from the snapshot, measures the '
      + 'element on the page and returns every checked property as figma → actual with pass/fail (same rules as npm run qa: '
      + 'tolerances, effective padding, full-width blocks). No map file needed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Figma node id (instance paths accepted)' },
        selector: { type: 'string', description: 'CSS selector of the element (first match)' },
        page: { type: 'string', description: 'page key from config/pages.json' },
        url: { type: 'string', description: 'page URL (overrides page)' },
        viewport: { type: 'string', enum: ['desktop', 'tablet', 'mobile'], description: 'default desktop' },
        ignore: { type: 'array', items: { type: 'string' }, description: 'properties to skip' },
        fresh: { type: 'boolean', description: 'reload the page instead of reusing the one loaded in the last 60 s' },
        prepare: { type: 'array', items: { type: 'object' }, description: 'steps before measuring AJAX content: [{click: "#tab"}, {waitFor: ".panel"}, {hover}, {scrollTo}, {fill, value}, {wait: ms}]; a page from config/pages.json applies its own prepare[] automatically' },
        ready: { type: 'string', description: 'SPA/React: selector that must be visible before measuring (hydration / data fetch finished); pages.json "ready" applies automatically' },
        depth: { type: 'number', description: '1 = also match the node\'s direct children to the element\'s children (by text, then by order) and compare their fonts/colours/sizes plus the gap between them' },
      },
      required: ['id', 'selector'],
    },
  },
  {
    name: 'pixel_guard_check_page',
    description: 'Page-vs-design comparison report: which properties mismatch, selector + figma → actual. '
      + 'Reads the existing reports/<page>-<viewport>.json (run npm run qa first).',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'page key from config/pages.json, e.g. home' },
        viewport: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] },
        only_failed: { type: 'boolean', description: 'mismatches only (default true); false lists every checked property incl. passed ones' },
      },
      required: ['page'],
    },
  },
  {
    name: 'pixel_guard_list_pages',
    description: 'List project pages: key, URL, match patterns and captured breakpoints.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args = {}) {
  if (name === 'figma_render_node') {
    const format = (args.format ?? 'PNG').toUpperCase();
    const mk = (id) => `/render?id=${encodeURIComponent(id)}&format=${format}&scale=${args.scale ?? 2}`
      + `&bg=${encodeURIComponent(args.bg ?? '#ffffff')}&timeout=${Math.min(300, Math.max(5, Number(args.timeout ?? 180)))}`
      + (args.width ? `&width=${Math.round(args.width)}` : '') + (args.source ? '&source=1' : '');
    const ext = { PNG: 'png', JPG: 'jpg', SVG: 'svg', PDF: 'pdf', WEBP: 'webp' }[format] ?? 'bin';

    if (Array.isArray(args.ids) && args.ids.length) {
      if (!args.save_dir) return fail('batch render needs save_dir');
      fs.mkdirSync(path.resolve(args.save_dir), { recursive: true });
      const lines = [];
      for (const one of args.ids) {
        const r = await api(mk(one), { raw: true });
        if (!r.ok) { lines.push(`✗ ${one}: ${r.buf.toString('utf8').slice(0, 160)}`); continue; }
        const f = path.resolve(args.save_dir, `${one.replace(/[:;]/g, '_')}.${ext}`);
        fs.writeFileSync(f, r.buf);
        lines.push(`✓ ${one} → ${f} (${Math.round(r.buf.length / 1024)} KB)${r.fallback ? ` ⚠ ${r.fallback}` : ''}`);
      }
      return text(lines.join('\n'));
    }
    if (!args.id) return fail('pass id or ids[]');
    const q = mk(args.id);

    if (args.save_to) {
      const r = await api(q, { raw: true });
      if (!r.ok) return fail(`render failed: ${r.buf.toString('utf8').slice(0, 300)}`);
      fs.mkdirSync(path.dirname(path.resolve(args.save_to)), { recursive: true });
      fs.writeFileSync(path.resolve(args.save_to), r.buf);
      return text(`saved: ${args.save_to} (${Math.round(r.buf.length / 1024)} KB, ${format})${r.fallback ? `\n⚠ ${r.fallback}` : ''}`);
    }

    const r = await api(`${q}&json=1`);
    if (!r.ok) return fail(r.json?.error ?? `error ${r.status}`);
    if (format === 'SVG' || format === 'PDF') {
      const body = Buffer.from(r.json.bytes, 'base64').toString('utf8');
      return text(`${r.json.name} · ${r.json.width}×${r.json.height}\n\n${body.slice(0, 20000)}`);
    }
    return {
      content: [
        { type: 'text', text: `${r.json.name} · ${r.json.type} · ${r.json.width}×${r.json.height}${r.json.fallback ? `\n⚠ ${r.json.fallback}` : ''}` },
        { type: 'image', data: r.json.bytes, mimeType: format === 'JPG' ? 'image/jpeg' : 'image/png' },
      ],
    };
  }

  if (name === 'figma_find_nodes') {
    if (args.text || args.in_snapshots) {
      const rows = searchNodes(ROOT, { text: args.text, name: args.query, frame: args.frame, limit: args.limit ?? 40 });
      if (!rows.length) return text(`nothing found for "${args.text ?? args.query}" in the snapshots`);
      return text(rows.map((n) => `${n.id}  ${n.type.padEnd(9)} ${n.x},${n.y} ${n.w}×${n.h}  ${JSON.stringify(n.text ?? n.name)}`
        + `${n.font ? '  ' + n.font : ''}${n.fill ? '  ' + n.fill : ''}\n      in ${n.parent} · ${n.frame}`).join('\n'));
    }
    if (!args.query) return fail('pass `text` (content search in snapshots) or `query` (layer name)');
    const r = await api(`/find?q=${encodeURIComponent(args.query)}`);
    if (!r.ok || r.json?.ok === false) {
      // plugin not connected — the snapshots on disk still know the names
      const rows = searchNodes(ROOT, { name: args.query, frame: args.frame, limit: args.limit ?? 40 });
      if (rows.length) return text(`(plugin offline — searched the snapshots)\n` + rows.map((n) => `${n.id}  ${n.type.padEnd(9)} ${n.x},${n.y} ${n.w}×${n.h}  ${JSON.stringify(n.name)}\n      in ${n.parent} · ${n.frame} (${n.file})`).join('\n'));
      return fail(r.json?.error ?? `error ${r.status}`);
    }
    const list = r.json.nodes ?? [];
    if (!list.length) return text(`nothing found for "${args.query}"`);
    return text(list.map((n) => `${n.id}  ${n.type.padEnd(9)} ${n.width}×${n.height}  ${n.name}  [${n.page}]`).join('\n'));
  }

  if (name === 'figma_get_node_styles') {
    if (Array.isArray(args.ids) && args.ids.length) {
      const parts = args.ids.map((one) => {
        const h = resolveNode(ROOT, one);
        if (!h) return `${one}: not in the snapshots`;
        return `${one}${h.via !== 'id' ? ` (via ${h.via})` : ''}: ${JSON.stringify(describeNode(h.node))}`;
      });
      return text(parts.join('\n\n'));
    }
    if (!args.id) return fail('pass id or ids[]');
    const hit = resolveNode(ROOT, args.id);
    if (!hit) return fail(`node ${args.id} is not in the snapshots — ask Pavel to export with the plugin`);
    const { children, svg, ...node } = hit.node;
    if (node.font) { node.font = { ...node.font, lineHeightPx: lineHeightPx(hit.node), letterSpacingPx: letterSpacingPx(hit.node) }; }
    const head = `design "${hit.snap.frameName}" (${hit.snap.file})${hit.via !== 'id' ? ` · resolved via ${hit.via}` : ''}`
      + `${hit.parent ? `\nparent: ${hit.parent.id} "${hit.parent.name}"` : ''}\nchildren: ${children?.length ?? 0}`;
    return text(`${head}\n\n${JSON.stringify(describeNode(hit.node))}\n\n${JSON.stringify(node, null, 2)}`);
  }

  if (name === 'figma_get_node_tree') {
    const hit = resolveNode(ROOT, args.id);
    if (!hit) return fail(`node ${args.id} is not in the snapshots`);
    return text(`design "${hit.snap.frameName}" (${hit.snap.file})\n\n${formatTree(hit.node, args.depth ?? 3)}`);
  }

  if (name === 'pixel_guard_measure' || name === 'pixel_guard_compare' || name === 'pixel_guard_probe' || name === 'pixel_guard_shot') {
    const vp = args.viewport ?? 'desktop';
    const width = (readJson(path.join(ROOT, 'config/viewports.json')) ?? { desktop: 1920, tablet: 912, mobile: 357 })[vp];
    const pages = readJson(path.join(ROOT, 'config/pages.json')) ?? {};
    const url = args.url ?? pages[args.page ?? '']?.url ?? Object.values(pages)[0]?.url;
    if (!url) return fail('no url: pass `url` or a `page` key from config/pages.json');
    const readySel = args.ready ?? pages[args.page ?? '']?.ready ?? null;

    if (name === 'pixel_guard_probe') {
      let r;
      try { r = await probe(url, width, args.steps, { ready: readySel }); } catch (e) { return fail(`probe failed: ${e.message}`); }
      const reqs = r.requests.map((q) => `  ${q.method} ${q.url}${q.body ? `\n      body: ${q.body}` : ''}  → ${q.status ?? 'pending'}${typeof q.ms === 'number' && q.status !== null ? ` (${q.ms} ms)` : ''}`);
      return text(`${url} @ ${vp}\n\nsteps:\n${r.stepLog.map((l) => '  ' + l).join('\n')}${r.stepError ? `\n  ✗ ${r.stepError}` : ''}`
        + `\n\nrequests (${r.requests.length}):\n${reqs.join('\n') || '  none — nothing was fetched'}`
        + `\n\nconsole (${r.errors.length}):\n${r.errors.map((e) => '  ' + e).join('\n') || '  clean'}`
        + `\n\nDOM: ${r.before.elements} → ${r.after.elements} elements · height ${r.before.height} → ${r.after.height}${r.before.url !== r.after.url ? ` · url → ${r.after.url}` : ''}`
        + `\n  added: ${r.after.added.join(', ') || '—'}\n  removed: ${r.after.removed.join(', ') || '—'}`);
    }

    if (name === 'pixel_guard_shot') {
      const prep = [...(pages[args.page ?? '']?.prepare ?? []), ...(Array.isArray(args.prepare) ? args.prepare : [])];
      let r;
      try { r = await shot(url, width, { selector: args.selector ?? null, steps: prep.length ? prep : null, freeze: args.freeze ?? null, fullPage: !!args.full_page, ready: readySel }); }
      catch (e) { return fail(`shot failed: ${e.message}`); }
      const meta = `${args.selector ?? (args.full_page ? 'full page' : 'viewport')} @ ${vp}${r.box ? ` · ${Math.round(r.box.width)}×${Math.round(r.box.height)} at ${Math.round(r.box.x)},${Math.round(r.box.y)}` : ''}${args.freeze?.length ? ` · frozen: ${args.freeze.join(', ')}` : ''}`;
      if (args.save_to) { fs.mkdirSync(path.dirname(path.resolve(args.save_to)), { recursive: true }); fs.writeFileSync(path.resolve(args.save_to), r.png); return text(`saved: ${args.save_to} (${Math.round(r.png.length / 1024)} KB) · ${meta}`); }
      return { content: [{ type: 'text', text: meta }, { type: 'image', data: r.png.toString('base64'), mimeType: 'image/png' }] };
    }
    const prepare = [...(pages[args.page ?? '']?.prepare ?? []), ...(Array.isArray(args.prepare) ? args.prepare : [])];
    const mopts = { fresh: !!args.fresh, sources: args.cascade ? 'all' : !!args.sources, prepare: prepare.length ? prepare : null, ready: args.ready ?? pages[args.page ?? '']?.ready ?? null };
    let rows;
    try { rows = await measure(url, width, args.selector, args.props, mopts); } catch (e) { return fail(`measure failed: ${e.message}`); }
    if (!rows.length) return fail(`nothing matches "${args.selector}" on ${url} @ ${vp}`);
    const hiddenCount = rows.filter((d) => d.hidden).length;
    if (!args.include_hidden) rows = rows.filter((d) => !d.hidden);
    if (!rows.length) return fail(`"${args.selector}" matches ${hiddenCount} element(s), all hidden (display:none / zero size)`);

    if (name === 'pixel_guard_measure') {
      // step between consecutive visible siblings: the repeated-item spacing a map of one <ul> never sees
      const step = (d, i) => {
        const prev = rows[i - 1]; if (!prev || prev.hidden) return '';
        const dy = Math.round((d.rect.y - prev.rect.y) * 10) / 10, dx = Math.round((d.rect.x - prev.rect.x) * 10) / 10;
        return Math.abs(dy) >= 1 ? ` · step ↓${dy}` : Math.abs(dx) >= 1 ? ` · step →${dx}` : '';
      };
      const fmt = (d, i) => `#${i + 1} <${d.tag}> ${d.rect.x},${d.rect.y} ${d.rect.width}×${d.rect.height} · ${d.children} children${d.hidden ? ' · HIDDEN' : ''}${step(d, i)}${d.text ? ` · "${d.text}"` : ''}\n`
        + `   inset ${d.inset.top}/${d.inset.right}/${d.inset.bottom}/${d.inset.left}`
        + (d.parentGap ? ` · parent ${d.parentGap.display} gap ${d.parentGap.rowGap}/${d.parentGap.columnGap}` : '') + '\n'
        + Object.entries(d.styles).filter(([, v]) => v !== '' && v !== 'none' && v !== 'normal' && v !== '0px' && v !== 'auto')
          .map(([k, v]) => `   ${k}: ${v}${d.sources?.[k] ? (args.cascade ? `\n${d.sources[k]}` : `\n      ↳ ${d.sources[k]}`) : ''}`).join('\n');
      return text(`${url} @ ${vp} (${width}px) · ${args.selector} · ${rows.length} visible${hiddenCount ? ` (+${hiddenCount} hidden)` : ''}\n\n${rows.map(fmt).join('\n\n')}`);
    }

    const hit = resolveNode(ROOT, args.id);
    if (!hit) return fail(`node ${args.id} is not in the snapshots`);
    const frameW = hit.snap.breakpoints.find((b) => b.viewport === vp)?.width ?? (hit.snap.tree.w >= 1900 ? hit.snap.tree.w : null);
    const dom = rows[0];
    const checks = compareNode(hit.node, dom, { ignore: args.ignore ?? [], frameW });
    const bad = checks.filter((c) => !c.pass);
    const line = (c) => `  ${c.pass ? '✓' : '✗'} ${c.prop}: ${c.figma} → ${c.actual}${c.delta && !c.pass ? ` (${c.delta})` : ''}`;
    let out = `${hit.node.id} "${hit.node.name}" (${hit.node.type} ${hit.node.w}×${hit.node.h}) ↔ ${args.selector} <${dom.tag}> ${dom.rect.width}×${dom.rect.height} @ ${vp}\n`
      + `${checks.length - bad.length} ✓ · ${bad.length} ✗\n\n${checks.map(line).join('\n')}`
      + (rows.length > 1 ? `\n\n(selector matches ${rows.length} elements, compared the first)` : '');

    if ((args.depth ?? 0) >= 1) {
      let kids;
      try { kids = await measure(url, width, `:is(${args.selector}) > *`, null, mopts); } catch (e) { return fail(`measure failed: ${e.message}`); }
      kids = kids.filter((k) => !k.hidden);
      const figKids = (hit.node.children ?? []).filter((c) => !c.mask && (c.w ?? 0) >= 1 && (c.h ?? 0) >= 1);
      const norm = (t) => (t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const used = new Set();
      // 1) text children by content; 2) a lone unmatched text child ↔ the element's own bare text;
      // 3) everything else by order among the elements still unused
      const byText = figKids.map((c) => (c.type === 'TEXT' && c.text
        ? kids.findIndex((k, idx) => !used.has(idx) && norm(k.text) && (norm(k.text) === norm(c.text) || norm(k.text).startsWith(norm(c.text).slice(0, 24))) && (used.add(idx), true))
        : -1));
      const bareText = norm(dom.ownText);
      const pairs = [];
      let cursor = 0;
      figKids.forEach((c, i) => {
        let j = byText[i];
        let self = false;
        if (j < 0 && c.type === 'TEXT') {
          const textKids = kids.filter((k, idx) => !used.has(idx) && norm(k.text));
          if (bareText && (norm(c.text) ? bareText.includes(norm(c.text).slice(0, 24)) : true)) self = true;
          else if (textKids.length === 1 && figKids.filter((x) => x.type === 'TEXT').length === 1) { j = kids.indexOf(textKids[0]); used.add(j); }
          else if (bareText) self = true;
        }
        if (j < 0 && !self && c.type !== 'TEXT') {
          while (cursor < kids.length && used.has(cursor)) cursor++;
          if (cursor < kids.length) { j = cursor; used.add(j); cursor++; }
        }
        pairs.push({ c, k: j >= 0 ? kids[j] : null, j, self });
      });
      out += `\n\nchildren (depth 1): ${figKids.length} in design, ${kids.length} visible on the page`;
      for (const { c, k, j, self } of pairs) {
        const label = `${c.id} ${c.type} "${c.type === 'TEXT' ? (c.text ?? '').slice(0, 40) : c.name}" ${c.w}×${c.h}`;
        if (self) {
          // bare text node inside the element: its font and colour are the element's own
          const cc = compareNode(c, dom, { ignore: [...(args.ignore ?? []), 'width', 'height'] });
          const cb = cc.filter((x) => !x.pass);
          out += `\n  ${cb.length ? '✗' : '✓'} ${label} ↔ text of <${dom.tag}> itself${norm(c.text) && !bareText.includes(norm(c.text).slice(0, 24)) ? ` (content differs: "${dom.ownText.slice(0, 40)}")` : ''}`
            + (cb.length ? '\n' + cb.map((x) => `      ${x.prop}: ${x.figma} → ${x.actual}${x.delta ? ` (${x.delta})` : ''}`).join('\n') : '');
          continue;
        }
        if (!k) { out += `\n  ✗ ${label} → no element`; continue; }
        const cc = compareNode(c, k, { ignore: args.ignore ?? [] });
        const cb = cc.filter((x) => !x.pass);
        out += `\n  ${cb.length ? '✗' : '✓'} ${label} ↔ #${j + 1} <${k.tag}> ${k.rect.width}×${k.rect.height}${k.text ? ` "${k.text.slice(0, 40)}"` : ''}`
          + (cb.length ? '\n' + cb.map((x) => `      ${x.prop}: ${x.figma} → ${x.actual}${x.delta ? ` (${x.delta})` : ''}`).join('\n') : '');
      }
      // gap: auto-layout itemSpacing vs the real distance between consecutive elements
      const l = hit.node.layout;
      if (l && kids.length >= 2) {
        const horiz = l.mode === 'HORIZONTAL';
        const steps = [];
        for (let i = 1; i < kids.length; i++) {
          const a = kids[i - 1].rect, b = kids[i].rect;
          steps.push(Math.round(((horiz ? b.x - (a.x + a.width) : b.y - (a.y + a.height))) * 10) / 10);
        }
        const uniq = [...new Set(steps)];
        const okGap = uniq.every((g) => Math.abs(g - (l.gap ?? 0)) <= 1);
        out += `\n  ${okGap ? '✓' : '✗'} gap (${horiz ? 'row' : 'column'}): ${l.gap ?? 0}px → ${uniq.length === 1 ? uniq[0] + 'px' : uniq.map((g) => g + 'px').join(', ')}`;
      }
    }
    return text(out);
  }

  if (name === 'pixel_guard_check_page') {
    const vp = args.viewport ?? 'desktop';
    const p = path.join(ROOT, 'reports', `${args.page}-${vp}.json`);
    const rep = readJson(p);
    if (!rep) return fail(`no report reports/${args.page}-${vp}.json — run npm run qa -- --page ${args.page} --viewport ${vp} first`);
    const onlyFailed = args.only_failed !== false;
    const nodes = rep.nodes.filter((n) => (onlyFailed ? n.status === 'failed' : true));
    const head = `${rep.page} @ ${rep.viewport} → ${rep.url}\n`
      + `${rep.score.pass} ✓ · ${rep.score.failed} ✗ · ${rep.score.missing} missing in DOM · ${rep.score.skip} skip\n`;
    const body = nodes.map((n) => {
      const rows = onlyFailed ? (n.diffs ?? []) : (n.checks ?? n.diffs ?? []);
      const lines = rows.map((d) => `    ${d.pass ? '✓' : '✗'} ${d.prop}: ${d.figma} → ${d.actual}${d.delta && !d.pass ? ` (${d.delta})` : ''}`).join('\n');
      return `\n${n.selector ?? n.key} [${n.status}${n.checked != null ? `, ${n.checked} checked` : ''}]${n.reason ? ` — ${n.reason}` : ''}\n${lines}`;
    }).join('');
    return text(head + (body || '\nno mismatches'));
  }

  if (name === 'pixel_guard_list_pages') {
    const cfg = readJson(path.join(ROOT, 'config/pages.json')) ?? {};
    const rows = Object.entries(cfg).map(([k, v]) => {
      const bp = Object.entries(v.frames ?? {}).filter(([, id]) => id).map(([n]) => n).join(',') || '—';
      return `${k.padEnd(16)} ${v.url}\n${' '.repeat(16)} breakpoints: ${bp}${v.match?.length ? ` · patterns: ${v.match.join(', ')}` : ''}`;
    });
    return text(rows.join('\n') || 'config/pages.json is empty');
  }

  return fail(`unknown tool: ${name}`);
}

// ── JSON-RPC over stdio ────────────────────────────────────────────────
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'pixel-guard', version: '0.1.0' },
    } });
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments ?? {});
      return send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true } });
    }
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method ${method} is not supported` } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (e) { process.stderr.write(`pixel-guard mcp: ${e.message}\n`); }
  }
});

process.on('exit', () => { closeBrowser().catch(() => {}); });
process.stdin.on('end', () => closeBrowser().finally(() => process.exit(0)));
process.stderr.write(`pixel-guard MCP ready · server ${BASE}\n`);
