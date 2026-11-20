/**
 * Spike: the comment panel, now that an account is signed in.
 *
 * Read-only: opens a video, opens the comment panel, dumps structure. It never
 * clicks send/like/collect.
 *
 * Requires the real profile (holds the login) and no other tool holding that
 * browser:   DSH_HOME=D:\dsh node scripts/spike-comments.mjs
 */
import fs from 'node:fs'
import { Browser, findBrowser } from '../lib/cdp.js'
import { FEED_URL, DISMISS_OVERLAY_SCRIPT } from '../lib/adapters/douyin/feed.js'
import { DISMISS_COACH_SCRIPT, openCardScript, waitForVideo } from '../lib/adapters/douyin/player.js'
import { dataDir } from '../lib/store.js'
import { loginState } from '../lib/session.js'

const exe = findBrowser('')
const profile = `${dataDir()}/profile-chrome`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const b = await Browser.launch({ executable: exe, userDataDir: profile })
const page = await b.newPage('about:blank')
await page.enable()

const PROBE = `(() => {
  const text = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  const commentish = [...document.querySelectorAll('div,span,button,li')]
    .filter(el => /^(评论|\\d+\\s*条评论)$/.test((el.innerText || '').trim()))
    .slice(0, 5)
    .map(el => ({ tag: el.tagName, text: (el.innerText || '').trim().slice(0, 20), cls: (el.className || '').toString().slice(0, 60) }));
  const cls = [...new Set([...document.querySelectorAll('[class]')]
    .map(el => (el.className || '').toString())
    .flatMap(s => s.split(/\\s+/))
    .filter(s => /comment|reply|danmaku/i.test(s)))].slice(0, 30);
  return {
    url: location.href,
    chars: text.length,
    commentish,
    classHints: cls,
    commentNodes: document.querySelectorAll('[class*="comment" i]').length,
    textareas: document.querySelectorAll('textarea, [contenteditable="true"]').length,
    bodyTail: text.slice(-260)
  };
})()`

try {
  await page.navigate(FEED_URL, { timeoutMs: 30000 })
  for (let i = 0; i < 30; i++) {
    const n = await page.evaluate(`document.querySelectorAll('[class*="waterfall-videoCardContainer"]').length`)
    if (n > 0) break
    await sleep(500)
  }
  await page.evaluate(DISMISS_OVERLAY_SCRIPT)
  console.log('login:', JSON.stringify(await loginState(page)))

  await page.evaluate(openCardScript(0))
  const state = await waitForVideo(page, { timeoutMs: 12000 })
  await page.evaluate(DISMISS_COACH_SCRIPT)
  await sleep(600)
  console.log('modal:', JSON.stringify({ modalOpen: Boolean(state?.modalOpen), videoCount: state?.videoCount }))
  console.log('before:', JSON.stringify(await page.evaluate(PROBE), null, 2))

  // Find the comment entry point. Try, in order: aria/title, an "N 条评论" label,
  // and finally the numeric counter that sits beside the comment icon.
  const clicked = await page.evaluate(`(() => {
    const byAria = document.querySelector('[aria-label*="评论" i], [title*="评论" i], [data-e2e*="comment" i]');
    if (byAria) { try { byAria.click(); return { via: 'aria' }; } catch {} }
    const label = [...document.querySelectorAll('div,span,button')]
      .filter(el => /^\\d+\\s*条评论$/.test((el.innerText || '').trim()))[0];
    if (label) { try { label.click(); return { via: 'label' }; } catch {} }
    const icons = [...document.querySelectorAll('[class*="comment" i]')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 8 && r.height > 8;
    });
    if (icons[0]) { try { icons[0].click(); return { via: 'class', cls: (icons[0].className || '').toString().slice(0,60) }; } catch {} }
    return { via: 'none' };
  })()`)
  console.log('clickedComment:', JSON.stringify(clicked))
  await sleep(3000)
  console.log('after:', JSON.stringify(await page.evaluate(PROBE), null, 2))

  const dump = await page.evaluate(`(() => {
    const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
    const i = text.search(/条评论|全部评论|留下你的精彩评论/);
    return { around: i >= 0 ? text.slice(Math.max(0, i - 80), i + 520) : null, chars: text.length };
  })()`)
  console.log('text:', JSON.stringify(dump, null, 2))
} finally {
  await page.close()
  await b.dispose()
}
