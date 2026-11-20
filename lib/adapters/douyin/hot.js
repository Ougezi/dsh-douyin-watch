/**
 * Hot list adapter (`https://www.douyin.com/hot`).
 *
 * Measured 2026-11-21: the hot page renders anonymously (no login) and its items
 * carry the *same* text shape as feed cards — `02:44 1805 <title> #tag … @author · 3天前`
 * — so `parseCard()` is reused as-is instead of inventing a second parser.
 *
 * Items are collected by shape rather than by an obfuscated class name: every
 * element whose text starts with `HH:MM`. Nested wrappers produce supersets, so
 * candidates are sorted by length and any text containing an already-kept one is
 * dropped — that keeps one entry per item without knowing the layout.
 */
export const HOT_URL = 'https://www.douyin.com/hot'

export function collectHotScript(max = 30) {
  return `(() => {
    const seen = new Set();
    const cands = [];
    for (const el of document.querySelectorAll('div,li,article,section')) {
      const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (!/^\\d{1,2}:\\d{2}\\s/.test(t)) continue;
      if (t.length < 12 || t.length > 400) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      cands.push(t);
    }
    cands.sort((a, b) => a.length - b.length);
    const kept = [];
    for (const t of cands) {
      if (kept.some((k) => t.includes(k))) continue;
      kept.push(t);
      if (kept.length >= ${Number(max) || 30}) break;
    }
    return { total: cands.length, items: kept };
  })()`
}

export const HOT_STATE_SCRIPT = `(() => {
  const text = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  const verify = [...document.querySelectorAll('iframe')]
    .filter(f => (f.src || '').includes('verifycenter'))
    .some(f => { const r = f.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  return {
    url: location.href,
    title: document.title,
    bodyChars: text.length,
    captchaVisible: verify,
    empty: text.length < 200
  };
})()`
