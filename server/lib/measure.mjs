import { DOM_PROPS } from './compare.mjs';
import { effectivePadding } from './inset.mjs';

/** One headless browser per process, one page per url+viewport — measuring
 *  several selectors on the same page must not reload it every time. */
let browser = null;
const pages = new Map();

async function getPage(url, width) {
  const key = `${width}|${url}`;
  if (pages.has(key)) return pages.get(key);
  if (!browser) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
  }
  const ctx = await browser.newContext({
    viewport: { width, height: 1000 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36 pixel-guard',
  });
  const pg = await ctx.newPage();
  const resp = await pg.goto(url, { waitUntil: 'load', timeout: 60000 });
  if (resp && !resp.ok()) { await ctx.close(); throw new Error(`HTTP ${resp.status()} for ${url}`); }
  await pg.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}' });
  await pg.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 800) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
    scrollTo(0, 0);
  });
  await pg.waitForTimeout(300);
  pages.set(key, pg);
  return pg;
}

const EXTRA = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'opacity', 'box-shadow', 'border-top-style', 'position', 'width', 'height', 'max-width'];

/** Live measurement of every element matching the selector. */
export async function measure(url, width, selector, props) {
  const pg = await getPage(url, width);
  const want = props?.length ? props : [...DOM_PROPS, ...EXTRA];
  return pg.evaluate(([sel, list, insetSrc]) => {
    const inset = new Function(`return ${insetSrc}`)();
    const els = [...document.querySelectorAll(sel)];
    const r1 = (v) => Math.round(v * 10) / 10;
    return els.slice(0, 40).map((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const hidden = cs.display === 'none' || cs.visibility === 'hidden' || (r.width === 0 && r.height === 0);
      const styles = {};
      for (const p of list) styles[p] = cs.getPropertyValue(p);
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const pcs = el.parentElement ? getComputedStyle(el.parentElement) : null;
      const parentGap = pcs && (pcs.display === 'flex' || pcs.display === 'grid') ? { rowGap: pcs.rowGap, columnGap: pcs.columnGap, display: pcs.display } : null;
      return {
        rect: { x: r1(r.left + scrollX), y: r1(r.top + scrollY), width: r1(r.width), height: r1(r.height) },
        styles, inset: inset(el), text, tag: el.tagName.toLowerCase(), children: el.children.length, hidden, parentGap,
      };
    });
  }, [selector, want, effectivePadding.toString()]);
}

export async function closeBrowser() {
  for (const pg of pages.values()) await pg.context().close().catch(() => {});
  pages.clear();
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}
