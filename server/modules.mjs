import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const META = path.join(ROOT, 'snapshots', '_project.json');

if (!fs.existsSync(META)) {
  console.error('Нет snapshots/_project.json — сделай «Экспорт всего проекта» в плагине.');
  process.exit(2);
}

const { fileName, pages, modules } = JSON.parse(fs.readFileSync(META, 'utf8'));
const onlyShared = process.argv.includes('--shared');
const list = onlyShared ? modules.filter((m) => m.shared) : modules;

console.log(`Проект «${fileName}»: ${pages.length} страниц, ${modules.length} модулей, ${modules.filter((m) => m.shared).length} сквозных\n`);

for (const m of list) {
  const mark = m.shared ? '⇄' : ' ';
  console.log(`${mark} ${m.name}`);
  console.log(`    инстансов: ${m.instances} · размеры: ${m.sizes.slice(0, 4).join(', ')}${m.sizes.length > 4 ? '…' : ''}`);
  console.log(`    страницы: ${m.pages.join(', ')}`);
}

if (onlyShared && !list.length) console.log('Сквозных модулей не найдено.');
