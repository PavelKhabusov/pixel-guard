let map = {};
let box = null;
let panel = null;

const ensureUi = () => {
  if (!box) {
    box = document.createElement('div');
    box.className = 'pg-box';
    document.documentElement.appendChild(box);
  }
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'pg-panel';
    panel.addEventListener('click', (e) => {
      if (e.target.classList.contains('pg-close')) panel.classList.remove('pg-on');
    });
    document.documentElement.appendChild(panel);
  }
};

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
  if (node.type === 'TEXT' && node.renderH != null) cmp('height', node.renderH, px(r.height), 4);
  else if (node.type !== 'TEXT') cmp('height', node.h, px(r.height), 2);

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

function show(node) {
  ensureUi();
  const sel = map[node.figmaId]?.selector || map[node.path]?.selector;
  const el = sel ? document.querySelector(sel) : null;

  if (!el) {
    box.classList.remove('pg-on');
    panel.className = 'pg-panel pg-on pg-miss';
    panel.innerHTML = `<button class="pg-close">×</button>
      <b>${esc(node.name || node.figmaId)}</b>
      <div class="pg-note">${sel ? `не найден в DOM:<br><code>${esc(sel)}</code>` : 'нет привязки в maps/home.map.json'}</div>`;
    return;
  }

  const r = el.getBoundingClientRect();
  Object.assign(box.style, {
    top: `${r.top + scrollY}px`, left: `${r.left + scrollX}px`,
    width: `${r.width}px`, height: `${r.height}px`,
  });
  box.classList.add('pg-on');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });

  const rows = diff(node, el);
  const bad = rows.filter((x) => !x.pass);
  panel.className = `pg-panel pg-on ${bad.length ? 'pg-bad' : 'pg-good'}`;
  panel.innerHTML = `<button class="pg-close">×</button>
    <b>${esc(node.name || node.figmaId)}</b>
    <div class="pg-sel"><code>${esc(sel)}</code></div>
    <div class="pg-score">${rows.length - bad.length} ✓ · ${bad.length} ✗</div>
    <table>${rows.map((x) => `<tr class="${x.pass ? 'ok' : 'no'}">
      <td>${esc(x.prop)}</td><td>${esc(x.fig)}</td><td>→</td><td>${esc(x.act)}</td>
      <td>${x.delta && !x.pass ? esc(x.delta) : ''}</td></tr>`).join('')}</table>`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'pg-select') show(msg.node);
  if (msg.type === 'pg-map') map = msg.map || {};
});

chrome.runtime.sendMessage({ type: 'pg-fetch', path: '/map?page=home' }, (m) => {
  if (m && !m.error) map = m;
});
