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

const ovState = { on: false, opacity: 0.5, mode: 'render', diff: false, data: null, offsetX: 0, offsetY: 0, loose: false };

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
      showUnanchored: ovState.loose,
    },
  });
  if (!r) { note.textContent = 'вкладка не отвечает'; return; }
  const d = ovState.data;
  const tab = await activeTab();
  const fit = Math.abs((tab?.width ?? d.w) - d.w) <= 40 ? '' : ` ⚠ окно ${tab?.width}px`;
  const anch = r.mode === 'image' ? '' : ` · ${r.placed}/${r.anchored} блоков по якорям${r.missing ? `, ${r.missing} не найдено` : ''}`;
  note.textContent = `${d.page ? d.page + ' · ' : ''}${d.frame} · ${d.w}px${fit}${anch}`;
  if (!r.anchored && r.mode !== 'image') note.textContent += ' — нет привязок, макет лёг по координатам';
  if (ovState.mode === 'image' && !d.png) {
    note.textContent += ' — PNG нет, переэкспортируй с чекбоксом PNG';
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

const activeTab = () => new Promise((res) => {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([t]) => res(t));
});

const viewportFor = (w) => (!w ? 'desktop' : w <= 600 ? 'mobile' : w <= 1100 ? 'tablet' : 'desktop');
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
