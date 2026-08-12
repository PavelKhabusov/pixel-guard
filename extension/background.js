const BASE = 'http://localhost:8971';
let status = { connected: false, peers: {} };
let abort = null;

const badge = (text, color) => {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
};

function toTabs(message) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, message).catch(() => {});
  });
}

function handle(event, data) {
  if (event === 'hello') { status.connected = true; badge('on', '#2e7d32'); return; }
  if (event === 'peers') { status.peers = JSON.parse(data); return; }
  if (event === 'select') { toTabs({ type: 'pg-select', node: JSON.parse(data) }); return; }
  if (event === 'snapshot') { toTabs({ type: 'pg-snapshot', info: JSON.parse(data) }); return; }
}

async function connect() {
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
    badge('off', '#b71c1c');
    setTimeout(connect, 3000);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'pg-status') { reply(status); return true; }
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
