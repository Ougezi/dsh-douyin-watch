/**
 * Asset discovery for downloads / user pages / collections / live.
 *
 * Every script here is read-only DOM inspection. Selectors prefer `data-e2e`
 * hooks when Douyin exposes them, then fall back to href/text shapes, because
 * the page is a moving target (probe with `node scripts/probe-*.mjs`).
 */

/** 图文作品的原图（去重、只保留竖版大图）；返回 [{src,w,h}] */
export function noteImagesScript() {
  return `(() => {
    const out = [];
    const seen = new Set();
    for (const img of document.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      const w = Number(img.naturalWidth) || 0;
      const h = Number(img.naturalHeight) || 0;
      if (!/^https?:/.test(src) || w < 600 || h < 800) continue;
      let key = src;
      try { key = new URL(src).pathname; } catch {}
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ src, w, h });
    }
    out.sort((a, b) => b.w * b.h - a.w * a.h);
    return out;
  })()`;
}

/** 视频源：og:video / video.currentSrc / 页面里的 play_addr */
export function videoSourceScript() {
  return `(() => {
    const out = [];
    const push = (u) => { if (u && /^https?:/.test(u) && !out.includes(u)) out.push(u); };
    const v = document.querySelector('video');
    if (v) { push(v.currentSrc); push(v.src); }
    for (const m of document.querySelectorAll('meta')) {
      const p = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
      if (p.includes('og:video') || p.includes('twitter:player:stream')) push(m.content);
    }
    for (const s of document.querySelectorAll('source')) push(s.src);
    return out;
  })()`;
}

/** 页面脚本里的播放/图片地址（图文 JSON、play_addr 等） */
export function pageAssetUrlsScript() {
  return `(() => {
    const html = document.documentElement.innerHTML;
    const urls = (html.match(/https?:[^"'\\\\\\s]+/g) || []).filter((u) =>
      /play_addr|playwm|\\/video\\/tos\\/|\\.mp4|\\.m4a|douyinpic\\.com|douyinstatic\\.com/i.test(u));
    return [...new Set(urls.map((u) => u.replace(/\\\\u002F/g, '/')))].slice(0, 20);
  })()`;
}

/** 用户主页的作品卡片（视频/图文），滚动后重复调用 */
export function userPostsScript() {
  return `(() => {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]')) {
      const href = a.href || '';
      const m = href.match(/\\/(video|note)\\/(\\d{6,})/);
      if (!m) continue;
      const text = (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
      out.push({ kind: m[1], id: m[2], url: href.split('?')[0], text });
    }
    const seen = new Set();
    return out.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
  })()`;
}

/** 用户主页的收藏/合集/音乐入口 */
export function userTabsScript() {
  return `(() => {
    const tabs = [];
    for (const a of document.querySelectorAll('a[href], [role="tab"], [data-e2e]')) {
      const label = (a.textContent || '').replace(/\\s+/g, '').trim();
      const e2e = a.getAttribute && a.getAttribute('data-e2e') || '';
      if (/作品|喜欢|收藏|合集|音乐/.test(label) || /tab|collect|like|music/i.test(e2e)) {
        tabs.push({ label: label.slice(0, 20), e2e, href: a.href || '' });
      }
    }
    return tabs.slice(0, 30);
  })()`;
}

/** 搜索结果里的用户行 */
export function searchUsersScript() {
  return `(() => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/user/"]')) {
      const href = a.href || '';
      const m = href.match(/\\/user\\/([\\w-]{6,})/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const box = a.closest('li,div') || a;
      const text = (box.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
      out.push({ secUid: m[1], url: href.split('?')[0], text });
    }
    return out.slice(0, 40);
  })()`;
}

/** 直播状态（只读）：页面上是否在直播 */
export function liveStateScript() {
  return `(() => {
    const text = document.body ? document.body.innerText : '';
    const live = /直播中|正在直播|LIVE|观看人数|人气/.test(text);
    const title = (document.title || '').slice(0, 120);
    return { live, title, url: location.href, sample: text.replace(/\\s+/g, ' ').slice(0, 200) };
  })()`;
}
