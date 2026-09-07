/** Device frame: the site lives in an iframe of the design width, placed
 *  left / center / right on the extension's own ground — like DevTools device
 *  mode, but done with a real iframe: media queries, fixed bars and scrollbars
 *  behave exactly as in a window of that width. No CDP involved. */
const q = new URLSearchParams(location.search);
const wrap = document.getElementById('wrap');
const frame = document.getElementById('page');

function apply({ w, pos, url }) {
  if (url && frame.src !== url) frame.src = url;
  if (w) frame.style.width = `${w}px`;
  wrap.className = pos ?? 'center';
  const p = new URLSearchParams(location.search);
  if (w) p.set('w', String(w)); if (pos) p.set('pos', pos); if (url) p.set('url', url);
  history.replaceState(null, '', `?${p}`);
  document.title = `${frame.style.width} · ${new URL(frame.src).host}`;
}
apply({ url: q.get('url'), w: Number(q.get('w')) || 357, pos: q.get('pos') || 'center' });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'pg-frame-set') { apply(msg); reply({ ok: true }); return true; }
  // the framed page reports its own navigation so the bar (and the URL param) follow it
  if (msg.type === 'pg-frame-url' && msg.url) { const p = new URLSearchParams(location.search); p.set('url', msg.url); history.replaceState(null, '', `?${p}`); }
});
