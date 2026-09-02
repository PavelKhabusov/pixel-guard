/**
 * Steps that bring AJAX content into the DOM before a measurement: open a tab,
 * a modal, hover a menu. Declared per page (config/pages.json → prepare[]) or
 * per map entry (maps/<page>.map.json → "prepare": [...]).
 *
 *   { "click": "#pills-otzyvy-tab" }
 *   { "hover": ".menu-item" }
 *   { "waitFor": ".pr-trev" }            // visible; "state": "attached" | "hidden" optional
 *   { "scrollTo": ".pr-faq" }
 *   { "fill": "input[name=qty]", "value": "120" }
 *   { "wait": 500 }                       // ms
 *   { "eval": "document.body.classList.add('x')" }
 */
export async function runPrepare(pg, steps, { log = () => {} } = {}) {
  if (!Array.isArray(steps) || !steps.length) return;
  // the same steps on the same page are executed once (a tab does not need re-clicking)
  const done = pg.__pgPrepared ??= new Set();
  const key = JSON.stringify(steps);
  if (done.has(key)) return;
  for (const s of steps) {
    const t = s.timeout ?? 8000;
    try {
      if (s.click) await pg.locator(s.click).first().click({ timeout: t });
      else if (s.hover) await pg.locator(s.hover).first().hover({ timeout: t });
      else if (s.waitFor) await pg.locator(s.waitFor).first().waitFor({ state: s.state ?? 'visible', timeout: t });
      else if (s.scrollTo) await pg.locator(s.scrollTo).first().scrollIntoViewIfNeeded({ timeout: t });
      else if (s.fill) await pg.locator(s.fill).first().fill(String(s.value ?? ''), { timeout: t });
      else if (s.wait) await pg.waitForTimeout(Number(s.wait));
      else if (s.eval) await pg.evaluate(s.eval);
      else throw new Error(`unknown step ${JSON.stringify(s)}`);
      log(`prepare ✓ ${describe(s)}`);
    } catch (e) {
      log(`prepare ✗ ${describe(s)}: ${e.message.split('\n')[0]}`);
      if (!s.optional) throw new Error(`prepare step failed: ${describe(s)} — ${e.message.split('\n')[0]}`);
    }
  }
  await pg.waitForTimeout(steps.some((s) => s.click || s.hover || s.fill) ? 400 : 0);
  done.add(key);
}

const describe = (s) => Object.entries(s).filter(([k]) => k !== 'timeout' && k !== 'optional').map(([k, v]) => `${k}=${v}`).join(' ');
