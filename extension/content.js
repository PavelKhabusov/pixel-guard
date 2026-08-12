let map = {};
let box = null;
let bar = null;
let tab = null;
let lastNode = null;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

function toggle(on) {
  buildUi();
  const next = on ?? !bar.classList.contains('pg-open');
  bar.classList.toggle('pg-open', next);
  if (!next) box.classList.remove('pg-on');
  if (next) poll();
}

function buildUi() {
  if (bar) return;
  box = document.createElement('div');
  box.className = 'pg-box';

  bar = document.createElement('aside');
  bar.className = 'pg-sidebar';
  bar.innerHTML = `
    <div class="pg-head">
      <h4>pixel-guard</h4>
      <div class="pg-stat"><span><span class="pg-dot off" id="pg-dot"></span><span id="pg-state">сервер недоступен</span></span></div>
      <div class="pg-stat"><span>плагин Figma</span><code id="pg-figma">—</code></div>
      <div class="pg-stat"><span>нод в карте</span><code id="pg-mapn">0</code></div>
      <div class="pg-hint" id="pg-hint"></div>
    </div>
    <div class="pg-body" id="pg-body"><div class="pg-empty">Кликни ноду в Figma — здесь появится сверка.</div></div>
    <div class="pg-log" id="pg-log"></div>`;

  const close = document.createElement('button');
  close.className = 'pg-close';
  close.textContent = '×';
  close.title = 'Закрыть (значок расширения — открыть снова)';
  close.onclick = () => toggle(false);
  bar.querySelector('.pg-head').appendChild(close);

  document.documentElement.append(box, bar);
  addEventListener('scroll', () => { if (lastNode) place(lastNode.el); }, { passive: true });
}

const logLine = (t) => {
  const l = document.getElementById('pg-log');
  if (!l) return;
  const d = document.createElement('div');
  d.textContent = t;
  l.prepend(d);
  while (l.children.length > 20) l.lastChild.remove();
};

function setStatus(s) {
  buildUi();
  const figma = s.peers?.figma ?? 0;
  document.getElementById('pg-dot').className = `pg-dot ${s.connected ? 'on' : 'off'}`;
  document.getElementById('pg-state').textContent = s.connected ? 'подключён к серверу' : 'сервер недоступен';
  document.getElementById('pg-figma').textContent = figma ? `${figma} ✓` : 'нет';
  document.getElementById('pg-mapn').textContent = Object.keys(map).filter((k) => !k.startsWith('_')).length;
  const hint = document.getElementById('pg-hint');
  if (!s.connected) hint.innerHTML = 'Сервер не отвечает — запусти <b>npm run server</b>.';
  else if (!figma) hint.innerHTML = 'Открой плагин <b>pixel-guard</b> в Figma и включи <b>живой режим</b>.';
  else hint.innerHTML = 'Готово: кликай ноду в Figma.';
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
  if (node.type === 'TEXT') { if (node.renderH != null) cmp('height', node.renderH, px(r.height), 4); }
  else cmp('height', node.h, px(r.height), 2);

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

function place(el) {
  const r = el.getBoundingClientRect();
  Object.assign(box.style, {
    top: `${r.top + scrollY}px`, left: `${r.left + scrollX}px`,
    width: `${r.width}px`, height: `${r.height}px`,
  });
  box.classList.add('pg-on');
}

function show(node) {
  toggle(true);
  const body = document.getElementById('pg-body');
  const sel = map[node.figmaId]?.selector || map[node.path]?.selector;
  const entry = map[node.figmaId] || map[node.path];
  const el = sel ? document.querySelector(sel) : null;
  logLine(`← ${node.name || node.figmaId}`);

  if (entry?.skip) {
    box.classList.remove('pg-on');
    body.innerHTML = `<div class="pg-node">${esc(node.name || node.figmaId)}</div>
      <div class="pg-note">skip: ${esc(entry.skip)}</div>`;
    return;
  }
  if (!el) {
    box.classList.remove('pg-on');
    lastNode = null;
    body.innerHTML = `<div class="pg-node">${esc(node.name || node.figmaId)}</div>
      <div class="pg-note">${sel ? `не найден в DOM:<br><code>${esc(sel)}</code>` : 'нет привязки в карте'}</div>
      <div class="pg-empty">Добавь в maps/&lt;page&gt;.map.json:<br><code>"${esc(node.figmaId)}": { "selector": "…" }</code></div>`;
    return;
  }

  lastNode = { el };
  place(el);
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });

  const rows = diff(node, el);
  const bad = rows.filter((x) => !x.pass);
  body.innerHTML = `<div class="pg-node">${esc(node.name || node.figmaId)}</div>
    <div class="pg-sel"><code>${esc(sel)}</code></div>
    <div class="pg-score">${rows.length - bad.length} ✓ · ${bad.length} ✗</div>
    <table>${rows.map((x) => `<tr class="${x.pass ? 'ok' : 'no'}">
      <td>${esc(x.prop)}</td><td>${esc(x.fig)}</td><td>→</td><td>${esc(x.act)}</td>
      <td>${x.delta && !x.pass ? esc(x.delta) : ''}</td></tr>`).join('')}</table>`;
}

const loadMap = () =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'pg-fetch', path: '/map?page=home' }, (m) => {
      if (m && !m.error) map = m;
      resolve(map);
    });
  });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'pg-map') { map = msg.map || {}; return; }
  if (msg.type === 'pg-status') { setStatus(msg.status); return; }
  if (msg.type === 'pg-toggle') { toggle(); return; }
  if (msg.type === 'pg-select') {
    if (Object.keys(map).length) show(msg.node);
    else loadMap().then(() => show(msg.node));
  }
});

const poll = () => {
  if (!bar?.classList.contains('pg-open') || document.hidden) return;
  chrome.runtime.sendMessage({ type: 'pg-status' }, (s) => s && setStatus(s));
};

setInterval(poll, 5000);
