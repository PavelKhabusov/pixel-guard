let map = {};
let box = null;
let lastEl = null;

const px = (s) => (s == null ? null : Math.round(parseFloat(s) * 10) / 10);

const parseColor = (s) => {
  const m = String(s).match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?\)/);
  if (!m) return null;
  const h = (n) => Number(n).toString(16).padStart(2, '0');
  return { hex: `#${h(m[1])}${h(m[2])}${h(m[3])}`, alpha: m[4] === undefined ? 1 : Number(m[4]) };
};

function figmaLineHeight(lh, size) {
  if (!lh || lh === 'mixed' || lh.unit === 'AUTO') return null;
  if (lh.unit === 'PIXELS') return lh.value;
  if (lh.unit === 'PERCENT') return (lh.value / 100) * size;
  return null;
}

function ensureBox() {
  if (box) return;
  box = document.createElement('div');
  box.className = 'pg-box';
  document.documentElement.appendChild(box);
  addEventListener('scroll', () => { if (lastEl) place(lastEl); }, { passive: true });
}

function place(el) {
  ensureBox();
  const r = el.getBoundingClientRect();
  Object.assign(box.style, {
    top: `${r.top + scrollY}px`, left: `${r.left + scrollX}px`,
    width: `${r.width}px`, height: `${r.height}px`,
  });
  box.classList.add('pg-on');
}

function diff(node, el) {
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const out = [];
  const cmp = (prop, fig, act, tol = 1) => {
    if (fig == null || act == null) return;
    const d = Math.round((act - fig) * 10) / 10;
    out.push({ prop, fig: `${fig}px`, act: `${act}px`, pass: Math.abs(d) <= tol, delta: `${d > 0 ? '+' : ''}${d}px` });
  };

  const hug = node.autoResize === 'WIDTH_AND_HEIGHT' || node.autoResize === 'TRUNCATE';
  if (!hug) cmp('width', node.w, px(r.width), 2);
  if (node.type === 'TEXT') {
    const act = px(r.height);
    const lo = node.renderH ?? node.h;
    const hi = Math.max(node.h ?? 0, node.renderH ?? 0);
    if (act != null && lo != null) {
      const pass = act >= lo - 10 && act <= hi + 10;
      out.push({ prop: 'height', fig: `${lo === hi ? lo : lo + '…' + hi}px`, act: `${act}px`, pass,
        delta: pass ? '' : `${act < lo ? '' : '+'}${Math.round((act < lo ? act - lo : act - hi) * 10) / 10}px` });
    }
  } else cmp('height', node.h, px(r.height), 2);

  const f = node.font;
  if (f) {
    const fam = (s.fontFamily || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
    if (f.family && f.family !== 'mixed')
      out.push({ prop: 'font-family', fig: f.family, act: fam, pass: f.family.toLowerCase() === fam.toLowerCase() });
    if (f.size !== 'mixed') cmp('font-size', f.size, px(s.fontSize));
    if (f.weight !== 'mixed')
      out.push({ prop: 'font-weight', fig: String(f.weight), act: s.fontWeight, pass: String(f.weight) === s.fontWeight });
    const lh = figmaLineHeight(f.lineHeight, f.size);
    if (lh != null && s.lineHeight !== 'normal') cmp('line-height', Math.round(lh * 10) / 10, px(s.lineHeight));
  }

  const fill = (node.fills || []).find((x) => x.type === 'solid');
  if (fill) {
    const prop = node.type === 'TEXT' ? 'color' : 'background-color';
    const act = parseColor(node.type === 'TEXT' ? s.color : s.backgroundColor);
    if (act) out.push({ prop, fig: fill.color, act: act.hex, pass: act.hex === fill.color.toLowerCase() });
  }

  if (node.layout) {
    const [pt, pr, pb, pl] = node.layout.padding || [];
    cmp('padding-top', pt, px(s.paddingTop));
    cmp('padding-right', pr, px(s.paddingRight));
    cmp('padding-bottom', pb, px(s.paddingBottom));
    cmp('padding-left', pl, px(s.paddingLeft));
  }
  return out;
}

function lookup(node) {
  const direct = map[node.figmaId] || map[node.path];
  if (direct) return direct;

  const cand = [node.component, node.name].filter(Boolean).map((s) => s.toLowerCase());
  for (const [key, entry] of Object.entries(map)) {
    if (!key.startsWith('@')) continue;
    const [namePart, sizePart] = key.slice(1).split('~');
    const names = namePart.toLowerCase().split('|').map((s) => s.trim());
    if (!names.some((n) => cand.includes(n))) continue;
    const [maxW, maxH] = (sizePart ?? '').split('x').map((v) => (v ? Number(v) : Infinity));
    if ((node.w ?? 0) > (maxW ?? Infinity) || (node.h ?? 0) > (maxH ?? Infinity)) continue;
    return entry;
  }
  return undefined;
}

function analyse(node) {
  const name = node.name || node.figmaId;
  const entry = lookup(node);
  const sel = entry?.selector;

  if (entry?.skip) {
    if (box) box.classList.remove('pg-on');
    return { name, figmaId: node.figmaId, skip: entry.skip };
  }

  const el = sel ? document.querySelector(sel) : null;
  if (!el) {
    if (box) box.classList.remove('pg-on');
    lastEl = null;
    return { name, figmaId: node.figmaId, selector: sel, found: false };
  }

  lastEl = el;
  place(el);
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return { name, figmaId: node.figmaId, selector: sel, found: true, rows: diff(node, el) };
}

const loadMap = () =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'pg-fetch', path: '/map?page=home' }, (m) => {
      if (m && !m.error) map = m;
      resolve(map);
    });
  });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'pg-map') { map = msg.map || {}; return; }
  if (msg.type === 'pg-mapsize') { reply(Object.keys(map).filter((k) => !k.startsWith('_')).length); return true; }
  if (msg.type === 'pg-select') {
    const run = () => reply(analyse(msg.node));
    if (Object.keys(map).length) run();
    else loadMap().then(run);
    return true;
  }
});

loadMap();

let ov = null;

function buildOverlay() {
  if (ov) return ov;
  ov = document.createElement('div');
  ov.className = 'pg-overlay';
  document.documentElement.appendChild(ov);
  return ov;
}

function showOverlay(data, opts) {
  buildOverlay();
  const anchor = document.querySelector(opts.anchor || 'body');
  const top = anchor ? anchor.getBoundingClientRect().top + scrollY : 0;
  const scale = opts.fit && data.w ? innerWidth / data.w : 1;

  ov.style.top = `${top}px`;
  ov.style.width = `${data.w * scale}px`;
  ov.style.height = `${data.h * scale}px`;
  ov.style.opacity = String(opts.opacity ?? 0.5);
  ov.style.display = 'block';
  ov.classList.toggle('pg-diff', !!opts.diff);

  ov.innerHTML = '';
  if (data.png && opts.mode !== 'boxes') {
    const img = document.createElement('img');
    img.src = `http://localhost:8971${data.png}`;
    img.style.width = '100%';
    ov.appendChild(img);
  } else {
    for (const b of data.boxes) {
      const d = document.createElement('div');
      d.className = 'pg-obox';
      d.style.cssText = `left:${b.x * scale}px;top:${b.y * scale}px;width:${b.w * scale}px;height:${b.h * scale}px`;
      d.title = `${b.name} · ${b.w}×${b.h}`;
      ov.appendChild(d);
    }
  }
  return { boxes: data.boxes.length, png: !!data.png, scale: Math.round(scale * 100) / 100 };
}

function hideOverlay() {
  if (ov) ov.style.display = 'none';
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'pg-overlay-show') { reply(showOverlay(msg.data, msg.opts ?? {})); return true; }
  if (msg.type === 'pg-overlay-hide') { hideOverlay(); reply({ ok: true }); return true; }
});
