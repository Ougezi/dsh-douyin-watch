/**
 * Overlay forensics: find the login dialog, print its ancestor chain (tag, class,
 * position, size, z-index), run the dismissal script, then report what happened.
 */
import { Browser, findBrowser } from '../lib/cdp.js'
import * as store from '../lib/store.js'
import { FEED_URL, PROBE_SCRIPT, DISMISS_OVERLAY_SCRIPT } from '../lib/feed.js'

const dir = store.ensureDirs()
const exe = findBrowser('')
const b = await Browser.launch({ executable: exe, userDataDir: `${dir}/profile` })
const page = await b.newPage('about:blank')
await page.enable()
await page.navigate(FEED_URL, { timeoutMs: 30000 })

for (let i = 0; i < 20; i++) {
  const p = await page.evaluate("document.querySelectorAll('[class*=\"waterfall-videoCardContainer\"]').length")
  if (p > 0) break
  await new Promise((r) => setTimeout(r, 500))
}
await new Promise((r) => setTimeout(r, 1500))

console.log('probe:', JSON.stringify(await page.evaluate(PROBE_SCRIPT), null, 2))

const chain = await page.evaluate(`(() => {
  const holders = [...document.querySelectorAll('div,section,aside')]
    .filter(el => (el.innerText || '').includes('扫码登录') && el.getBoundingClientRect().width > 100);
  if (!holders.length) return { found: false, count: 0 };
  const m = holders.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
  const out = [];
  let cur = m;
  for (let i = 0; i < 10 && cur; i++) {
    const s = getComputedStyle(cur);
    const r = cur.getBoundingClientRect();
    out.push({
      tag: cur.tagName,
      cls: (cur.className || '').toString().slice(0, 70),
      pos: s.position, z: s.zIndex, display: s.display,
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.x), y: Math.round(r.y)
    });
    cur = cur.parentElement;
  }
  return { found: true, count: holders.length, chain: out };
})()`)
console.log('chain:', JSON.stringify(chain, null, 2))

const dismiss = await page.evaluate(DISMISS_OVERLAY_SCRIPT)
console.log('dismiss result:', JSON.stringify(dismiss))

await new Promise((r) => setTimeout(r, 800))
console.log('probe after dismiss:', JSON.stringify(await page.evaluate(PROBE_SCRIPT), null, 2))

await page.screenshot().then((png) => import('node:fs').then((fs) => fs.writeFileSync(`${dir}/overlay-before.png`, png)))
console.log('full screenshot written')

await page.close()
await b.dispose()
