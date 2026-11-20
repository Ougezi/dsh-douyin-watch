/**
 * Spike: Edge + 鎾斁鍣?+ 鎼滅储 + 鐑.
 *
 * Answers, with evidence, before any production code is written:
 *   1. does our zero-dependency CDP engine drive Edge the same way as Chrome?
 *   2. after opening a feed card, is there a real <video>? can we seek it? do
 *      frames come back usable or black?
 *   3. what do the search page and the hot list look like?
 *
 *   node scripts/spike.mjs [chrome|edge]
 */
import fs from 'node:fs'
import { Browser, findBrowser } from '../lib/cdp.js'
import { FEED_URL, PROBE_SCRIPT, DISMISS_OVERLAY_SCRIPT } from '../lib/adapters/douyin/feed.js'
import { dataDir, ensureDirs } from '../lib/store.js'

const channel = process.argv[2] === 'chrome' ? 'chrome' : 'edge'
const exe = channel === 'edge'
  ? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p))
  : findBrowser('')

const dir = ensureDirs()
const out = { channel, executable: exe, steps: {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function clickAt(page, x, y) {
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }
  await page.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base })
  await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}

async function probeFeed(page) {
  return page.evaluate(PROBE_SCRIPT)
}

if (!exe) {
  console.error(`FAIL: no ${channel} executable found`)
  process.exit(1)
}

const t0 = Date.now()
const browser = await Browser.launch({ executable: exe, userDataDir: `${dir}/profile-${channel}` })
out.launchMs = Date.now() - t0
const page = await browser.newPage('about:blank')
await page.enable()

try {
  // ---- 1) feed ----
  await page.navigate(FEED_URL, { timeoutMs: 30000 })
  for (let i = 0; i < 30; i++) {
    const p = await probeFeed(page)
    if (p.cards > 0) break
    await sleep(500)
  }
  out.steps.feed = await probeFeed(page)
  await page.evaluate(DISMISS_OVERLAY_SCRIPT)

  // ---- 2) open the first card and look for a real player ----
  const card = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[class*="waterfall-videoCardContainer"]')];
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.width > 200 && r.height > 150 && r.bottom > 0 && r.top < innerHeight) {
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
      }
    }
    return null;
  })()`)
  out.steps.cardRect = card
  if (card) {
    await clickAt(page, card.x, card.y)
    await sleep(3500)
    out.steps.player = await page.evaluate(`(() => {
      const v = document.querySelector('video');
      return {
        url: location.href,
        videoCount: document.querySelectorAll('video').length,
        readyState: v ? v.readyState : null,
        currentTime: v ? Number(v.currentTime.toFixed(2)) : null,
        duration: v && isFinite(v.duration) ? Number(v.duration.toFixed(2)) : null,
        paused: v ? v.paused : null,
        muted: v ? v.muted : null,
        videoWidth: v ? v.videoWidth : null,
        videoHeight: v ? v.videoHeight : null
      };
    })()`)

    // try seeking 3s in, then wait for a decoded frame
    if (out.steps.player.videoCount > 0) {
      out.steps.seek = await page.evaluate(`(async () => {
        const v = document.querySelector('video');
        if (!v) return { ok: false };
        try { v.currentTime = Math.min(3, (v.duration || 10) - 0.5); } catch (e) { return { ok: false, err: String(e) }; }
        await new Promise(r => setTimeout(r, 1200));
        try { v.pause(); } catch {}
        return { ok: true, currentTime: Number(v.currentTime.toFixed(2)), readyState: v.readyState, videoWidth: v.videoWidth };
      })()`)
      await sleep(400)
      const png = await page.screenshot()
      const file = `${dir}/spike-${channel}-frame.png`
      fs.writeFileSync(file, png)
      out.steps.frame = { file, bytes: png.length }
    }
  }

  // ---- 3) search page ----
  for (const url of ['https://www.douyin.com/search/%E7%BE%8E%E9%A3%9F?type=general']) {
    try {
      await page.navigate(url, { timeoutMs: 25000 })
      await sleep(2500)
      out.steps.search = await page.evaluate(`(() => ({
        url: location.href,
        title: document.title,
        videos: document.querySelectorAll('video').length,
        videoLinks: document.querySelectorAll('a[href*="/video/"]').length,
        cards: document.querySelectorAll('[class*="videoCardContainer"], [class*="searchResultCard"], li[class]').length,
        bodyChars: (document.body.innerText || '').length,
        head: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 240)
      }))()`)
    } catch (e) {
      out.steps.search = { error: String(e.message ?? e) }
    }
  }

  // ---- 4) hot list ----
  for (const url of ['https://www.douyin.com/hot', 'https://www.douyin.com/hotlist']) {
    try {
      await page.navigate(url, { timeoutMs: 25000 })
      await sleep(2000)
      const r = await page.evaluate(`(() => ({
        url: location.href,
        title: document.title,
        bodyChars: (document.body.innerText || '').length,
        head: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 240)
      }))()`)
      out.steps.hot = out.steps.hot || []
      out.steps.hot.push(r)
    } catch (e) {
      out.steps.hot = out.steps.hot || []
      out.steps.hot.push({ url, error: String(e.message ?? e) })
    }
  }
} finally {
  await page.close()
  await browser.dispose()
}

console.log(JSON.stringify(out, null, 2))
