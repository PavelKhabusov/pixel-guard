import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCert } from './lib/cert.mjs';
import { saveFrames } from './lib/save.mjs';
import { subscribe, publish, peers } from './lib/bus.mjs';
import { ensureLocalConfigs } from './lib/bootstrap.mjs';
import { matchPage } from './lib/pagematch.mjs';

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
    console.warn(`[ingest] отказано не-локальному клиенту: ${req.socket.remoteAddress}`);
    return res.writeHead(403).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/ping') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true, service: 'pixel-guard', peers: peers() }));
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
    if (!hit) return res.writeHead(404).end(JSON.stringify({ ok: false, error: 'нет снапшота' }));
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
          error: `для ${forUrl} нет страницы в config/pages.json — добавь url или шаблон в match[]`,
        }));
      }
      matchedPage = { key: hit.key, how: hit.how };
      want = hit.cfg.frames?.[viewport] ?? null;
      if (!want) {
        res.setHeader('Content-Type', 'application/json');
        return res.writeHead(404).end(JSON.stringify({
          ok: false, error: `у страницы «${hit.key}» не задан frame для ${viewport}`,
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

      // карта привязок этой страницы — чтобы наложение шло поблочно,
      // каждый блок к своему DOM-элементу, а не одним слепком сверху.
      const pageKey = matchedPage?.key ?? url.searchParams.get('page');
      const pageMap = pageKey ? readJsonSafe(path.join(ROOT, 'maps', `${pageKey}.map.json`)) ?? {} : {};
      const sharedMap = readJsonSafe(path.join(ROOT, 'maps', '_shared.map.json')) ?? {};
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
          // @-ключ цепляем только к самому компоненту (INSTANCE/COMPONENT),
          // иначе одноимённый текст внутри секции получает тот же селектор
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
        // Не спускаемся внутрь иконок: у ноды есть свой SVG, либо все её
        // дети — векторы с SVG (обёртка «svg (location)» + два Vector).
        // Иначе поверх иконки ложатся пустые боксы с чужими цветами.
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
        anchored: boxes.filter((b) => b.anchor).length,
        png: fs.existsSync(png) ? `/png?file=${encodeURIComponent(path.basename(png))}` : null,
      }));
    }
    return res.writeHead(404).end(JSON.stringify({
      ok: false,
      error: want ? `снапшот с frame ${want} не найден — переэкспортируй макет` : 'нет снапшотов',
    }));
  }

  // ноды, на которые ссылается карта страницы — для сверки без Figma
  if (req.method === 'GET' && url.pathname === '/nodes') {
    const forUrl = url.searchParams.get('url');
    const viewport = url.searchParams.get('viewport') ?? 'desktop';
    const pages = readJsonSafe(path.join(ROOT, 'config/pages.json')) ?? {};
    const hit = forUrl ? matchPage(pages, forUrl) : null;
    const pageKey = hit?.key ?? url.searchParams.get('page') ?? 'home';
    const frameId = hit?.cfg?.frames?.[viewport] ?? pages[pageKey]?.frames?.[viewport];
    res.setHeader('Content-Type', 'application/json');
    if (!frameId) return res.writeHead(404).end(JSON.stringify({ ok: false, error: `нет frame для ${pageKey}/${viewport}` }));

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
      return res.end(JSON.stringify({ page: pageKey, viewport, frame: j.frameName, nodes: out, found: Object.keys(out).length, wanted: keys.length }));
    }
    return res.writeHead(404).end(JSON.stringify({ ok: false, error: `снапшот с frame ${frameId} не найден` }));
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
      if (!key) return res.writeHead(400).end(JSON.stringify({ ok: false, error: 'нет key' }));
      const target = key.startsWith('@') ? path.join(ROOT, 'maps', '_shared.map.json') : path.join(ROOT, 'maps', `${page}.map.json`);
      const cur = readJsonSafe(target) ?? {};
      if (remove) delete cur[key];
      else cur[key] = entry;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(cur, null, 2));
      console.log(`[map] ${remove ? 'удалено' : 'записано'} ${key} → ${path.relative(ROOT, target)}${entry?.selector ? ` (${entry.selector})` : ''}`);
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
        console.log(`[ingest] проект «${project.fileName}»: ${meta.pages.length} стр, ${saved.length - 1} frame, ${meta.modules.length} модулей (${shared} сквозных)`);
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
    console.log(`pixel-guard ingest: https://localhost:${TLS_PORT} → ${SNAP}  (Figma в браузере)`);
    if (created) console.log(`  сертификат создан: ${path.relative(ROOT, certPath)}`);
    console.log(`  один раз открой https://localhost:${TLS_PORT}/ping и прими самоподписанный сертификат`);
  });
} catch (e) {
  console.warn(`pixel-guard: HTTPS не поднят (${e.message}). Веб-Figma сможет только скачать JSON вручную.`);
}
