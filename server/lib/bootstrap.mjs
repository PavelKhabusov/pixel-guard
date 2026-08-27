import fs from 'node:fs';
import path from 'node:path';

const PAIRS = [
  ['config/pages.example.json', 'config/pages.json'],
  ['maps/home.example.map.json', 'maps/home.map.json'],
];

export function ensureLocalConfigs(root) {
  for (const [src, dst] of PAIRS) {
    const to = path.join(root, dst);
    if (fs.existsSync(to)) continue;
    const from = path.join(root, src);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    console.log(`pixel-guard: created ${dst} from ${path.basename(src)} — fill it in for your project`);
  }
}
