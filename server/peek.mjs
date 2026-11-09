// Quick live measurement: open a URL at a given width and print what a JS expression returns.
// npm run peek -- <url> <width> '<js expression>'   e.g. '[...document.querySelectorAll("h1")].map(e => e.getBoundingClientRect().width)'
import { chromium } from 'playwright';

const [url, width, js] = process.argv.slice(2);
if (!url || !width || !js) { console.error("usage: npm run peek -- <url> <width> '<js expression>'"); process.exit(2); }

const auth = process.env.PG_HTTP_AUTH;
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: Number(width), height: 900 },
  ...(auth ? { httpCredentials: { username: auth.split(':')[0], password: auth.split(':').slice(1).join(':') } } : {}),
});
const pg = await ctx.newPage();
await pg.goto(url, { waitUntil: 'load', timeout: 60000 });
await pg.waitForTimeout(800);
console.log(JSON.stringify(await pg.evaluate(js), null, 1));
await browser.close();
