import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const META = path.join(ROOT, 'snapshots', '_project.json');

if (!fs.existsSync(META)) {
  console.error('No snapshots/_project.json — run "Export whole project" in the plugin.');
  process.exit(2);
}

const { fileName, pages, modules } = JSON.parse(fs.readFileSync(META, 'utf8'));
const onlyShared = process.argv.includes('--shared');
const list = onlyShared ? modules.filter((m) => m.shared) : modules;

console.log(`Project "${fileName}": ${pages.length} pages, ${modules.length} modules, ${modules.filter((m) => m.shared).length} shared\n`);

for (const m of list) {
  const mark = m.shared ? '⇄' : ' ';
  console.log(`${mark} ${m.name}`);
  console.log(`    instances: ${m.instances} · sizes: ${m.sizes.slice(0, 4).join(', ')}${m.sizes.length > 4 ? '…' : ''}`);
  console.log(`    pages: ${m.pages.join(', ')}`);
}

if (onlyShared && !list.length) console.log('No shared modules found.');
