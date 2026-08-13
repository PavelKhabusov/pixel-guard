const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const LABEL = {
  pass: '✓ совпадает', failed: '✗ расхождения', missing: 'нет в DOM',
  skip: 'skip', 'map-error': 'нода не найдена', absent: 'нет в макете',
};

export function renderHtml(report) {
  const { score, nodes } = report;

  const byProp = {};
  for (const n of nodes) for (const d of n.diffs ?? []) (byProp[d.prop] ??= []).push({ ...d, key: n.key, selector: n.selector });
  const propRows = Object.entries(byProp)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([prop, list]) => `<tr><td><code>${esc(prop)}</code></td><td>${list.length}</td>
      <td class="muted">${esc(list.slice(0, 3).map((d) => `${d.figma}→${d.actual}`).join(', '))}${list.length > 3 ? '…' : ''}</td></tr>`)
    .join('');

  const sections = nodes.map((n) => {
    const diffs = (n.diffs ?? [])
      .map((d) => `<tr><td><code>${esc(d.prop)}</code></td><td class="fig">${esc(d.figma)}</td>
        <td class="act">${esc(d.actual)}</td><td class="delta">${esc(d.delta ?? '')}</td></tr>`)
      .join('');
    const meta = n.status === 'skip' ? esc(n.reason ?? '')
      : n.status === 'pass' ? `${n.checked ?? 0} проверок — всё сходится`
      : n.status === 'failed' ? `${n.checked ?? 0} проверок, ${n.diffs.length} расхождений`
      : '';
    return `<section class="${n.status}" data-status="${n.status}">
      <h3><b>${esc(n.key)}</b>${n.selector ? ` <code>${esc(n.selector)}</code>` : ''}</h3>
      <div class="meta"><span class="tag ${n.status}">${LABEL[n.status] ?? n.status}</span> ${meta}</div>
      ${diffs ? `<table class="diffs"><tr><th>свойство</th><th>Figma</th><th>сайт</th><th>Δ</th></tr>${diffs}</table>` : ''}
    </section>`;
  }).join('\n');

  return `<!doctype html><meta charset="utf-8">
<title>pixel-guard: ${esc(report.page)} @ ${esc(report.viewport)}</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 24px;
         background: #1a222b; color: #dde5ee; }
  .wrap { max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { color: #8fb5da; margin: 0 0 18px; font-size: 13px; }
  .sub a { color: #8fb5da; }
  code { background: #222b36; padding: 1px 5px; border-radius: 4px;
         font: 12px ui-monospace, Menlo, monospace; color: #8fb5da; }
  .cards { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; }
  .card { background: #222b36; border-radius: 8px; padding: 10px 14px; min-width: 92px; }
  .card b { display: block; font-size: 20px; font-weight: 600; }
  .card span { font-size: 11px; color: #b9c6d4; }
  .card.ok b { color: #9ec9a8; } .card.bad b { color: #e8a0a0; } .card.warn b { color: #d4b483; }
  .panel { background: #222b36; border-radius: 8px; padding: 12px 16px; margin-bottom: 18px; }
  .panel h2 { font-size: 13px; margin: 0 0 8px; color: #b9c6d4; font-weight: 600; }
  .panel table { border-collapse: collapse; width: 100%; font-size: 13px; }
  .panel td { padding: 3px 8px 3px 0; }
  .muted { color: #6f7f8f; font-size: 12px; }
  .filters { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
  .filters button { background: #222b36; color: #b9c6d4; border: 1px solid #34424f;
                    border-radius: 6px; padding: 5px 11px; font-size: 12px; cursor: pointer; }
  .filters button.on { background: #7ba7d4; color: #16202a; border-color: #7ba7d4; font-weight: 600; }
  section { background: #222b36; border-left: 3px solid #7fb08a; border-radius: 6px;
            padding: 10px 14px; margin: 8px 0; }
  section.failed { border-left-color: #c98b8b; }
  section.missing, section.map-error { border-left-color: #d4b483; }
  section.absent, section.skip { border-left-color: #4a5766; opacity: .7; }
  section h3 { margin: 0; font-size: 13px; font-weight: 400; }
  section h3 b { font-weight: 600; }
  .meta { font-size: 12px; color: #b9c6d4; margin-top: 4px; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 4px; font-size: 11px;
         background: #34424f; margin-right: 6px; }
  .tag.pass { color: #9ec9a8; } .tag.failed { color: #e8a0a0; }
  .tag.missing, .tag.map-error { color: #d4b483; }
  table.diffs { border-collapse: collapse; margin-top: 8px; font-size: 12.5px;
                font-family: ui-monospace, Menlo, monospace; }
  table.diffs td, table.diffs th { padding: 2px 14px 2px 0; text-align: left; }
  table.diffs th { color: #6f7f8f; font-weight: 400; font-size: 11px; }
  .fig { color: #b9c6d4; } .act { color: #e8a0a0; } .delta { color: #d4b483; }
  section.pass .act { color: #9ec9a8; }
</style>
<div class="wrap">
  <h1>${esc(report.page)} @ ${esc(report.viewport)}</h1>
  <p class="sub"><a href="${esc(report.url)}">${esc(report.url)}</a> · макет «${esc(report.frame)}» · ${esc(report.generatedAt?.slice(0, 16).replace('T', ' '))}</p>

  <div class="cards">
    <div class="card ok"><b>${score.pass}</b><span>совпало</span></div>
    <div class="card bad"><b>${score.failed}</b><span>расхождений</span></div>
    <div class="card warn"><b>${score.missing}</b><span>нет в DOM</span></div>
    <div class="card"><b>${score.skip}</b><span>skip</span></div>
    ${score.absent ? `<div class="card"><b>${score.absent}</b><span>нет в макете</span></div>` : ''}
    ${score['map-error'] ? `<div class="card warn"><b>${score['map-error']}</b><span>нода не найдена</span></div>` : ''}
  </div>

  ${propRows ? `<div class="panel"><h2>Чаще всего расходится</h2><table>${propRows}</table></div>` : ''}

  <div class="filters">
    <button class="on" data-f="all">все (${nodes.length})</button>
    <button data-f="failed">✗ расхождения (${score.failed})</button>
    <button data-f="pass">✓ совпадает (${score.pass})</button>
    <button data-f="missing">нет в DOM (${score.missing})</button>
    <button data-f="skip">skip (${score.skip})</button>
  </div>

  ${sections}
</div>
<script>
  const btns = [...document.querySelectorAll('.filters button')];
  btns.forEach((b) => b.onclick = () => {
    btns.forEach((x) => x.classList.toggle('on', x === b));
    const f = b.dataset.f;
    document.querySelectorAll('section').forEach((s) => {
      s.style.display = f === 'all' || s.dataset.status === f ? '' : 'none';
    });
  });
</script>`;
}
