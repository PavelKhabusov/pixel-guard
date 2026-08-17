const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const logLine = (t) => {
  const d = document.createElement('div');
  d.textContent = t;
  $('log').prepend(d);
  while ($('log').children.length > 25) $('log').lastChild.remove();
};

function setStatus(s) {
  const figma = s.peers?.figma ?? 0;
  $('dot').className = `dot ${s.connected ? 'on' : 'off'}`;
  $('state').textContent = s.connected ? 'подключён к серверу' : 'сервер недоступен';
  $('figma').textContent = figma ? `${figma} ✓` : 'нет';
  $('mapn').textContent = s.mapSize ?? 0;
  if (!s.connected) $('hint').innerHTML = 'Сервер не отвечает — запусти <b>npm run server</b>.';
  else if (!figma) $('hint').innerHTML = 'Открой плагин <b>pixel-guard</b> в Figma и включи <b>живой режим</b>.';
  else $('hint').innerHTML = 'Готово: кликай ноду в Figma.';
}

function render(r) {
  const body = $('body');
  logLine(`← ${r.name}`);
  if (r.figmaId) showBind(r.node ? { ...r.node, figmaId: r.figmaId, name: r.name } : { figmaId: r.figmaId, name: r.name }, r.found || !!r.skip);
  if (r.skip) {
    body.innerHTML = `<div class="node">${esc(r.name)}</div><div class="note">skip: ${esc(r.skip)}</div>`;
    return;
  }
  if (!r.found) {
    body.innerHTML = `<div class="node">${esc(r.name)}</div>
      <div class="note">${r.selector ? `не найден в DOM:<br><code>${esc(r.selector)}</code>` : 'нет привязки в карте'}</div>
      <div class="empty">Добавь в maps/&lt;page&gt;.map.json:<br><code>"${esc(r.figmaId)}": { "selector": "…" }</code></div>`;
    return;
  }
  const bad = r.rows.filter((x) => !x.pass).length;
  body.innerHTML = `<div class="node">${esc(r.name)}</div>
    <div class="sel"><code>${esc(r.selector)}</code></div>
    <div class="score">${r.rows.length - bad} ✓ · ${bad} ✗</div>
    <table>${r.rows.map((x) => `<tr class="${x.pass ? 'ok' : 'no'}">
      <td>${esc(x.prop)}</td><td>${esc(x.fig)}</td><td>→</td><td>${esc(x.act)}</td>
      <td>${x.delta && !x.pass ? esc(x.delta) : ''}</td></tr>`).join('')}</table>`;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'pg-panel-result') render(msg.result);
  if (msg.type === 'pg-panel-status') setStatus(msg.status);
});

const poll = () => chrome.runtime.sendMessage({ type: 'pg-status' }, (s) => s && setStatus(s));
poll();
setInterval(poll, 3000);

const ovState = { on: false, opacity: 0.5, mode: 'render', diff: false, data: null, offsetX: 0, offsetY: 0, loose: false, autoScale: true, solo: false, split: null };

const toActiveTab = (msg) =>
  new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([t]) => {
      if (!t) return resolve(null);
      chrome.tabs.sendMessage(t.id, msg).then(resolve).catch(() => resolve(null));
    });
  });

async function applyOverlay() {
  const note = $('ov-note');
  if (!ovState.on) { await toActiveTab({ type: 'pg-overlay-hide' }); note.textContent = ''; return; }
  if (!ovState.data) {
    const tab = await activeTab();
    const vp = viewportFor(tab?.width);
    const path = `/overlay?url=${encodeURIComponent(tab?.url ?? '')}&viewport=${vp}`;
    const d = await new Promise((res) => chrome.runtime.sendMessage({ type: 'pg-fetch', path }, res));
    if (!d || d.ok === false || d.error) { note.textContent = d?.error ?? 'снапшот не найден'; return; }
    ovState.data = d;
  }
  const r = await toActiveTab({
    type: 'pg-overlay-show',
    data: ovState.data,
    opts: {
      opacity: ovState.opacity, mode: ovState.mode, diff: ovState.diff,
      offsetX: ovState.offsetX, offsetY: ovState.offsetY,
      showUnanchored: ovState.loose, autoScale: ovState.autoScale !== false,
      solo: ovState.solo, split: ovState.split,
    },
  });
  if (!r) { note.textContent = 'вкладка не отвечает'; return; }
  const d = ovState.data;
  const tab = await activeTab();
  const fit = Math.abs((tab?.width ?? d.w) - d.w) <= 40 ? '' : ` ⚠ окно ${tab?.width}px`;
  const sc = r.scale && r.scale !== 1 ? ` · масштаб ${Math.round(r.scale * 100)}%` : '';
  const anch = r.mode === 'image' ? '' : ` · ${r.placed}/${r.anchored} блоков${r.missing ? `, ${r.missing} нет` : ''}${sc}`;
  note.textContent = `${d.page ? d.page + ' · ' : ''}${d.frame} · ${d.w}px${fit}${anch}`;
  if (!r.anchored && r.mode !== 'image') note.textContent += ' — нет привязок, макет лёг по координатам';
  if (ovState.mode === 'image' && !d.png) {
    note.textContent += ' — PNG нет, переэкспортируй с чекбоксом PNG';
  }
  if (ovState.mode === 'shots' && !d.hasShots) {
    note.textContent += ' — рендеров нет, запусти npm run shots';
  }
}

$('ov-on').onchange = (e) => { ovState.on = e.target.checked; ovState.data = null; applyOverlay(); };
chrome.tabs.onActivated.addListener(() => { ovState.data = null; if (ovState.on) applyOverlay(); });
chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'complete') { ovState.data = null; if (ovState.on) applyOverlay(); } });
$('ov-op').oninput = (e) => {
  ovState.opacity = e.target.value / 100;
  $('ov-val').textContent = `${e.target.value}%`;
  if (ovState.on) applyOverlay();
};
$('ov-mode').onchange = (e) => { ovState.mode = e.target.value; if (ovState.on) applyOverlay(); };
$('ov-x').oninput = (e) => { ovState.offsetX = +e.target.value || 0; if (ovState.on) applyOverlay(); };
$('ov-y').oninput = (e) => { ovState.offsetY = +e.target.value || 0; if (ovState.on) applyOverlay(); };
$('ov-loose').onchange = (e) => { ovState.loose = e.target.checked; if (ovState.on) applyOverlay(); };
$('ov-scale').onchange = (e) => { ovState.autoScale = e.target.checked; if (ovState.on) applyOverlay(); };
$('ov-solo').onchange = (e) => { ovState.solo = e.target.checked; if (ovState.on) applyOverlay(); };
$('ov-split-on').onchange = (e) => {
  ovState.split = e.target.checked ? Number($('ov-split').value) : null;
  $('ov-split').disabled = !e.target.checked;
  if (ovState.on) applyOverlay();
};
$('ov-split').oninput = (e) => {
  ovState.split = Number(e.target.value);
  $('ov-split-val').textContent = `${e.target.value}%`;
  if (ovState.on) applyOverlay();
};

// линию можно тащить прямо на странице — держим ползунок в курсе
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'pg-split-moved') return;
  ovState.split = msg.split;
  $('ov-split').value = String(msg.split);
  $('ov-split-val').textContent = `${msg.split}%`;
});

const activeTab = () => new Promise((res) => {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([t]) => res(t));
});

let vpChoice = 'auto';
const VP_W = { desktop: 1920, tablet: 912, mobile: 357 };

const autoViewport = (w) => (!w ? 'desktop' : w <= 600 ? 'mobile' : w <= 1100 ? 'tablet' : 'desktop');
const viewportFor = (w) => (vpChoice === 'auto' ? autoViewport(w) : vpChoice);

async function showVpNote() {
  const tab = await activeTab();
  const vp = viewportFor(tab?.width);
  const ref = VP_W[vp];
  const diff = tab?.width && ref ? Math.abs(tab.width - ref) : 0;
  $('vp-note').textContent = `${vp} · макет ${ref}px · окно ${tab?.width ?? '?'}px`
    + (diff > 80 ? ' — ширина сильно расходится, блоки масштабируются' : '');
}

// Переключатель меняет и ОКНО браузера: сравнивать desktop-вёрстку
// с мобильным макетом бессмысленно — сайт должен перестроиться сам.
async function resizeWindowTo(vp) {
  const ref = VP_W[vp];
  if (!ref) return;
  const tab = await activeTab();
  if (!tab?.windowId) return;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (!win) return;
  // ширина окна = ширина вьюпорта + хром браузера и боковая панель
  const chromeW = (win.width ?? 0) - (tab.width ?? 0);
  await chrome.windows.update(tab.windowId, { width: ref + Math.max(0, chromeW), state: 'normal' })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
}

document.querySelectorAll('.vp-btn').forEach((b) => {
  b.onclick = async () => {
    document.querySelectorAll('.vp-btn').forEach((x) => x.classList.toggle('on', x === b));
    vpChoice = b.dataset.vp;
    ovState.data = null;
    if (vpChoice !== 'auto' && $('vp-resize').checked) await resizeWindowTo(vpChoice);
    showVpNote();
    if (ovState.on) applyOverlay();
  };
});
$('ov-diff').onchange = (e) => { ovState.diff = e.target.checked; if (ovState.on) applyOverlay(); };

let curNode = null;
let curPages = [];

const post = (path, body) =>
  new Promise((res) => chrome.runtime.sendMessage({ type: 'pg-post', path, body }, res));

function guessPage(url) {
  const hit = curPages.find((p) => p.url && url && new URL(p.url).pathname === new URL(url).pathname);
  return hit?.key;
}

async function fillPages() {
  const list = await new Promise((res) => chrome.runtime.sendMessage({ type: 'pg-fetch', path: '/pages' }, res));
  if (!Array.isArray(list)) return;
  curPages = list;
  const sel = $('bind-page');
  sel.innerHTML = list.map((p) => `<option value="${p.key}">${p.key}</option>`).join('');
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([t]) => {
    const g = t && guessPage(t.url);
    if (g) sel.value = g;
  });
}

function showBind(node, found) {
  curNode = node;
  $('bind').hidden = !node || found;
  $('bind-note').textContent = '';
}

async function saveBinding(entry) {
  const key = curNode?.figmaId;
  if (!key) return;
  const r = await post('/map', { page: $('bind-page').value, key, entry });
  $('bind-note').textContent = r?.ok ? `записано в ${r.file} (${r.size} ключей)` : `ошибка: ${r?.error ?? '—'}`;
  if (r?.ok) {
    await toActiveTab({ type: 'pg-remap' });
    $('bind').hidden = true;
  }
}

$('bind-go').onclick = async () => {
  if (!curNode) return;
  $('bind-note').textContent = 'кликни элемент на странице (Esc — отмена)';
  await toActiveTab({ type: 'pg-pick-start', node: curNode });
};

$('bind-skip').onclick = () => saveBinding({ skip: 'помечено вручную из панели' });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'pg-pick-result') {
    $('bind-note').textContent = `${msg.selector} · ${msg.domSize}`;
    saveBinding({ selector: msg.selector, source: 'manual', name: curNode?.name });
    render({ name: curNode?.name ?? '', figmaId: curNode?.figmaId, selector: msg.selector, found: true, rows: msg.rows });
  }
  if (msg.type === 'pg-pick-cancelled') $('bind-note').textContent = 'отменено';
});

fillPages();
setTimeout(showVpNote, 300);


async function runAudit() {
  const note = $('audit-note');
  note.textContent = 'читаю макет…';
  const tab = await activeTab();
  const vp = viewportFor(tab?.width);
  const path = `/nodes?url=${encodeURIComponent(tab?.url ?? '')}&viewport=${vp}`;
  const data = await new Promise((res) => chrome.runtime.sendMessage({ type: 'pg-fetch', path }, res));
  if (!data || data.ok === false) { note.textContent = data?.error ?? 'нет данных'; return; }

  const rows = await toActiveTab({ type: 'pg-audit', nodes: data.nodes, page: data.page });
  if (!rows) { note.textContent = 'вкладка не отвечает — обнови страницу'; return; }

  const n = (s) => rows.filter((r) => r.status === s).length;
  note.textContent = `${data.page} @ ${vp} · ${n('pass')} ✓ · ${n('failed')} ✗ · ${n('missing')} нет в DOM · ${n('skip')} skip`;

  const order = { failed: 0, missing: 1, nofig: 2, pass: 3, skip: 4 };
  const label = { pass: '✓', failed: '✗', missing: 'нет в DOM', nofig: 'нет в макете', skip: 'skip' };
  $('body').innerHTML = rows
    .sort((a, b) => order[a.status] - order[b.status])
    .map((r, i) => `<div class="arow ${r.status}" data-i="${i}">
        <span class="st">${label[r.status]}${r.bad ? ' ' + r.bad : ''}</span>
        <div class="nm">${esc(r.name || r.key)}</div>
        <div class="sl">${esc(r.selector ?? r.reason ?? '')}</div>
      </div>`).join('') || '<div class="empty">в карте нет привязок для этой страницы</div>';

  const sorted = rows.sort((a, b) => order[a.status] - order[b.status]);
  document.querySelectorAll('.arow').forEach((el) => {
    el.onclick = () => {
      const r = sorted[+el.dataset.i];
      if (r.rows) render({ name: r.name || r.key, figmaId: r.key, selector: r.selector, found: true, rows: r.rows });
      if (r.selector) toActiveTab({ type: 'pg-highlight', selector: r.selector });
    };
  });
}

$('run-audit').onclick = runAudit;


// Панель закрыли — убираем наложение и подсветку со всех вкладок,
// иначе макет остаётся висеть на странице до перезагрузки.
const cleanup = () => {
  chrome.runtime.sendMessage({ type: 'pg-cleanup' });
};
addEventListener('pagehide', cleanup);
addEventListener('beforeunload', cleanup);
