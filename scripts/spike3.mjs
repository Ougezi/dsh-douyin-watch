/**
 * Spike-3: comments — can we read them, and do they need a login?
 *
 * Opens the first card, clears the coach mark, then looks for a comment panel by
 * shape (elements whose text says `…条评论`) instead of guessing class names.
 *
 *   node scripts/spike3.mjs [chrome|edge]
 */
import fs from 'node:fs'
import { Browser } from '../lib/cdp.js'
import { FEED_URL, DISMISS_OVERLAY_SCRIPT } from '../lib/adapters/douyin/feed.js'
import { DISMISS_COACH_SCRIPT, openCardScript, waitForVideo, closeModal } from '../lib/adapters/douyin/player.js'
import { ensureDirs } from '../lib/store.js'

const channel = process.argv[2] === 'chrome' ? 'chrome' : 'edge'
const exe = channel === 'edge'
  ? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p))
  : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const dir = ensureDirs()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { channel }

const PROBE = `(() => {
  const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
  const commentish = [...document.querySelectorAll('div,span,li')]
    .filter(el => /^\\s*\\d+\\s*(条评论|评论)\\s*$/.test((el.innerText || '').trim()))
    .slice(0, 5)
    .map(el => ({ tag: el.tagName, text: (el.innerText || '').trim().slice(0, 30) }));
  return {
    url: location.href,
    bodyChars: text.length,
    loginHints: ['登录后即可评论', '登录后可评论', '请先登录'].filter(t => text.includes(t)),
    commentCounters: commentish,
    commentNodes: document.querySelectorAll('[class*="comment" i]').length,
    hasTextarea: document.querySelectorAll('textarea, [contenteditable="true"]').length,
    sample: text.slice(0, 260)
  };
})()`

const browser = await Browser.launch({ executable: exe, userDataDir: `${dir}/profile-${channel}` })
const page = await browser.newPage('about:blank')
await page.enable()

try {
  await page.navigate(FEED_URL, { timeoutMs: 30000 })
  for (let i = 0; i < 30; i++) {
    const n = await page.evaluate(`document.querySelectorAll('[class*="waterfall-videoCardContainer"]').length`)
    if (n > 0) break
    await sleep(500)
  }
  await page.evaluate(DISMISS_OVERLAY_SCRIPT)
  out.beforeOpen = await page.evaluate(PROBE)

  await page.evaluate(openCardScript(0))
  const state = await waitForVideo(page, { timeoutMs: 12000 })
  out.modal = { modalOpen: Boolean(state?.modalOpen), videoCount: state?.videoCount, readyState: state?.readyState }
  await page.evaluate(DISMISS_COACH_SCRIPT)
  await sleep(600)
  out.afterOpen = await page.evaluate(PROBE)

  // Try to open the comment panel: the comment counter is usually clickable.
  const clicked = await page.evaluate(`(() => {
    const cands = [...document.querySelectorAll('div,span,button,li')]
      .filter(el => /^\\s*\\d+\\s*(条评论|评论)\\s*$/.test((el.innerText || '').trim()));
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      try { el.click(); return { ok: true, text: (el.innerText || '').trim() }; } catch {}
    }
    // fallback: an element whose aria/title mentions comments
    const alt = document.querySelector('[aria-label*="评论" i], [title*="评论" i], [data-e2e*="comment" i]');
    if (alt) { try { alt.click(); return { ok: true, text: 'aria' }; } catch {} }
    return { ok: false };
  })()`)
  out.clickedComment = clicked
  await sleep(2500)
  out.afterCommentClick = await page.evaluate(PROBE)

  const dump = await page.evaluate(`(() => {
    const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
    const idx = text.indexOf('条评论');
    return {
      around: idx >= 0 ? text.slice(Math.max(0, idx - 120), idx + 420) : null,
      tail: text.slice(-300)
    };
  })()`)
  out.text = dump
} finally {
  await page.evaluate(closeModal && `void 0`).catch(() => {})
  await page.close()
  await browser.dispose()
}

console.log(JSON.stringify(out, null, 2))
