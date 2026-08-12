import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveFrames } from './lib/save.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SNAP = path.join(ROOT, 'snapshots');

const file = process.argv[2];
if (!file) {
  console.error('Использование: npm run import -- <файл.pg.json>');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`Файл не найден: ${file}`);
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const frames = Array.isArray(data) ? data : data.frames ?? [data];
if (!frames.length || !frames[0]?.frameName) {
  console.error('Не похоже на снапшот pixel-guard: нет frames[].frameName');
  process.exit(2);
}

const saved = saveFrames(frames, SNAP);
console.log(`\nГотово: ${saved.join(', ')}`);
