/**
 * Spike: what do *logged-in* search results look like?
 *
 * Must run against the real profile (it holds the login), so run it only while no
 * other tool has that browser open:
 *   DSH_HOME=D:\dsh node scripts/spike-search.mjs
 */
import fs from 'node:fs'
import { Browser, findBrowser } from '../lib/cdp.js'
import { dataDir } from '../lib/store.js'
import { loginState } from '../lib/session.js'

const exe = findBrowser('')
const profile = `${dataDir()}/profile-chrome`
console.log('exe:', exe)
console.log('profile:', profile, fs.existsSync(profile) ? '(exists)' : '(MISSING)')

const b = await Browser.launch({ executable: exe, userDataDir: profile })
const page = await b.newPage('about:blank')
await page.enable()

try {
  await page.navigate('https://www.douyin.com/search/%E7%BE%8E%E9%A3%9F', { timeoutMs: 30000 })
  await new Promise((r) => setTimeout(r, 3500))
  console.log('login:', JSON.stringify(await loginState(page)))

  const info = await page.evaluate(`(() => {
    const text = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
    const anchors = [...document.querySelectorAll('a[href*="/video/"]')];
    const dur = [...document.querySelectorAll('div,li,article,section')]
      .filter(el => /^\\d{1,2}:\\d{2}\\s/.test((el.innerText || '').replace(/\\s+/g, ' ').trim()))
      .map(el => (el.innerText || '').replace(/\\s+/g, ' ').trim())
      .filter(t => t.length > 12 && t.length < 400);
    const cls = [...new Set([...document.querySelectorAll('[class]')]
      .map(el => (el.className || '').toString())
      .flatMap(s => s.split(/\\s+/))
      .filter(s => /card|search|result|video|item/i.test(s)))].slice(0, 40);
    return {
      url: location.href,
      title: document.title,
      chars: text.length,
      anchors: anchors.length,
      anchorSample: anchors.slice(0, 3).map(a => ({ href: a.getAttribute('href'), t: (a.innerText || '').replace(/\\s+/g, ' ').slice(0, 50) })),
      durLike: dur.length,
      durSample: dur.slice(0, 3),
      classHints: cls,
      liCount: document.querySelectorAll('li').length,
      bodyHead: text.slice(0, 300)
    };
  })()`)
  console.log(JSON.stringify(info, null, 2))
} finally {
  await page.close()
  await b.dispose()
}
