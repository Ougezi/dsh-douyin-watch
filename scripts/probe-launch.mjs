/**
 * Isolate the launcher: launch -> use -> dispose -> launch again.
 * Catches the "second browser won't start" class of bug without the tool layer.
 */
import { Browser, findBrowser } from '../lib/cdp.js'
import * as store from '../lib/store.js'

const dir = store.ensureDirs()
const exe = findBrowser('')
console.log('browser:', exe)

async function cycle(n) {
  const t = Date.now()
  const b = await Browser.launch({ executable: exe, userDataDir: `${dir}/profile` })
  console.log(`[${n}] launched pid=${b.child.pid} port=${b.port} in ${Date.now() - t}ms`)
  const page = await b.newPage('about:blank')
  await page.enable()
  await page.navigate('https://www.douyin.com/?recommend=1', { timeoutMs: 30000 })
  const probe = await page.evaluate("({url: location.href, cards: document.querySelectorAll('[class*=\"waterfall-videoCardContainer\"]').length})")
  console.log(`[${n}] probe:`, JSON.stringify(probe))
  await page.close()
  console.log(`[${n}] page closed; chrome alive=${b.child.exitCode === null}`)
  await new Promise((r) => setTimeout(r, 800))
  console.log(`[${n}] after 800ms chrome alive=${b.child.exitCode === null}`)
  await b.dispose()
  console.log(`[${n}] disposed; exitCode=${b.child.exitCode}`)
  await new Promise((r) => setTimeout(r, 500))
}

await cycle(1)
await cycle(2)
await cycle(3)
console.log('OK: three consecutive launches')
