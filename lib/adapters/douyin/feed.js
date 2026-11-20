/**
 * Douyin page adapters.
 *
 * Everything version-specific about the site lives here, in two directions:
 *  - in-page scripts that read the DOM (fragile: class names carry hashes, so we
 *    match on the stable *suffix* of the semantic class)
 *  - a pure text parser that turns one card's innerText into a record
 *
 * The parser is deliberately token based. Douyin's card text is a fixed shape:
 *   共创 06:29 1.3万 <title> #tag #tag @author · 2天前
 * and it survives UI reshuffles far better than any per-field selector.
 */

export const FEED_URL = 'https://www.douyin.com/?recommend=1'
export const CARD_SELECTOR = '[class*="waterfall-videoCardContainer"]'

const sleep = (ms) => `await new Promise(r => setTimeout(r, ${ms}))`

/** Probe the page: what is on screen and can it be driven? */
export const PROBE_SCRIPT = `(() => {
  const cards = document.querySelectorAll(${JSON.stringify(CARD_SELECTOR)});
  const scrollers = [...document.querySelectorAll('div,main,section')]
    .filter(n => n.scrollHeight - n.clientHeight > 120 && n.clientHeight > 300)
    .map(n => ({ n, delta: n.scrollHeight - n.clientHeight }))
    .sort((a, b) => b.delta - a.delta);
  const verify = [...document.querySelectorAll('iframe')]
    .filter(f => (f.src || '').includes('verifycenter'))
    .map(f => { const r = f.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter(r => r.w > 0 && r.h > 0);
  // A login dialog is a *fixed overlay* that covers the feed. Body text alone is
  // not evidence: '我的' and '登录' are in the nav even when signed out (that
  // mistake produced covers with the QR dialog baked into them).
  const loginModal = [...document.querySelectorAll('div,section,aside')].some(el => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (s.position !== 'fixed' && s.position !== 'absolute') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.height < 160) return false;
    return (el.innerText || '').includes('扫码登录');
  });
  const bodyText = document.body ? document.body.innerText : '';
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    cards: cards.length,
    videos: document.querySelectorAll('video').length,
    scrollable: scrollers.length,
    captchaVisible: verify.length > 0,
    loginModal,
    loginWall: /扫码登录|登录后查看|请先登录/.test(bodyText) && cards.length === 0,
    bodyChars: bodyText.length
  };
})()`

/**
 * Remove the login dialog.
 *
 * Structure measured on 2026-11-20: the dialog is a **full-viewport fixed
 * backdrop** (1264x805, z-index 9999, display:flex) whose subtree contains the
 * 726x483 panel. The panel itself is `position: static`, so walking up from the
 * text looking for "the nearest fixed ancestor" walks past eight wrappers and
 * misses it. Hit the backdrop directly instead: any fixed element containing the
 * prompt that covers a large share of the viewport.
 */
export const DISMISS_OVERLAY_SCRIPT = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
  const backs = [...document.querySelectorAll('div,section,aside')].filter(el => {
    const s = getComputedStyle(el);
    if (s.position !== 'fixed') return false;
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (!(el.innerText || '').includes('扫码登录')) return false;
    return area(el) >= 0.4 * vw * vh;
  }).sort((a, b) => area(b) - area(a));
  if (!backs.length) {
    // fall back to a close control inside any dialog-ish container
    const holder = [...document.querySelectorAll('div,section')]
      .filter(el => (el.innerText || '').includes('扫码登录'))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
    const btn = holder && holder.querySelector('[aria-label*="关闭"],[class*="close" i],[class*="Close"]');
    if (btn && btn.getBoundingClientRect().width > 0) {
      try { btn.click(); return { found: true, action: 'clicked-close' }; } catch {}
    }
    return { found: false };
  }
  let hidden = 0;
  for (const el of backs) {
    el.style.setProperty('display', 'none', 'important');
    hidden++;
  }
  // dialogs usually lock page scrolling while open; release it
  try {
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  } catch {}
  return { found: true, action: 'hidden-backdrop', hidden };
})()`

/**
 * Scroll the feed in steps (to trigger lazy loading) and return the text of up
 * to `max` distinct cards, in DOM order.
 */
export function collectScript(rounds = 4, stepPx = 700, max = 30) {
  return `(async () => {
    const SEL = ${JSON.stringify(CARD_SELECTOR)};
    const scrollers = [...document.querySelectorAll('div,main,section')]
      .filter(n => n.scrollHeight - n.clientHeight > 120 && n.clientHeight > 300)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    const scroller = scrollers[0] || null;
    const startTop = scroller ? scroller.scrollTop : 0;
    for (let i = 1; i <= ${rounds}; i++) {
      if (scroller) scroller.scrollTop = startTop + i * ${stepPx};
      else window.scrollBy(0, ${stepPx});
      ${sleep(420)}
    }
    const seen = new Set();
    const out = [];
    const nodes = [...document.querySelectorAll(SEL)];
    for (let i = 0; i < nodes.length && out.length < ${max}; i++) {
      const el = nodes[i];
      const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (text.length < 8) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      out.push({ index: i, text, w: Math.round(el.getBoundingClientRect().width) });
    }
    if (scroller) scroller.scrollTop = startTop;
    return { total: nodes.length, collected: out.length, items: out };
  })()`
}

/** Bring one card into view and report where it sits, for a cover screenshot. */
export function focusScript(index) {
  return `(async () => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(CARD_SELECTOR)})];
    const el = nodes[${Number(index)}];
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    ${sleep(320)}
    const r = el.getBoundingClientRect();
    return {
      x: r.x + window.scrollX,
      y: r.y + window.scrollY,
      width: r.width,
      height: r.height,
      visible: r.width > 40 && r.height > 40 && r.bottom > 0 && r.top < (window.innerHeight || 2000)
    };
  })()`
}

const DURATION_RE = /(?:^|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?(?=\s|$)/
const LIKE_TOKEN_RE = /^(\d+(?:\.\d+)?)(万|亿|w|W)$/
const AGE_RE = /[·•]\s*([0-9]+\s*(?:秒|分钟|小时|天|周|个月|年)前?|\d{1,2}月\d{1,2}日|\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2})/
const AUTHOR_RE = /@([^\s@#·•]{1,40})/
const TAG_RE = /#([^\s#@·•，,。]{1,30})/g

const LIKE_UNIT = { 万: 1e4, w: 1e4, W: 1e4, 亿: 1e8 }

/** Split a like token ("1.3万", "12") into a number. */
export function parseLikes(token) {
  if (!token) return null
  const m = LIKE_TOKEN_RE.exec(token.trim())
  if (m) return Math.round(parseFloat(m[1]) * (LIKE_UNIT[m[2]] ?? 1))
  const plain = /^(\d+)$/.exec(token.trim())
  return plain ? Number(plain[1]) : null
}

/** "06:29" -> 389 */
export function parseDuration(value) {
  if (!value) return null
  const parts = value.split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return null
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return null
}

const NOISE_PREFIX = new Set(['共创', '独播', '置顶', '广告', '热榜', '推荐'])

/**
 * Parse one card's innerText into a record. Returns null when the text carries
 * no usable title (a partially rendered card, a promo tile, and so on).
 */
export function parseCard(text) {
  if (typeof text !== 'string') return null
  const raw = text.replace(/\s+/g, ' ').trim()
  if (!raw) return null

  let rest = raw

  const dur = DURATION_RE.exec(rest)
  let durationText = null
  let durationSec = null
  if (dur) {
    durationText = dur[0].trim()
    durationSec = parseDuration(durationText)
    rest = rest.replace(durationText, ' ')
  }

  let likesText = null
  let likes = null
  for (const token of rest.split(' ')) {
    const t = token.trim()
    if (!t) continue
    if (LIKE_TOKEN_RE.test(t) || /^\d{2,}$/.test(t)) {
      const value = parseLikes(t)
      if (value !== null && (LIKE_TOKEN_RE.test(t) || value >= 0)) {
        likesText = t
        likes = value
        rest = rest.replace(t, ' ')
        break
      }
    }
  }

  const age = AGE_RE.exec(rest)
  const ageText = age ? age[1].trim() : null
  const author = AUTHOR_RE.exec(rest)
  const authorName = author ? author[1] : null

  const tags = []
  for (const m of rest.matchAll(TAG_RE)) {
    if (m[1] && !tags.includes(m[1])) tags.push(m[1])
  }

  let title = rest
  title = title.replace(TAG_RE, ' ')
  if (authorName) title = title.replace(`@${authorName}`, ' ')
  if (ageText) title = title.replace(age[0], ' ')
  title = title.replace(/[·•]\s*$/, ' ')
  const words = title
    .split(' ')
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => !NOISE_PREFIX.has(w))
  title = words.join(' ').trim()

  if (title.length < 4) return null

  // Reject anything that carries no video signal at all (promo tiles, "download
  // the app" banners, skeleton placeholders). A real card has at least one of:
  // a duration, an author, or a hashtag.
  if (durationSec == null && !authorName && tags.length === 0) return null

  return {
    title: title.slice(0, 300),
    author: authorName,
    tags: tags.slice(0, 8),
    likes,
    likesText,
    durationSec,
    durationText,
    ageText
  }
}

/** Stable identity for dedupe across rounds. */
export function cardId(record) {
  const basis = `${record.title}|${record.author ?? ''}`.toLowerCase().replace(/\s+/g, '')
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < basis.length; i++) {
    const c = basis.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0
    h2 = Math.imul(h2 + c, 2654435761) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}
