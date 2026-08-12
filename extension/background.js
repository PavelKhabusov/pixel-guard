const BASE = 'http://localhost:8971';
let status = { connected: false, peers: {}, targets: 0 };
let abort = null;

let shownBadge = null;
const badge = (text, color) => {
  if (shownBadge === text) return;
  shownBadge = text;
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
};

const SKIP = /^(chrome|edge|about|devtools|chrome-extension):|^https?:\/\/(www\.)?figma\.com\//;

const toPanel = (message) => chrome.runtime.sendMessage(message).catch(() => {});

function toTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    const targets = tabs.filter((t) => t.url && !SKIP.test(t.url));
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
        toPanel({ type: 'pg-panel-result', result });
      }).catch(() => {});
    }
    setTimeout(() => {
      if (!answered) toPanel({ type: 'pg-panel-result', result: { name: message.node.name || message.node.figmaId, figmaId: message.node.figmaId, found: false } });
    }, 400);
  });
}

function handle(event, data) {
  if (event === 'hello') {
    status.connected = true;
    if (offTimer) { clearTimeout(offTimer); offTimer = null; }
    badge('on', '#5e8f6b');
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
    throw new Error('поток закрыт');
  } catch (e) {
    if (abort?.signal.aborted) return;
    status.connected = false;
    if (!offTimer) offTimer = setTimeout(() => { offTimer = null; if (!status.connected) badge('off', '#a86a6a'); }, 5000);
    setTimeout(connect, 3000);
  } finally {
    connecting = false;
  }
}

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId != null) chrome.sidePanel?.open({ windowId: tab.windowId }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'pg-status') {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([t]) => {
      if (!t || SKIP.test(t.url ?? '')) return reply(status);
      chrome.tabs.sendMessage(t.id, { type: 'pg-mapsize' })
        .then((n) => reply({ ...status, mapSize: n ?? 0 }))
        .catch(() => reply(status));
    });
    return true;
  }
  if (msg.type === 'pg-reconnect') { connect(); reply({ ok: true }); return true; }
  if (msg.type === 'pg-emit') {
    fetch(`${BASE}/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.body),
    }).then((r) => r.json()).then(reply).catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'pg-fetch') {
    fetch(`${BASE}${msg.path}`).then((r) => r.json()).then(reply).catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
