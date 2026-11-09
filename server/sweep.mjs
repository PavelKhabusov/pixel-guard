// Adaptive sweep: one page across many widths (presets + every breakpoint ±1px)
// looking for layout breakage that per-node design checks miss: horizontal page
// scroll, elements sticking out of the viewport, clipped or spilling text.
// npm run sweep -- --page home [--widths 320,375,768] [--bp 576,768,992]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ensureLocalConfigs } from './lib/bootstrap.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
ensureLocalConfigs(ROOT);

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = (process.argv[i + 1] ?? '--').startsWith('--') ? true : process.argv[++i];
}
const pages = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/pages.json'), 'utf8'));
const list = args.page ? String(args.page).split(',') : Object.keys(pages).filter((p) => pages[p].url && !pages[p].prepare?.length);

const BP = (args.bp ? String(args.bp) : '364,386,576,768,912,930,992,1200,1280,1400,1440,1670').split(',').map(Number);
const widths = args.widths
  ? String(args.widths).split(',').map(Number)
  : [...new Set([320, 340, 357, 375, 390, 414, 480, 640, 820, 1024, 1100, 1366, 1536, 1920, ...BP.flatMap((b) => [b - 1, b, b + 1])])]
      .filter((w) => w >= 320 && w <= 1920).sort((a, b) => a - b);

const auth = process.env.PG_HTTP_AUTH;
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1000 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36 pixel-guard',
  ...(auth ? { httpCredentials: { username: auth.split(':')[0], password: auth.split(':').slice(1).join(':') } } : {}),
});

// runs in the page: returns issues for the current width
function probe() {
  const vw = document.documentElement.clientWidth;
  const out = [];
  const sel = (el) => {
    const parts = [];
    for (let e = el, d = 0; e && e.nodeType === 1 && d < 4; e = e.parentElement, d++) {
      let s = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(s + '#' + e.id); break; }
      const cls = [...e.classList].filter((c) => !/^(is-|active|show|swiper-slide-)/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const visible = (el, r) => r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  // nearest ancestor that clips horizontally (overflow-x != visible) — content inside is intentional
  const clipper = (el) => {
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const o = getComputedStyle(e).overflowX;
      if (o !== 'visible') return e;
    }
    return null;
  };
  const docW = document.documentElement.scrollWidth;
  if (docW > vw + 1) out.push({ type: 'page-scroll', sel: 'html', px: docW - vw });

  const all = document.body.querySelectorAll('*');
  for (const el of all) {
    if (el.closest('script,style,svg,noscript,iframe,.modal:not(.show),.dropdown-menu:not(.show),.visually-hidden,.sr-only,.screen-reader-text,[hidden],[aria-hidden="true"]')) continue;
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') continue;
    // sticks out of the viewport and nothing clips it
    if ((r.right > vw + 1 || r.left < -1) && !clipper(el)) {
      out.push({ type: 'out-of-viewport', sel: sel(el), px: Math.round(Math.max(r.right - vw, -r.left)) });
      continue;
    }
    // text clipped inside its own box (overflow hidden / ellipsis aside)
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 2);
    if (!hasText) continue;
    if (cs.overflowX !== 'visible' && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1) {
      out.push({ type: 'text-clipped', sel: sel(el), px: el.scrollWidth - el.clientWidth });
      continue;
    }
    // text wider than the element's parent box (spills over neighbours)
    const p = el.parentElement;
    if (p && cs.display !== 'inline') {
      const pr = p.getBoundingClientRect();
      const pcs = getComputedStyle(p);
      const pr0 = pr.right - parseFloat(pcs.borderRightWidth || 0);
      if (r.right > pr0 + 2 && pcs.overflowX === 'visible' && !['absolute', 'fixed'].includes(cs.position)) {
        out.push({ type: 'text-spills', sel: sel(el), px: Math.round(r.right - pr0) });
      }
    }
  }
  return out;
}

const report = {};
for (const page of list) {
  const cfg = pages[page];
  const pg = await ctx.newPage();
  try {
    await pg.goto(cfg.url, { waitUntil: 'load', timeout: 60000 });
  } catch (e) { console.log(`✗ ${page}: ${e.message.split('\n')[0]}`); await pg.close(); continue; }
  // wake lazy blocks once at full height
  await pg.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 800) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } window.scrollTo(0, 0); });
  const issues = {};
  for (const w of widths) {
    await pg.setViewportSize({ width: w, height: 900 });
    await pg.waitForTimeout(250);
    for (const it of await pg.evaluate(probe)) {
      const k = it.type + ' ' + it.sel;
      (issues[k] ??= { type: it.type, sel: it.sel, widths: [], maxPx: 0 }).widths.push(w);
      issues[k].maxPx = Math.max(issues[k].maxPx, it.px);
    }
  }
  await pg.close();
  // resizing a live page leaves transitions/JS state behind: re-check each hit on a page loaded fresh at that width
  const byWidth = {};
  for (const it of Object.values(issues)) (byWidth[it.widths[0]] ??= []).push(it);
  for (const [w, its] of Object.entries(byWidth)) {
    const fp = await ctx.newPage();
    await fp.setViewportSize({ width: +w, height: 900 });
    try {
      await fp.goto(cfg.url, { waitUntil: 'load', timeout: 60000 });
      await fp.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 800) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } window.scrollTo(0, 0); });
      await fp.waitForTimeout(400);
      const fresh = new Set((await fp.evaluate(probe)).map((x) => x.type + ' ' + x.sel));
      for (const it of its) it.confirmed = fresh.has(it.type + ' ' + it.sel);
    } catch { for (const it of its) it.confirmed = null; }
    await fp.close();
  }
  const rows = Object.values(issues).filter((r) => args.all || r.confirmed !== false)
    .sort((a, b) => a.type.localeCompare(b.type) || b.widths.length - a.widths.length);
  report[page] = { url: cfg.url, widths, issues: rows };
  const ranges = (ws) => ws.reduce((acc, w) => {
    const i = widths.indexOf(w), last = acc[acc.length - 1];
    if (last && widths.indexOf(last[1]) === i - 1) last[1] = w; else acc.push([w, w]);
    return acc;
  }, []).map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
  console.log(`\n${rows.length ? '✗' : '✓'} ${page} — ${rows.length} issue(s)`);
  for (const r of rows.slice(0, 40)) console.log(`   ${r.type.padEnd(16)} ${String(r.maxPx).padStart(4)}px  ${r.sel}   @ ${ranges(r.widths)}`);
}
await browser.close();
fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
const outPath = path.join(ROOT, 'reports', args.page ? `sweep-${String(args.page).replace(/,/g, '_')}.json` : 'sweep-all.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
console.log(`\n→ ${path.relative(ROOT, outPath)}`);
