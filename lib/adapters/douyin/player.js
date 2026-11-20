/**
 * Player adapter — opening a real `<video>` and capturing a frame.
 *
 * Measured 2026-11-21 (spike):
 *  - `Input.dispatchMouseEvent` at a card's centre does NOT open the player
 *    (`videoCount` stayed 0); a synthetic `element.click()` does.
 *  - The opened URL carries a stable id: `https://www.douyin.com/jingxuan?modal_id=<id>`
 *    and `<video>` reports `readyState = 4`, `duration = 444.17`.
 *
 * So `modal_id` is the identity we keep, and it doubles as a way to reopen a
 * specific video without clicking anything.
 */
import { FEED_URL } from './feed.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const JINGXUAN_URL = 'https://www.douyin.com/jingxuan'

export function modalUrl(modalId) {
  return `${JINGXUAN_URL}?modal_id=${encodeURIComponent(String(modalId))}`
}

export function modalIdOf(url) {
  try {
    const id = new URL(url).searchParams.get('modal_id')
    return id && /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

/** Click one feed card by DOM index (synthetic click — the only thing that works). */
export function openCardScript(index) {
  return `(() => {
    const nodes = [...document.querySelectorAll('[class*="waterfall-videoCardContainer"]')];
    const el = nodes[${Number(index) || 0}];
    if (!el) return { ok: false, reason: 'no-card', total: nodes.length };
    el.click();
    return { ok: true, total: nodes.length };
  })()`
}

export const VIDEO_STATE_SCRIPT = `(() => {
  const v = document.querySelector('video');
  const rect = v ? v.getBoundingClientRect() : null;
  return {
    url: location.href,
    videoCount: document.querySelectorAll('video').length,
    readyState: v ? v.readyState : null,
    currentTime: v ? Number(v.currentTime.toFixed(2)) : null,
    duration: v && isFinite(v.duration) ? Number(v.duration.toFixed(2)) : null,
    paused: v ? v.paused : null,
    videoWidth: v ? v.videoWidth : null,
    videoHeight: v ? v.videoHeight : null,
    rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
  };
})()`

/** Seek, let the decoder present a frame, then pause so the capture is stable. */
export function seekScript(seconds) {
  const target = Number(seconds) || 0
  return `(async () => {
    const v = document.querySelector('video');
    if (!v) return { ok: false, reason: 'no-video' };
    const duration = isFinite(v.duration) ? v.duration : null;
    const at = duration ? Math.min(${target}, Math.max(0, duration - 0.5)) : ${target};
    try { v.currentTime = at; } catch (e) { return { ok: false, reason: 'seek-failed', error: String(e) }; }
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      v.addEventListener('seeked', finish, { once: true });
      setTimeout(finish, 1500);
    });
    await new Promise((r) => setTimeout(r, 350));
    try { v.pause(); } catch {}
    return { ok: true, currentTime: Number(v.currentTime.toFixed(2)), readyState: v.readyState, videoWidth: v.videoWidth };
  })()`
}

/**
 * First-use coach mark. Measured 2026-11-21: the player modal shows a tutorial
 * layer (`滚动"鼠标"或点按"键盘上下键"查看更多推荐视频` + `我知道了`) that covers the
 * video. Capturing without dismissing it yields a frame of the tutorial, not the
 * video — technically non-black, but useless as evidence.
 */
export const DISMISS_COACH_SCRIPT = `(() => {
  const labels = ['我知道了', '知道了', '开始体验', '开始观看'];
  let clicked = 0;
  for (const el of document.querySelectorAll('div,button,span,a')) {
    const t = (el.innerText || '').trim();
    if (!labels.includes(t)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) continue;
    try { el.click(); clicked++; } catch {}
    if (clicked >= 1) break;
  }
  let hidden = 0;
  for (const el of document.querySelectorAll('div')) {
    const s = getComputedStyle(el);
    if (s.position !== 'fixed') continue;
    const t = el.innerText || '';
    if (t.includes('滚动') && t.includes('查看更多推荐视频')) {
      el.style.setProperty('display', 'none', 'important');
      hidden++;
    }
  }
  return { clicked, hidden };
})()`

/** Resolve the video's rect again after a layout change (coach dismissal shifts it). */
export async function videoRect(page) {
  const state = await page.evaluate(VIDEO_STATE_SCRIPT)
  return state?.rect ?? null
}

/**
 * Wait until the modal video can actually present a frame (`readyState >= 2`).
 * The modal can appear before its media is decodable; seeking at that point is a
 * no-op and the capture returns the poster. Measured: one card needed ~2s extra.
 */
export async function waitForReady(page, { timeoutMs = 8000, pollMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs
  let state = null
  try {
    state = await page.evaluate(VIDEO_STATE_SCRIPT)
  } catch {}
  while (Date.now() < deadline && (!state || (state.readyState ?? 0) < 2)) {
    await sleep(pollMs)
    try {
      state = await page.evaluate(VIDEO_STATE_SCRIPT)
    } catch {}
  }
  return state
}

/**
 * Poll until a *modal player* exists, or give up with a reason.
 *
 * Trap this fixes: the feed preloads a hidden `<video>` (readyState 0), so
 * "videoCount > 0" alone is NOT evidence the player opened — an earlier version
 * accepted it and reported a successful capture with `duration: null` and no
 * frame. A real player is identified by `?modal_id=` in the URL.
 */
export async function waitForVideo(page, { timeoutMs = 15000, pollMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs
  let state = null
  while (Date.now() < deadline) {
    try {
      state = await page.evaluate(VIDEO_STATE_SCRIPT)
    } catch {
      state = null
    }
    const modalOpen = Boolean(state && /[?&]modal_id=\d+/.test(state.url ?? ''))
    if (modalOpen && state.videoCount > 0 && state.readyState >= 2) return { ...state, modalOpen: true }
    await sleep(pollMs)
  }
  return { ...(state ?? { videoCount: 0, readyState: null, url: null }), modalOpen: Boolean(state && /[?&]modal_id=\d+/.test(state.url ?? '')) }
}

/**
 * Close the player modal. Escape first (cheap), then a close control, then a
 * navigation fallback — never leave the modal open, or the next action runs
 * against a covered page.
 */
export async function closeModal(page, logger) {
  try {
    await page.pressEscape()
    await new Promise((r) => setTimeout(r, 400))
    const stillOpen = await page.evaluate(`location.href.includes('modal_id=') || document.querySelectorAll('video').length > 0`)
    if (!stillOpen) return { closed: true, via: 'escape' }
  } catch {}
  try {
    const clicked = await page.evaluate(`(() => {
      const btn = document.querySelector('[class*="close" i], [aria-label*="关闭"], [data-e2e*="close"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`)
    if (clicked) {
      await new Promise((r) => setTimeout(r, 500))
      return { closed: true, via: 'button' }
    }
  } catch {}
  try {
    await page.navigate(FEED_URL, { timeoutMs: 20000 })
    return { closed: true, via: 'navigate' }
  } catch (err) {
    logger?.warn?.(`douyin-watch: closeModal failed: ${err?.message ?? err}`)
    return { closed: false, via: 'none' }
  }
}
