/**
 * Effective padding of an element: the distance from its edges to the content.
 * Figma keeps padding on the section frame; a site usually puts it on a nested
 * centered .container (or the container's own padding). Walk the single-child
 * wrapper chain and accumulate the inset — that is what the design measures.
 * Runs inside the page (extension content script or page.evaluate).
 */
export function effectivePadding(el) {
  const pf = (v) => parseFloat(v) || 0;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  let pad = { top: pf(cs.paddingTop), right: pf(cs.paddingRight), bottom: pf(cs.paddingBottom), left: pf(cs.paddingLeft) };
  let cur = el;
  for (let hops = 0; hops < 4; hops++) {
    const kids = [...cur.children].filter((c) => {
      const d = getComputedStyle(c);
      return d.display !== 'none' && d.position !== 'absolute' && d.position !== 'fixed';
    });
    if (kids.length !== 1) break;
    const k = kids[0];
    const kr = k.getBoundingClientRect();
    if (kr.width < 1 || kr.height < 1) break;
    const kc = getComputedStyle(k);
    pad = {
      top: kr.top - r.top + pf(kc.paddingTop),
      right: r.right - kr.right + pf(kc.paddingRight),
      bottom: r.bottom - kr.bottom + pf(kc.paddingBottom),
      left: kr.left - r.left + pf(kc.paddingLeft),
    };
    cur = k;
  }
  const round = (v) => Math.round(v * 10) / 10;
  return { top: round(pad.top), right: round(pad.right), bottom: round(pad.bottom), left: round(pad.left) };
}
