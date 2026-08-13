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

  // масштаб 1:1 — макет снят под конкретный брейкпоинт, растягивать нельзя.
  // при align=center центрируем, иначе прижимаем влево к контенту страницы.
  const scale = opts.scale ?? 1;
  const left = opts.align === 'center' ? Math.max(0, (innerWidth - data.w * scale) / 2) : 0;

  Object.assign(ov.style, {
    top: `${top + (opts.offsetY ?? 0)}px`,
    left: `${left + (opts.offsetX ?? 0)}px`,
    width: `${data.w * scale}px`,
    height: `${data.h * scale}px`,
    opacity: String(opts.opacity ?? 0.5),
    display: 'block',
    transform: scale === 1 ? '' : `scale(${scale})`,
    transformOrigin: '0 0',
  });
  ov.classList.toggle('pg-diff', !!opts.diff);
  ov.classList.toggle('pg-outline', opts.mode === 'outline');

  ov.innerHTML = '';
  if (data.png && opts.mode === 'image') {
    const img = document.createElement('img');
    img.src = `http://localhost:8971${data.png}`;
    img.style.cssText = `width:${data.w}px;height:${data.h}px;display:block`;
    ov.appendChild(img);
    return { boxes: 0, png: true, mode: 'image', scale };
  }

  const frag = document.createFragment ? document.createFragment() : document.createDocumentFragment();
  for (const b of data.boxes) {
    const d = document.createElement('div');
    d.className = 'pg-obox';
    const css = [
      `left:${b.x}px`, `top:${b.y}px`, `width:${b.w}px`, `height:${b.h}px`,
    ];
    if (b.opacity != null && b.opacity !== 1) css.push(`opacity:${b.opacity}`);
    if (opts.mode !== 'outline') {
      if (b.fill) css.push(`background:${b.fill}${b.fillOpacity != null && b.fillOpacity < 1 ? Math.round(b.fillOpacity * 255).toString(16).padStart(2, '0') : ''}`);
      if (b.radius != null) {
        css.push(`border-radius:${Array.isArray(b.radius) ? b.radius.map((r) => r + 'px').join(' ') : b.radius + 'px'}`);
      }
      if (b.stroke) css.push(`box-shadow:inset 0 0 0 ${b.strokeWeight || 1}px ${b.stroke}`);
    }
    if (b.text != null && b.font && opts.mode !== 'outline') {
      d.textContent = b.text;
      const f = b.font;
      css.push(
        `color:${b.fill || '#000'}`,
        `font-family:'${f.family}',sans-serif`,
        `font-size:${f.size}px`,
        `font-weight:${f.weight}`,
        `line-height:${f.lineHeight ? f.lineHeight + 'px' : 'normal'}`,
        `text-align:${({ LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }[f.align] || 'left')}`,
        'background:none', 'white-space:pre-wrap', 'overflow:hidden',
      );
      if (f.letterSpacing) css.push(`letter-spacing:${f.letterSpacing}px`);
      if (f.case === 'UPPER') css.push('text-transform:uppercase');
    }
    d.style.cssText = css.join(';');
    d.title = `${b.name} · ${b.w}×${b.h}${b.fill ? ' · ' + b.fill : ''}`;
    frag.appendChild(d);
  }
  ov.appendChild(frag);
  return { boxes: data.boxes.length, png: !!data.png, mode: opts.mode, scale };
}

function hideOverlay() {
  if (ov) ov.style.display = 'none';
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'pg-overlay-show') { reply(showOverlay(msg.data, msg.opts ?? {})); return true; }
  if (msg.type === 'pg-overlay-hide') { hideOverlay(); reply({ ok: true }); return true; }
});

let pick = null;

function uniqueSelector(el) {
  const nice = (e) => {
    const cls = [...e.classList].filter((c) => !/^(is-|js-|swiper-|wp-|has-|active|current)/.test(c));
    return e.tagName.toLowerCase() + (e.id ? '#' + CSS.escape(e.id) : '') + cls.slice(0, 3).map((c) => '.' + CSS.escape(c)).join('');
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
  tip.textContent = `Выбери элемент для «${node.name || node.figmaId}» · Esc — отмена`;
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
