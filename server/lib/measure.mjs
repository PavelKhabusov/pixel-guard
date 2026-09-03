import { DOM_PROPS } from './compare.mjs';
import { effectivePadding } from './inset.mjs';
import { runPrepare } from './prepare.mjs';

/** One headless browser per process, one page per url+viewport — measuring
 *  several selectors on the same page must not reload it every time. */
let browser = null;
const pages = new Map();

const PAGE_TTL = 60000;   // reuse a loaded page this long after its load
const MAX_PAGES = 4;      // more live pages = more renderer processes (~120 MB each)
const IDLE_SWEEP = 15000;

// Every cached page is a Chromium renderer that keeps its memory until the
// context is closed. Pages used to be closed only when the same url+width was
// requested again, so hours of measuring different pages piled up dozens of
// renderers (2.6 GB). Now: idle pages are swept, the count is capped, and the
// browser itself goes away once nothing is cached.
let sweeper = null;
async function closeEntry(key, c) {
  pages.delete(key);
  await c.pg.context().close().catch(() => {});
}
async function sweep() {
  const now = Date.now();
  for (const [k, c] of [...pages]) if (now - c.used > PAGE_TTL) await closeEntry(k, c);
  if (pages.size) return;
  if (sweeper) { clearInterval(sweeper); sweeper = null; }
  if (browser) { const b = browser; browser = null; await b.close().catch(() => {}); }
}
function armSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => sweep().catch(() => {}), IDLE_SWEEP);
  sweeper.unref?.();
}
async function evictOverflow() {
  while (pages.size > MAX_PAGES) {
    const [k, c] = [...pages].sort((a, b) => a[1].used - b[1].used)[0];
    await closeEntry(k, c);
  }
}

async function getPage(url, width, fresh = false, ready = null) {
  const key = `${width}|${url}`;
  const c = pages.get(key);
  if (c && !fresh && Date.now() - c.at < PAGE_TTL) { c.used = Date.now(); return c.pg; }
  if (c) await closeEntry(key, c);
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
  pages.set(key, { pg, at: Date.now(), used: Date.now() });
  await evictOverflow();
  armSweeper();
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
    const sourceMap = (el, propsList, all) => {
      const hits = rulesFor(el);
      const out = {};
      for (const prop of propsList) {
        const cands = [];
        for (const h of hits) {
          const v = h.style.getPropertyValue(prop);
          if (!v) continue;
          const imp = h.style.getPropertyPriority(prop) === 'important' ? 1 : 0;
          cands.push({ rank: [imp, h.spec, h.order], sel: h.sel, file: h.file, value: v + (imp ? ' !important' : '') });
        }
        const inline = el.style.getPropertyValue(prop);
        if (inline) cands.push({ rank: [el.style.getPropertyPriority(prop) === 'important' ? 2 : 0.5, 1e9, 1e9], sel: 'style=""', file: 'inline', value: inline });
        if (!cands.length) continue;
        cands.sort((a, b) => b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1] || b.rank[2] - a.rank[2]);
        const line = (c) => `${c.value}  ←  ${c.sel}  (${c.file})`;
        out[prop] = all ? cands.map((c, i) => (i ? '   ✗ ' : '   ✓ ') + line(c)).join('\n') : line(cands[0]);
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
        ...(wantSources ? { sources: sourceMap(el, list, wantSources === 'all') } : {}),
      };
    });
  }, [selector, want, effectivePadding.toString(), sources]);
}

/** "Click and tell": run the steps while recording XHR/fetch, console errors and
 *  what appeared / disappeared in the DOM. Finds the "click ✓, zero requests" bugs. */
export async function probe(url, width, steps, { fresh = true, ready = null } = {}) {
  const pg = await getPage(url, width, fresh, ready);
  const requests = [];
  const errors = [];
  const onReq = (rq) => { const t = rq.resourceType(); if (t === 'xhr' || t === 'fetch' || t === 'document') requests.push({ method: rq.method(), url: rq.url(), body: rq.postData()?.slice(0, 500) ?? null, type: t, status: null, ms: Date.now() }); };
  const onRes = (rs) => { const r = requests.find((x) => x.url === rs.url() && x.status === null); if (r) { r.status = rs.status(); r.ms = Date.now() - r.ms; } };
  const onReqFail = (rq) => { const r = requests.find((x) => x.url === rq.url() && x.status === null); if (r) { r.status = 'failed: ' + (rq.failure()?.errorText ?? '?'); } };
  const onConsole = (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text().slice(0, 300)}`); };
  const onPageError = (e) => errors.push(`uncaught: ${String(e.message ?? e).slice(0, 300)}`);
  pg.on('request', onReq); pg.on('response', onRes); pg.on('requestfailed', onReqFail); pg.on('console', onConsole); pg.on('pageerror', onPageError);
  await pg.evaluate(() => {
    const sig = (n) => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + [...n.classList].slice(0, 3).map((c) => '.' + c).join('');
    window.__pgMut = { added: new Map(), removed: new Map() };
    window.__pgObs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) if (n.nodeType === 1) { const k = sig(n); window.__pgMut.added.set(k, (window.__pgMut.added.get(k) ?? 0) + 1); }
        for (const n of m.removedNodes) if (n.nodeType === 1) { const k = sig(n); window.__pgMut.removed.set(k, (window.__pgMut.removed.get(k) ?? 0) + 1); }
      }
    });
    window.__pgObs.observe(document.documentElement, { childList: true, subtree: true });
  });
  const before = await pg.evaluate(() => ({ elements: document.getElementsByTagName('*').length, height: document.body.scrollHeight, url: location.href }));
  const stepLog = [];
  let stepError = null;
  try { await runPrepare(pg, steps, { log: (m) => stepLog.push(m) }); } catch (e) { stepError = e.message; }
  await pg.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await pg.waitForTimeout(300);
  const after = await pg.evaluate(() => {
    window.__pgObs?.disconnect();
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => (v > 1 ? `${k} ×${v}` : k));
    return { elements: document.getElementsByTagName('*').length, height: document.body.scrollHeight, url: location.href, added: top(window.__pgMut.added), removed: top(window.__pgMut.removed) };
  });
  pg.off('request', onReq); pg.off('response', onRes); pg.off('requestfailed', onReqFail); pg.off('console', onConsole); pg.off('pageerror', onPageError);
  return { stepLog, stepError, requests, errors, before, after };
}

/** Screenshot after the steps; freeze[] aborts requests matching these substrings
 *  (e.g. ["/wp-admin/admin-ajax.php"]) so a skeleton / loading state can be captured. */
export async function shot(url, width, { selector = null, steps = null, freeze = null, fullPage = false, fresh = false, ready = null } = {}) {
  const pg = await getPage(url, width, fresh || !!freeze, ready);
  let unroute = null;
  if (freeze?.length) {
    const handler = (route) => (freeze.some((f) => route.request().url().includes(f)) ? route.abort() : route.continue());
    await pg.route('**/*', handler);
    unroute = () => pg.unroute('**/*', handler);
  }
  try {
    if (steps) await runPrepare(pg, steps);
    await pg.waitForTimeout(200);
    if (selector) {
      const loc = pg.locator(selector).first();
      await loc.waitFor({ state: 'visible', timeout: 8000 });
      await loc.scrollIntoViewIfNeeded();
      const box = await loc.boundingBox();
      return { png: await loc.screenshot({ type: 'png' }), box };
    }
    return { png: await pg.screenshot({ type: 'png', fullPage }), box: null };
  } finally {
    if (unroute) await unroute();
  }
}

export async function closeBrowser() {
  if (sweeper) { clearInterval(sweeper); sweeper = null; }
  for (const [k, c] of [...pages]) await closeEntry(k, c);
  pages.clear();
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}
