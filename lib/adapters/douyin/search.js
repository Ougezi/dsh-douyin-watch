/**
 * Search adapter.
 *
 * Two states matter more than the happy path:
 *  - signed out: `https://www.douyin.com/search/<kw>` renders a login wall
 *    (`登录后即可搜索更多精彩视频`) with zero results. Reporting that as "no results"
 *    would be a lie.
 *  - signed in (measured 2026-11-21): results render, but they use neither the
 *    feed's card class nor any `<a href="/video/">` anchor. Their text shape,
 *    however, is identical to every other douyin list, so collection happens by
 *    shape (see shapes.js) instead of by class.
 */
export const SEARCH_LOGIN_MARKER = '登录后即可搜索'

/** Only a diagnostic hint: the real collection is shape-based, not class-based. */
export const SEARCH_CARD_CLASS_HINT = 'search-result-card'

export function searchUrl(keyword) {
  return `https://www.douyin.com/search/${encodeURIComponent(String(keyword))}`
}

export const SEARCH_STATE_SCRIPT = `(() => {
  const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
  const verify = [...document.querySelectorAll('iframe')]
    .filter(f => (f.src || '').includes('verifycenter'))
    .some(f => { const r = f.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  return {
    url: location.href,
    title: document.title,
    needsLogin: text.includes(${JSON.stringify(SEARCH_LOGIN_MARKER)}),
    captchaVisible: verify,
    bodyChars: text.length,
    cardCount: document.querySelectorAll('[class*="waterfall-videoCardContainer"]').length,
    searchCardCount: document.querySelectorAll('[class*="' + ${JSON.stringify(SEARCH_CARD_CLASS_HINT)} + '"]').length
  };
})()`
