const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderHtml(report) {
  const rows = report.nodes.map((n) => {
    const badge = { pass: '✓', failed: '✗', missing: 'нет в DOM', skip: 'skip', 'map-error': 'нода не найдена' }[n.status];
    const diffs = (n.diffs ?? [])
      .map((d) => `<tr><td>${esc(d.prop)}</td><td>${esc(d.figma)}</td><td>${esc(d.actual)}</td><td>${esc(d.delta ?? '')}</td></tr>`)
      .join('');
    return `<section class="${n.status}">
      <h3><span class="badge">${badge}</span> ${esc(n.key)} <code>${esc(n.selector ?? '')}</code>
      <small>${n.checked ?? 0} проверок, ${n.diffs?.length ?? 0} расхождений</small></h3>
      ${diffs ? `<table><tr><th>свойство</th><th>Figma</th><th>сайт</th><th>Δ</th></tr>${diffs}</table>` : ''}
    </section>`;
  }).join('\n');

  return `<!doctype html><meta charset="utf-8"><title>pixel-guard: ${esc(report.page)} @ ${esc(report.viewport)}</title>
<style>
  body{font:14px/1.5 system-ui;margin:24px;max-width:960px;background:#fafafa;color:#222}
  h1{font-size:20px} code{background:#eee;padding:1px 5px;border-radius:4px;font-size:12px}
  section{background:#fff;border:1px solid #e5e5e5;border-left:4px solid #4caf50;border-radius:6px;padding:10px 14px;margin:10px 0}
  section.failed{border-left-color:#bf2120} section.missing,section.map-error{border-left-color:#ff9800}
  h3{margin:0;font-size:14px} small{color:#888;font-weight:400;margin-left:8px}
  .badge{display:inline-block;min-width:18px}
  table{border-collapse:collapse;margin-top:8px;font-size:13px}
  td,th{border:1px solid #e5e5e5;padding:3px 10px;text-align:left} th{background:#f5f5f5}
</style>
<h1>pixel-guard — ${esc(report.page)} @ ${esc(report.viewport)} (${esc(report.url)})</h1>
<p>${report.score.pass} ✓ · ${report.score.failed} ✗ · ${report.score.missing} нет в DOM · ${report.score.skip} skip</p>
${rows}`;
}
