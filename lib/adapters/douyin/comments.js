/**
 * Comments adapter.
 *
 * Measured 2026-11-21 (signed in):
 *  - The modal player exposes no comment DOM and no `textarea`; clicking its
 *    aria/icon column does nothing observable.
 *  - The **standalone video page** `https://www.douyin.com/video/<id>` renders a
 *    real comment list under the heading `全部评论`:
 *
 *      露营骚总 ... 撸铁2小时，拍摄1个半小时，修图20分钟 5天前·浙江 4 分享 回复
 *      你是个好人 ... 坚持不自律何尝不是一种自律呢 1周前·江苏 2 分享 回复
 *
 *    Shape: `<author> ... <content> <age>·<location> <likes> 分享 回复`.
 *
 * Class names are build hashes, so collection is by that text shape, then the
 * same "drop supersets" trick used for cards keeps one entry per comment.
 */
export function videoPageUrl(modalId) {
  return `https://www.douyin.com/video/${encodeURIComponent(String(modalId))}`
}

export const COMMENTS_STATE_SCRIPT = `(() => {
  const text = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  const hasHeading = text.includes('全部评论');
  const items = [...document.querySelectorAll('div,li,section')].filter(el => {
    const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!/分享\\s*回复/.test(t)) return false;
    return t.length > 8 && t.length < 500;
  });
  const verify = [...document.querySelectorAll('iframe')]
    .filter(f => (f.src || '').includes('verifycenter'))
    .some(f => { const r = f.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const loginWall = /登录后即可评论|登录后查看评论/.test(text);
  return {
    url: location.href,
    title: document.title,
    chars: text.length,
    hasHeading,
    candidateCount: items.length,
    captchaVisible: verify,
    loginWall,
    title2: (document.querySelector('h1') ? document.querySelector('h1').innerText : '').slice(0, 80)
  };
})()`

/** One text per comment element, with nested wrappers removed. */
export function collectCommentsScript(max = 40) {
  return `(() => {
    const seen = new Set();
    const cands = [];
    for (const el of document.querySelectorAll('div,li,section')) {
      const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (!/分享\\s*回复/.test(t)) continue;
      if (t.length < 8 || t.length > 500) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      cands.push(t);
    }
    cands.sort((a, b) => a.length - b.length);
    const kept = [];
    for (const t of cands) {
      if (kept.some((k) => t.includes(k))) continue;
      kept.push(t);
      if (kept.length >= ${Number(max) || 40}) break;
    }
    return { total: cands.length, items: kept };
  })()`
}

const AGE_RE = /(\d+\s*(?:秒|分钟|小时|天|周|个月|年)前|\d{1,2}-\d{1,2}|\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日)/
const LIKE_RE = /(\d+(?:\.\d+)?[万亿]?)\s*分享\s*回复/
const LOCATION_RE = /·\s*([^\s·]{1,12})/

/**
 * Parse one comment line. Returns null when the line carries no comment signal,
 * so callers never store a "reply" button stub as if it were a comment.
 */
export function parseComment(text) {
  if (typeof text !== 'string') return null
  const raw = text.replace(/\s+/g, ' ').trim()
  if (!/分享\s*回复/.test(raw)) return null

  const ageMatch = AGE_RE.exec(raw)
  if (!ageMatch) return null
  const head = raw.slice(0, ageMatch.index).trim()
  const tail = raw.slice(ageMatch.index)

  const likeMatch = LIKE_RE.exec(tail)
  const locationMatch = LOCATION_RE.exec(tail)
  const likesText = likeMatch ? likeMatch[1] : null
  const likes = likesText
    ? /万/.test(likesText)
      ? Math.round(parseFloat(likesText) * 1e4)
      : /亿/.test(likesText)
        ? Math.round(parseFloat(likesText) * 1e8)
        : Number(likesText)
    : null

  // `<author> ... <content>`; older layouts omit the author block entirely.
  let author = null
  let content = head
  const sep = head.indexOf(' ... ')
  if (sep > 0) {
    author = head.slice(0, sep).trim() || null
    content = head.slice(sep + 5).trim()
  }

  if (!content || content.length < 1) return null
  return {
    author,
    content: content.slice(0, 500),
    ageText: ageMatch[1].trim(),
    location: locationMatch ? locationMatch[1] : null,
    likes,
    likesText
  }
}
