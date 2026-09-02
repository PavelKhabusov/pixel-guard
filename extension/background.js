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
const isTarget = (url) => {
  if (!url || SKIP.test(url)) return false;
  try { return allHosts().includes(new URL(url).host); } catch { return false; }
};

function applyPanelFor(tab) {
  if (!tab?.id) return;
  chrome.sidePanel?.setOptions({ tabId: tab.id, path: 'panel.html', enabled: isTarget(tab.url) }).catch(() => {});
}
const refreshPanels = () => chrome.tabs.query({}, (tabs) => tabs.forEach(applyPanelFor));
chrome.sidePanel?.setOptions({ enabled: false }).catch(() => {});
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.url || info.status === 'complete') applyPanelFor(tab);
  if (info.url && !isTarget(info.url)) {
    for (const type of ['pg-overlay-hide', 'pg-pick-stop', 'pg-inspect-stop', 'pg-unhighlight']) chrome.tabs.sendMessage(id, { type }).catch(() => {});
    applyEmulation(id, null);
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => chrome.tabs.get(tabId).then(async (tab) => {
  applyPanelFor(tab);
  if (isTarget(tab.url)) {
    const w = await wantedWidth(tabId);
    if (w && !(await attachedTabs()).includes(tabId)) applyEmulation(tabId, w);
  } else {
    for (const id of await attachedTabs()) applyEmulation(id, null);
  }
}).catch(() => {}));
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); setWanted(tabId, null); });
refreshPanels();

const toPanel = (message) => chrome.runtime.sendMessage(message).catch(() => {});

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
      chrome.tabs.sendMessage(t.id, message).then((result) => {
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
const setWanted = async (tabId, width) => {
  const { wanted = {} } = await chrome.storage.session.get('wanted');
  if (width) wanted[tabId] = width; else delete wanted[tabId];
  await chrome.storage.session.set({ wanted });
};
const wantedWidth = async (tabId) => ((await chrome.storage.session.get('wanted')).wanted ?? {})[tabId] ?? null;
const attachedTabs = async () => {
  const targets = await chrome.debugger.getTargets().catch(() => []);
  return targets.filter((t) => t.attached && t.tabId != null).map((t) => t.tabId);
};

async function emulateWidth(tabId, width) {
  await setWanted(tabId, width);
  return applyEmulation(tabId, width);
}

async function applyEmulation(tabId, width) {
  const target = { tabId };
  try {
    if (!width) {
      await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
      await chrome.debugger.detach(target).catch(() => {});
      attached.delete(tabId);
      return { ok: true, width: null };
    }
    if (!attached.has(tabId) && !(await attachedTabs()).includes(tabId)) {
      await chrome.debugger.attach(target, '1.3');
    }
    attached.add(tabId);
    await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
      width, height: 0, deviceScaleFactor: 0, mobile: width <= 600,
    });
    return { ok: true, width };
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
    attachedTabs().then((ids) => { for (const tabId of ids) emulateWidth(tabId, null).catch(() => {}); });
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
      chrome.tabs.sendMessage(t.id, { type: 'pg-mapsize' })
        .then((n) => reply({ ...status, mapSize: n ?? 0 }))
        .catch(() => reply(status));
    });
    return true;
  }
  if (msg.type === 'pg-reconnect') { connect(); reply({ ok: true }); return true; }
  if (msg.type === 'pg-hosts') { reply({ server: serverHosts, user: userHosts }); return true; }
  if (msg.type === 'pg-is-target') {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([t]) => {
      let host = null; try { host = new URL(t?.url ?? '').host; } catch {}
      reply({ target: isTarget(t?.url), host, userAdded: !!host && userHosts.includes(host) && !serverHosts.includes(host) });
    });
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
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([t]) => {
      if (!t) return reply({ ok: false, error: 'no active tab' });
      if (!isTarget(t.url)) return reply({ ok: false, error: 'not a project site' });
      emulateWidth(t.id, msg.width).then(reply);
    });
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
