const BASE = 'http://localhost:8971';
let status = { connected: false, peers: {}, targets: 0 };
let abort = null;

let shownBadge = null;
const iconCache = {};

// Chrome always draws the badge as a label, so the indicator is baked
// right into the icon: a dot in the bottom-right corner cut out of the base.
async function iconWithDot(color) {
  if (iconCache[color]) return iconCache[color];
  const out = {};
  for (const size of [16, 32, 48]) {
    const res = await fetch(chrome.runtime.getURL(`icons/icon-${size}.png`));
    const bmp = await createImageBitmap(await res.blob());
    const cv = new OffscreenCanvas(size, size);
    const g = cv.getContext('2d');
    g.drawImage(bmp, 0, 0, size, size);

    const r = Math.max(2.5, size * 0.17);
    const cx = size - r - size * 0.06;
    const cy = size - r - size * 0.06;

    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.arc(cx, cy, r * 1.5, 0, Math.PI * 2);
    g.fill();

    g.globalCompositeOperation = 'source-over';
    g.fillStyle = color;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();

    out[size] = g.getImageData(0, 0, size, size);
  }
  iconCache[color] = out;
  return out;
}

const badge = (state, color, title) => {
  if (shownBadge === state) return;
  shownBadge = state;
  chrome.action.setTitle({ title: `pixel-guard — ${title}` });
  iconWithDot(color)
    .then((imageData) => chrome.action.setIcon({ imageData }))
    .catch(() => {});
};

const SKIP = /^(chrome|edge|about|devtools|chrome-extension):|^https?:\/\/(www\.)?figma\.com\//;

// The extension only works on allowed sites: hosts from config/pages.json plus
// the ones added on the options page. The side panel is disabled globally and
// enabled per tab, so it never travels to other tabs when switching.
let serverHosts = [];
let userHosts = [];
chrome.storage.local.get(['hosts', 'userHosts'], (v) => {
  if (Array.isArray(v?.hosts)) serverHosts = v.hosts;
  if (Array.isArray(v?.userHosts)) userHosts = v.userHosts;
  refreshPanels();
});
chrome.storage.onChanged.addListener((ch) => {
  if (ch.userHosts) { userHosts = ch.userHosts.newValue ?? []; refreshPanels(); }
});

async function loadHosts() {
  try {
    const r = await fetch(`${BASE}/pages`);
    const list = await r.json();
    const set = new Set();
    for (const p of list) { try { set.add(new URL(p.url).host); } catch {} }
    serverHosts = [...set];
    chrome.storage.local.set({ hosts: serverHosts });
    refreshPanels();
  } catch {}
}

const allHosts = () => [...new Set([...serverHosts, ...userHosts])];
// our device frame page carries the real page in ?url= — judge by that
const FRAME_URL = chrome.runtime.getURL('frame.html');
const innerUrl = (url) => (url && url.startsWith(FRAME_URL) ? (new URL(url).searchParams.get('url') || null) : url);
// geo/regional subdomains (goryachiy-klyuch.plitka-propress.ru) are the same site
const sameSite = (host, allowed) => host === allowed || host.endsWith('.' + allowed);
const isTarget = (url) => {
  url = innerUrl(url);
  if (!url || SKIP.test(url)) return false;
  try { const h = new URL(url).host; return allHosts().some((a) => sameSite(h, a)); } catch { return false; }
};

function applyPanelFor(tab) {
  if (!tab?.id) return;
  chrome.sidePanel?.setOptions({ tabId: tab.id, path: 'panel.html', enabled: isTarget(tab.url) }).catch(() => {});
}
const refreshPanels = () => chrome.tabs.query({}, (tabs) => tabs.forEach(applyPanelFor));
chrome.sidePanel?.setOptions({ enabled: false }).catch(() => {});
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  // the device frame page rewrites its own ?w=&pos= via replaceState — that is not a navigation away
  if (info.url && !info.url.startsWith(FRAME_URL)) setFrameOf(id, null);
  if (info.url || info.status === 'complete') applyPanelFor(tab);
  if (info.url && !isTarget(info.url)) {
    for (const type of ['pg-overlay-hide', 'pg-pick-stop', 'pg-inspect-stop', 'pg-unhighlight']) chrome.tabs.sendMessage(id, { type }).catch(() => {});
    applyEmulation(id, null);
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => chrome.tabs.get(tabId).then(async (tab) => {
  applyPanelFor(tab);
  if (isTarget(tab.url)) {
    const w = await wantedFor(tabId);
    if (w?.width && !(await ownAttached()).has(tabId)) applyEmulation(tabId, w.width, w.shifted);
  } else {
    for (const id of await ownAttached()) applyEmulation(id, null);
  }
}).catch(() => {}));
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); setWanted(tabId, null); chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId % 1000000 + 1] }).catch(() => {}); });
refreshPanels();

const toPanel = (message) => chrome.runtime.sendMessage(message).catch(() => {});
// tab → frameId of the site's content script (0 = top frame; inside the device
// frame it is the iframe). Kept in session storage: the worker forgets memory.
const frameOf = async (tabId) => ((await chrome.storage.session.get('pageFrame')).pageFrame ?? {})[tabId] ?? 0;
const setFrameOf = async (tabId, frameId) => { const m = (await chrome.storage.session.get('pageFrame')).pageFrame ?? {}; if (frameId == null) delete m[tabId]; else m[tabId] = frameId; await chrome.storage.session.set({ pageFrame: m }); };
const toPage = async (tabId, message) => {
  let frameId = await frameOf(tabId);
  // on the device frame page the site's script announces itself once the iframe
  // has loaded — give it a few seconds instead of talking to our own top frame
  if (!frameId) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t?.url?.startsWith(FRAME_URL)) {
      for (let i = 0; i < 16 && !frameId; i++) { await new Promise((r) => setTimeout(r, 250)); frameId = await frameOf(tabId); }
      if (!frameId) return null;
    }
  }
  return chrome.tabs.sendMessage(tabId, message, { frameId }).catch(() => null);
};

function toTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    const targets = tabs.filter((t) => isTarget(t.url));
    status.targets = targets.length;
    if (message.type !== 'pg-select') {
      for (const t of targets) chrome.tabs.sendMessage(t.id, message).catch(() => {});
      return;
    }
    let answered = false;
    for (const t of targets) {
      toPage(t.id, message).then((result) => {
        if (!result || answered) return;
        if (result.found || result.skip) answered = true;
        toPanel({ type: 'pg-panel-result', result: { ...result, node: message.node } });
      }).catch(() => {});
    }
    setTimeout(() => {
      if (!answered) toPanel({ type: 'pg-panel-result', result: { name: message.node.name || message.node.figmaId, figmaId: message.node.figmaId, found: false, node: message.node } });
    }, 400);
  });
}

function handle(event, data) {
  if (event === 'hello') {
    status.connected = true;
    loadHosts();
    if (offTimer) { clearTimeout(offTimer); offTimer = null; }
    badge('on', '#7fb08a', 'server connected');
    return;
  }
  if (event === 'peers') { status.peers = JSON.parse(data); return; }
  if (event === 'select') { toTabs({ type: 'pg-select', node: JSON.parse(data) }); return; }
  if (event === 'snapshot') { toTabs({ type: 'pg-snapshot', info: JSON.parse(data) }); return; }
}

let connecting = false;
let offTimer = null;

async function connect() {
  if (connecting) return;
  connecting = true;
  if (abort) abort.abort();
  abort = new AbortController();
  try {
    const r = await fetch(`${BASE}/bus?role=extension`, { signal: abort.signal });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (raw.startsWith(':')) continue;
        const ev = /^event: (.+)$/m.exec(raw)?.[1];
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        if (ev) handle(ev, data);
      }
    }
    throw new Error('stream closed');
  } catch (e) {
    if (abort?.signal.aborted) return;
    status.connected = false;
    if (!offTimer) offTimer = setTimeout(() => { offTimer = null; if (!status.connected) badge('off', '#c98b8b', 'server unavailable — run npm run server'); }, 5000);
    setTimeout(connect, 3000);
  } finally {
    connecting = false;
  }
}

/**
 * Viewport narrowing like in DevTools: the extension cannot change the content
 * width directly, but CDP (Emulation.setDeviceMetricsOverride) can.
 * It is the same mechanism DevTools responsive mode uses.
 */
const attached = new Set();
chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId));
// The service worker dies after ~30s idle and forgets in-memory state, while
// debugger sessions survive. So the wanted width lives in session storage and
// "who is attached" is asked from Chrome itself.
const setWanted = async (tabId, width, shifted = false) => {
  const { wanted = {} } = await chrome.storage.session.get('wanted');
  if (width) wanted[tabId] = { width, shifted }; else delete wanted[tabId];
  await chrome.storage.session.set({ wanted });
};
const wantedFor = async (tabId) => { const w = ((await chrome.storage.session.get('wanted')).wanted ?? {})[tabId]; return typeof w === 'number' ? { width: w, shifted: false } : (w ?? null); };
const wantedWidth = async (tabId) => (await wantedFor(tabId))?.width ?? null;

async function emulateWidth(tabId, width, shifted = false) {
  await setWanted(tabId, width, shifted);
  return applyEmulation(tabId, width, shifted);
}

// Our own attachments survive a service-worker restart in session storage.
// chrome.debugger.getTargets() reports ANY client (DevTools, Playwright) as
// "attached" — trusting it made us skip attach and then fail on every command.
const ownAttached = async () => new Set(((await chrome.storage.session.get('ownAttached')).ownAttached ?? []));
const setOwn = async (tabId, on) => { const set = await ownAttached(); if (on) set.add(tabId); else set.delete(tabId); await chrome.storage.session.set({ ownAttached: [...set] }); };
chrome.debugger.onDetach.addListener((src) => setOwn(src.tabId, false));

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    const m = String(e?.message ?? e);
    if (!/already attached/i.test(m) || !(await ownAttached()).has(tabId)) {
      throw new Error(/another debugger|already attached/i.test(m) ? `another debugger is attached to this tab (DevTools?) — close it and retry: ${m}` : m);
    }
  }
  attached.add(tabId);
  await setOwn(tabId, true);
}

async function applyEmulation(tabId, width, shifted = false) {
  const target = { tabId };
  try {
    if (!width) {
      await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
      await chrome.debugger.sendCommand(target, 'Emulation.setScrollbarsHidden', { hidden: false }).catch(() => {});
      await chrome.debugger.detach(target).catch(() => {});
      attached.delete(tabId);
      await setOwn(tabId, false);
      return { ok: true, width: null };
    }
    await ensureAttached(tabId);
    // a shifted page (center/right) needs a desktop-style layout viewport:
    // with mobile:true Chrome widens it to the shifted content and every
    // fixed bar spans the whole tab. Scrollbars are hidden so the width stays exact.
    const mobile = width <= 600 && !shifted;
    await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
      width, height: 0, deviceScaleFactor: 0, mobile,
    });
    await chrome.debugger.sendCommand(target, 'Emulation.setScrollbarsHidden', { hidden: shifted }).catch(() => {});
    return { ok: true, width, mobile };
  } catch (e) {
    attached.delete(tabId);
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// Panel closed (or Chrome unloaded it) — the port breaks, clean up after ourselves.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pg-panel') return;
  port.onDisconnect.addListener(() => {
    chrome.tabs.query({}, (tabs) => {
      for (const t of tabs.filter((x) => isTarget(x.url))) {
        chrome.tabs.sendMessage(t.id, { type: 'pg-overlay-hide' }).catch(() => {});
        chrome.tabs.sendMessage(t.id, { type: 'pg-pick-stop' }).catch(() => {});
        chrome.tabs.sendMessage(t.id, { type: 'pg-inspect-stop' }).catch(() => {});
        chrome.tabs.sendMessage(t.id, { type: 'pg-unhighlight' }).catch(() => {});
      }
    });
    ownAttached().then((ids) => { for (const tabId of ids) emulateWidth(tabId, null).catch(() => {}); });
    chrome.storage.session.set({ wanted: {} });
  });
});

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});

// target site: open the panel for THIS tab only; anything else: the options
// page, where the current site can be added to the list
chrome.action.onClicked.addListener((tab) => {
  if (isTarget(tab.url)) chrome.sidePanel?.open({ tabId: tab.id }).catch(() => {});
  else chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'pg-status') {
    panelSeen = Date.now();
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([t]) => {
      if (!isTarget(t?.url)) return reply(status);
      toPage(t.id, { type: 'pg-mapsize' }).then((n) => reply({ ...status, mapSize: n ?? 0 }));
    });
    return true;
  }
  if (msg.type === 'pg-reconnect') { connect(); reply({ ok: true }); return true; }
  if (msg.type === 'pg-hosts') { reply({ server: serverHosts, user: userHosts }); return true; }
  if (msg.type === 'pg-is-target') {
    const answer = (t) => {
      const u = innerUrl(t?.url);
      let host = null; try { host = new URL(u ?? '').host; } catch {}
      reply({ target: isTarget(t?.url), host, framed: !!t?.url && t.url.startsWith(FRAME_URL), userAdded: !!host && userHosts.some((a) => sameSite(host, a)) && !serverHosts.some((a) => sameSite(host, a)) });
    };
    if (msg.tabId != null) chrome.tabs.get(msg.tabId).then(answer).catch(() => answer(null));
    else chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([t]) => answer(t));
    return true;
  }
  // ── device frame: the site in an iframe of the design width on our own page ──
  if (msg.type === 'pg-frame-open') {
    (async () => {
      const t = await chrome.tabs.get(msg.tabId);
      const url = innerUrl(t.url);
      if (!isTarget(url)) return reply({ ok: false, error: `not an allowed site (${url ?? t.url}; allowed: ${allHosts().join(', ') || 'none yet — server not reached'})` });
      // the site forbids framing (X-Frame-Options / frame-ancestors): strip those
      // headers for sub-frames of THIS tab only, for as long as the frame is open
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [msg.tabId % 1000000 + 1],
        addRules: [{
          id: msg.tabId % 1000000 + 1, priority: 1,
          action: { type: 'modifyHeaders', responseHeaders: [{ header: 'x-frame-options', operation: 'remove' }, { header: 'content-security-policy', operation: 'remove' }, { header: 'content-security-policy-report-only', operation: 'remove' }] },
          condition: { tabIds: [msg.tabId], resourceTypes: ['sub_frame'] },
        }],
      }).catch((e) => console.warn('[frame] dnr', e));
      await applyEmulation(msg.tabId, null).catch(() => {});
      await setWanted(msg.tabId, null);
      const target = `${FRAME_URL}?url=${encodeURIComponent(url)}&w=${msg.w ?? 357}&pos=${msg.pos ?? 'center'}`;
      await chrome.tabs.update(msg.tabId, { url: target });
      reply({ ok: true });
    })().catch((e) => reply({ ok: false, error: String(e?.message ?? e) }));
    return true;
  }
  if (msg.type === 'pg-frame-close') {
    (async () => {
      const t = await chrome.tabs.get(msg.tabId);
      const url = innerUrl(t.url);
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [msg.tabId % 1000000 + 1] }).catch(() => {});
      if (url && url !== t.url) await chrome.tabs.update(msg.tabId, { url });
      reply({ ok: true });
    })().catch((e) => reply({ ok: false, error: String(e?.message ?? e) }));
    return true;
  }
  if (msg.type === 'pg-frame-set') {
    chrome.tabs.sendMessage(msg.tabId, { type: 'pg-frame-set', w: msg.w, pos: msg.pos }, { frameId: 0 }).then(reply).catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  // The framed page announces itself (with its frameId) — remember where the
  // site's content script lives in that tab
  if (msg.type === 'pg-frame-url' && sender.tab?.id != null) {
    setFrameOf(sender.tab.id, sender.frameId ?? 0).then(() => chrome.tabs.sendMessage(sender.tab.id, msg, { frameId: 0 }).catch(() => {}));
    return;
  }
  if (msg.type === 'pg-debug-frame') { chrome.storage.session.get('pageFrame').then((v) => reply(v.pageFrame ?? {})); return true; }
  // Messages for the site's content script go to ITS frame only: on the device
  // frame page the top document is ours and would close the port without answering
  if (msg.type === 'pg-to-page') {
    toPage(msg.tabId, msg.msg).then(reply);
    return true;
  }
  if (msg.type === 'pg-emit') {
    fetch(`${BASE}/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.body),
    }).then((r) => r.json()).then(reply).catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'pg-post') {
    fetch(`${BASE}${msg.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.body ?? {}),
    }).then((r) => r.json()).then(reply).catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'pg-pick-done') {
    toPanel({ type: 'pg-pick-result', selector: msg.selector, domSize: msg.domSize, rows: msg.rows, node: msg.node });
    return;
  }
  if (msg.type === 'pg-pick-cancel') { toPanel({ type: 'pg-pick-cancelled' }); return; }
  if (msg.type === 'pg-inspect-done' || msg.type === 'pg-inspect-stopped' || msg.type === 'pg-spa-nav') { toPanel(msg); return; }
  if (msg.type === 'pg-split-moved') { toPanel(msg); return; }
  if (msg.type === 'pg-emulate') {
    // the panel names its own tab; the active-tab fallback is for old panels only
    const withTab = (t) => {
      if (!t) return reply({ ok: false, error: 'no tab' });
      if (!isTarget(t.url)) return reply({ ok: false, error: 'not a project site' });
      emulateWidth(t.id, msg.width, !!msg.shifted).then(reply);
    };
    if (msg.tabId != null) chrome.tabs.get(msg.tabId).then(withTab).catch(() => withTab(null));
    else chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([t]) => withTab(t));
    return true;
  }
  if (msg.type === 'pg-cleanup') {
    chrome.tabs.query({}, (tabs) => {
      for (const t of tabs.filter((x) => isTarget(x.url))) {
        chrome.tabs.sendMessage(t.id, { type: 'pg-overlay-hide' }).catch(() => {});
        chrome.tabs.sendMessage(t.id, { type: 'pg-pick-stop' }).catch(() => {});
        chrome.tabs.sendMessage(t.id, { type: 'pg-inspect-stop' }).catch(() => {});
        chrome.tabs.sendMessage(t.id, { type: 'pg-unhighlight' }).catch(() => {});
      }
    });
    return;
  }
  if (msg.type === 'pg-shot') {
    // The site CSP blocks http://localhost in img-src, so fetch the image
    // from the extension and return a data:URI — allowed by 'self' data:
    fetch(`${BASE}/shot?file=${encodeURIComponent(msg.file)}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((buf) => {
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 8192) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        }
        reply({ ok: true, dataUrl: `data:image/png;base64,${btoa(bin)}` });
      })
      .catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'pg-fetch') {
    fetch(`${BASE}${msg.path}`).then((r) => r.json()).then(reply).catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
});

let panelSeen = 0;
setInterval(() => {
  if (!panelSeen || Date.now() - panelSeen < 6000) return;
  panelSeen = 0;
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs.filter((x) => isTarget(x.url))) {
      chrome.tabs.sendMessage(t.id, { type: 'pg-overlay-hide' }).catch(() => {});
      chrome.tabs.sendMessage(t.id, { type: 'pg-pick-stop' }).catch(() => {});
    }
  });
}, 3000);

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
