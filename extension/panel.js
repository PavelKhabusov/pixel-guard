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
  $('dot').className = `dot ${s.connected ? 'on' : ''}`;
  // Одна строка вместо трёх полей: сервер, Figma и размер карты
  $('state').textContent = !s.connected
    ? 'сервер не запущен'
    : `${s.mapSize ?? 0} привязок · Figma ${figma ? 'на связи' : 'не нужна'}`;

  if (!s.connected) {
    alertBox('<b>Сервер не запущен.</b>Выполни <code>npm run server</code> в папке pixel-guard.');
  }
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
  const fails = r.rows.filter((x) => !x.pass);
  const oks = r.rows.filter((x) => x.pass);
  const row = (x) => `<tr class="${x.pass ? 'ok' : 'no'}">
      <td>${esc(x.prop)}</td><td>${esc(x.fig)}</td><td>→</td><td>${esc(x.act)}</td>
      <td>${x.delta && !x.pass ? esc(x.delta) : ''}</td></tr>`;

  // Сначала расхождения — ради них всё и затевалось. Совпавшие прячем
  // под раскрывашку, иначе список выглядит как «чушь из одинаковых строк».
  body.innerHTML = `<div class="node">${esc(r.name)}</div>
    <div class="sel"><code>${esc(r.selector)}</code></div>
    <div class="score">${oks.length} ✓ · ${fails.length} ✗</div>
    ${fails.length ? `<table>${fails.map(row).join('')}</table>`
      : '<div class="allok">всё сходится с макетом</div>'}
    ${oks.length ? `<details class="okwrap"><summary>совпало: ${oks.length}</summary>
      <table>${oks.map(row).join('')}</table></details>` : ''}`;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'pg-panel-result') render(msg.result);
  if (msg.type === 'pg-panel-status') setStatus(msg.status);
});

/** Заметный баннер вместо серой строчки внизу: content script живёт только
 *  до перезагрузки страницы, и без объяснения непонятно, почему всё молчит. */
function alertBox(html, action) {
  const box = $('alert');
  if (!html) { box.hidden = true; return; }
  $('alert-txt').innerHTML = html;
  const btn = $('alert-act');
  btn.hidden = !action;
  if (action) { btn.textContent = action.label; btn.onclick = action.run; }
  box.hidden = false;
}

const reloadTab = () => chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([t]) => {
  if (t) chrome.tabs.reload(t.id);
  alertBox(null);
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
  if (!r) {
    alertBox('<b>Страница не отвечает.</b><br>Расширение обновилось, а на открытой '
      + 'вкладке работает старая версия — она живёт только до перезагрузки.',
      { label: 'Обновить страницу', run: reloadTab });
    note.textContent = '';
    return;
  }
  alertBox(null);
  const d = ovState.data;
  const tab = await activeTab();
  const fit = Math.abs((tab?.width ?? d.w) - d.w) <= 40 ? '' : ` ⚠ окно ${tab?.width}px`;
  const sc = r.scale && r.scale !== 1 ? ` · масштаб ${Math.round(r.scale * 100)}%` : '';
  const anch = r.mode === 'image' ? '' : ` · ${r.placed}/${r.anchored} блоков${r.missing ? `, ${r.missing} нет` : ''}${sc}`;
  note.textContent = `${d.page ? d.page + ' · ' : ''}${d.frame} · ${d.w}px${fit}${anch}`;

  // Объясняем, ПОЧЕМУ на странице пусто, а не оставляем гадать
  if (r.mode === 'shots' && r.anchored && !d.hasShots) {
    alertBox('<b>PNG блоков не сняты.</b><br>Режим «PNG по блокам» показывает рендеры из Figma — '
      + 'их нужно один раз выгрузить: <code>npm run shots</code>.');
  } else if (!r.anchored && r.mode !== 'image') {
    alertBox('<b>Для этой страницы нет привязок.</b><br>Наложению не на что опереться. '
      + 'Наполни карту: <code>npm run automap -- --page ' + (d.page ?? '?') + ' --min 75 --write</code>, '
      + 'либо кликни ноду в Figma и нажми «Привязать мышью».');
  } else if (r.anchored && r.placed < r.anchored / 2) {
    alertBox(`<b>Нашлось ${r.placed} из ${r.anchored} блоков.</b><br>Остальные селекторы не найдены на странице — `
      + 'вероятно карта от другой версии вёрстки. Проверь: <code>npm run verify -- --fix</code>.');
  } else {
    alertBox(null);
  }
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
  $('vp-note').textContent = `${vp} · макет ${ref}px · вьюпорт ${tab?.width ?? '?'}px`
    + (vpChoice === 'auto' ? ' · по ширине окна' : ' · эмуляция DevTools')
    + (diff > 80 && vpChoice === 'auto' ? ' — расходится, блоки масштабируются' : '');
}

// Сужаем ВЬЮПОРТ страницы, а не окно браузера — как адаптивный режим
// DevTools. Окно остаётся прежним, перестраивается только контент.
async function emulateViewport(vp) {
  const width = vp === 'auto' ? null : VP_W[vp];
  const r = await new Promise((res) => chrome.runtime.sendMessage({ type: 'pg-emulate', width }, res));
  if (r?.ok === false) $('vp-note').textContent = `не удалось сузить: ${r.error}`;
  await new Promise((res) => setTimeout(res, 500));
  return r;
}

document.querySelectorAll('.vp-btn').forEach((b) => {
  b.onclick = async () => {
    document.querySelectorAll('.vp-btn').forEach((x) => x.classList.toggle('on', x === b));
    vpChoice = b.dataset.vp;
    ovState.data = null;
    await emulateViewport(vpChoice);
    showVpNote();
    if (ovState.on) applyOverlay();
  };
});

// панель закрывают — снимаем эмуляцию, иначе страница останется узкой
addEventListener('pagehide', () => chrome.runtime.sendMessage({ type: 'pg-emulate', width: null }));
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

  const rows = await toActiveTab({ type: 'pg-audit', nodes: data.nodes, page: data.page, frameW: data.frameW });
  if (!rows) {
    alertBox('<b>Страница не отвечает.</b><br>Скорее всего расширение перезагружали — '
      + 'обнови вкладку, чтобы вернуть связь.', { label: 'Обновить страницу', run: reloadTab });
    note.textContent = '';
    return;
  }
  alertBox(null);

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
