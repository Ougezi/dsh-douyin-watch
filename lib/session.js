/**
 * Owns the one browser and one page per process, and the shared page routines
 * every surface needs (open the feed, dismiss overlays).
 *
 * Why one page: closing the last page terminates the browser (measured: exitCode
 * becomes 0 immediately after Page.close), so a per-call open/close cycle would
 * tear the window down between rounds — exactly wrong for a captcha or a login
 * wall, where the user needs that same window to stay put.
 *
 * Why per-channel profiles: a Douyin login in Chrome must not be assumed present
 * in Edge. Each channel gets its own directory, and the legacy `profile/` (from
 * when Chrome was the only option) is renamed once into `profile-chrome/`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Browser, browserCandidates, resolveBrowser } from './cdp.js'
import { FEED_URL, PROBE_SCRIPT, DISMISS_OVERLAY_SCRIPT } from './adapters/douyin/feed.js'
import * as store from './store.js'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let currentBrowser = null
let currentPage = null
let currentChannel = null

export function browserState() {
  const running = Boolean(currentBrowser && currentBrowser.child && currentBrowser.child.exitCode === null)
  return {
    running,
    channel: currentChannel,
    pageReused: Boolean(currentPage)
  }
}

function legacyProfileDir() {
  return path.join(store.dataDir(), 'profile')
}

export function profileDirFor(channel) {
  return path.join(store.dataDir(), `profile-${channel ?? 'other'}`)
}

/**
 * One-time move of the legacy single profile into the channel directory. Only
 * done for Chrome, because Chrome was the default before channels existed.
 * Any failure is non-fatal: we keep using whatever directory exists.
 */
function migrateLegacyProfile(channel, logger) {
  if (channel !== 'chrome') return null
  const legacy = legacyProfileDir()
  const target = profileDirFor('chrome')
  try {
    if (!fs.existsSync(legacy) || fs.existsSync(target)) return null
    fs.renameSync(legacy, target)
    logger?.info?.(`douyin-watch: migrated legacy profile -> ${target}`)
    return target
  } catch (err) {
    logger?.warn?.(`douyin-watch: profile migration skipped: ${err?.message ?? err}`)
    return null
  }
}

export async function pageAlive(page) {
  if (!page) return false
  try {
    await page.evaluate('1')
    return true
  } catch {
    return false
  }
}

async function getBrowser(cfg, logger) {
  if (currentBrowser && currentBrowser.child && currentBrowser.child.exitCode === null) {
    return { browser: currentBrowser, reused: true, channel: currentChannel }
  }
  const requested = cfg.browserChannel ?? 'auto'
  const { executable, channel } = resolveBrowser(cfg.chromePath, requested)
  if (!executable) {
    const tried = browserCandidates(cfg.chromePath, requested === 'auto' ? 'auto' : requested).slice(0, 4).join(' | ')
    const error = new Error(`没有找到可用的浏览器（通道 ${requested}）`)
    error.code = 'no-browser'
    error.hint = `装 Chrome 或 Edge，或把 config.chromePath 指到 exe；当前通道是 ${requested}。试过：${tried}`
    throw error
  }
  store.ensureDirs()
  migrateLegacyProfile(channel, logger)
  const browser = await Browser.launch({
    executable,
    userDataDir: profileDirFor(channel),
    headless: cfg.headless
  })
  currentBrowser = browser
  currentChannel = channel
  logger?.info?.(`douyin-watch: launched ${channel} (${executable})`)
  return { browser, reused: false, channel }
}

export async function ensurePage(cfg, logger) {
  if (currentPage && currentBrowser && currentBrowser.child.exitCode === null && (await pageAlive(currentPage))) {
    return { page: currentPage, reused: true }
  }
  await disposeBrowser()
  const { browser, channel } = await getBrowser(cfg, logger)
  const page = await browser.newPage('about:blank')
  await page.enable()
  currentPage = page
  return { page, reused: false, channel }
}

export async function disposeBrowser() {
  const b = currentBrowser
  currentBrowser = null
  currentPage = null
  currentChannel = null
  if (!b) return false
  try {
    await b.dispose()
  } catch {}
  return true
}

/** Get the login overlay out of the way so covers and scrolling stay usable. */
export async function dismissOverlays(page, logger) {
  try {
    const result = await page.evaluate(DISMISS_OVERLAY_SCRIPT)
    if (result?.found && result.action === 'none') {
      await page.pressEscape()
      await sleep(350)
    }
    return result
  } catch (err) {
    logger?.warn?.(`douyin-watch: overlay dismiss failed: ${err?.message ?? err}`)
    return null
  }
}

/** Open the feed and poll until cards, a login wall or a captcha appears. */
export async function openFeed(cfg, logger, { waitMs = 25000 } = {}) {
  const { page, reused, channel } = await ensurePage(cfg, logger)
  await page.navigate(FEED_URL, { timeoutMs: 30000 })
  const deadline = Date.now() + waitMs
  let probe = null
  while (Date.now() < deadline) {
    try {
      probe = await page.evaluate(PROBE_SCRIPT)
    } catch (err) {
      logger?.warn?.(`douyin-watch: probe failed: ${err?.message ?? err}`)
    }
    if (probe && (probe.cards > 0 || probe.captchaVisible)) break
    await sleep(600)
  }
  if (probe?.loginModal) {
    await dismissOverlays(page, logger)
    try {
      probe = await page.evaluate(PROBE_SCRIPT)
    } catch {}
  }
  return { page, probe, reused, channel }
}

/**
 * Is this browser profile signed in to Douyin?
 *
 * Not by watching for a login dialog: the feed loads fine anonymously and shows
 * no dialog, so "no dialog" would read as "signed in".
 *
 * Not by any cookie either: an anonymous visit already sets 23 cookies
 * (ttwid, odin_tt, __ac_nonce …), and a single sample once produced a false
 * "signed in" on a fresh profile. So:
 *   - only real session names count (`sessionid` / `sessionid_ss`);
 *   - a positive result is confirmed with a second sample, because a flaky read
 *     must never be allowed to claim a login.
 * Cookie values are never returned — only names and counts.
 */
const SESSION_COOKIE_NAMES = new Set(['sessionid', 'sessionid_ss'])

async function sessionHits(page) {
  const cookies = await page.cookies('douyin.com')
  return cookies.filter((c) => SESSION_COOKIE_NAMES.has(c.name)).length
}

export async function loginState(page) {
  const out = { checked: false, signedIn: false, sessionCookies: 0, loginModal: false }
  try {
    const first = await sessionHits(page)
    out.checked = true
    out.sessionCookies = first
    if (first > 0) {
      // confirm before claiming a login
      await sleep(300)
      const second = await sessionHits(page)
      out.sessionCookies = Math.min(first, second)
      out.signedIn = second > 0
    }
  } catch (err) {
    out.error = String(err?.message ?? err)
  }
  try {
    const probe = await page.evaluate(`(() => {
      const fixed = [...document.querySelectorAll('div,section,aside')].some((el) => {
        const s = getComputedStyle(el);
        if (s.position !== 'fixed' && s.position !== 'absolute') return false;
        const r = el.getBoundingClientRect();
        return r.width > 200 && r.height > 160 && (el.innerText || '').includes('扫码登录');
      });
      return fixed;
    })()`)
    out.loginModal = Boolean(probe)
  } catch {}
  return out
}

export { FEED_URL }
