// Overlay screenshots without a human at the browser: loads the real extension into
// Playwright, asks the running server for the page's overlay (same /overlay the panel
// uses) and shoots the page with the design laid on top, slice by slice.
// npm run overlay -- --page home --viewport tablet [--mode split|diff|outline|render] [--opacity 0.5] [--chunk 1400] [--only-shot]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = (process.argv[i + 1] ?? '--').startsWith('--') ? true : process.argv[++i];
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const pages = readJson(path.join(ROOT, 'config/pages.json'));
const viewports = readJson(path.join(ROOT, 'config/viewports.json'));
const page = args.page ?? 'home';
const viewport = args.viewport ?? 'desktop';
const cfg = pages[page];
if (!cfg) { console.error(`No page "${page}"`); process.exit(2); }
const width = Number(viewports[viewport] ?? viewport);
const mode = args.mode ?? 'split';
const chunk = Number(args.chunk ?? 1400);
const SERVER = process.env.PG_SERVER ?? 'http://127.0.0.1:8971';
const url = args.url ?? cfg.url;

const ovRes = await fetch(`${SERVER}/overlay?url=${encodeURIComponent(url)}&viewport=${viewport}&page=${encodeURIComponent(page)}`);
const data = await ovRes.json();
if (!ovRes.ok || data.ok === false) { console.error('overlay:', data.error ?? ovRes.status); process.exit(1); }

const auth = process.env.PG_HTTP_AUTH;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-overlay-'));
const ext = path.join(ROOT, 'extension');
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width, height: 1000 },
  ...(auth ? { httpCredentials: { username: auth.split(':')[0], password: auth.split(':').slice(1).join(':') } } : {}),
});
try {
  let sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const pg = ctx.pages()[0] ?? await ctx.newPage();
  await pg.goto(url, { waitUntil: 'load', timeout: 90000 });
  await pg.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}' });
  await pg.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 700) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); } scrollTo(0, 0); });
  await pg.waitForTimeout(800);

  const opts = {
    opacity: Number(args.opacity ?? (mode === 'split' ? 1 : 0.5)), mode: mode === 'split' ? 'render' : mode,
    diff: mode === 'diff', offsetX: 0, offsetY: 0, showUnanchored: false, autoScale: true, solo: false,
    split: mode === 'split' ? Number(args.split ?? 50) : null,
  };
  const reply = await sw.evaluate(async ({ url, data, opts }) => {
    const [tab] = await chrome.tabs.query({ url: url.replace(/#.*$/, '') + '*' });
    const t = tab ?? (await chrome.tabs.query({ active: true }))[0];
    return chrome.tabs.sendMessage(t.id, { type: 'pg-overlay-show', data, opts }, { frameId: 0 });
  }, { url, data, opts });
  if (reply && reply.ok === false) console.warn('overlay reply:', reply);
  await pg.waitForTimeout(1500);

  const outDir = path.join(ROOT, 'reports', 'overlay');
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (f.startsWith(`${page}-${viewport}-${mode}-`)) fs.unlinkSync(path.join(outDir, f));
  const H = await pg.evaluate(() => document.documentElement.scrollHeight);
  const from = Number(args.from ?? 0), to = Math.min(H, Number(args.to ?? H));
  for (let y = from, n = 1; y < to; y += chunk, n++) {
    const h = Math.min(chunk, to - y);
    await pg.setViewportSize({ width, height: h });
    await pg.evaluate((y) => scrollTo(0, y), y);
    await pg.waitForTimeout(500);
    const file = path.join(outDir, `${page}-${viewport}-${mode}-${String(n).padStart(2, '0')}.png`);
    await pg.screenshot({ path: file });
    console.log(`${path.relative(ROOT, file)}  y ${y}–${y + h}`);
  }
  console.log(`${data.boxes?.length ?? data.nodes?.length ?? '?'} overlay boxes · page ${H}px`);
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
