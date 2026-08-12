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
