import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCert } from './lib/cert.mjs';
import { saveFrames } from './lib/save.mjs';
import { subscribe, publish, peers, peerDetails } from './lib/bus.mjs';
import { ensureLocalConfigs } from './lib/bootstrap.mjs';
import { matchPage } from './lib/pagematch.mjs';
import { flattenPng } from './lib/flatten.mjs';
import { renderHtml } from './report-html.mjs';

const PORT = Number(process.env.PORT || 8971);
const TLS_PORT = Number(process.env.TLS_PORT || PORT + 1);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SNAP = path.join(ROOT, 'snapshots');
const CERT_DIR = path.join(ROOT, 'config', 'cert');
const MAX_BODY = 300 * 1024 * 1024;

ensureLocalConfigs(ROOT);

const isLoopback = (ip = '') =>
  ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.') || ip === '::ffff:127.0.0.1' || ip.startsWith('::ffff:127.');

const handler = (req, res) => {
  if (!isLoopback(req.socket.remoteAddress)) {
    console.warn(`[ingest] rejected non-local client: ${req.socket.remoteAddress}`);
    return res.writeHead(403).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/ping') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: true, service: 'pixel-guard',
      peers: peers(),
      figmaAlive: (peers().figma ?? 0) > 0,
      connections: peerDetails(),
      render: { active: renderActive.size, queued: renderQueue.length, parallel: RENDER_PARALLEL },
    }));
  }

  if (req.method === 'GET' && url.pathname === '/bus') {
    subscribe(url.searchParams.get('role') ?? 'unknown', res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/emit') {
    return readBody(req, res, ({ event, payload, to }) => {
      const sent = publish(event, payload, to);
      res.end(JSON.stringify({ ok: true, sent }));
    });
  }

  if (req.method === 'GET' && url.pathname === '/snapshot') {
    const want = url.searchParams.get('frame');
    const files = fs.existsSync(SNAP) ? fs.readdirSync(SNAP).filter((f) => f.endsWith('.json')) : [];
    const hit = want
      ? files.find((f) => f === want || f === `${want}.json` || readJsonSafe(path.join(SNAP, f))?.frameId === want)
      : files[0];
    res.setHeader('Content-Type', 'application/json');
    if (!hit) return res.writeHead(404).end(JSON.stringify({ ok: false, error: 'no snapshot' }));
    return res.end(fs.readFileSync(path.join(SNAP, hit), 'utf8'));
  }

  if (req.method === 'GET' && url.pathname === '/snapshots') {
    const files = fs.existsSync(SNAP) ? fs.readdirSync(SNAP).filter((f) => f.endsWith('.json')) : [];
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(files.map((f) => {
      const j = readJsonSafe(path.join(SNAP, f)) ?? {};
      return { file: f, frameName: j.frameName, frameId: j.frameId, breakpoints: j.breakpoints ?? [] };
    })));
  }

  if (req.method === 'GET' && url.pathname === '/overlay') {
    let want = url.searchParams.get('frame');
    const forUrl = url.searchParams.get('url');
    const viewport = url.searchParams.get('viewport') ?? 'desktop';
    let matchedPage = null;

    const explicitPage = url.searchParams.get('page');
    if (!want && (forUrl || explicitPage)) {
      const pages = readJsonSafe(path.join(ROOT, 'config/pages.json')) ?? {};
      // an explicit page (a virtual page: modal / tab measured on the same URL) beats URL matching
      const hit = explicitPage && pages[explicitPage] ? { key: explicitPage, cfg: pages[explicitPage], how: 'page param' } : matchPage(pages, forUrl);
      if (!hit) {
        res.setHeader('Content-Type', 'application/json');
        return res.writeHead(404).end(JSON.stringify({
          ok: false,
          error: `no page for ${forUrl} in config/pages.json — add its url or a pattern to match[]`,
        }));
      }
      matchedPage = { key: hit.key, how: hit.how };
      want = hit.cfg.frames?.[viewport] ?? null;
      if (!want) {
        res.setHeader('Content-Type', 'application/json');
        return res.writeHead(404).end(JSON.stringify({
          ok: false, error: `page "${hit.key}" has no frame for ${viewport}`,
        }));
      }
    }

    const files = fs.existsSync(SNAP) ? fs.readdirSync(SNAP).filter((f) => f.endsWith('.json') && !f.startsWith('_')) : [];
    res.setHeader('Content-Type', 'application/json');
    for (const f of files) {
      const j = readJsonSafe(path.join(SNAP, f));
      if (!j?.tree) continue;
      const root = want ? findById(j.tree, want) : j.tree;
      if (!root) continue;
      const png = path.join(SNAP, f.replace(/\.json$/, '.png'));
      const depthLimit = Number(url.searchParams.get('depth') ?? 64);

      // this page's map — so the overlay is applied block by block,
      // each block onto its own DOM element, not as one flat layer on top.
      const pageKey = matchedPage?.key ?? url.searchParams.get('page');
      const pageMap = pageKey ? readJsonSafe(path.join(ROOT, 'maps', `${pageKey}.map.json`)) ?? {} : {};
      const sharedMap = readJsonSafe(path.join(ROOT, 'maps', '_shared.map.json')) ?? {};
      // pre-rendered block PNGs (npm run shots) — for per-container pixel comparison
      const shots = readJsonSafe(path.join(SNAP, 'shots', '_shots.json')) ?? {};
      const anchors = [];
      const skips = [];
      for (const [key, entry] of Object.entries({ ...sharedMap, ...pageMap })) {
        if (key.startsWith('_')) continue;
        if (entry?.skip) skips.push(key);
        else if (entry?.selector) anchors.push({ key, selector: entry.selector });
      }
      // "skip" in the map means the block is not in the markup at all:
      // drawing it would put a design-only section over some other block
      // "@name~WxH" matches by component/name within the size limit
      const keyMatches = (k, n) => {
        if (k === n.id) return true;
        if (!k.startsWith('@')) return false;
        // "@name" is a component key: a menu link whose text happens to equal a
        // section name ("Фотогалерея") must not inherit that section's skip
        if (n.type !== 'INSTANCE' && n.type !== 'COMPONENT') return false;
        const [names, size] = k.slice(1).split('~');
        const [maxW, maxH] = (size ?? '').split('x').map((v) => (v ? Number(v) : Infinity));
        if ((n.w ?? 0) > maxW || (n.h ?? 0) > maxH) return false;
        return names.split('|').some((nm) => nm.trim().toLowerCase() === (n.component ?? n.name ?? '').toLowerCase());
      };
      // a node that has a selector is never skipped: "@Header" (the 393px
      // mobile component) must not swallow the desktop header bound via @H|header
      const skipped = (n) => !anchors.some((a) => keyMatches(a.key, n)) && skips.some((k) => keyMatches(k, n));
      const boxes = [];
      // A frame with clipsContent cuts whatever hangs outside it (a 1112px
      // photo inside a 480px slot). Older snapshots have no clip flag — then
      // only image fills are clamped: a photo overflowing its slot is always
      // clipped, an overflowing row of buttons usually is not.
      const clipStack = [];
      // a skipped node is not drawn, but a bound descendant still is: "skip" on
      // a design-only wrapper row must not swallow the photo and picker inside it
      const hasAnchorInside = (n) => (n.children ?? []).some((c) => anchors.some((a) => keyMatches(a.key, c)) || hasAnchorInside(c));
      const walk = (n, depth, parentId) => {
        if (depth > depthLimit) return;
        if (depth > 0 && skipped(n)) {
          if (!hasAnchorInside(n)) return;
          for (const c of n.children ?? []) walk(c, depth + 1, parentId);
          return;
        }
        // masks are invisible; older snapshots have no flag — the clipPath group
        // from an SVG import is recognised by its name (clip0_810_1524)
        if (n.mask || /^clip\d*_/i.test(n.name ?? '')) return;
        let { x, y, w, h } = n;
        // a LINE is 0px tall in Figma — give it its stroke weight, otherwise it
        // is dropped as "too small" and dividers vanish from the overlay
        const stroked = Array.isArray(n.strokes) && n.strokes.length > 0;
        if (n.type === 'LINE' || (stroked && (h < 1 || w < 1))) {
          const sw = n.strokeWeight === 'mixed' ? 1 : (n.strokeWeight || 1);
          if (h < 1) h = sw;
          if (w < 1) w = sw;
        }
        // a thin filled bar (burger line 16×2) is a shape; only dots and hairlines are noise
        const small = (((n.w ?? 0) < 4 && (n.h ?? 0) < 4) || (n.w ?? 0) < 1 || (n.h ?? 0) < 1) && !n.svgRef && !stroked;
        const hasImage = Array.isArray(n.fills) && n.fills.some((f) => f && f.type === 'image');
        const clipBy = clipStack.length ? clipStack[clipStack.length - 1] : (hasImage && parentId ? parentBox.get(parentId) : null);
        let radius = n.cornerRadius ?? null;
        if (depth > 0 && clipBy) {
          const x2 = Math.min(x + w, clipBy.x + clipBy.w), y2 = Math.min(y + h, clipBy.y + clipBy.h);
          const clamped = x < clipBy.x || y < clipBy.y || x + w > clipBy.x + clipBy.w || y + h > clipBy.y + clipBy.h;
          x = Math.max(x, clipBy.x); y = Math.max(y, clipBy.y);
          w = Math.max(0, x2 - x); h = Math.max(0, y2 - y);
          if (clamped && radius == null) radius = clipBy.radius ?? null;
        }
        if (depth > 0 && !small && w >= 1 && h >= 1) {
          const fill = Array.isArray(n.fills) ? n.fills.find((f) => f.type === 'solid') : null;
          const image = Array.isArray(n.fills) && n.fills.some((f) => f.type === 'image');
          // attach an @-key only to the component itself (INSTANCE/COMPONENT),
          // otherwise a same-named text inside the section gets the same selector
          const anchor = anchors.find((a) => a.key === n.id)
            ?? anchors.find((a) => a.key.startsWith('@')
              && (n.type === 'INSTANCE' || n.type === 'COMPONENT')
              && a.key.slice(1).split('~')[0].split('|')
                   .some((nm) => nm.toLowerCase() === (n.component ?? n.name ?? '').toLowerCase()));
          boxes.push({
            id: n.id, name: n.name, type: n.type, parent: parentId,
            anchor: anchor?.selector ?? null,
            anchorKey: anchor?.key ?? null,
            x: Math.round((x - (root.x ?? 0)) * 10) / 10,
            y: Math.round((y - (root.y ?? 0)) * 10) / 10,
            w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10,
            fill: fill ? fill.color : null,
            fillOpacity: fill ? fill.opacity ?? 1 : null,
            image,
            radius,
            stroke: n.strokes?.[0]?.color ?? null,
            strokeOpacity: n.strokes?.[0] ? n.strokes[0].opacity ?? 1 : null,
            strokeWeight: n.strokeWeight === 'mixed' ? 1 : n.strokeWeight ?? null,
            opacity: n.opacity ?? 1,
            text: n.type === 'TEXT' ? n.text ?? '' : null,
            segments: n.type === 'TEXT' && Array.isArray(n.segments) ? n.segments : null,
            svgRef: n.svgRef ?? null,
            shot: anchor ? (shots[`${pageKey}|${viewport}|${anchor.key}`]?.file ?? null) : null,
            font: n.type === 'TEXT' && n.font ? {
              family: n.font.family, size: n.font.size, weight: n.font.weight,
              align: n.font.align, case: n.font.case, decoration: n.font.decoration ?? null,
              lineHeight: n.font.lineHeight?.unit === 'PIXELS' ? n.font.lineHeight.value
                : n.font.lineHeight?.unit === 'PERCENT' ? (n.font.lineHeight.value / 100) * n.font.size : null,
              letterSpacing: n.font.letterSpacing?.unit === 'PIXELS' ? n.font.letterSpacing.value
                : n.font.letterSpacing?.unit === 'PERCENT' ? (n.font.letterSpacing.value / 100) * n.font.size : null,
            } : null,
          });
        }
        // Don't descend into icons: the node has its own SVG, or all its
        // children are vectors with SVG (an "svg (location)" wrapper + two Vectors).
        // Otherwise empty boxes with foreign colours land on top of the icon.
        if (n.svgRef || n.svg) return;
        // a bare vector without its own SVG would be an empty box in a foreign colour;
        // a vector that carries an SVG (icon inside a 20×20 wrapper) must be drawn
        const bare = (c) => (c.type === 'VECTOR' || c.type === 'BOOLEAN_OPERATION') && !c.svgRef && !c.svg;
        parentBox.set(n.id, { x, y, w, h, radius });
        const clips = depth > 0 && n.clip;
        if (clips) clipStack.push({ x, y, w, h, radius });
        for (const c of n.children ?? []) if (!bare(c)) walk(c, depth + 1, depth > 0 ? n.id : null);
        if (clips) clipStack.pop();
      };
      const parentBox = new Map();
      walk(root, 0, null);
      return res.end(JSON.stringify({
        frame: j.frameName, page: matchedPage?.key, matchedBy: matchedPage?.how,
        w: root.w, h: root.h, boxes,
        svgLib: j.svgLib ?? {},
        shotsBase: '/shot?file=',
        hasShots: Object.keys(shots).length > 0,
        anchored: boxes.filter((b) => b.anchor).length,
        png: fs.existsSync(png) ? `/png?file=${encodeURIComponent(path.basename(png))}` : null,
      }));
    }
    return res.writeHead(404).end(JSON.stringify({
      ok: false,
      error: want ? `no snapshot with frame ${want} — re-export the design` : 'no snapshots',
    }));
  }

  // nodes referenced by the page map — for comparison without Figma
  if (req.method === 'GET' && url.pathname === '/nodes') {
    const forUrl = url.searchParams.get('url');
    const viewport = url.searchParams.get('viewport') ?? 'desktop';
    const pages = readJsonSafe(path.join(ROOT, 'config/pages.json')) ?? {};
    const explicit = url.searchParams.get('page');
    const hit = explicit && pages[explicit] ? { key: explicit, cfg: pages[explicit] } : forUrl ? matchPage(pages, forUrl) : null;
    const pageKey = hit?.key ?? explicit ?? 'home';
    const frameId = hit?.cfg?.frames?.[viewport] ?? pages[pageKey]?.frames?.[viewport];
    res.setHeader('Content-Type', 'application/json');
    if (!frameId) return res.writeHead(404).end(JSON.stringify({ ok: false, error: `no frame for ${pageKey}/${viewport}` }));

    const files = fs.existsSync(SNAP) ? fs.readdirSync(SNAP).filter((f) => f.endsWith('.json') && !f.startsWith('_')) : [];
    for (const f of files) {
      const j = readJsonSafe(path.join(SNAP, f));
      const root = j?.tree ? findById(j.tree, frameId) : null;
      if (!root) continue;

      const pageMap = readJsonSafe(path.join(ROOT, 'maps', `${pageKey}.map.json`)) ?? {};
      const sharedMap = readJsonSafe(path.join(ROOT, 'maps', '_shared.map.json')) ?? {};
      const keys = Object.keys({ ...sharedMap, ...pageMap }).filter((k) => !k.startsWith('_'));
      const out = {};
      const walk = (n) => {
        for (const k of keys) {
          if (out[k]) continue;
          const isAt = k.startsWith('@');
          const hitNode = isAt
            ? (n.type === 'INSTANCE' || n.type === 'COMPONENT')
              && k.slice(1).split('~')[0].split('|').some((nm) => nm.toLowerCase() === (n.component ?? n.name ?? '').toLowerCase())
            : n.id === k;
          if (hitNode) out[k] = n;
        }
        for (const c of n.children ?? []) walk(c);
      };
      walk(root);
      for (const k of Object.keys(out)) {
        const { children, ...rest } = out[k];
        out[k] = rest;
      }
      return res.end(JSON.stringify({ page: pageKey, viewport, frame: j.frameName, frameId, frameW: root.w, nodes: out, found: Object.keys(out).length, wanted: keys.length }));
    }
    return res.writeHead(404).end(JSON.stringify({ ok: false, error: `no snapshot with frame ${frameId}` }));
  }

  // On-demand render: ask the plugin for an image of a specific node.
  // Replaces the Figma REST API — works without a token and without rate limits.
  if (req.method === 'GET' && url.pathname === '/render') {
    const id = url.searchParams.get('id');
    if (!id) { res.setHeader('Content-Type', 'application/json'); return res.writeHead(400).end(JSON.stringify({ ok: false, error: '?id=<figma node id> is required' })); }
    const format0 = (url.searchParams.get('format') ?? 'PNG').toUpperCase();
    // WEBP is produced on the server from the plugin's PNG
    const toWebp = format0 === 'WEBP';
    const format = toWebp ? 'PNG' : format0;
    const scale = Number(url.searchParams.get('scale') ?? 2);
    const asJson = url.searchParams.get('json') === '1';
    const bg = url.searchParams.get('bg') ?? '#ffffff';
    const maxW = Number(url.searchParams.get('width') ?? 0) || null;
    // fast path: hand over the node's image fill without exportAsync at all
    const source = url.searchParams.get('source') === '1';

    if (!peers().figma) {
      res.setHeader('Content-Type', 'application/json');
      return res.writeHead(503).end(JSON.stringify({
        ok: false, error: 'Figma plugin is not connected — open pixel-guard in Figma and enable "live mode"',
      }));
    }

    const cacheKey = `${id}:${format}:${scale}:${bg}:${source ? 's' : ''}`;
    const deliver = async (result) => {
      if ((toWebp || maxW) && (result.format === 'PNG' || result.fallback)) {
        try {
          const t = await transformImage(result.bytes, { width: maxW, webp: toWebp, bg: bg === 'none' ? null : bg });
          result = { ...result, bytes: t.bytes, format: toWebp ? 'WEBP' : 'PNG', outWidth: t.width, outHeight: t.height, flattened: true };
        } catch (e) {
          console.warn(`[render] transform failed: ${e.message} — sending the original`);
        }
      }
      sendRender(res, result, asJson, result.flattened ? 'none' : bg);
    };
    const cached = renderCache.get(cacheKey);
    if (cached) return void deliver(cached);

    const reqId = `r${++renderSeq}`;
    const timeout = Math.min(300000, Math.max(5000, Number(url.searchParams.get('timeout') ?? 90) * 1000));
    const queued = enqueue({
      reqId, timeout, event: 'render', payload: { reqId, id, format, scale, source },
      done: (msg) => {
        if (msg.error) {
          res.setHeader('Content-Type', 'application/json');
          return res.writeHead(504).end(JSON.stringify({
            ok: false, error: msg.error, reqId, stage: msg.stage ?? 'lost', id, format,
          }));
        }
        renderCache.set(cacheKey, msg.result);
        if (renderCache.size > 200) renderCache.delete(renderCache.keys().next().value);
        deliver(msg.result);
      },
    });
    if (queued > 1) console.log(`[render] ${id} queued (${queued})`);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/find') {
    const query = url.searchParams.get('q') ?? '';
    res.setHeader('Content-Type', 'application/json');
    if (!peers().figma) return res.writeHead(503).end(JSON.stringify({ ok: false, error: 'Figma plugin is not connected' }));
    const reqId = `f${++renderSeq}`;
    enqueue({
      reqId, timeout: 30000, event: 'find', payload: { reqId, query },
      done: (msg) => {
        if (msg.error) return res.writeHead(504).end(JSON.stringify({ ok: false, error: msg.error, reqId }));
        res.end(JSON.stringify({ ok: true, nodes: msg.nodes }));
      },
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/render-ack') {
    return readBody(req, res, ({ reqId }) => {
      const job = renderActive.get(reqId);
      if (job) job.stage = 'rendering';
      res.end(JSON.stringify({ ok: true }));
    });
  }

  if (req.method === 'GET' && url.pathname === '/render-queue') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: true,
      parallel: RENDER_PARALLEL,
      active: [...renderActive.values()].map((j) => ({ reqId: j.reqId, stage: j.stage, ms: Date.now() - j.startedAt })),
      queued: renderQueue.length,
      cached: renderCache.size,
    }));
  }

  if (req.method === 'POST' && url.pathname === '/render-result') {
    return readBody(req, res, (msg) => {
      const fn = renderWaiters.get(msg.reqId);
      if (fn) { renderWaiters.delete(msg.reqId); fn(msg); }
      res.end(JSON.stringify({ ok: true }));
    });
  }

  if (req.method === 'GET' && url.pathname === '/shot') {
    const f = path.basename(url.searchParams.get('file') ?? '');
    const p = path.join(SNAP, 'shots', f);
    if (!f.endsWith('.png') || !fs.existsSync(p)) return res.writeHead(404).end();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'max-age=60');
    return res.end(fs.readFileSync(p));
  }

  if (req.method === 'GET' && url.pathname === '/png') {
    const f = path.basename(url.searchParams.get('file') ?? '');
    const p = path.join(SNAP, f);
    if (!f.endsWith('.png') || !fs.existsSync(p)) return res.writeHead(404).end();
    res.setHeader('Content-Type', 'image/png');
    return res.end(fs.readFileSync(p));
  }

  if (req.method === 'GET' && url.pathname === '/pages') {
    const cfg = readJsonSafe(path.join(ROOT, 'config/pages.json')) ?? {};
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(Object.entries(cfg).map(([key, v]) => ({ key, url: v.url, match: v.match ?? [], virtual: !!(v.prepare?.length) || (Array.isArray(v.match) && !v.match.length), title: v.title ?? null }))));
  }

  if (req.method === 'GET' && url.pathname === '/map') {
    // the content script asks by its own URL — the page map is picked via match[]
    const forUrl = url.searchParams.get('url');
    const pagesCfg = readJsonSafe(path.join(ROOT, 'config/pages.json')) ?? {};
    const pageKey = url.searchParams.get('page') ?? (forUrl ? matchPage(pagesCfg, forUrl)?.key : null) ?? 'home';
    const p = path.join(ROOT, 'maps', `${pageKey}.map.json`);
    const shared = readJsonSafe(path.join(ROOT, 'maps', '_shared.map.json')) ?? {};
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ...shared, ...(readJsonSafe(p) ?? {}) }));
  }

  // "Check page" in the extension writes the same report as `npm run qa`
  if (req.method === 'POST' && url.pathname === '/report') {
    return readBody(req, res, ({ page, viewport = 'desktop', url: pageUrl, frame, frameId, rows = [] }) => {
      if (!page) return res.writeHead(400).end(JSON.stringify({ ok: false, error: 'page is required' }));
      const score = { pass: 0, failed: 0, missing: 0, skip: 0, absent: 0, 'map-error': 0 };
      const nodes = rows.map((r) => {
        const status = r.status === 'nofig' ? 'absent' : r.status;
        score[status] = (score[status] ?? 0) + 1;
        const diffs = (r.rows ?? []).filter((x) => !x.pass).map((x) => ({ prop: x.prop, figma: x.fig, actual: x.act, pass: false, ...(x.delta && { delta: x.delta }) }));
        return { key: r.key, selector: r.selector, status, ...(r.reason && { reason: r.reason }), ...(r.rows && { checked: r.rows.length, diffs }) };
      });
      const report = { page, viewport, url: pageUrl, frame, frameId, generatedAt: new Date().toISOString(), source: 'extension', score, nodes };
      fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
      const base = path.join(ROOT, 'reports', `${page}-${viewport}`);
      fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 1));
      fs.writeFileSync(`${base}.html`, renderHtml(report));
      console.log(`[report] ${page}-${viewport}: ${score.pass} ✓ · ${score.failed} ✗ (from extension)`);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, file: `reports/${page}-${viewport}.json` }));
    });
  }

  if (req.method === 'POST' && url.pathname === '/map') {
    return readBody(req, res, ({ page = 'home', key, entry, remove }) => {
      if (!key) return res.writeHead(400).end(JSON.stringify({ ok: false, error: 'key is required' }));
      const target = key.startsWith('@') ? path.join(ROOT, 'maps', '_shared.map.json') : path.join(ROOT, 'maps', `${page}.map.json`);
      const cur = readJsonSafe(target) ?? {};
      if (remove) delete cur[key];
      else cur[key] = entry;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(cur, null, 2));
      console.log(`[map] ${remove ? 'removed' : 'saved'} ${key} → ${path.relative(ROOT, target)}${entry?.selector ? ` (${entry.selector})` : ''}`);
      res.end(JSON.stringify({ ok: true, file: path.relative(ROOT, target), size: Object.keys(cur).length }));
    });
  }

  if (req.method === 'POST' && url.pathname === '/ingest') {
    return readBody(req, res, ({ frames, project }) => {
      if (project) {
        const saved = [];
        const libs = { compLib: project.compLib, svgLib: project.svgLib };
        for (const pg of project.pages ?? []) saved.push(...saveFrames(pg.frames, SNAP, libs));
        fs.mkdirSync(SNAP, { recursive: true });
        const meta = {
          fileName: project.fileName,
          savedAt: new Date().toISOString(),
          pages: (project.pages ?? []).map((p) => ({
            page: p.page,
            frames: p.frames.map((f) => ({ frameId: f.frameId, frameName: f.frameName, breakpoints: f.breakpoints ?? [] })),
          })),
          modules: project.modules ?? [],
        };
        fs.writeFileSync(path.join(SNAP, '_project.json'), JSON.stringify(meta, null, 1));
        saved.push('snapshots/_project.json');
        const shared = meta.modules.filter((m) => m.shared).length;
        console.log(`[ingest] project "${project.fileName}": ${meta.pages.length} pages, ${saved.length - 1} frames, ${meta.modules.length} modules (${shared} shared)`);
        publish('snapshot', { saved, project: true });
        return res.end(JSON.stringify({ ok: true, saved }));
      }
      const saved = saveFrames(frames, SNAP);
      publish('snapshot', { saved, frames: frames.map((f) => ({ frameId: f.frameId, frameName: f.frameName, breakpoints: f.breakpoints ?? [] })) });
      res.end(JSON.stringify({ ok: true, saved }));
    });
  }

  res.writeHead(404).end();
};

const renderWaiters = new Map();
const renderCache = new Map();
let renderSeq = 0;

/** The Figma plugin is single-threaded: while it renders a large node, the
 *  next request just waits its turn and burns through its timeout. So we
 *  queue jobs and cap how many are in flight at once. */
const renderQueue = [];
const renderActive = new Map();
// the plugin exports one node at a time anyway; parallel requests only burn their timeouts in its queue
const RENDER_PARALLEL = Number(process.env.PG_RENDER_PARALLEL || 1);

function enqueue(job) {
  renderQueue.push(job);
  pumpQueue();
  return renderQueue.length + renderActive.size;
}

function pumpQueue() {
  while (renderActive.size < RENDER_PARALLEL && renderQueue.length) startJob(renderQueue.shift());
}

function startJob(job) {
  renderActive.set(job.reqId, job);
  job.stage = 'sent';
  job.startedAt = Date.now();

  job.timer = setTimeout(() => {
    renderWaiters.delete(job.reqId);
    finishJob(job, { error: `plugin did not respond within ${Math.round(job.timeout / 1000)}s`, stage: job.stage, reqId: job.reqId });
  }, job.timeout);

  renderWaiters.set(job.reqId, (msg) => {
    clearTimeout(job.timer);
    finishJob(job, msg);
  });

  publish(job.event, job.payload, 'figma');
}

function finishJob(job, msg) {
  renderActive.delete(job.reqId);
  try { job.done(msg); } catch (e) { console.error('[render]', e.message); }
  setImmediate(pumpQueue);
}

const MIME = { PNG: 'image/png', JPG: 'image/jpeg', SVG: 'image/svg+xml', PDF: 'application/pdf', WEBP: 'image/webp' };

/** Downscale / convert to WEBP in a headless page: a 13 MB source photo
 *  becomes a ready-to-use image in a second, with no native image deps. */
let _tfPage = null;
async function transformImage(base64, { width, webp, bg }) {
  if (!_tfPage) {
    const { chromium } = await import('playwright');
    const b = await chromium.launch();
    _tfPage = await (await b.newContext()).newPage();
  }
  const head = Buffer.from(base64.slice(0, 12), 'base64');
  const mime = head[0] === 0xff && head[1] === 0xd8 ? 'image/jpeg' : 'image/png';
  return _tfPage.evaluate(async ([b64, w, webp, bg, mime]) => {
    const img = new Image();
    img.src = `data:${mime};base64,${b64}`;
    await img.decode();
    const k = w && img.naturalWidth > w ? w / img.naturalWidth : 1;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(img.naturalWidth * k));
    cv.height = Math.max(1, Math.round(img.naturalHeight * k));
    const g = cv.getContext('2d');
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, cv.width, cv.height); }
    g.drawImage(img, 0, 0, cv.width, cv.height);
    return { bytes: cv.toDataURL(webp ? 'image/webp' : 'image/png', 0.85).split(',')[1], width: cv.width, height: cv.height };
  }, [base64, width, webp, bg, mime]);
}

function sendRender(res, result, asJson, bg = '#ffffff') {
  // Figma exports PNG without the canvas background — on a dark theme the
  // transparency reads as a black fill. Put an opaque background underneath.
  if (result.format === 'PNG' && bg !== 'none') {
    const flat = flattenPng(result.bytes, bg);
    if (flat) result = { ...result, bytes: flat };
  }
  if (asJson) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true, ...result }));
  }
  res.setHeader('Content-Type', MIME[result.format] ?? 'application/octet-stream');
  res.setHeader('X-Node-Name', encodeURIComponent(result.name ?? ''));
  if (result.fallback) res.setHeader('X-Render-Fallback', encodeURIComponent(result.fallback));
  return res.end(Buffer.from(result.bytes, 'base64'));
}

function findById(node, id) {
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const r = findById(c, id);
    if (r) return r;
  }
  return null;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function readBody(req, res, onJson) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    try {
      onJson(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    } catch (e) {
      console.error('[ingest] error:', e.message);
      res.writeHead(400).end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
}

const listenLocal = (server, port, done) => {
  server.on('error', (e) => {
    if (e.code !== 'EAFNOSUPPORT' && e.code !== 'EADDRNOTAVAIL') throw e;
    server.listen(port, '127.0.0.1', done);
  });
  server.listen(port, '::', done);
};

listenLocal(http.createServer(handler), PORT, () =>
  console.log(`pixel-guard ingest: http://localhost:${PORT} → ${SNAP}  (Figma Desktop)`)
);

try {
  const { key, cert, created, certPath } = ensureCert(CERT_DIR);
  listenLocal(https.createServer({ key, cert }, handler), TLS_PORT, () => {
    console.log(`pixel-guard ingest: https://localhost:${TLS_PORT} → ${SNAP}  (Figma in browser)`);
    if (created) console.log(`  certificate created: ${path.relative(ROOT, certPath)}`);
    console.log(`  open https://localhost:${TLS_PORT}/ping once and accept the self-signed certificate`);
  });
} catch (e) {
  console.warn(`pixel-guard: HTTPS not started (${e.message}). Web Figma will only be able to download JSON manually.`);
}
