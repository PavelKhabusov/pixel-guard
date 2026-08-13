import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandTree } from './lib/expand.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SNAP = path.join(ROOT, 'snapshots');

const files = fs.readdirSync(SNAP).filter((f) => f.endsWith('.json') && !f.startsWith('_'));

// 1) собираем библиотеку компонентов из вхождений, где дети сохранились
const lib = {};
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(SNAP, f), 'utf8'));
  const walk = (n) => {
    const ref = n.compDef ?? n.compRef;
    if (ref && n.children?.length && !lib[ref]) lib[ref] = { x: n.x, y: n.y, children: n.children };
    for (const c of n.children ?? []) walk(c);
  };
  if (d.tree) walk(d.tree);
}
console.log(`библиотека компонентов: ${Object.keys(lib).length}`);

// 2) разворачиваем пустые ссылки
let fixed = 0, stillEmpty = 0;
for (const f of files) {
  const p = path.join(SNAP, f);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!d.tree) continue;

  let touched = 0;
  const count = (n) => {
    if ((n.compRef ?? n.compDef) && !n.children?.length) touched++;
    for (const c of n.children ?? []) count(c);
  };
  count(d.tree);
  if (!touched) continue;

  d.tree = expandTree(d.tree, lib);

  let left = 0;
  const check = (n) => {
    if ((n.compRef ?? n.compDef) && !n.children?.length) left++;
    for (const c of n.children ?? []) check(c);
  };
  check(d.tree);

  fs.writeFileSync(p, JSON.stringify(d, null, 1));
  fixed += touched - left;
  stillEmpty += left;
  console.log(`  ${f}: развёрнуто ${touched - left}${left ? `, осталось пустых ${left}` : ''}`);
}

console.log(`\nразвёрнуто ${fixed} ссылок${stillEmpty ? `, без данных осталось ${stillEmpty} (нет в библиотеке)` : ''}`);
