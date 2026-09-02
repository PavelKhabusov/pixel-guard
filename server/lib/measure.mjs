import { DOM_PROPS } from './compare.mjs';
import { effectivePadding } from './inset.mjs';
import { runPrepare } from './prepare.mjs';

/** One headless browser per process, one page per url+viewport — measuring
 *  several selectors on the same page must not reload it every time. */
let browser = null;
const pages = new Map();

const PAGE_TTL = 60000;

async function getPage(url, width, fresh = false, ready = null) {
  const key = `${width}|${url}`;
  const c = pages.get(key);
  if (c && !fresh && Date.now() - c.at < PAGE_TTL) return c.pg;
  if (c) { await c.pg.context().close().catch(() => {}); pages.delete(key); }
  if (!browser) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
  }
  const ctx = await browser.newContext({
    viewport: { width, height: 1000 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36 pixel-guard',
  });
  const pg = await ctx.newPage();
  // no HTTP cache: a first load that raced its stylesheets must not be served again
  const cdp = await ctx.newCDPSession(pg);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
  const resp = await pg.goto(url, { waitUntil: 'load', timeout: 60000 });
  if (resp && !resp.ok()) { await ctx.close(); throw new Error(`HTTP ${resp.status()} for ${url}`); }
  await pg.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  if (ready) await pg.locator(ready).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  await pg.evaluate(() => document.fonts?.ready).catch(() => {});
  await pg.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}' });
  await pg.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 800) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
    scrollTo(0, 0);
  });
  await pg.waitForTimeout(300);
  pages.set(key, { pg, at: Date.now() });
  return pg;
}

const EXTRA = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'opacity', 'box-shadow', 'border-top-style', 'position', 'width', 'height', 'max-width'];

/** Live measurement of every element matching the selector.
 *  sources: for each returned property, the rule that WON the cascade —
 *  selector, stylesheet file and the declared value (DevTools "Styles" in one call). */
export async function measure(url, width, selector, props, { fresh = false, sources = false, prepare = null, ready = null } = {}) {
  const pg = await getPage(url, width, fresh, ready);
  if (prepare) await runPrepare(pg, prepare);
  const want = props?.length ? props : [...DOM_PROPS, ...EXTRA];
  return pg.evaluate(([sel, list, insetSrc, wantSources]) => {
    const inset = new Function(`return ${insetSrc}`)();

    // who wins each property: walk every same-origin rule that matches the
    // element, rank by !important > specificity > order; inline style beats all
    const specificity = (s) => {
      let a = 0, b = 0, c = 0;
      const rest = s.replace(/#[\w-]+/g, () => (a++, ''))
        .replace(/\.[\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, (m) => (m.startsWith('::') ? c++ : b++, ''))
        .replace(/[>+~*,\s]/g, ' ');
      rest.split(' ').forEach((t) => { if (/^[a-z][\w-]*$/i.test(t)) c++; });
      return a * 1e6 + b * 1e3 + c;
    };
    const rulesFor = (el) => {
      const hits = [];
      let order = 0;
      const visit = (rules, file) => {
        for (const r of rules) {
          try {
            if (r.cssRules && (r.type === 4 || r.type === 12)) { // @media / @supports
              if (r.type !== 4 || matchMedia(r.conditionText).matches) visit(r.cssRules, file);
              continue;
            }
            if (!r.selectorText || !r.style) continue;
            for (const one of r.selectorText.split(',')) {
              const t = one.trim();
              try { if (el.matches(t)) { hits.push({ sel: t, spec: specificity(t), order: order++, style: r.style, file }); break; } } catch {}
            }
          } catch {}
        }
      };
      for (const sh of document.styleSheets) {
        const file = (sh.href ? sh.href.replace(location.origin, '') : 'inline <style>');
        try { visit(sh.cssRules, file); } catch { /* cross-origin sheet */ }
      }
      return hits;
    };
    const sourceMap = (el, propsList) => {
      const hits = rulesFor(el);
      const out = {};
      for (const prop of propsList) {
        let best = null;
        for (const h of hits) {
          const v = h.style.getPropertyValue(prop);
          if (!v) continue;
          const imp = h.style.getPropertyPriority(prop) === 'important' ? 1 : 0;
          const rank = [imp, h.spec, h.order];
          if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && (rank[1] > best.rank[1] || (rank[1] === best.rank[1] && rank[2] > best.rank[2]))))
            best = { rank, sel: h.sel, file: h.file, value: v + (imp ? ' !important' : '') };
        }
        const inline = el.style.getPropertyValue(prop);
        if (inline && (!best || best.rank[0] === 0 || el.style.getPropertyPriority(prop) === 'important'))
          best = { sel: 'style=""', file: 'inline', value: inline };
        if (best) out[prop] = `${best.value}  ←  ${best.sel}  (${best.file})`;
      }
      return out;
    };
    const els = [...document.querySelectorAll(sel)];
    const r1 = (v) => Math.round(v * 10) / 10;
    return els.slice(0, 40).map((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const hidden = cs.display === 'none' || cs.visibility === 'hidden' || (r.width === 0 && r.height === 0);
      const styles = {};
      for (const p of list) styles[p] = cs.getPropertyValue(p);
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').trim().replace(/\s+/g, ' ').slice(0, 80);
      const pcs = el.parentElement ? getComputedStyle(el.parentElement) : null;
      const parentGap = pcs && (pcs.display === 'flex' || pcs.display === 'grid') ? { rowGap: pcs.rowGap, columnGap: pcs.columnGap, display: pcs.display } : null;
      return {
        rect: { x: r1(r.left + scrollX), y: r1(r.top + scrollY), width: r1(r.width), height: r1(r.height) },
        styles, inset: inset(el), text, ownText, tag: el.tagName.toLowerCase(), children: el.children.length, hidden, parentGap,
        ...(wantSources ? { sources: sourceMap(el, list) } : {}),
      };
    });
  }, [selector, want, effectivePadding.toString(), sources]);
}

export async function closeBrowser() {
  for (const { pg } of pages.values()) await pg.context().close().catch(() => {});
  pages.clear();
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}
