const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export const CANDIDATE_JS = `(() => {
  const out = [];
  const ROOT = window.__pgRoot ? document.querySelector(window.__pgRoot) : null;
  const scope = ROOT ?? document;
  const prefix = window.__pgRoot ? window.__pgRoot + ' ' : '';
  const skip = /^(script|style|meta|link|head|br|noscript)$/i;
  const walk = (el, depth) => {
    if (depth > 22 || skip.test(el.tagName)) return;
    const r = el.getBoundingClientRect();
    if (r.width >= 8 && r.height >= 8) {
      const nice = (e) => {
        // React / CSS-modules / styled-components produce hashed classes that change
        // on every build — prefer stable hooks and drop the generated ones
        const hashed = (c) => /^(sc-|css-|jsx-|emotion-|chakra-|Mui[A-Z]\w*-root-\d|_[a-z0-9]{5,}$)/.test(c) || /__[A-Za-z0-9_-]{5,}$/.test(c) || /[a-z]-[a-z0-9]{6,}$/i.test(c) && /\d/.test(c) && /[a-z]/.test(c) && c.length > 12;
        const cls = [...e.classList].filter((c) => !/^(is-|js-|swiper-|wp-|has-|active|current)/.test(c) && !hashed(c));
        for (const a of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
          const v = e.getAttribute(a);
          if (v) return e.tagName.toLowerCase() + '[' + a + '="' + CSS.escape(v) + '"]';
        }
        const idOk = e.id && !/\d{3,}|^[a-z]+-[a-z0-9]{6,}$|^:r/.test(e.id);
        return e.tagName.toLowerCase() + (idOk ? '#' + CSS.escape(e.id) : '') + cls.slice(0, 3).map((c) => '.' + CSS.escape(c)).join('');
      };
      let sel = nice(el);
      if (scope.querySelectorAll(sel).length > 1) {
        for (let p = el.parentElement, hops = 0; p && p !== document.body && p !== ROOT && hops < 3; p = p.parentElement, hops++) {
          sel = nice(p) + ' ' + sel;
          if (scope.querySelectorAll(sel).length === 1) break;
        }
      }
      if (scope.querySelectorAll(sel).length > 1) {
        const sibs = [...el.parentElement.children].filter((s) => s.tagName === el.tagName);
        if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')';
      }
      const unique = scope.querySelectorAll(sel).length === 1;
      out.push({
        sel: prefix + sel,
        unique,
        tag: el.tagName.toLowerCase(),
        w: Math.round(r.width * 10) / 10,
        h: Math.round(r.height * 10) / 10,
        x: Math.round((r.left + scrollX) * 10) / 10,
        y: Math.round((r.top + scrollY) * 10) / 10,
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        own: [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 120),
        kids: el.children.length,
      });
    }
    for (const c of el.children) walk(c, depth + 1);
  };
  if (ROOT) { for (const c of ROOT.children) walk(c, 1); } else walk(document.body, 0);
  return out;
})()`;

export function collectFigmaNodes(root, { maxDepth = 6 } = {}) {
  const out = [];
  const baseY = root.y ?? 0;
  const walk = (n, depth, path, parentY) => {
    const p = path ? `${path}/${n.name}` : n.name;
    // child coordinates are relative to the parent — accumulate the absolute one
    const absY = depth === 0 ? (n.y ?? 0) : parentY + (n.y ?? 0);
    const small = (n.w ?? 0) < 60 && (n.h ?? 0) < 60;
    if (depth > 0 && (n.w ?? 0) >= 8 && (n.h ?? 0) >= 8 && n.type !== 'VECTOR' && !n.icon && !(small && n.type !== 'TEXT')) {
      // the text a container carries (a menu item frame with one label inside):
      // on the site that label is often a bare text node, so the container is
      // the element that has to be matched — by that text
      const texts = [];
      const grab = (m, d) => { if (m.type === 'TEXT' && m.text) texts.push(m.text); else if (d < 3) for (const c of m.children ?? []) grab(c, d + 1); };
      if (n.type !== 'TEXT') grab(n, 0);
      out.push({ ...n, path: p, depth, absY: absY - baseY, innerText: texts.length ? texts.join(' ') : null });
    }
    if (depth < maxDepth) for (const c of n.children ?? []) walk(c, depth + 1, p, depth === 0 ? 0 : absY);
  };
  walk(root, 0, '', 0);
  return out;
}

function scoreOne(fig, dom, rootW, domRootW, rootH, domRootH, rootY) {
  const scale = domRootW && rootW ? domRootW / rootW : 1;
  let score = 0;
  const why = [];

  if (fig.type === 'TEXT' && fig.text) {
    const a = norm(fig.text);
    const b = norm(dom.own) || norm(dom.text);
    if (a && b) {
      if (a === b) { score += 60; why.push('text exact'); }
      else if (b.startsWith(a) || a.startsWith(b)) { score += 40; why.push('text partial'); }
      else if (b.includes(a)) { score += 22; why.push('text inside'); }
    }
    if (dom.kids === 0) score += 6;
  } else if (fig.innerText) {
    const a = norm(fig.innerText);
    const b = norm(dom.text);
    if (a && b) {
      if (a === b) { score += 45; why.push('inner text exact'); }
      else if (b.includes(a) || a.includes(b)) { score += 15; why.push('inner text'); }
    }
  }

  const dw = Math.abs(dom.w - fig.w * scale);
  if (dw <= 1) { score += 30; why.push('width'); }
  else if (dw <= 4) { score += 20; why.push('width ±4'); }
  else if (dw <= 12) { score += 8; }
  else if (fig.w && dw / fig.w > 0.5) score -= 15;

  const dh = Math.abs(dom.h - fig.h);
  if (dh <= 2) { score += 18; why.push('height'); }
  else if (dh <= 8) { score += 10; }
  else if (fig.h && dh / fig.h > 0.6) score -= 8;

  if (fig.type === 'TEXT' && dom.kids > 2) score -= 12;
  if (fig.type !== 'TEXT' && fig.children?.length && dom.kids === 0) score -= 10;

  // Vertical position: a node from the design header cannot be a footer
  // element. Without this the matcher linked the header's "Get a visualization"
  // to a footer link by text alone.
  if (fig.absY != null && dom.y != null && rootH && domRootH) {
    const relFig = fig.absY / rootH;
    const relDom = dom.y / domRootH;
    const gap = Math.abs(relFig - relDom);
    if (gap < 0.05) score += 12;
    else if (gap > 0.35) score -= 30;
    else if (gap > 0.2) score -= 12;
  }
  if (fig.layout && dom.kids > 0) score += 4;
  if (dom.unique) score += 8; else score -= 20;
  if (fig.type !== 'TEXT' && !fig.innerText && !fig.name.match(/[a-z\u0430-\u044f]{3}/i)) score -= 14;

  return { score, why };
}

export function matchNodes(figNodes, domNodes, { rootW, domRootW, rootH, domRootH, rootY, min = 45 } = {}) {
  const used = new Set();
  const results = [];

  const ordered = [...figNodes].sort((a, b) => {
    const at = a.type === 'TEXT' ? 0 : 1;
    const bt = b.type === 'TEXT' ? 0 : 1;
    return at - bt || b.w * b.h - a.w * a.h;
  });

  for (const fig of ordered) {
    let best = null;
    for (const dom of domNodes) {
      if (used.has(dom.sel)) continue;
      const { score, why } = scoreOne(fig, dom, rootW, domRootW, rootH, domRootH, rootY);
      if (!best || score > best.score) best = { dom, score, why };
    }
    if (best && best.score >= min) {
      used.add(best.dom.sel);
      results.push({
        figmaId: fig.id, name: fig.name, path: fig.path, type: fig.type,
        selector: best.dom.sel, score: best.score, why: best.why,
        figSize: `${fig.w}x${fig.h}`, domSize: `${best.dom.w}x${best.dom.h}`,
      });
    } else {
      results.push({ figmaId: fig.id, name: fig.name, path: fig.path, type: fig.type, selector: null, score: best?.score ?? 0 });
    }
  }
  return results;
}
