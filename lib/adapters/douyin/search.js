/**
 * Search adapter.
 *
 * Measured 2026-11-21: `https://www.douyin.com/search/<kw>` renders anonymously
 * only as a login wall — the page shows `登录后即可搜索更多精彩视频` with zero
 * results and about 638 characters of footer. Both `/search/<kw>` and
 * `/search/<kw>?type=video` behave the same.
 *
 * So this adapter's primary job is to *recognise* that state and report it
 * honestly instead of returning an empty list that looks like "no results".
 */
export const SEARCH_LOGIN_MARKER = '登录后即可搜索'

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
    cardCount: document.querySelectorAll('[class*="waterfall-videoCardContainer"]').length
  };
})()`
