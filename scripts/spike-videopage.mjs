/**
 * Spike: does the standalone video page (`/video/<id>`) expose comments, and in
 * what shape? Read-only.
 *
 *   DSH_HOME=D:\dsh node scripts/spike-videopage.mjs [modalId]
 */
import fs from 'node:fs'
import { Browser, findBrowser } from '../lib/cdp.js'
import { dataDir } from '../lib/store.js'
import { loginState } from '../lib/session.js'

const modalId = process.argv[2] ?? '7706790998765428730'
const exe = findBrowser('')
const profile = `${dataDir()}/profile-chrome`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const b = await Browser.launch({ executable: exe, userDataDir: profile })
const page = await b.newPage('about:blank')
await page.enable()

const PROBE = `(() => {
  const text = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  const idx = text.search(/条评论|全部评论|留下你的精彩评论|暂无评论/);
  const numeric = [...document.querySelectorAll('div,span')]
    .filter(el => /^\\d+(?:\\.\\d+)?[万亿]?$/.test((el.innerText || '').trim()))
    .slice(0, 12)
    .map(el => {
      const r = el.getBoundingClientRect();
      return { t: (el.innerText || '').trim(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
    });
  return {
    url: location.href,
    chars: text.length,
    hasCommentWords: /条评论|全部评论|留下你的精彩评论|暂无评论/.test(text),
    around: idx >= 0 ? text.slice(Math.max(0, idx - 60), idx + 400) : null,
    textareas: document.querySelectorAll('textarea, [contenteditable="true"]').length,
    numeric,
    tail: text.slice(-300)
  };
})()`

try {
  const url = `https://www.douyin.com/video/${modalId}`
  await page.navigate(url, { timeoutMs: 30000 })
  await sleep(3500)
  console.log('login:', JSON.stringify(await loginState(page)))
  console.log('first:', JSON.stringify(await page.evaluate(PROBE), null, 2))

  // Comments usually live further down; scroll a few times and re-probe.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(`window.scrollBy(0, 900)`)
    await sleep(900)
  }
  console.log('afterScroll:', JSON.stringify(await page.evaluate(PROBE), null, 2))
} finally {
  await page.close()
  await b.dispose()
}
