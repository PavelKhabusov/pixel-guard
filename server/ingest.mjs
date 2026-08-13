import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCert } from './lib/cert.mjs';
import { saveFrames } from './lib/save.mjs';
import { subscribe, publish, peers } from './lib/bus.mjs';
import { ensureLocalConfigs } from './lib/bootstrap.mjs';

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
    const want = url.searchParams.get('frame');
    const files = fs.existsSync(SNAP) ? fs.readdirSync(SNAP).filter((f) => f.endsWith('.json') && !f.startsWith('_')) : [];
    res.setHeader('Content-Type', 'application/json');
    for (const f of files) {
      const j = readJsonSafe(path.join(SNAP, f));
      if (!j?.tree) continue;
      const root = want ? findById(j.tree, want) : j.tree;
      if (!root) continue;
      const png = path.join(SNAP, f.replace(/\.json$/, '.png'));
      const boxes = [];
      const walk = (n, depth) => {
        if (depth > 4) return;
        if (depth > 0 && (n.w ?? 0) >= 12 && (n.h ?? 0) >= 12) {
          boxes.push({ id: n.id, name: n.name, x: n.x - (root.x ?? 0), y: n.y - (root.y ?? 0), w: n.w, h: n.h, type: n.type });
        }
        for (const c of n.children ?? []) walk(c, depth + 1);
      };
      walk(root, 0);
      return res.end(JSON.stringify({
        frame: j.frameName, w: root.w, h: root.h, boxes,
        png: fs.existsSync(png) ? `/png?file=${encodeURIComponent(path.basename(png))}` : null,
      }));
    }
    return res.writeHead(404).end(JSON.stringify({ ok: false, error: 'нет снапшота' }));
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
        for (const pg of project.pages ?? []) saved.push(...saveFrames(pg.frames, SNAP));
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
