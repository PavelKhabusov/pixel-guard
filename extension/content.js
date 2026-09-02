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
  // A full-width block stretches across the whole window, while the design is
  // captured at a fixed width: the difference is the window width, not a page
  // bug. Skip the comparison.
  const fullWidth = Math.abs(node.w - (window.__pgFrameW ?? node.w)) < 2
    && Math.abs(r.width - innerWidth) < 4;
  if (!hug && !fullWidth) cmp('width', node.w, px(r.width), 2);
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
    const inset = effectivePadding(el);
    // Figma keeps padding on the section; the site may put it on a nested
    // centered container — accept the literal padding OR the effective inset
    const pad = (side, fig, lit) => {
      if (fig == null || lit == null) return;
      cmp(`padding-${side}`, fig, Math.abs(lit - fig) <= 1 ? lit : inset[side]);
    };
    pad('top', pt, px(s.paddingTop));
    pad('right', pr, px(s.paddingRight));
    pad('bottom', pb, px(s.paddingBottom));
    pad('left', pl, px(s.paddingLeft));
  }
  return out;
}

// same as server/lib/inset.mjs — content scripts cannot import it
function effectivePadding(el) {
  const pf = (v) => parseFloat(v) || 0;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  let pad = { top: pf(cs.paddingTop), right: pf(cs.paddingRight), bottom: pf(cs.paddingBottom), left: pf(cs.paddingLeft) };
  let cur = el;
  for (let hops = 0; hops < 4; hops++) {
    const kids = [...cur.children].filter((c) => {
      const d = getComputedStyle(c);
      return d.display !== 'none' && d.position !== 'absolute' && d.position !== 'fixed';
    });
    if (kids.length !== 1) break;
    const k = kids[0];
    const kr = k.getBoundingClientRect();
    if (kr.width < 1 || kr.height < 1) break;
    const kc = getComputedStyle(k);
    pad = {
      top: kr.top - r.top + pf(kc.paddingTop),
      right: r.right - kr.right + pf(kc.paddingRight),
      bottom: r.bottom - kr.bottom + pf(kc.paddingBottom),
      left: kr.left - r.left + pf(kc.paddingLeft),
    };
    cur = k;
  }
  const round = (v) => Math.round(v * 10) / 10;
  return { top: round(pad.top), right: round(pad.right), bottom: round(pad.bottom), left: round(pad.left) };
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

const loadMap = (page) =>
  new Promise((resolve) => {
    const q = page ? `page=${encodeURIComponent(page)}` : `url=${encodeURIComponent(location.href)}`;
    chrome.runtime.sendMessage({ type: 'pg-fetch', path: `/map?${q}` }, (m) => {
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

/** SPA navigation (React Router, Next): the URL changes without a reload, so the
 *  page map and the overlay data must follow it. */
(() => {
  let last = location.href;
  const changed = () => {
    if (location.href === last) return;
    last = location.href;
    map = {};
    loadMap().then(() => chrome.runtime.sendMessage({ type: 'pg-spa-nav', url: location.href }).catch(() => {}));
  };
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function (...a) { const r = orig.apply(this, a); setTimeout(changed, 0); return r; };
  }
  addEventListener('popstate', () => setTimeout(changed, 0));
  addEventListener('hashchange', () => setTimeout(changed, 0));
})();

const within = (b, a) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w + 1 && b.y + b.h <= a.y + a.h + 1;

let ov = null;
let fixedLayer = null;
let lastOverlay = null;
const shotCache = new Map();
let reflowPending = false;

function buildOverlay() {
  if (ov) return ov;
  ov = document.createElement('div');
  ov.className = 'pg-overlay';
  document.documentElement.appendChild(ov);
  return ov;
}

// #rrggbb + Figma paint opacity → #rrggbbaa; the design's half-transparent
// text and 25% dividers must not turn solid in the overlay
const withAlpha = (hex, op) => (hex && op != null && op < 1 ? hex + Math.round(op * 255).toString(16).padStart(2, '0') : hex);

function boxStyle(b, opts) {
  const css = [];
  if (b.opacity != null && b.opacity !== 1) css.push(`opacity:${b.opacity}`);
  if (opts.mode !== 'outline') {
    // a photo placeholder: the design has an image fill we cannot reproduce,
    // hatch it so the slot reads as "picture goes here" and not as a blank
    if (b.image && !b.svg && !b.svgRef) css.push('background:repeating-linear-gradient(45deg,#d9d9d9 0 8px,#ececec 8px 16px)');
    else if (b.fill && !b.svg && !b.svgRef) css.push(`background:${withAlpha(b.fill, b.fillOpacity)}`);
    if (b.radius != null) css.push(`border-radius:${Array.isArray(b.radius) ? b.radius.map((r) => r + 'px').join(' ') : b.radius + 'px'}`);
    if (b.stroke) css.push(`box-shadow:inset 0 0 0 ${b.strokeWeight || 1}px ${withAlpha(b.stroke, b.strokeOpacity)}`);
  }
  if (b.text != null && b.font && opts.mode !== 'outline') {
    const f = b.font;
    css.push(
      `color:${withAlpha(b.fill, b.fillOpacity) || '#000'}`,
      `font-family:'${f.family}',sans-serif`,
      `font-size:${f.size}px`,
      `font-weight:${f.weight}`,
      `line-height:${f.lineHeight ? f.lineHeight + 'px' : 'normal'}`,
      `text-align:${({ LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }[f.align] || 'left')}`,
      'background:none',
      // single-line design text must stay on one line even with a wider fallback font
      b.text.includes('\n') || b.h > f.size * 1.7 ? 'white-space:pre-wrap' : 'white-space:pre',
      'overflow:visible',
    );
    if (f.letterSpacing) css.push(`letter-spacing:${f.letterSpacing}px`);
    if (f.case === 'UPPER') css.push('text-transform:uppercase');
    if (f.decoration === 'UNDERLINE') css.push('text-decoration:underline');
    if (f.decoration === 'STRIKETHROUGH') css.push('text-decoration:line-through');
  }
  return css;
}

function makeBox(b, opts, left, top, scale, lib) {
  const d = document.createElement('div');
  d.className = 'pg-obox';

  // "PNG per block": the anchor block has its own render from Figma —
  // place the image instead of redrawing nodes, it is pixel-perfect
  if (opts.mode === 'shots' && b.shot) {
    const img = document.createElement('img');
    // A Figma PNG can be taller than the node (shadows, effects exceed the
    // bounding box): stretch by width, keep the height proportional so nothing is clipped
    img.style.cssText = 'width:100%;height:auto;display:block';
    const cached = shotCache.get(b.shot);
    if (cached) img.src = cached;
    else {
      chrome.runtime.sendMessage({ type: 'pg-shot', file: b.shot }, (r) => {
        if (r?.ok) { shotCache.set(b.shot, r.dataUrl); img.src = r.dataUrl; }
      });
    }
    d.appendChild(img);
    d.style.cssText = `left:${left}px;top:${top}px;width:${b.w * scale}px;overflow:visible`;
    d.title = `${b.name} · ${b.w}×${b.h} (PNG from design)`;
    return d;
  }

  const svg = b.svg ?? (b.svgRef && lib ? lib[b.svgRef] : null);
  if (svg && opts.mode !== 'outline') {
    d.innerHTML = svg;
    const el = d.firstElementChild;
    if (el && el.tagName.toLowerCase() === 'svg') {
      el.setAttribute('width', '100%');
      el.setAttribute('height', '100%');
    }
  } else if (b.text != null && b.font && opts.mode !== 'outline') {
    if (b.segments?.length) {
      for (const sg of b.segments) {
        const sp = document.createElement('span');
        sp.textContent = sg.text;
        const css = [];
        if (sg.fill) css.push(`color:${withAlpha(sg.fill, sg.fillOpacity)}`);
        if (sg.weight) css.push(`font-weight:${sg.weight}`);
        if (sg.size) css.push(`font-size:${sg.size}px`);
        if (sg.family) css.push(`font-family:'${sg.family}',sans-serif`);
        sp.style.cssText = css.join(';');
        d.appendChild(sp);
      }
    } else d.textContent = b.text;
  }
  const css = [`left:${left}px`, `top:${top}px`, `width:${b.w * scale}px`, `height:${b.h * scale}px`, ...boxStyle(b, opts)];
  if (scale !== 1) css.push(`transform:scale(${scale})`, 'transform-origin:0 0', `width:${b.w}px`, `height:${b.h}px`);
  d.style.cssText = css.join(';');
  d.title = `${b.name} · ${b.w}×${b.h}${b.fill ? ' · ' + b.fill : ''}`;
  d.dataset.pgid = b.id;
  return d;
}

const isFixed = (el) => {
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    const p = getComputedStyle(e).position;
    if (p === 'fixed' || p === 'sticky') return p;
  }
  return null;
};

/**
 * Per-block overlay. Every bound block is placed onto its own DOM element;
 * the scale is computed from the ACTUAL element width (the site container is
 * fluid, the design is fixed), fixed/sticky blocks are drawn in the same
 * coordinate layer.
 */
/** Places one design (the page or an extra: a tab, a modal) onto its bound
 *  elements. Boxes are appended to frag; fixed/sticky ones to fx.frag. */
function drawDesign(data, opts, off, frag, fx) {

  // one DOM element = one layer: if several keys point to it (the hero and
  // the whole product component both bound to section.pr-phero), keep the
  // block whose size is closest to the element — the larger one would drag
  // its whole subtree onto a section that only holds a part of it
  const bySel = new Map();
  const elSize = new Map();
  for (const b of data.boxes.filter((x) => x.anchor)) {
    if (!elSize.has(b.anchor)) {
      const el = document.querySelector(b.anchor);
      elSize.set(b.anchor, el ? el.getBoundingClientRect() : null);
    }
    const r = elSize.get(b.anchor);
    const dist = (x) => (r ? Math.abs(x.w - r.width) + Math.abs(x.h - r.height) : -(x.w * x.h));
    const prev = bySel.get(b.anchor);
    if (!prev || dist(b) < dist(prev)) bySel.set(b.anchor, b);
  }
  let anchored = [...bySel.values()];

  // An anchor is a container. A small text node must not be an anchor: if its
  // position on the page differs (a menu item was moved), its whole subtree
  // moves with it. Such nodes are drawn inside their parent.
  const CONTAINER_MIN = 200;
  anchored = anchored.filter((b) => !(b.w < CONTAINER_MIN && b.h < 40) && !(b.type === 'TEXT' && b.w < CONTAINER_MIN));
  const anchoredSet = new Set(anchored);
  for (const b of data.boxes) if (b.anchor && !anchoredSet.has(b)) b.anchor = null;

  // In PNG mode a block already contains all its content: if the parent is
  // drawn as an image, nested anchors add a second layer on top — this made
  // the header menu double.
  if (opts.mode === 'shots') {
    // Show ONLY blocks with a ready render. The other anchors are separate
    // labels and small nodes: without an image they are drawn as text over
    // the page and turn the overlay into a mess.
    anchored = anchored.filter((a) => a.shot);
    // and do not put a block on top of a block: skip nested ones
    anchored = anchored.filter((a) => !anchored.some((p) => p !== a && within(a, p) && p.w * p.h > a.w * a.h));
  }

  const used = [];
  let placed = 0, missing = 0, scaleSum = 0;

  const resolved = anchored.map((a) => ({ a, el: document.querySelector(a.anchor) }));
  const drawnSet = new Set(resolved.filter((x) => x.el).map((x) => x.a));
  // A child box is drawn once, by its nearest anchored ancestor in the design
  // tree — not by geometry: a row that hangs below its parent's bounds (the
  // phone row under the sticky calculator) still belongs to that parent.
  const byId = new Map(data.boxes.map((b) => [b.id, b]));
  const ownerOf = (b) => {
    for (let p = byId.get(b.parent); p; p = byId.get(p.parent)) if (drawnSet.has(p)) return p;
    return null;
  };
  const children = new Map();
  for (const b of data.boxes) {
    if (b.anchor && drawnSet.has(b)) continue;
    const o = ownerOf(b);
    if (!o) continue;
    if (!children.has(o)) children.set(o, []);
    children.get(o).push(b);
  }

  for (const { a, el } of resolved) {
    if (!el) { missing++; continue; }
    const r = el.getBoundingClientRect();
    const fixed = isFixed(el);

    // Scale ONLY a fluid container (up to 12% difference): a larger gap is a
    // structural difference between design and page — the block is full-width
    // in the design and container-bound on the page. It must not be squeezed:
    // the content would shift and colors/icons would stop matching.
    const rel = a.w > 0 ? Math.abs(r.width - a.w) / a.w : 1;
    const k = opts.autoScale === false || rel > 0.12 ? 1 : r.width / a.w;
    scaleSum += k;

    // fixed/sticky: viewport coordinates (the element is already shifted by
    // scroll), everything else — absolute document coordinates
    let baseL = r.left + (fixed ? 0 : scrollX) + off.x;
    let baseT = r.top + (fixed ? 0 : scrollY) + off.y;
    // A text node bound to a block with a taller line-height (h2 at 32px vs a
    // 22px design box): CSS centres the glyphs in the line, so centre the box too
    if (a.type === 'TEXT' && r.height > a.h * k && r.height < a.h * k * 2.2) baseT += (r.height - a.h * k) / 2;
    // A full-width design block bound to a centered container (the design's
    // 1920px strip vs the site's 1640px #avitoBlock): align their centers,
    // otherwise the block starts at the container edge and hangs off the right.
    if (Math.abs(a.w - data.w) < 2) baseL += (r.width - a.w * k) / 2;
    used.push({ x: a.x, y: a.y, w: a.w, h: a.h });
    placed++;

    let target = frag;
    if (fixed) {
      if (!fx.frag) fx.frag = document.createDocumentFragment();
      target = fx.frag;
    }
    target.appendChild(makeBox(a, opts, baseL, baseT, k, data.svgLib));
    if (opts.mode === 'shots' && a.shot) continue;
    for (const b of children.get(a) ?? []) {
      target.appendChild(makeBox(b, opts, baseL + (b.x - a.x) * k, baseT + (b.y - a.y) * k, k, data.svgLib));
    }
  }

  // Unanchored nodes are placed by design coordinates and on a long page
  // spill into other blocks (items from the middle of the design ended up in
  // the header). So they are not drawn by default — only via an explicit checkbox.
  if (opts.showUnanchored === true) {
    const bodyTop = document.body.getBoundingClientRect().top + scrollY;
    for (const b of data.boxes) {
      if (b.anchor || ownerOf(b)) continue;
      if (used.some((u) => within(b, u))) continue;
      const d = makeBox(b, opts, b.x + off.x, bodyTop + b.y + off.y, 1, data.svgLib);
      d.classList.add('pg-loose');
      frag.appendChild(d);
    }
  }

  return { anchored: anchored.length, placed, missing, scaleSum };
}

// an extra design is drawn only while its root element is actually on screen
const rootVisible = (sel) => {
  const el = sel ? document.querySelector(sel) : null;
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && r.width > 0 && r.height > 0 ? el : null;
};
const isModalLike = (el) => !!(el.closest('.modal, [role=dialog], dialog, .offcanvas, [class*=modal]') || isFixed(el));

function showOverlay(data, opts) {
  buildOverlay();
  lastOverlay = { data, opts };
  const off = { x: opts.offsetX ?? 0, y: opts.offsetY ?? 0 };
  const layerOpacity = opts.split != null ? 1 : (opts.opacity ?? 0.5);
  Object.assign(ov.style, {
    top: '0px', left: '0px', width: '100%', height: '0px',
    opacity: String(layerOpacity), display: 'block',
  });
  ov.classList.toggle('pg-diff', !!opts.diff);
  ov.classList.toggle('pg-outline', opts.mode === 'outline');

  // Curtain: show the design only to the left of the line — like a
  // "before/after" comparison widget. 100% = whole design, 0% = site only.
  const split = opts.split;
  ov.style.clipPath = split == null ? '' : `inset(0 ${100 - split}% 0 0)`;
  // the left side must show ONLY the design: dim the site under the curtain,
  // otherwise the layers blend and the curtain seems not to work
  document.documentElement.style.setProperty('--pg-split', `${split ?? 0}%`);
  document.documentElement.classList.toggle('pg-split-on', split != null);
  if (split == null) { splitDim?.remove(); splitDim = null; }
  else {
    if (!splitDim) {
      splitDim = document.createElement('div');
      splitDim.className = 'pg-split-dim';
      document.documentElement.appendChild(splitDim);
    }
  }
  applySplitLine(split, opts);

  ov.innerHTML = '';
  if (fixedLayer) { fixedLayer.remove(); fixedLayer = null; }

  // "design only": dim the page itself, otherwise its text reads mixed with
  // the design text and the header seems to contain foreign items
  document.documentElement.classList.toggle('pg-solo', !!opts.solo);

  if (data.png && opts.mode === 'image') {
    const anchor = document.querySelector(opts.anchor || 'body');
    const top = anchor ? anchor.getBoundingClientRect().top + scrollY : 0;
    const img = document.createElement('img');
    img.src = `http://localhost:8971${data.png}`;
    img.style.cssText = `position:absolute;left:${off.x}px;top:${top + off.y}px;width:${data.w}px;display:block`;
    ov.appendChild(img);
    return { boxes: 0, png: true, mode: 'image', anchored: 0, placed: 1, scale: 1 };
  }

  const frag = document.createDocumentFragment();
  const fx = { frag: null };

  // auto mode: extras (tabs, modals) whose root is visible right now; an open
  // modal covers the page, so the page's own blocks are not drawn under it
  const live = (data.extras ?? []).map((e) => ({ e, el: rootVisible(e.root) })).filter((x) => x.el);
  const modalOpen = live.some((x) => isModalLike(x.el));
  const stats = { anchored: 0, placed: 0, missing: 0, scaleSum: 0 };
  const add = (r) => { for (const k of Object.keys(stats)) stats[k] += r[k]; };
  if (!modalOpen) add(drawDesign(data, opts, off, frag, fx));
  for (const { e } of live) add(drawDesign(e, opts, off, frag, fx));
  const fixedFrag = fx.frag;
  const anchored = { length: stats.anchored };
  const placed = stats.placed, missing = stats.missing, scaleSum = stats.scaleSum;
  activeExtras = live.map((x) => x.e.title ?? x.e.page);

  ov.appendChild(frag);
  if (fixedFrag) {
    fixedLayer = document.createElement('div');
    fixedLayer.className = 'pg-overlay pg-fixed' + (opts.diff ? ' pg-diff' : '') + (opts.mode === 'outline' ? ' pg-outline' : '');
    fixedLayer.style.opacity = String(layerOpacity);
    fixedLayer.style.display = 'block';
    if (opts.split != null) fixedLayer.style.clipPath = `inset(0 ${100 - opts.split}% 0 0)`;
    fixedLayer.appendChild(fixedFrag);
    document.documentElement.appendChild(fixedLayer);
  }

  return {
    boxes: data.boxes.length, png: !!data.png, mode: opts.mode,
    anchored: anchored.length, placed, missing,
    scale: placed ? Math.round((scaleSum / placed) * 1000) / 1000 : 1,
    extras: activeExtras, modalOpen,
  };
}

let activeExtras = [];

/** Tabs open, modals appear, accordions expand — the overlay follows the DOM
 *  instead of waiting for a click in the panel. Our own layers live outside
 *  <body>, so observing body does not feed back. */
let domRedraw = null;
new MutationObserver(() => {
  if (!lastOverlay || !ov || ov.style.display === 'none') return;
  clearTimeout(domRedraw);
  domRedraw = setTimeout(() => showOverlay(lastOverlay.data, lastOverlay.opts), 250);
}).observe(document.body ?? document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open'] });

let splitLine = null;
let splitDim = null;

function applySplitLine(split, opts) {
  if (split == null) {
    if (splitLine) { splitLine.remove(); splitLine = null; }
    return;
  }
  if (!splitLine) {
    splitLine = document.createElement('div');
    splitLine.className = 'pg-split';
    splitLine.innerHTML = '<span class="pg-split-grip"></span>';
    document.documentElement.appendChild(splitLine);

    // the line can be dragged with the mouse right on the page
    let dragging = false;
    const move = (e) => {
      if (!dragging || !lastOverlay) return;
      const pct = Math.min(100, Math.max(0, (e.clientX / innerWidth) * 100));
      lastOverlay.opts.split = Math.round(pct);
      showOverlay(lastOverlay.data, lastOverlay.opts);
      chrome.runtime.sendMessage({ type: 'pg-split-moved', split: Math.round(pct) }).catch(() => {});
    };
    splitLine.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
    addEventListener('mousemove', move, true);
    addEventListener('mouseup', () => { dragging = false; });
  }
  splitLine.style.left = `${split}%`;
  splitLine.style.display = 'block';
}

function hideOverlay() {
  if (ov) ov.style.display = 'none';
  if (fixedLayer) { fixedLayer.remove(); fixedLayer = null; }
  if (splitLine) { splitLine.remove(); splitLine = null; }
  if (splitDim) { splitDim.remove(); splitDim = null; }
  document.documentElement.classList.remove('pg-solo', 'pg-split-on');
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'pg-overlay-show') { reply(showOverlay(msg.data, msg.opts ?? {})); return true; }
  if (msg.type === 'pg-overlay-hide') { hideOverlay(); reply({ ok: true }); return true; }
});

let pick = null;

function uniqueSelector(el) {
  const nice = (e) => {
    // React / CSS-modules / styled-components produce hashed classes that change
    // on every build — prefer stable hooks and drop the generated ones
    const hashed = (c) => /^(sc-|css-|jsx-|emotion-|chakra-|Mui[A-Z]\w*-root-\d|_[a-z0-9]{5,}$)/.test(c) || /__[A-Za-z0-9_-]{5,}$/.test(c) || /[a-z]-[a-z0-9]{6,}$/i.test(c) && /\d/.test(c) && /[a-z]/.test(c) && c.length > 12;
    const cls = [...e.classList].filter((c) => !/^(is-|js-|swiper-|wp-|has-|active|current)/.test(c) && !hashed(c));
    for (const a of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
      const v = e.getAttribute(a);
      if (v) return `${e.tagName.toLowerCase()}[${a}="${CSS.escape(v)}"]`;
    }
    const idOk = e.id && !/\d{3,}|^[a-z]+-[a-z0-9]{6,}$|^:r/.test(e.id);
    return e.tagName.toLowerCase() + (idOk ? '#' + CSS.escape(e.id) : '') + cls.slice(0, 3).map((c) => '.' + CSS.escape(c)).join('');
  };
  let sel = nice(el);
  if (document.querySelectorAll(sel).length === 1) return sel;
  for (let p = el.parentElement, hops = 0; p && p !== document.body && hops < 4; p = p.parentElement, hops++) {
    sel = nice(p) + ' ' + sel;
    if (document.querySelectorAll(sel).length === 1) return sel;
  }
  const sibs = [...(el.parentElement?.children ?? [])].filter((s) => s.tagName === el.tagName);
  if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(el) + 1})`;
  return sel;
}

function startPick(node) {
  stopPick();
  const hi = document.createElement('div');
  hi.className = 'pg-pick';
  document.documentElement.appendChild(hi);

  const tip = document.createElement('div');
  tip.className = 'pg-pick-tip';
  tip.textContent = `Pick an element for "${node.name || node.figmaId}" · Esc to cancel`;
  document.documentElement.appendChild(tip);

  const onMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === hi || el === tip) return;
    pick.el = el;
    const r = el.getBoundingClientRect();
    Object.assign(hi.style, {
      top: `${r.top + scrollY}px`, left: `${r.left + scrollX}px`,
      width: `${r.width}px`, height: `${r.height}px`, display: 'block',
    });
  };
  const onClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = pick?.el;
    if (!el) return;
    const selector = uniqueSelector(el);
    const r = el.getBoundingClientRect();
    chrome.runtime.sendMessage({
      type: 'pg-pick-done',
      node,
      selector,
      domSize: `${Math.round(r.width)}x${Math.round(r.height)}`,
      rows: diff(node, el),
    });
    stopPick();
  };
  const onKey = (e) => { if (e.key === 'Escape') { chrome.runtime.sendMessage({ type: 'pg-pick-cancel' }); stopPick(); } };

  pick = { hi, tip, onMove, onClick, onKey, el: null };
  addEventListener('mousemove', onMove, true);
  addEventListener('click', onClick, true);
  addEventListener('keydown', onKey, true);
}

/** Inspect mode: hover highlights, click reports the element — its selector,
 *  the map keys bound to it (or an ancestor) and the design box under the
 *  cursor — so a mismatch can be quoted as "1173:20486 ↔ aside.pr-phero__picker". */
let inspect = null;

function startInspect() {
  stopInspect(); stopPick();
  const hi = document.createElement('div');
  hi.className = 'pg-pick pg-inspect';
  document.documentElement.appendChild(hi);
  const tip = document.createElement('div');
  tip.className = 'pg-pick-tip';
  tip.textContent = 'Inspect: click an element · Esc to exit';
  document.documentElement.appendChild(tip);

  const onMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === hi || el === tip) return;
    inspect.el = el;
    const r = el.getBoundingClientRect();
    Object.assign(hi.style, { top: `${r.top + scrollY}px`, left: `${r.left + scrollX}px`, width: `${r.width}px`, height: `${r.height}px`, display: 'block' });
  };
  const onClick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = inspect?.el; if (!el) return;
    const r = el.getBoundingClientRect();
    // map entries whose selector matches the element itself, else the nearest ancestor
    const hits = [];
    for (let node = el, hops = 0; node && node !== document.body && hops < 5 && !hits.length; node = node.parentElement, hops++) {
      for (const [key, entry] of Object.entries(map)) {
        if (key.startsWith('_') || !entry?.selector) continue;
        try { if (node.matches(entry.selector)) hits.push({ key, selector: entry.selector, name: entry.name ?? null, exact: node === el }); } catch {}
      }
    }
    // smallest drawn design box under the cursor
    let box = null;
    for (const d of document.querySelectorAll('.pg-obox[data-pgid]')) {
      const b = d.getBoundingClientRect();
      if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) continue;
      if (!box || b.width * b.height < box.area) box = { id: d.dataset.pgid, title: d.title, area: b.width * b.height };
    }
    chrome.runtime.sendMessage({
      type: 'pg-inspect-done',
      selector: uniqueSelector(el),
      tag: el.tagName.toLowerCase(),
      size: `${Math.round(r.width)}×${Math.round(r.height)}`,
      text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60),
      hits, box: box ? { id: box.id, title: box.title } : null,
    });
    lastEl = el; place(el);
  };
  const onKey = (e) => { if (e.key === 'Escape') { chrome.runtime.sendMessage({ type: 'pg-inspect-stopped' }); stopInspect(); } };
  inspect = { hi, tip, onMove, onClick, onKey, el: null };
  addEventListener('mousemove', onMove, true);
  addEventListener('click', onClick, true);
  addEventListener('keydown', onKey, true);
}

function stopInspect() {
  if (!inspect) return;
  removeEventListener('mousemove', inspect.onMove, true);
  removeEventListener('click', inspect.onClick, true);
  removeEventListener('keydown', inspect.onKey, true);
  inspect.hi.remove(); inspect.tip.remove();
  inspect = null;
}

/** prepare[] steps from config/pages.json executed in the live tab: opens a
 *  modal or a tab so its design can be overlaid. Playwright's :has-text("…")
 *  is honoured by filtering on textContent. */
function findForStep(sel) {
  const m = sel.match(/^(.*?):has-text\("(.+?)"\)(.*)$/);
  if (!m) return document.querySelector(sel);
  const [, before, txt, after] = m;
  return [...document.querySelectorAll((before || '*') + (after || ''))].find((e) => (e.textContent ?? '').includes(txt)) ?? null;
}
async function runSteps(steps) {
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
  for (const s of steps) {
    const t = s.timeout ?? 8000;
    if (s.click) { const el = await until(() => findForStep(s.click), t); if (!el) { if (s.optional) continue; throw new Error(`click: ${s.click} not found`); } el.click(); }
    else if (s.hover) { const el = findForStep(s.hover); if (el) el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); }
    else if (s.waitFor) { const el = await until(() => { const e = findForStep(s.waitFor); return e && e.getBoundingClientRect().width > 0 ? e : null; }, t); if (!el && !s.optional) throw new Error(`waitFor: ${s.waitFor} did not appear`); }
    else if (s.scrollTo) { findForStep(s.scrollTo)?.scrollIntoView({ block: 'center' }); }
    else if (s.fill) { const el = findForStep(s.fill); if (el) { el.value = String(s.value ?? ''); el.dispatchEvent(new Event('input', { bubbles: true })); } }
    else if (s.wait) await new Promise((r) => setTimeout(r, Number(s.wait)));
  }
  await new Promise((r) => setTimeout(r, 400));
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'pg-prepare') {
    runSteps(msg.steps ?? []).then(() => reply({ ok: true })).catch((e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'pg-inspect-start') { startInspect(); reply({ ok: true }); return true; }
  if (msg.type === 'pg-inspect-stop') { stopInspect(); reply({ ok: true }); return true; }
  if (msg.type === 'pg-diff') {
    const el = document.querySelector(msg.selector);
    reply(el ? { rows: diff(msg.node, el) } : null);
    return true;
  }
});

function stopPick() {
  if (!pick) return;
  removeEventListener('mousemove', pick.onMove, true);
  removeEventListener('click', pick.onClick, true);
  removeEventListener('keydown', pick.onKey, true);
  pick.hi.remove();
  pick.tip.remove();
  pick = null;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'pg-pick-start') { startPick(msg.node); reply({ ok: true }); return true; }
  if (msg.type === 'pg-remap') { loadMap().then(() => reply({ ok: true })); return true; }
  if (msg.type === 'pg-pick-stop') { stopPick(); reply({ ok: true }); return true; }
});

/** Compares the whole page against the map without Figma: for every binding
 *  take the node from the snapshot (already on disk) and compare it with the DOM. */
function auditPage(nodesById) {
  const rows = [];
  for (const [key, entry] of Object.entries(map)) {
    if (key.startsWith('_')) continue;
    if (entry.skip) { rows.push({ key, status: 'skip', reason: entry.skip }); continue; }
    if (!entry.selector) continue;

    const fig = nodesById[key] ?? nodesById[entry.figmaId];
    const el = document.querySelector(entry.selector);
    if (!el) { rows.push({ key, selector: entry.selector, status: 'missing', name: entry.name }); continue; }
    if (!fig) { rows.push({ key, selector: entry.selector, status: 'nofig', name: entry.name }); continue; }

    const d = diff(fig, el).filter((x) => !(entry.ignore ?? []).includes(x.prop));
    const bad = d.filter((x) => !x.pass);
    rows.push({
      key, selector: entry.selector, name: entry.name ?? fig.name,
      status: bad.length ? 'failed' : 'pass', rows: d, bad: bad.length, checked: d.length,
    });
  }
  return rows;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'pg-audit') {
    if (msg.frameW) window.__pgFrameW = msg.frameW;
    const run = () => reply(auditPage(msg.nodes ?? {}));
    if (Object.keys(map).length) run();
    else loadMap(msg.page).then(run);
    return true;
  }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'pg-unhighlight') { if (box) box.classList.remove('pg-on'); lastEl = null; reply({ ok: true }); return true; }
  if (msg.type === 'pg-highlight') {
    const el = document.querySelector(msg.selector);
    if (el) { lastEl = el; place(el); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    reply({ ok: !!el });
    return true;
  }
});


/** A fixed/sticky header changes height and position on scroll (the top bar
 *  slides away), so its layer is recomputed instead of drawn once. */
addEventListener('scroll', () => {
  if (!lastOverlay || !fixedLayer || reflowPending) return;
  reflowPending = true;
  requestAnimationFrame(() => {
    reflowPending = false;
    if (!lastOverlay || !ov || ov.style.display === 'none') return;
    showOverlay(lastOverlay.data, lastOverlay.opts);
  });
}, { passive: true });

/** The extension was reloaded: this script is orphaned — no messages reach it,
 *  but its overlay would stay on the page forever. Watch the port to the
 *  background; when the context is gone, take everything down. */
const PG_DOM = '.pg-overlay, .pg-box, .pg-pick, .pg-pick-tip, .pg-split, .pg-split-dim';

function teardown() {
  try { hideOverlay(); } catch {}
  try { stopPick(); stopInspect(); } catch {}
  for (const el of document.querySelectorAll(PG_DOM)) el.remove();
  document.documentElement.classList.remove('pg-solo', 'pg-split-on');
  ov = null; box = null; lastEl = null; lastOverlay = null;
}

// leftovers of a previous, already dead instance
for (const el of document.querySelectorAll(PG_DOM)) el.remove();
document.documentElement.classList.remove('pg-solo', 'pg-split-on');

function watchContext() {
  let port;
  try { port = chrome.runtime.connect({ name: 'pg-content' }); } catch { teardown(); return; }
  port.onDisconnect.addListener(() => {
    // the service worker merely went idle — reconnect; the extension is gone — clean up
    if (chrome.runtime?.id) setTimeout(watchContext, 500);
    else teardown();
  });
}
watchContext();
