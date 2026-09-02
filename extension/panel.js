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
  // One line instead of three fields: server, Figma and map size
  $('state').textContent = !s.connected
    ? 'server not running'
    : `${s.mapSize ?? 0} bindings · Figma ${figma ? 'connected' : 'not needed'}`;

  if (!s.connected) {
    alertBox('<b>Server not running.</b>Run <code>npm run server</code> in the pixel-guard folder.');
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
      <div class="note">${r.selector ? `not found in DOM:<br><code>${esc(r.selector)}</code>` : 'no binding in map'}</div>
      <div class="empty">Add to maps/&lt;page&gt;.map.json:<br><code>"${esc(r.figmaId)}": { "selector": "…" }</code></div>`;
    return;
  }
  const fails = r.rows.filter((x) => !x.pass);
  const oks = r.rows.filter((x) => x.pass);
  const row = (x) => `<tr class="${x.pass ? 'ok' : 'no'}">
      <td>${esc(x.prop)}</td><td>${esc(x.fig)}</td><td>→</td><td>${esc(x.act)}</td>
      <td>${x.delta && !x.pass ? esc(x.delta) : ''}</td></tr>`;

  // Mismatches first — they are the whole point. Matching rows are hidden
  // behind a disclosure, otherwise the list looks like noise of identical lines.
  body.innerHTML = `<div class="node">${esc(r.name)}</div>
    <div class="sel"><code>${esc(r.selector)}</code></div>
    <div class="score">${oks.length} ✓ · ${fails.length} ✗</div>
    ${fails.length ? `<table>${fails.map(row).join('')}</table>`
      : '<div class="allok">everything matches the design</div>'}
    ${oks.length ? `<details class="okwrap"><summary>matched: ${oks.length}</summary>
      <table>${oks.map(row).join('')}</table></details>` : ''}`;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'pg-panel-result') render(msg.result);
  if (msg.type === 'pg-panel-status') setStatus(msg.status);
});

/** A visible banner instead of a grey line at the bottom: the content script
 *  only lives until the page reloads, and without an explanation it is unclear
 *  why everything went silent. */
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

const ovState = { on: false, opacity: 1, mode: 'render', diff: false, data: null, offsetX: 0, offsetY: 0, loose: false, autoScale: true, solo: false, split: null };

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
    if (!d || d.ok === false || d.error) { note.textContent = d?.error ?? 'snapshot not found'; return; }
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
    alertBox('<b>Page not responding.</b><br>The extension was updated, but the open '
      + 'tab still runs the old version — it only lives until a reload.',
      { label: 'Reload page', run: reloadTab });
    note.textContent = '';
    return;
  }
  alertBox(null);
  const d = ovState.data;
  const tab = await activeTab();
  const fit = Math.abs((tab?.width ?? d.w) - d.w) <= 40 ? '' : ` ⚠ window ${tab?.width}px`;
  const sc = r.scale && r.scale !== 1 ? ` · scale ${Math.round(r.scale * 100)}%` : '';
  const anch = r.mode === 'image' ? '' : ` · ${r.placed}/${r.anchored} blocks${r.missing ? `, ${r.missing} missing` : ''}${sc}`;
  note.textContent = `${d.page ? d.page + ' · ' : ''}${d.frame} · ${d.w}px${fit}${anch}`;

  // Explain WHY the page is empty instead of leaving the user guessing
  if (r.mode === 'shots' && r.anchored && !d.hasShots) {
    alertBox('<b>Block PNGs not captured.</b><br>The "PNG per block" mode shows renders from Figma — '
      + 'export them once: <code>npm run shots</code>.');
  } else if (!r.anchored && r.mode !== 'image') {
    alertBox('<b>No bindings for this page.</b><br>The overlay has nothing to anchor to. '
      + 'Fill the map: <code>npm run automap -- --page ' + (d.page ?? '?') + ' --min 75 --write</code>, '
      + 'or click a node in Figma and press "Bind with mouse".');
  } else if (r.anchored && r.placed < r.anchored / 2) {
    alertBox(`<b>Found ${r.placed} of ${r.anchored} blocks.</b><br>The other selectors are not on the page — `
      + 'the map is probably from another version of the page. Check: <code>npm run verify -- --fix</code>.');
  } else {
    alertBox(null);
  }
  if (ovState.mode === 'image' && !d.png) {
    note.textContent += ' — no PNG, re-export with the PNG checkbox';
  }
  if (ovState.mode === 'shots' && !d.hasShots) {
    note.textContent += ' — no renders, run npm run shots';
  }
}

$('ov-on').onchange = (e) => {
  ovState.on = e.target.checked;
  $('ov-opts').hidden = !e.target.checked;
  ovState.data = null;
  applyOverlay();
};
chrome.tabs.onActivated.addListener(() => { ovState.data = null; if (ovState.on) applyOverlay(); });
chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'complete') { ovState.data = null; if (ovState.on) applyOverlay(); } });
ovState.opacity = $('ov-op').value / 100;
$('ov-op').oninput = (e) => {
  ovState.opacity = e.target.value / 100;
  $('ov-val').textContent = `${e.target.value}%`;
  if (ovState.on) applyOverlay();
};
ovState.mode = $('ov-mode').value;
$('ov-mode').onchange = (e) => { ovState.mode = e.target.value; if (ovState.on) applyOverlay(); };
$('ov-x').oninput = (e) => { ovState.offsetX = +e.target.value || 0; $('ov-x-val').textContent = e.target.value; if (ovState.on) applyOverlay(); };
$('ov-y').oninput = (e) => { ovState.offsetY = +e.target.value || 0; $('ov-y-val').textContent = e.target.value; if (ovState.on) applyOverlay(); };
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

// the line can be dragged right on the page — keep the slider in sync
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'pg-split-moved') return;
  ovState.split = msg.split;
  $('ov-split').value = String(msg.split);
  $('ov-split-val').textContent = `${msg.split}%`;
});

const activeTab = () => new Promise((res) => {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([t]) => res(t));
});

// Desktop by default: the design is fixed-width, so the page viewport is
// emulated to the same width and the overlay lands on the pixel. "auto" (no
// emulation, design picked by window width) is an explicit fourth mode.
let vpChoice = 'desktop';
const VP_W = { desktop: 1920, tablet: 912, mobile: 357 };

const autoViewport = (w) => (!w ? 'desktop' : w <= 600 ? 'mobile' : w <= 1100 ? 'tablet' : 'desktop');
const viewportFor = (w) => (vpChoice === 'auto' ? autoViewport(w) : vpChoice);

async function showVpNote() {
  const tab = await activeTab();
  const vp = viewportFor(tab?.width);
  const ref = VP_W[vp];
  const diff = tab?.width && ref ? Math.abs(tab.width - ref) : 0;
  $('vp-note').textContent = `${vp} · design ${ref}px · viewport ${tab?.width ?? '?'}px`
    + (vpChoice === 'auto' ? ' · by window width' : ' · DevTools emulation')
    + (diff > 80 && vpChoice === 'auto' ? ' — mismatch, blocks are scaled' : '');
}

// Narrow the page VIEWPORT, not the browser window — like DevTools responsive
// mode. The window stays the same, only the content reflows.
async function emulateViewport(vp) {
  const width = vp === 'auto' ? null : VP_W[vp];
  const r = await new Promise((res) => chrome.runtime.sendMessage({ type: 'pg-emulate', width }, res));
  if (r?.ok === false) $('vp-note').textContent = `could not narrow: ${r.error}`;
  await new Promise((res) => setTimeout(res, 500));
  return r;
}

async function setViewport(vp) {
  vpChoice = VP_W[vp] || vp === 'auto' ? vp : 'desktop';
  document.querySelectorAll('.vp-btn').forEach((x) => x.classList.toggle('on', x.dataset.vp === vpChoice));
  try { chrome.storage.local.set({ vpChoice }); } catch {}
  ovState.data = null;
  await emulateViewport(vpChoice);
  showVpNote();
  if (ovState.on) applyOverlay();
}

document.querySelectorAll('.vp-btn').forEach((b) => { b.onclick = () => setViewport(b.dataset.vp); });

chrome.storage.local.get('vpChoice', (v) => setViewport(v?.vpChoice ?? 'desktop'));
// a new tab gets the same emulation, otherwise the overlay silently falls back to the window width
chrome.tabs.onActivated.addListener(() => { if (vpChoice !== 'auto') emulateViewport(vpChoice).then(showVpNote); });

// panel is closing — remove emulation, otherwise the page stays narrow
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
  $('bind-note').textContent = r?.ok ? `saved to ${r.file} (${r.size} keys)` : `error: ${r?.error ?? '—'}`;
  if (r?.ok) {
    await toActiveTab({ type: 'pg-remap' });
    $('bind').hidden = true;
  }
}

$('bind-go').onclick = async () => {
  if (!curNode) return;
  $('bind-note').textContent = 'click an element on the page (Esc to cancel)';
  await toActiveTab({ type: 'pg-pick-start', node: curNode });
};

$('bind-skip').onclick = () => saveBinding({ skip: 'marked manually from the panel' });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'pg-pick-result') {
    $('bind-note').textContent = `${msg.selector} · ${msg.domSize}`;
    saveBinding({ selector: msg.selector, source: 'manual', name: curNode?.name });
    render({ name: curNode?.name ?? '', figmaId: curNode?.figmaId, selector: msg.selector, found: true, rows: msg.rows });
  }
  if (msg.type === 'pg-pick-cancelled') $('bind-note').textContent = 'cancelled';
});

fillPages();


async function runAudit() {
  const note = $('audit-note');
  note.textContent = 'reading design…';
  const tab = await activeTab();
  const vp = viewportFor(tab?.width);
  const path = `/nodes?url=${encodeURIComponent(tab?.url ?? '')}&viewport=${vp}`;
  const data = await new Promise((res) => chrome.runtime.sendMessage({ type: 'pg-fetch', path }, res));
  if (!data || data.ok === false) { note.textContent = data?.error ?? 'no data'; return; }

  const rows = await toActiveTab({ type: 'pg-audit', nodes: data.nodes, page: data.page, frameW: data.frameW });
  if (!rows) {
    alertBox('<b>Page not responding.</b><br>The extension was most likely reloaded — '
      + 'reload the tab to restore the connection.', { label: 'Reload page', run: reloadTab });
    note.textContent = '';
    return;
  }
  alertBox(null);

  const n = (s) => rows.filter((r) => r.status === s).length;
  note.textContent = `${data.page} @ ${vp} · ${n('pass')} ✓ · ${n('failed')} ✗ · ${n('missing')} not in DOM · ${n('skip')} skip`;
  post('/report', { page: data.page, viewport: vp, url: tab?.url, frame: data.frame, frameId: data.frameId, rows })
    .then((r) => { if (r?.ok) note.textContent += ` · saved ${r.file}`; });

  const order = { failed: 0, missing: 1, nofig: 2, pass: 3, skip: 4 };
  const label = { pass: '✓', failed: '✗', missing: 'not in DOM', nofig: 'not in design', skip: 'skip' };
  $('body').innerHTML = rows
    .sort((a, b) => order[a.status] - order[b.status])
    .map((r, i) => `<div class="arow ${r.status}" data-i="${i}">
        <span class="st">${label[r.status]}${r.bad ? ' ' + r.bad : ''}</span>
        <div class="nm">${esc(r.name || r.key)}</div>
        <div class="sl">${esc(r.selector ?? r.reason ?? '')}</div>
      </div>`).join('') || '<div class="empty">the map has no bindings for this page</div>';

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

// ── Inspect: click an element on the page → Figma id + selector + diff ──
let inspectOn = false;
let nodeCache = null;

async function nodesForTab() {
  const tab = await activeTab();
  const vp = viewportFor(tab?.width);
  const key = `${tab?.url}|${vp}`;
  if (nodeCache?.key === key) return nodeCache.data;
  const data = await new Promise((res) => chrome.runtime.sendMessage({ type: 'pg-fetch', path: `/nodes?url=${encodeURIComponent(tab?.url ?? '')}&viewport=${vp}` }, res));
  nodeCache = { key, data: data?.ok === false ? null : data };
  return nodeCache.data;
}

async function setInspect(on) {
  inspectOn = on;
  $('inspect-go').classList.toggle('on', on);
  await toActiveTab({ type: on ? 'pg-inspect-start' : 'pg-inspect-stop' });
  if (on) $('body').innerHTML = '<div class="empty">Click an element on the page. Esc exits.</div>';
}
$('inspect-go').onclick = () => setInspect(!inspectOn);

// clipboard API refuses when the panel document is not focused (the click
// came from the page a moment ago) — fall back to a hidden textarea
async function copyText(val) {
  try { await navigator.clipboard.writeText(val); return true; } catch {}
  const ta = document.createElement('textarea');
  ta.value = val; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta); ta.focus(); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}
const copyBtn = (val) => {
  const b = document.createElement('button');
  b.textContent = 'copy';
  b.onclick = async () => {
    const ok = await copyText(val);
    b.textContent = ok ? 'copied' : 'failed'; b.classList.toggle('done', ok);
    setTimeout(() => { b.textContent = 'copy'; b.classList.remove('done'); }, 1200);
  };
  return b;
};
const kv = (k, v, copy = v) => {
  const d = document.createElement('div'); d.className = 'kv';
  d.innerHTML = `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`;
  if (copy) d.appendChild(copyBtn(copy));
  return d;
};

async function showInspect(msg) {
  const data = await nodesForTab();
  const nodes = data?.nodes ?? {};
  const body = $('body');
  body.innerHTML = '';
  const card = document.createElement('div'); card.className = 'insp';
  const primary = msg.hits[0];
  const figId = primary?.key ?? msg.box?.id ?? null;
  const node = primary ? nodes[primary.key] : null;
  if (figId) card.appendChild(kv('figma', figId));
  card.appendChild(kv('selector', msg.selector));
  if (figId) card.appendChild(kv('quote', `${figId} ↔ ${msg.selector}`));
  const sub = document.createElement('div'); sub.className = 'sub';
  sub.textContent = !figId ? 'no binding in the map and no overlay box here'
    : primary && !primary.exact ? 'id of the nearest bound ancestor'
    : !primary ? 'id from the overlay box under the cursor (not in the map)' : '';
  if (sub.textContent) card.appendChild(sub);
  // render() replaces body.innerHTML — serialising the card into it would drop
  // the copy buttons' handlers, so the card is prepended as a live node afterwards
  if (node && primary) {
    const r = await toActiveTab({ type: 'pg-diff', node, selector: primary.selector });
    if (r?.rows) {
      render({ name: node.name, figmaId: primary.key, selector: primary.selector, found: true, rows: r.rows });
      $('bind').hidden = true;
    }
  }
  body.prepend(card);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'pg-inspect-done') showInspect(msg);
  if (msg.type === 'pg-inspect-stopped') { inspectOn = false; $('inspect-go').classList.remove('on'); }
});
chrome.tabs.onActivated.addListener(() => { nodeCache = null; if (inspectOn) setInspect(false); });
// SPA route change: same tab, new page — new map, new design
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'pg-spa-nav') return;
  nodeCache = null; ovState.data = null;
  if (ovState.on) applyOverlay();
  logLine(`→ ${msg.url}`);
});


// Panel closed — remove the overlay, highlight and viewport emulation.
// pagehide in the Chrome side panel does not always fire, but the background
// reliably sees the port disconnect — so we keep a port open.
chrome.runtime.connect({ name: 'pg-panel' });
