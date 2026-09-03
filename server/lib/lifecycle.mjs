import { execSync } from 'node:child_process';

/** Playwright browsers outlive a killed node parent (SIGKILL, crash): each one is
 *  a chrome-headless-shell tree of ~120 MB per tab that nobody closes any more.
 *  On start, kill the ones whose parent is gone (reparented to PID 1). Only
 *  Playwright's own binaries (ms-playwright path) — never the user's Chrome. */
export function killOrphanBrowsers() {
  let out = '';
  try { out = execSync('ps -eo pid=,ppid=,args=', { encoding: 'utf8' }); } catch { return 0; }
  let n = 0;
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, args] = m;
    if (Number(ppid) !== 1 || !/ms-playwright|chrome-headless-shell/.test(args) || !/--headless|headless-shell/.test(args)) continue;
    try { process.kill(Number(pid), 'SIGKILL'); n++; } catch {}
  }
  if (n) process.stderr.write(`pixel-guard: killed ${n} orphan browser process(es)\n`);
  return n;
}

/** close(): async graceful shutdown (used on signals); killNow(): synchronous
 *  last resort for 'exit', where nothing async ever completes. */
export function installShutdown({ close, killNow }) {
  let closing = false;
  const bye = (sig) => {
    if (closing) return;
    closing = true;
    const t = setTimeout(() => { killNow?.(); process.exit(0); }, 3000);
    t.unref?.();
    Promise.resolve().then(() => close?.()).catch(() => {}).finally(() => { killNow?.(); process.exit(sig === 'SIGINT' ? 130 : 0); });
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => bye(sig));
  process.on('exit', () => { try { killNow?.(); } catch {} });
}
