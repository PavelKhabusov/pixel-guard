#!/usr/bin/env node
/**
 * MCP-сервер pixel-guard: даёт агентам Claude доступ к макету Figma
 * через наш плагин, без Figma REST API и его лимитов.
 *
 * Транспорт — JSON-RPC по stdio (спецификация MCP), поэтому SDK не нужен.
 * В stdout уходит ТОЛЬКО протокол; всё остальное — в stderr.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.PG_BASE || 'http://localhost:8971';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

async function api(pathname, { raw = false } = {}) {
  const r = await fetch(`${BASE}${pathname}`);
  if (raw) return { ok: r.ok, status: r.status, buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') };
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, json: j };
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

const TOOLS = [
  {
    name: 'figma_render_node',
    description: 'Отрендерить ноду макета Figma в картинку через плагин pixel-guard (без REST API и лимитов). '
      + 'Возвращает изображение. Нужен запущенный npm run server и открытый плагин с включённым «живым режимом».',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id ноды Figma, например 445:3377' },
        format: { type: 'string', enum: ['PNG', 'JPG', 'SVG', 'PDF'], description: 'формат, по умолчанию PNG' },
        scale: { type: 'number', description: 'масштаб для PNG/JPG, по умолчанию 2' },
        save_to: { type: 'string', description: 'если указан — сохранить файл по этому пути вместо отдачи картинкой' },
      },
      required: ['id'],
    },
  },
  {
    name: 'figma_find_nodes',
    description: 'Найти ноды в макете Figma по части имени (через плагин). Возвращает id, имя, тип, размер и страницу.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'часть имени ноды' } },
      required: ['query'],
    },
  },
  {
    name: 'figma_get_node_styles',
    description: 'Точные значения ноды из снапшота на диске: шрифты, цвета, размеры, padding/gap из auto-layout. '
      + 'Работает без Figma — читает snapshots/*.json.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'id ноды Figma' } },
      required: ['id'],
    },
  },
  {
    name: 'pixel_guard_check_page',
    description: 'Отчёт сверки вёрстки с макетом по странице: какие свойства разошлись, селектор + figma → actual. '
      + 'Читает готовый reports/<page>-<viewport>.json (сначала запусти npm run qa).',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'ключ страницы из config/pages.json, например home' },
        viewport: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] },
        only_failed: { type: 'boolean', description: 'только расхождения (по умолчанию true)' },
      },
      required: ['page'],
    },
  },
  {
    name: 'pixel_guard_list_pages',
    description: 'Список страниц проекта: ключ, URL, шаблоны match и снятые брейкпоинты.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function findNodeInSnapshots(id) {
  const dir = path.join(ROOT, 'snapshots');
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
    const j = readJson(path.join(dir, f));
    if (!j?.tree) continue;
    const walk = (n) => {
      if (n.id === id) return n;
      for (const c of n.children ?? []) { const r = walk(c); if (r) return r; }
      return null;
    };
    const hit = walk(j.tree);
    if (hit) return { node: hit, frame: j.frameName, file: f };
  }
  return null;
}

async function callTool(name, args = {}) {
  if (name === 'figma_render_node') {
    const format = (args.format ?? 'PNG').toUpperCase();
    const q = `/render?id=${encodeURIComponent(args.id)}&format=${format}&scale=${args.scale ?? 2}`;

    if (args.save_to) {
      const r = await api(q, { raw: true });
      if (!r.ok) return fail(`не отрендерил: ${r.buf.toString('utf8').slice(0, 300)}`);
      fs.mkdirSync(path.dirname(path.resolve(args.save_to)), { recursive: true });
      fs.writeFileSync(path.resolve(args.save_to), r.buf);
      return text(`сохранено: ${args.save_to} (${Math.round(r.buf.length / 1024)} КБ, ${format})`);
    }

    const r = await api(`${q}&json=1`);
    if (!r.ok) return fail(r.json?.error ?? `ошибка ${r.status}`);
    if (format === 'SVG' || format === 'PDF') {
      const body = Buffer.from(r.json.bytes, 'base64').toString('utf8');
      return text(`${r.json.name} · ${r.json.width}×${r.json.height}\n\n${body.slice(0, 20000)}`);
    }
    return {
      content: [
        { type: 'text', text: `${r.json.name} · ${r.json.type} · ${r.json.width}×${r.json.height}` },
        { type: 'image', data: r.json.bytes, mimeType: format === 'JPG' ? 'image/jpeg' : 'image/png' },
      ],
    };
  }

  if (name === 'figma_find_nodes') {
    const r = await api(`/find?q=${encodeURIComponent(args.query)}`);
    if (!r.ok || r.json?.ok === false) return fail(r.json?.error ?? `ошибка ${r.status}`);
    const list = r.json.nodes ?? [];
    if (!list.length) return text(`ничего не найдено по «${args.query}»`);
    return text(list.map((n) => `${n.id}  ${n.type.padEnd(9)} ${n.width}×${n.height}  ${n.name}  [${n.page}]`).join('\n'));
  }

  if (name === 'figma_get_node_styles') {
    const hit = findNodeInSnapshots(args.id);
    if (!hit) return fail(`ноды ${args.id} нет в снапшотах — попроси Pavel снять экспорт плагином`);
    const { children, svg, ...node } = hit.node;
    return text(`макет «${hit.frame}» (${hit.file})\n\n${JSON.stringify(node, null, 2)}`);
  }

  if (name === 'pixel_guard_check_page') {
    const vp = args.viewport ?? 'desktop';
    const p = path.join(ROOT, 'reports', `${args.page}-${vp}.json`);
    const rep = readJson(p);
    if (!rep) return fail(`нет отчёта reports/${args.page}-${vp}.json — сначала npm run qa -- --page ${args.page} --viewport ${vp}`);
    const onlyFailed = args.only_failed !== false;
    const nodes = rep.nodes.filter((n) => (onlyFailed ? n.status === 'failed' : true));
    const head = `${rep.page} @ ${rep.viewport} → ${rep.url}\n`
      + `${rep.score.pass} ✓ · ${rep.score.failed} ✗ · ${rep.score.missing} нет в DOM · ${rep.score.skip} skip\n`;
    const body = nodes.map((n) => {
      const diffs = (n.diffs ?? []).map((d) => `    ${d.prop}: ${d.figma} → ${d.actual}${d.delta ? ` (${d.delta})` : ''}`).join('\n');
      return `\n${n.selector ?? n.key} [${n.status}]\n${diffs}`;
    }).join('');
    return text(head + (body || '\nрасхождений нет'));
  }

  if (name === 'pixel_guard_list_pages') {
    const cfg = readJson(path.join(ROOT, 'config/pages.json')) ?? {};
    const rows = Object.entries(cfg).map(([k, v]) => {
      const bp = Object.entries(v.frames ?? {}).filter(([, id]) => id).map(([n]) => n).join(',') || '—';
      return `${k.padEnd(16)} ${v.url}\n${' '.repeat(16)} брейкпоинты: ${bp}${v.match?.length ? ` · шаблоны: ${v.match.join(', ')}` : ''}`;
    });
    return text(rows.join('\n') || 'config/pages.json пуст');
  }

  return fail(`неизвестный инструмент: ${name}`);
}

// ── JSON-RPC по stdio ────────────────────────────────────────────────
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
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `ошибка: ${e.message}` }], isError: true } });
    }
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `метод ${method} не поддерживается` } });
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

process.stderr.write(`pixel-guard MCP готов · сервер ${BASE}\n`);
