import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = (process.argv[i + 1] ?? '--').startsWith('--') ? true : process.argv[++i];
}

const page = args.page ?? 'home';
const viewport = args.viewport ?? 'desktop';
const reportPath = path.join(ROOT, 'reports', `${page}-${viewport}.json`);

if (!fs.existsSync(reportPath)) {
  console.error(`Нет отчёта ${path.relative(ROOT, reportPath)} — сначала npm run qa -- --page ${page} --viewport ${viewport}`);
  process.exit(2);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const viewports = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/viewports.json'), 'utf8'));
const width = viewports[viewport];

const SHORTHAND = {
  'padding-top': 'padding-top', 'padding-right': 'padding-right',
  'padding-bottom': 'padding-bottom', 'padding-left': 'padding-left',
};

const value = (d) => {
  const v = String(d.figma);
  if (d.prop === 'font-weight') return v;
  if (d.prop === 'font-family') return `'${v}', sans-serif`;
  if (/^#/.test(v)) return v.split(' / ')[0];
  if (/^\d/.test(v)) return v.includes('…') ? `${v.split('…')[1]}` : v;
  return v;
};

const blocks = [];
for (const n of report.nodes) {
  if (n.status !== 'failed' || !n.selector || !n.diffs?.length) continue;
  const decls = n.diffs
    .filter((d) => d.prop !== 'width' && d.prop !== 'height')
    .map((d) => `  ${SHORTHAND[d.prop] ?? d.prop}: ${value(d)}; /* было ${d.actual}${d.delta ? `, ${d.delta}` : ''} */`);
  if (!decls.length) continue;
  blocks.push(`/* ${n.key}${n.figmaId && n.figmaId !== n.key ? ` — ${n.figmaId}` : ''} */\n${n.selector} {\n${decls.join('\n')}\n}`);
}

if (!blocks.length) {
  console.log(`Нечего править: ${page} @ ${viewport} — расхождений в стилях нет.`);
  process.exit(0);
}

const media = viewport === 'desktop' ? null : `@media (max-width: ${width}px)`;
const body = media
  ? `${media} {\n${blocks.join('\n\n').split('\n').map((l) => (l ? `  ${l}` : l)).join('\n')}\n}`
  : blocks.join('\n\n');

const css = `/* pixel-guard: ${page} @ ${viewport} (${width}px)
   ${report.url}
   сгенерировано из reports/${page}-${viewport}.json — ПРОВЕРЬ перед применением:
   значения взяты из макета, каскад и специфичность не учитываются. */\n\n${body}\n`;

const out = path.join(ROOT, 'reports', `${page}-${viewport}.css`);
fs.writeFileSync(out, css);
console.log(css);
console.log(`\n→ ${path.relative(ROOT, out)} (${blocks.length} блоков)`);
