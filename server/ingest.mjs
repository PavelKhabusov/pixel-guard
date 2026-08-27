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

    if (!want && forUrl) {
      const pages = readJsonSafe(path.join(ROOT, 'config/pages.json')) ?? {};
      const hit = matchPage(pages, forUrl);
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
      const depthLimit = Number(url.searchParams.get('depth') ?? 8);

      // this page's map — so the overlay is applied block by block,
      // each block onto its own DOM element, not as one flat layer on top.
      const pageKey = matchedPage?.key ?? url.searchParams.get('page');
      const pageMap = pageKey ? readJsonSafe(path.join(ROOT, 'maps', `${pageKey}.map.json`)) ?? {} : {};
      const sharedMap = readJsonSafe(path.join(ROOT, 'maps', '_shared.map.json')) ?? {};
      // pre-rendered block PNGs (npm run shots) — for per-container pixel comparison
      const shots = readJsonSafe(path.join(SNAP, 'shots', '_shots.json')) ?? {};
      const anchors = [];
      for (const [key, entry] of Object.entries({ ...sharedMap, ...pageMap })) {
        if (key.startsWith('_') || !entry?.selector) continue;
        anchors.push({ key, selector: entry.selector });
      }
      const boxes = [];
      const walk = (n, depth) => {
        if (depth > depthLimit) return;
        const small = (n.w ?? 0) < 4 || (n.h ?? 0) < 4;
        if (depth > 0 && !small) {
          const fill = Array.isArray(n.fills) ? n.fills.find((f) => f.type === 'solid') : null;
          // attach an @-key only to the component itself (INSTANCE/COMPONENT),
          // otherwise a same-named text inside the section gets the same selector
          const anchor = anchors.find((a) => a.key === n.id)
            ?? anchors.find((a) => a.key.startsWith('@')
              && (n.type === 'INSTANCE' || n.type === 'COMPONENT')
              && a.key.slice(1).split('~')[0].split('|')
                   .some((nm) => nm.toLowerCase() === (n.component ?? n.name ?? '').toLowerCase()));
          boxes.push({
            id: n.id, name: n.name, type: n.type,
            anchor: anchor?.selector ?? null,
            anchorKey: anchor?.key ?? null,
            x: Math.round((n.x - (root.x ?? 0)) * 10) / 10,
            y: Math.round((n.y - (root.y ?? 0)) * 10) / 10,
            w: n.w, h: n.h,
            fill: fill ? fill.color : null,
            fillOpacity: fill ? fill.opacity ?? 1 : null,
            radius: n.cornerRadius ?? null,
            stroke: n.strokes?.[0]?.color ?? null,
            strokeWeight: n.strokeWeight === 'mixed' ? 1 : n.strokeWeight ?? null,
            opacity: n.opacity ?? 1,
            text: n.type === 'TEXT' ? n.text ?? '' : null,
            svgRef: n.svgRef ?? null,
            shot: anchor ? (shots[`${pageKey}|${viewport}|${anchor.key}`]?.file ?? null) : null,
            font: n.type === 'TEXT' && n.font ? {
              family: n.font.family, size: n.font.size, weight: n.font.weight,
              align: n.font.align, case: n.font.case,
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
        const kids = n.children ?? [];
        const vectorish = kids.length > 0 && kids.every((c) =>
          c.svgRef || c.svg || c.type === 'VECTOR' || c.type === 'BOOLEAN_OPERATION');
        if (vectorish) return;
        for (const c of kids) walk(c, depth + 1);
      };
      walk(root, 0);
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
    const hit = forUrl ? matchPage(pages, forUrl) : null;
    const pageKey = hit?.key ?? url.searchParams.get('page') ?? 'home';
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
      return res.end(JSON.stringify({ page: pageKey, viewport, frame: j.frameName, frameW: root.w, nodes: out, found: Object.keys(out).length, wanted: keys.length }));
    }
    return res.writeHead(404).end(JSON.stringify({ ok: false, error: `no snapshot with frame ${frameId}` }));
  }

  // On-demand render: ask the plugin for an image of a specific node.
  // Replaces the Figma REST API — works without a token and without rate limits.
  if (req.method === 'GET' && url.pathname === '/render') {
    const id = url.searchParams.get('id');
    if (!id) { res.setHeader('Content-Type', 'application/json'); return res.writeHead(400).end(JSON.stringify({ ok: false, error: '?id=<figma node id> is required' })); }
    const format = (url.searchParams.get('format') ?? 'PNG').toUpperCase();
    const scale = Number(url.searchParams.get('scale') ?? 2);
    const asJson = url.searchParams.get('json') === '1';
    const bg = url.searchParams.get('bg') ?? '#ffffff';

    if (!peers().figma) {
      res.setHeader('Content-Type', 'application/json');
      return res.writeHead(503).end(JSON.stringify({
        ok: false, error: 'Figma plugin is not connected — open pixel-guard in Figma and enable "live mode"',
      }));
    }

    const cacheKey = `${id}:${format}:${scale}:${bg}`;
    const cached = renderCache.get(cacheKey);
    if (cached) return sendRender(res, cached, asJson, bg);

    const reqId = `r${++renderSeq}`;
    const timeout = Math.min(300000, Math.max(5000, Number(url.searchParams.get('timeout') ?? 90) * 1000));
    const queued = enqueue({
      reqId, timeout, event: 'render', payload: { reqId, id, format, scale },
      done: (msg) => {
        if (msg.error) {
          res.setHeader('Content-Type', 'application/json');
          return res.writeHead(504).end(JSON.stringify({
            ok: false, error: msg.error, reqId, stage: msg.stage ?? 'lost', id, format,
          }));
        }
        renderCache.set(cacheKey, msg.result);
        if (renderCache.size > 200) renderCache.delete(renderCache.keys().next().value);
        sendRender(res, msg.result, asJson, bg);
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
    return res.end(JSON.stringify(Object.entries(cfg).map(([key, v]) => ({ key, url: v.url }))));
  }

  if (req.method === 'GET' && url.pathname === '/map') {
    const p = path.join(ROOT, 'maps', `${url.searchParams.get('page') ?? 'home'}.map.json`);
    const shared = readJsonSafe(path.join(ROOT, 'maps', '_shared.map.json')) ?? {};
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ...shared, ...(readJsonSafe(p) ?? {}) }));
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
const RENDER_PARALLEL = Number(process.env.PG_RENDER_PARALLEL || 3);

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

const MIME = { PNG: 'image/png', JPG: 'image/jpeg', SVG: 'image/svg+xml', PDF: 'application/pdf' };

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
