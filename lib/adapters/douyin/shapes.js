/**
 * Shared collector: find one text per card by *shape*, not by class name.
 *
 * Why: douyin's class names carry build hashes and differ per surface (feed,
 * hot list, search results), but the card text is the same everywhere —
 * `HH:MM <likes> <title> #tag … @author · <age>`. Measured 2026-11-21:
 *   - hot list  : 10 entries by this rule
 *   - search    : 68 nested matches for 20-ish real cards (hence dedupe)
 *
 * Nested wrappers make a parent's text a superset of its children's, so
 * candidates are sorted shortest-first and any text containing an already-kept
 * one is dropped. That yields one entry per card without knowing the layout.
 */
export function collectByDurationShapeScript(max = 30) {
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

/** Scroll one step; used to page in more entries than the first render holds. */
export function scrollStepScript(px = 1200) {
  return `(() => {
    const cands = [...document.querySelectorAll('div,main,section')]
      .filter(n => n.scrollHeight - n.clientHeight > 120 && n.clientHeight > 300)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    const el = cands[0];
    if (el) {
      const before = el.scrollTop;
      el.scrollTop = Math.min(el.scrollTop + ${Number(px) || 1200}, el.scrollHeight);
      return { via: 'inner', before, after: el.scrollTop, max: el.scrollHeight };
    }
    const beforeY = window.scrollY;
    window.scrollBy(0, ${Number(px) || 1200});
    return { via: 'window', before: beforeY, after: window.scrollY };
  })()`
}
