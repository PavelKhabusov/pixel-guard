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
    return els.slice(0, 20).map((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const styles = {};
      for (const p of list) styles[p] = cs.getPropertyValue(p);
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
      return {
        rect: { x: Math.round((r.left + scrollX) * 10) / 10, y: Math.round((r.top + scrollY) * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 },
        styles, inset: inset(el), text, tag: el.tagName.toLowerCase(), children: el.children.length,
      };
    });
  }, [selector, want, effectivePadding.toString()]);
}

export async function closeBrowser() {
  for (const pg of pages.values()) await pg.context().close().catch(() => {});
  pages.clear();
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}
