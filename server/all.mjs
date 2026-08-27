import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = (process.argv[i + 1] ?? '--').startsWith('--') ? true : process.argv[++i];
}

const pages = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/pages.json'), 'utf8'));
const viewports = args.viewport ? [args.viewport] : ['desktop', 'tablet', 'mobile'];
const only = args.page ? String(args.page).split(',') : Object.keys(pages);

const rows = [];
for (const page of only) {
  for (const viewport of viewports) {
    if (!pages[page]?.frames?.[viewport]) continue;
    const r = spawnSync('node', [path.join(ROOT, 'server/run.mjs'), '--page', page, '--viewport', viewport], {
      encoding: 'utf8', cwd: ROOT,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = out.match(/(\d+) ✓ · (\d+) ✗ · (\d+) missing/);
    rows.push(m
      ? { page, viewport, pass: +m[1], failed: +m[2], missing: +m[3] }
      : { page, viewport, error: out.trim().split('\n').pop() });
    process.stdout.write(`${m ? (+m[2] ? '✗' : '✓') : '!'} ${page}/${viewport}\n`);
  }
}

const w = Math.max(...rows.map((r) => r.page.length), 8);
console.log(`\n${'page'.padEnd(w)}  viewport   ✓    ✗   missing`);
console.log('─'.repeat(w + 30));
let tp = 0, tf = 0, tm = 0;
for (const r of rows) {
  if (r.error) { console.log(`${r.page.padEnd(w)}  ${r.viewport.padEnd(9)} error: ${r.error.slice(0, 40)}`); continue; }
  tp += r.pass; tf += r.failed; tm += r.missing;
  console.log(`${r.page.padEnd(w)}  ${r.viewport.padEnd(9)} ${String(r.pass).padStart(3)}  ${String(r.failed).padStart(3)}  ${String(r.missing).padStart(5)}`);
}
console.log('─'.repeat(w + 30));
console.log(`${'TOTAL'.padEnd(w)}  ${''.padEnd(9)} ${String(tp).padStart(3)}  ${String(tf).padStart(3)}  ${String(tm).padStart(5)}`);

fs.writeFileSync(path.join(ROOT, 'reports/_summary.json'), JSON.stringify({ rows, total: { pass: tp, failed: tf, missing: tm } }, null, 1));
process.exit(tf ? 1 : 0);
