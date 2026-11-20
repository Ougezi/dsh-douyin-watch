/**
 * Spike-2: how does a feed card actually open a player, and what is on the
 * hot list / search page. Tries several click strategies and dumps bounded text.
 *
 *   node scripts/spike2.mjs
 */
import fs from 'node:fs'
import { Browser } from '../lib/cdp.js'
import { FEED_URL, DISMISS_OVERLAY_SCRIPT } from '../lib/adapters/douyin/feed.js'
import { ensureDirs } from '../lib/store.js'

const exe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p))
const dir = ensureDirs()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { steps: [] }

const browser = await Browser.launch({ executable: exe, userDataDir: `${dir}/profile-edge` })
const page = await browser.newPage('about:blank')
await page.enable()

const probe = () => page.evaluate(`(() => ({
  url: location.href,
  videos: document.querySelectorAll('video').length,
  dialogs: document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]').length,
  cd: (() => { const v = document.querySelector('video'); return v ? { readyState: v.readyState, ct: Number(v.currentTime.toFixed(2)), d: isFinite(v.duration) ? Number(v.duration.toFixed(2)) : null } : null; })(),
  bodyChars: (document.body.innerText || '').length
}))()`)

try {
  await page.navigate(FEED_URL, { timeoutMs: 30000 })
  for (let i = 0; i < 30; i++) {
    const n = await page.evaluate(`document.querySelectorAll('[class*="waterfall-videoCardContainer"]').length`)
    if (n > 0) break
    await sleep(500)
  }
  await page.evaluate(DISMISS_OVERLAY_SCRIPT)
  out.steps.push({ name: 'feed-loaded', ...(await probe()) })

  // ---- strategy 1: synthetic .click() on the card itself ----
  const clicked = await page.evaluate(`(() => {
    const el = document.querySelector('[class*="waterfall-videoCardContainer"]');
    if (!el) return { ok: false };
    el.click();
    return { ok: true, cls: (el.className || '').toString().slice(0, 60) };
  })()`)
  await sleep(3000)
  out.steps.push({ name: 'click-card-js', clicked, ...(await probe()) })

  // ---- strategy 2: click the innermost cursor:pointer element ----
  if ((await probe()).videos === 0) {
    const target = await page.evaluate(`(() => {
      const card = document.querySelector('[class*="waterfall-videoCardContainer"]');
      if (!card) return null;
      const all = [...card.querySelectorAll('*')];
      const ptr = all.filter(n => getComputedStyle(n).cursor === 'pointer');
      const pick = ptr[ptr.length - 1] || card;
      const r = pick.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: pick.tagName, cls: (pick.className || '').toString().slice(0, 50), count: ptr.length };
    })()`)
    out.steps.push({ name: 'pointer-target', target })
    if (target) {
      const base = { x: Math.round(target.x), y: Math.round(target.y), button: 'left', clickCount: 1, buttons: 1 }
      await page.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y })
      await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
      await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
      await sleep(3500)
      out.steps.push({ name: 'click-pointer', ...(await probe()) })
    }
  }

  // ---- strategy 3: dispatch a full pointer + mouse sequence ----
  if ((await probe()).videos === 0) {
    const r = await page.evaluate(`(() => {
      const el = document.querySelector('[class*="waterfall-videoCardContainer"]');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    })()`)
    if (r) {
      for (const type of ['pointerdown', 'pointerup']) {
        await page.session.send('Input.dispatchMouseEvent', {
          type: type === 'pointerdown' ? 'mousePressed' : 'mouseReleased',
          x: r.x, y: r.y, button: 'left', clickCount: 1, buttons: type === 'pointerdown' ? 1 : 0, pointerType: 'mouse'
        }).catch(() => {})
      }
      const el = await page.evaluate(`import('node:fs') && null`).catch(() => null)
      await page.evaluate(`(() => {
        const el = document.querySelector('[class*="waterfall-videoCardContainer"]');
        if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      })()`)
      await sleep(3500)
      out.steps.push({ name: 'click-bubbling-mouseevent', ...(await probe()) })
    }
  }

  // ---- hot list text ----
  await page.navigate('https://www.douyin.com/hot', { timeoutMs: 25000 })
  await sleep(3000)
  out.steps.push({
    name: 'hot',
    ...(await probe()),
    text: await page.evaluate(`(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 1200)`)
  })

  // ---- search: two URL shapes ----
  for (const url of [
    'https://www.douyin.com/search/%E7%BE%8E%E9%A3%9F',
    'https://www.douyin.com/search/%E7%BE%8E%E9%A3%9F?type=video'
  ]) {
    await page.navigate(url, { timeoutMs: 25000 })
    await sleep(3000)
    out.steps.push({
      name: 'search',
      url,
      ...(await probe()),
      text: await page.evaluate(`(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 600)`)
    })
  }
} finally {
  await page.close()
  await browser.dispose()
}

console.log(JSON.stringify(out, null, 2))
