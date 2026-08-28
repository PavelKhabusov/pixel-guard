const $ = (id) => document.getElementById(id);
let userHosts = [];
let serverHosts = [];

const norm = (s) => {
  const t = String(s ?? '').trim();
  if (!t) return null;
  try { return new URL(t.includes('://') ? t : `https://${t}`).host; } catch { return null; }
};

function draw() {
  const list = $('list');
  const rows = [
    ...serverHosts.map((h) => ({ h, src: 'pages.json' })),
    ...userHosts.filter((h) => !serverHosts.includes(h)).map((h) => ({ h, src: 'manual' })),
  ];
  list.innerHTML = rows.map(({ h, src }) => `<div class="host"><span>${h}</span><span class="src">${src}</span>
    ${src === 'manual' ? `<button data-h="${h}" title="remove">✕</button>` : ''}</div>`).join('')
    || '<div class="empty">no sites yet — the server is not running or the list is empty</div>';
  list.querySelectorAll('button').forEach((b) => {
    b.onclick = () => save(userHosts.filter((x) => x !== b.dataset.h));
  });
}

function save(next) {
  userHosts = [...new Set(next)];
  chrome.storage.local.set({ userHosts }, draw);
}

function add(raw) {
  const h = norm(raw);
  if (!h || userHosts.includes(h) || serverHosts.includes(h)) return;
  save([...userHosts, h]);
  $('host').value = '';
}

$('add').onclick = () => add($('host').value);
$('host').onkeydown = (e) => { if (e.key === 'Enter') add($('host').value); };
$('add-cur').onclick = () => chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([t]) => add(t?.url));

chrome.runtime.sendMessage({ type: 'pg-hosts' }, (r) => {
  serverHosts = r?.server ?? [];
  userHosts = r?.user ?? [];
  draw();
});
