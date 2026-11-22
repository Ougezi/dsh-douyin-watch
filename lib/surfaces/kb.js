/**
 * Surface C — read-only knowledge source (`kb_*`).
 *
 * Everything here is a read: hot list, one video's metadata + frame, search
 * results, and a Markdown dump. No write action ever appears in this file, which
 * is what makes it safe to register by default.
 *
 * Honesty rules baked in:
 *  - search is login-gated today, so it returns `needs-login` instead of an
 *    empty list that would read like "no results";
 *  - a frame is reported with `frameSuspect` when it is suspiciously small
 *    (a flat/black capture compresses to a few KB) rather than claiming a decode.
 */
import fs from 'node:fs'
import path from 'node:path'
import { FEED_URL, cardId, parseCaption, parseCard, parseLikes } from '../adapters/douyin/feed.js'
import { targetFromUrl, resolveShareLink } from '../adapters/douyin/share.js'
import { collectByDurationShapeScript, scrollStepScript } from '../adapters/douyin/shapes.js'
import { HOT_STATE_SCRIPT, HOT_URL, collectHotScript, scrollScript } from '../adapters/douyin/hot.js'
import { noteImagesScript } from '../adapters/douyin/assets.js'
import {
  DISMISS_COACH_SCRIPT,
  MODAL_META_SCRIPT,
  VIDEO_STATE_SCRIPT,
  closeModal,
  modalIdFrom,
  modalIdOf,
  modalUrl,
  openCardScript,
  seekScript,
  videoRect,
  waitForReady,
  waitForVideo
} from '../adapters/douyin/player.js'
import { SEARCH_STATE_SCRIPT, searchUrl } from '../adapters/douyin/search.js'
import {
  COMMENTS_STATE_SCRIPT,
  collectCommentsScript,
  parseComment,
  videoPageUrl
} from '../adapters/douyin/comments.js'
import * as session from '../session.js'
import * as store from '../store.js'
import { checkBudget } from '../policy.js'
import { clampInt, defineTool, refusal } from '../tool-util.js'

const sleep = session.sleep

function budgetRefusal(cfg, day) {
  const gate = checkBudget(cfg, day)
  if (gate.ok) return null
  return refusal(gate.code, gate.error, gate.hint, { budget: gate.budget })
}

async function runHot(cfg, logger, args) {
  const limit = clampInt(args.limit, 1, 50, 20)
  const day = store.dayKey()
  const blocked = budgetRefusal(cfg, day)
  if (blocked) return blocked

  let page
  try {
    page = (await session.ensurePage(cfg, logger)).page
  } catch (err) {
    if (err?.code === 'no-browser') return refusal(err.code, err.message, err.hint)
    return refusal('browser-failed', `浏览器起不来：${err?.message ?? err}`, '先跑 dy_diagnose 看是哪一步失败。')
  }

  try {
    await page.navigate(HOT_URL, { timeoutMs: 30000 })
    const deadline = Date.now() + 25000
    let state = null
    let collected = { items: [], total: 0 }
    while (Date.now() < deadline) {
      state = await page.evaluate(HOT_STATE_SCRIPT)
      if (state.captchaVisible) {
        return refusal(
          'captcha',
          '热榜页弹出了人机验证，我停在这里。',
          '在那个浏览器窗口里手动完成验证后重新调用 kb_hot。'
        )
      }
      if (!state.empty) {
        collected = await page.evaluate(collectHotScript(Math.max(limit * 2, 30)))
        if (collected.items.length) break
      }
      await sleep(600)
    }

    // The first render holds only a screenful; page in more when the caller asked
    // for more than that. Stop as soon as scrolling stops yielding new entries, so
    // a short hot list cannot turn into four pointless scrolls.
    const seenTexts = new Set(collected.items)
    let scrollRounds = 0
    while (seenTexts.size < limit && scrollRounds < 4) {
      scrollRounds += 1
      try {
        await page.evaluate(scrollScript(1400))
      } catch {
        break
      }
      await sleep(700)
      const more = await page.evaluate(collectHotScript(Math.max(limit * 2, 30)))
      const before = seenTexts.size
      for (const text of more.items ?? []) seenTexts.add(text)
      if (seenTexts.size === before) break
    }
    collected = { items: [...seenTexts], total: Math.max(collected.total ?? 0, seenTexts.size) }

    if (!collected.items.length) {
      return refusal(
        'no-items',
        '热榜页面打开了，但一条都没解析出来。',
        '跑 dy_diagnose 看页面真实结构；热榜改版时这条最可能出现。',
        { state }
      )
    }

    const items = []
    const rows = []
    for (const text of collected.items) {
      const parsed = parseCard(text)
      if (!parsed) continue
      items.push(parsed)
      rows.push({ kind: 'hot', id: cardId(parsed), ...parsed })
      if (items.length >= limit) break
    }
    if (!items.length) {
      return refusal('no-items-parsed', '条目在，但没有一条解析出标题。', '把 kb_hot 的返回贴出来，我按真实结构改解析器。', {
        sample: collected.items.slice(0, 3)
      })
    }

    store.appendKnowledge(rows)
    store.appendJournal([
      { surface: 'kb', action: 'kb_hot', ok: true, code: 'ok', params: { limit }, evidence: { count: items.length }, cost: { modelCalls: 0 } }
    ])

    return { ok: true, code: 'ok', count: items.length, scanned: collected.items.length, url: state?.url ?? HOT_URL, items }
  } catch (err) {
    return refusal('kb-hot-failed', `热榜失败：${err?.message ?? err}`, '页面没关，可以直接重试；若是结构问题请跑 dy_diagnose。')
  }
}

async function runVideo(cfg, logger, args) {
  const day = store.dayKey()
  const blocked = budgetRefusal(cfg, day)
  if (blocked) return blocked

  const wantFrame = args.frame !== false
  const seekTo = Number.isFinite(Number(args.seekTo)) ? Math.max(0, Number(args.seekTo)) : 3
  const wantPages = clampInt(args.pages, 1, 6, 1)
  const cardIndex = clampInt(args.cardIndex, 0, 200, 0)

  // Accept a bare id, a modal URL, a /video/<id> or /note/<id> link, or the
  // v.douyin.com short link the app's "复制链接" hands you (that one 302s to a
  // share page whose path also says whether it is a video or a 图文 note).
  const rawInput = args.modalId == null ? null : String(args.modalId).trim()
  let modalIdInput = modalIdFrom(rawInput)
  let kindHint = null
  let resolvedFrom = null
  if (modalIdInput == null && rawInput) {
    const direct = targetFromUrl(rawInput)
    if (direct) {
      modalIdInput = direct.modalId
      kindHint = direct.kind
    } else {
      let resolved = null
      try {
        resolved = await resolveShareLink(rawInput)
      } catch (err) {
        logger?.warn?.(`douyin-watch: short link resolve failed: ${err?.message ?? err}`)
      }
      if (resolved) {
        modalIdInput = resolved.modalId
        kindHint = resolved.kind
        resolvedFrom = resolved.resolvedUrl ?? null
      }
    }
  }
  if (rawInput && !modalIdInput) {
    return refusal(
      'invalid-argument',
      `没能从 "${rawInput.slice(0, 80)}" 里解析出视频/图文 id。`,
      '传纯数字 id、含 modal_id= 的地址、/video/<id> 或 /note/<id> 分享链接、或 v.douyin.com 短链；也可以用 cardIndex 点开推荐流某张卡。'
    )
  }

  let page
  try {
    page = (await session.ensurePage(cfg, logger)).page
  } catch (err) {
    if (err?.code === 'no-browser') return refusal(err.code, err.message, err.hint)
    return refusal('browser-failed', `浏览器起不来：${err?.message ?? err}`, '先跑 dy_diagnose 看是哪一步失败。')
  }

  let openedVia = 'url'
  try {
    let state = null
    if (!modalIdInput) {
      openedVia = 'click'
      await page.navigate(FEED_URL, { timeoutMs: 30000 })
      const deadline = Date.now() + 20000
      let cards = 0
      while (Date.now() < deadline) {
        cards = await page.evaluate(`document.querySelectorAll('[class*="waterfall-videoCardContainer"]').length`)
        if (cards > 0) break
        await sleep(500)
      }
      await session.dismissOverlays(page, logger)

      // Some cards are topic/aggregate tiles that navigate elsewhere instead of
      // opening the player. Try the requested index, then the next one.
      let lastClick = null
      for (let attempt = 0; attempt < 2 && !state?.modalOpen; attempt++) {
        const idx = cardIndex + attempt
        lastClick = await page.evaluate(openCardScript(idx))
        if (!lastClick.ok) break
        state = await waitForVideo(page, { timeoutMs: 6000 })
        if (state?.modalOpen) break
        await closeModal(page, logger)
        await session.dismissOverlays(page, logger)
      }
      if (!lastClick?.ok) {
        return refusal('no-card', `没有第 ${cardIndex} 张卡片（页面共 ${lastClick?.total ?? 0} 张）。`, '先跑 dy_diagnose 看卡片数量，再改 cardIndex。', {
          total: lastClick?.total ?? 0
        })
      }
    } else {
      await page.navigate(modalUrl(modalIdInput), { timeoutMs: 30000 })
      state = await waitForVideo(page, { timeoutMs: 15000 })
    }

    if (!state || !state.modalOpen || !state.videoCount) {
      return refusal(
        'player-not-opened',
        '卡片点了，但没有出现播放器模态（或者它没加载出可解码的画面）。',
        '先跑 dy_diagnose；抖音改版后播放器挂载方式可能变了。窗口保持打开，可直接重试或换 cardIndex。',
        { openedVia, state }
      )
    }

    const modalId = modalIdOf(state.url) ?? modalIdInput

    // Clear the first-use coach mark, otherwise the "frame" is a picture of the
    // tutorial overlay rather than the video.
    let coach = null
    try {
      coach = await page.evaluate(DISMISS_COACH_SCRIPT)
      if (coach?.clicked || coach?.hidden) await sleep(500)
    } catch (err) {
      logger?.warn?.(`douyin-watch: coach dismissal failed: ${err?.message ?? err}`)
    }

    // The modal's own metadata is the only trustworthy description of what
    // opened; the page body is mostly nav and footer boilerplate (an earlier
    // version ran the card parser over it and reported the ICP licence text as
    // the title).
    let meta = null
    try {
      meta = await page.evaluate(MODAL_META_SCRIPT)
    } catch (err) {
      logger?.warn?.(`douyin-watch: modal meta read failed: ${err?.message ?? err}`)
    }
    const caption = parseCaption(meta?.desc)
    const nick = typeof meta?.nick === 'string' ? meta.nick.replace(/^@+\s*/, '').trim() : null
    const diggLikes = parseLikes(meta?.digg)

    const rect = (await videoRect(page)) ?? state.rect
    const visibleVideo = Boolean(rect && rect.width > 40 && rect.height > 40)

    // 图文 (image post): the page ships a hidden <video> for its background
    // audio, so `videoCount > 0` proves nothing and the video rect is 0x0. Its
    // content is a carousel — capture the viewport and step it with real mouse
    // clicks, because the arrow is a hover-only overlay.
    if (!visibleVideo) {
      const shots = []
      const view = await page.viewport().catch(() => null)
      const clickX = Math.round((view?.width ?? 1264) * 0.87)
      const clickY = Math.round((view?.height ?? 805) * 0.5)
      for (let p = 1; p <= (wantFrame ? wantPages : 0); p++) {
        if (p > 1) {
          await page.clickAt(clickX, clickY)
          await sleep(1400)
        }
        const png = await page.screenshot()
        const file = store.framePath(day, `${modalId ?? 'note'}-p${p}`)
        fs.writeFileSync(file, png)
        shots.push({ page: p, file, bytes: png.length })
      }
      // 图文原图（去重、只留竖版大图）：kb_download 与下游用它，不必重复实现
      const images = await page.evaluate(noteImagesScript()).catch(() => [])
      if (Array.isArray(images) && images.length) {
        for (const img of images.slice(0, 20)) {
          store.appendKnowledge([{ kind: 'note-image', modalId: modalId ?? null, url: img.src, width: img.w, height: img.h, title: caption.title || null }])
        }
      }
      store.appendKnowledge([
        {
          kind: 'note',
          modalId: modalId ?? null,
          url: state.url,
          title: caption.title || null,
          author: nick,
          likes: diggLikes,
          tags: caption.tags,
          images: (images || []).map((x) => x.src),
          pages: shots.map((s) => s.file)
        }
      ])
      store.appendJournal([
        {
          surface: 'kb',
          action: 'kb_video',
          ok: true,
          code: 'ok',
          target: { id: modalId ?? `card${cardIndex}`, kind: 'note' },
          evidence: { files: shots.map((s) => s.file) },
          cost: { modelCalls: 0 }
        }
      ])
      await closeModal(page, logger)
      return {
        ok: true,
        code: 'ok',
        kind: 'note',
        modalId: modalId ?? null,
        openedVia,
        url: state.url,
        resolvedFrom,
        title: caption.title || null,
        author: nick,
        likes: diggLikes,
        tags: caption.tags,
        pages: shots,
        images: (images || []).map((x) => x.src),
        frameFile: shots[0]?.file ?? null,
        note: shots.length
          ? `图文作品：截了 ${shots.length} 页（可用 pages 参数翻更多页）；它的 <video> 只是背景音频，没有可解码画面。`
          : 'frame=false：只读了元数据，没有存图。'
      }
    }

    // The modal can be open before the media is decodable; seeking then is a
    // no-op and the "frame" would be the poster image. Long videos cold-start
    // slowly (measured: 159s video ready at ~20s on a warm profile).
    const ready = await waitForReady(page, { timeoutMs: 20000 })
    const videoReady = (ready?.readyState ?? state.readyState ?? 0) >= 2

    let seek = null
    if (videoReady) {
      try {
        seek = await page.evaluate(seekScript(seekTo))
      } catch (err) {
        seek = { ok: false, reason: 'seek-error', error: String(err?.message ?? err) }
      }
    }

    let frameFile = null
    let frameBytes = 0
    let frameSuspect = false
    if (wantFrame && rect && rect.width > 40 && rect.height > 40) {
      try {
        const cap = await page.captureFrame(rect)
        frameFile = store.framePath(day, modalId ?? `card${cardIndex}`)
        fs.writeFileSync(frameFile, cap.png)
        frameBytes = cap.bytes
        // A capture only counts as a decoded frame when the media was ready AND
        // the seek landed. Otherwise it is a poster/tutorial shot: measured
        // 23KB for a poster vs 300KB–1MB for a real frame.
        frameSuspect = cap.suspect || !videoReady || !seek?.ok
      } catch (err) {
        logger?.warn?.(`douyin-watch: frame capture failed: ${err?.message ?? err}`)
      }
    }

    store.appendKnowledge([
      {
        kind: 'video',
        modalId: modalId ?? null,
        url: state.url,
        durationSec: state.duration,
        currentTime: seek?.currentTime ?? state.currentTime,
        title: caption.title || null,
        author: nick,
        likes: diggLikes,
        tags: caption.tags,
        frameFile
      }
    ])
    store.appendJournal([
      {
        surface: 'kb',
        action: 'kb_video',
        ok: true,
        code: 'ok',
        target: { id: modalId ?? `card${cardIndex}`, kind: 'video' },
        evidence: { file: frameFile },
        cost: { modelCalls: 0 }
      }
    ])

    await closeModal(page, logger)

    return {
      ok: true,
      code: 'ok',
      kind: 'video',
      modalId: modalId ?? null,
      openedVia,
      url: state.url,
      resolvedFrom,
      video: {
        durationSec: state.duration,
        currentTime: seek?.currentTime ?? state.currentTime,
        readyState: state.readyState,
        videoWidth: state.videoWidth,
        videoHeight: state.videoHeight
      },
      seek,
      coachDismissed: coach,
      videoReady,
      seekedFrame: Boolean(seek?.ok),
      title: caption.title || null,
      author: nick,
      likes: diggLikes,
      tags: caption.tags,
      desc: meta?.desc ?? null,
      frameFile,
      frameBytes,
      frameSuspect,
      frameHint: frameSuspect
        ? '截图体积偏小，可能是黑帧或尚未解码；需要视觉判断时请自行读这张图确认。'
        : null
    }
  } catch (err) {
    return refusal('kb-video-failed', `打开视频失败：${err?.message ?? err}`, '页面可能被弹层挡住；先跑 dy_diagnose，窗口保持打开可直接重试。')
  }
}

async function runSearch(cfg, logger, args) {
  const keyword = String(args.keyword ?? '').trim()
  if (!keyword) return refusal('invalid-argument', 'keyword 不能为空。', '传一个搜索关键词，例如 {"keyword":"美食"}。')
  const limit = clampInt(args.limit, 1, 50, 15)
  const day = store.dayKey()
  const blocked = budgetRefusal(cfg, day)
  if (blocked) return blocked

  let page
  try {
    page = (await session.ensurePage(cfg, logger)).page
  } catch (err) {
    if (err?.code === 'no-browser') return refusal(err.code, err.message, err.hint)
    return refusal('browser-failed', `浏览器起不来：${err?.message ?? err}`, '先跑 dy_diagnose 看是哪一步失败。')
  }

  try {
    await page.navigate(searchUrl(keyword), { timeoutMs: 30000 })
    await sleep(2000)
    let state = await page.evaluate(SEARCH_STATE_SCRIPT)

    // The results may render a moment later; re-probe once. Note the emptiness
    // signal is the *search* card count, not the feed's — search results use a
    // different class (and no anchors at all), so the feed count is always 0 here.
    if (state.needsLogin || (state.searchCardCount === 0 && state.bodyChars < 600)) {
      await sleep(2500)
      state = await page.evaluate(SEARCH_STATE_SCRIPT)
    }

    if (state.captchaVisible) {
      return refusal('captcha', '搜索页弹出了人机验证。', '在那个浏览器窗口里手动完成验证后重新调用 kb_search。', { state })
    }

    const sample = await page
      .evaluate(`(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400)`)
      .catch(() => '')

    // The wall is not always the exact string we first measured, so fall back to
    // any login phrasing rather than mislabelling it "no results".
    const looksGated = state.needsLogin || /登录后|扫码登录|请先?登录|登录即可/.test(sample)

    if (looksGated) {
      return refusal(
        'needs-login',
        '抖音搜索需要登录后才能出结果。',
        '在插件自己的浏览器窗口里扫码登录抖音（一次即可，登录态保存在 profile-<channel>/）。登录后 kb_search 可直接用；在此之前热榜与视频详情仍可用。',
        { state, sample }
      )
    }

    // Upstream trouble is not a structure change and not a login wall. Measured
    // 2026-11-21: the search backend answered `502 Bad Gateway (kngx/1.10.2)`.
    if (/50[234]\s*(Bad Gateway|Service Unavailable|Gateway Time-out)|访问过于频繁|请求过于频繁/.test(sample)) {
      return refusal(
        'upstream-error',
        '抖音搜索服务此刻返回了错误页（不是登录墙，也不是插件解析失败）。',
        '等一会儿再试；若持续出现，换关键词或用 kb_hot / kb_video 先做别的事。',
        { state, sample }
      )
    }

    // Only a genuinely blank page is "no results". A rendered page with search
    // cards but no parseable titles is a different failure, reported after the
    // shape-based collection below.
    const looksBlank = state.bodyChars < 300 && state.searchCardCount === 0
    if (looksBlank) {
      return refusal(
        'no-results',
        '搜索页几乎是空白，也没有识别到登录墙。',
        '跑 dy_diagnose 看这个页面到底是什么；抖音改版或限流时会出现这种情况。',
        { state, sample }
      )
    }

    // Signed in: results exist but are not feed cards and have no <a href>.
    // Collect by text shape, paging with scrolls until we have enough or stall.
    await session.dismissOverlays(page, logger)
    // 排序（按热度/按时间）：页面上有对应 tab 才点，没有就忽略
    if (sort === 'hot' || sort === 'time') {
      const label = sort === 'hot' ? '按热度' : '按时间'
      await page.evaluate(`(() => {
        for (const el of document.querySelectorAll('button,span,div,a')) {
          if ((el.textContent || '').trim() === ${JSON.stringify(label)}) { el.click(); return true; }
        }
        return false;
      })()`).catch(() => {})
      await sleep(800)
    }
    // 展开二级回复（只点“展开/更多回复”，不点任何发表入口）
    if (args.replies) {
      for (let i = 0; i < 6; i++) {
        const clicked = await page.evaluate(`(() => {
          let n = 0;
          for (const el of document.querySelectorAll('button,span,div,a')) {
            const t = (el.textContent || '').replace(/\\s+/g, '').trim();
            if (/^展开\\d*条?回复$|^更多回复$|^查看\\d*条回复$/.test(t)) { el.click(); n++; if (n >= 10) break; }
          }
          return n;
        })()`).catch(() => 0)
        if (!clicked) break
        await sleep(700)
      }
    }

    const seenTexts = new Set()
    let scanned = 0
    for (let round = 0; round < 4; round++) {
      const batch = await page.evaluate(collectByDurationShapeScript(Math.max(limit * 2, 30)))
      scanned = Math.max(scanned, Number(batch?.total) || 0)
      for (const text of batch?.items ?? []) seenTexts.add(text)
      if (seenTexts.size >= limit) break
      try {
        await page.evaluate(scrollStepScript(1400))
      } catch {
        break
      }
      await sleep(700)
    }

    const items = []
    const rows = []
    for (const text of seenTexts) {
      const parsed = parseCard(text)
      if (!parsed) continue
      items.push(parsed)
      rows.push({ kind: 'search', keyword, id: cardId(parsed), ...parsed })
      if (items.length >= limit) break
    }

    if (!items.length) {
      return refusal(
        'no-results-parsed',
        '搜索结果页有内容，但没有一条解析出标题。',
        '跑 dy_diagnose 看这个页面；抖音改版时搜索结果的结构最可能变。',
        { state, sample }
      )
    }

    store.appendKnowledge(rows)
    store.appendJournal([
      {
        surface: 'kb',
        action: 'kb_search',
        ok: true,
        code: 'ok',
        params: { keyword, limit },
        evidence: { count: items.length },
        cost: { modelCalls: 0 }
      }
    ])

    return { ok: true, code: 'ok', keyword, count: items.length, scanned, url: state.url, items }
  } catch (err) {
    return refusal('kb-search-failed', `搜索失败：${err?.message ?? err}`, '页面没关，可直接重试。')
  }
}

/**
 * Read one video's comments from the standalone video page.
 *
 * The modal player has no comment DOM (measured), so this navigates to
 * `/video/<id>` instead — that page renders `全部评论` plus real comment rows.
 * Read-only: it never posts, likes or replies.
 */
async function runComments(cfg, logger, args) {
  const day = store.dayKey()
  const blocked = budgetRefusal(cfg, day)
  if (blocked) return blocked
  const limit = clampInt(args.limit, 1, 100, 20)
  const cursor = clampInt(args.cursor, 0, 1000, 0)
  const sort = String(args.sort || '').toLowerCase()
  const cardIndex = clampInt(args.cardIndex, 0, 200, 0)
  const modalIdInput = modalIdFrom(args.modalId)
  if (args.modalId && !modalIdInput) {
    return refusal(
      'invalid-argument',
      `没能从 "${String(args.modalId).slice(0, 80)}" 里解析出 modal_id。`,
      '传纯数字 id、含 modal_id= 的地址，或 /video/<id> 分享链接；也可以用 cardIndex 点开推荐流某张卡。'
    )
  }

  let page
  try {
    page = (await session.ensurePage(cfg, logger)).page
  } catch (err) {
    if (err?.code === 'no-browser') return refusal(err.code, err.message, err.hint)
    return refusal('browser-failed', `浏览器起不来：${err?.message ?? err}`, '先跑 dy_diagnose 看是哪一步失败。')
  }

  try {
    let modalId = modalIdInput
    if (!modalId) {
      // Learn the id from the feed, then leave the modal — the video page is the
      // surface that actually renders comments.
      await page.navigate(FEED_URL, { timeoutMs: 30000 })
      for (let i = 0; i < 30; i++) {
        const n = await page.evaluate(`document.querySelectorAll('[class*="waterfall-videoCardContainer"]').length`)
        if (n > 0) break
        await sleep(500)
      }
      await session.dismissOverlays(page, logger)
      const clicked = await page.evaluate(openCardScript(cardIndex))
      if (!clicked.ok) {
        return refusal('no-card', `没有第 ${cardIndex} 张卡片（页面共 ${clicked.total} 张）。`, '先跑 dy_diagnose 看卡片数量，再改 cardIndex。')
      }
      const opened = await waitForVideo(page, { timeoutMs: 12000 })
      modalId = modalIdOf(opened?.url) ?? null
      await closeModal(page, logger)
      if (!modalId) {
        return refusal('player-not-opened', '点开了卡片但没拿到 modal_id。', '先跑 dy_diagnose；或直接把视频链接/ID 传给 modalId。', { opened })
      }
    }

    await page.navigate(videoPageUrl(modalId), { timeoutMs: 30000 })
    const deadline = Date.now() + 20000
    let state = null
    while (Date.now() < deadline) {
      state = await page.evaluate(COMMENTS_STATE_SCRIPT)
      if (state.captchaVisible) {
        return refusal('captcha', '评论页弹出了人机验证。', '在那个浏览器窗口里手动完成验证后重新调用 kb_comments。', { state })
      }
      if (state.hasHeading && state.candidateCount > 0) break
      await sleep(600)
    }

    if (state?.loginWall) {
      return refusal('needs-login', '评论需要登录后才能查看。', '调 dy_login 扫码登录后再试。', { state })
    }

    // 排序（按热度/按时间）：页面上有对应 tab 才点，没有就忽略
    if (sort === 'hot' || sort === 'time') {
      const label = sort === 'hot' ? '按热度' : '按时间'
      await page.evaluate(`(() => {
        for (const el of document.querySelectorAll('button,span,div,a')) {
          if ((el.textContent || '').trim() === ${JSON.stringify(label)}) { el.click(); return true; }
        }
        return false;
      })()`).catch(() => {})
      await sleep(800)
    }
    // 展开二级回复（只点“展开/更多回复”，不点任何发表入口）
    if (args.replies) {
      for (let i = 0; i < 6; i++) {
        const clicked = await page.evaluate(`(() => {
          let n = 0;
          for (const el of document.querySelectorAll('button,span,div,a')) {
            const t = (el.textContent || '').replace(/\\s+/g, '').trim();
            if (/^展开\\d*条?回复$|^更多回复$|^查看\\d*条回复$/.test(t)) { el.click(); n++; if (n >= 10) break; }
          }
          return n;
        })()`).catch(() => 0)
        if (!clicked) break
        await sleep(700)
      }
    }

    const seenTexts = new Set()
    let scanned = 0
    for (let round = 0; round < 4; round++) {
      const batch = await page.evaluate(collectCommentsScript(Math.max(limit * 2, 40)))
      scanned = Math.max(scanned, Number(batch?.total) || 0)
      for (const text of batch?.items ?? []) seenTexts.add(text)
      if (seenTexts.size >= limit) break
      try {
        await page.evaluate(`window.scrollBy(0, 1200)`)
      } catch {
        break
      }
      await sleep(800)
    }

    const comments = []
    const rows = []
    let skipped = 0
    for (const text of seenTexts) {
      const parsed = parseComment(text)
      if (!parsed) continue
      if (skipped < cursor) { skipped += 1; continue }
      comments.push(parsed)
      rows.push({ kind: 'comment', modalId, ...parsed })
      if (comments.length >= limit) break
    }

    if (!comments.length) {
      return refusal(
        'no-comments',
        '视频页打开了，但没有解析出任何评论。',
        '可能这条视频评论未开放、被折叠，或改版了。跑 dy_diagnose 看页面；换一条视频再试。',
        { state, scanned }
      )
    }

    store.appendKnowledge(rows)
    store.appendJournal([
      {
        surface: 'kb',
        action: 'kb_comments',
        ok: true,
        code: 'ok',
        target: { id: modalId },
        evidence: { count: comments.length },
        cost: { modelCalls: 0 }
      }
    ])

    return { ok: true, code: 'ok', modalId, count: comments.length, scanned, url: state?.url ?? videoPageUrl(modalId), comments }
  } catch (err) {
    return refusal('kb-comments-failed', `读取评论失败：${err?.message ?? err}`, '页面没关，可直接重试；若是结构问题请跑 dy_diagnose。')
  }
}

function buildKnowledgeMarkdown(day, rows) {
  const hot = rows.filter((r) => r.kind === 'hot')
  const videos = rows.filter((r) => r.kind === 'video')
  const searches = rows.filter((r) => r.kind === 'search')
  const comments = rows.filter((r) => r.kind === 'comment')
  const lines = [`# 抖音只读知识库 · ${day}`, '']
  lines.push(
    `- 热榜条目 **${hot.length}** · 视频详情 **${videos.length}** · 搜索结果 **${searches.length}** · 评论 **${comments.length}**`
  )
  lines.push('')

  if (hot.length) {
    lines.push('## 热榜')
    lines.push('')
    lines.push('| # | 标题 | 作者 | 时长 | 点赞 | 话题 |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    hot.forEach((r, i) => {
      const title = String(r.title ?? '').replace(/\|/g, '\\|').slice(0, 60)
      const tags = (r.tags ?? []).map((t) => `#${t}`).join(' ')
      const dur = r.durationText ?? '--'
      lines.push(`| ${i + 1} | ${title} | ${r.author ? '@' + r.author : '--'} | ${dur} | ${r.likesText ?? r.likes ?? '--'} | ${tags || '--'} |`)
    })
    lines.push('')
  }

  if (videos.length) {
    lines.push('## 视频详情')
    lines.push('')
    for (const v of videos) {
      lines.push(`- ${v.title ?? '(未解析标题)'}${v.author ? ` — @${v.author}` : ''}`)
      if (v.modalId) lines.push(`  - modal_id: \`${v.modalId}\``)
      if (v.durationSec != null) lines.push(`  - 时长: ${v.durationSec}s`)
      if (v.frameFile) lines.push(`  - 帧: \`${v.frameFile}\``)
    }
    lines.push('')
  }

  if (searches.length) {
    lines.push('## 搜索')
    lines.push('')
    const byKeyword = new Map()
    for (const s of searches) {
      if (!byKeyword.has(s.keyword)) byKeyword.set(s.keyword, [])
      byKeyword.get(s.keyword).push(s)
    }
    for (const [keyword, list] of byKeyword) {
      lines.push(`### ${keyword}（${list.length} 条）`)
      lines.push('')
      for (const s of list) {
        lines.push(`- ${String(s.title ?? '').slice(0, 80)}${s.author ? ` — @${s.author}` : ''}`)
      }
      lines.push('')
    }
  }

  if (comments.length) {
    lines.push('## 评论')
    lines.push('')
    const byVideo = new Map()
    for (const c of comments) {
      const key = c.modalId ?? '(unknown)'
      if (!byVideo.has(key)) byVideo.set(key, [])
      byVideo.get(key).push(c)
    }
    for (const [modalId, list] of byVideo) {
      lines.push(`### \`${modalId}\`（${list.length} 条）`)
      lines.push('')
      for (const c of list) {
        const who = c.author ? `${c.author}` : '匿名'
        const meta = [c.ageText, c.location].filter(Boolean).join(' · ')
        const likes = c.likes != null ? ` · ${c.likesText ?? c.likes} 赞` : ''
        lines.push(`- **${who}**：${String(c.content ?? '').slice(0, 200)}${meta ? `（${meta}${likes}）` : likes}`)
      }
      lines.push('')
    }
  }

  if (!hot.length && !videos.length && !searches.length && !comments.length) {
    lines.push('_今天还没有采集任何内容。先跑 kb_hot / kb_video / kb_search / kb_comments。_')
  }
  return lines.join('\n')
}

async function runSave(cfg, args) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(args?.day ?? '') ? args.day : store.dayKey()
  const rows = store.readKnowledge(day)
  const outDir = typeof args?.outDir === 'string' && args.outDir.trim() ? args.outDir.trim() : store.knowledgeDir()
  try {
    fs.mkdirSync(outDir, { recursive: true })
  } catch (err) {
    return refusal('invalid-outdir', `输出目录不可用：${err?.message ?? err}`, '换一个可写目录，或省略 outDir 用默认目录。')
  }
  const file = path.join(outDir, `${day}.md`)
  const markdown = buildKnowledgeMarkdown(day, rows)
  try {
    fs.writeFileSync(file, markdown, 'utf8')
  } catch (err) {
    return refusal('write-failed', `写文件失败：${err?.message ?? err}`, '检查目录权限，或换 outDir。')
  }
  store.appendJournal([
    { surface: 'kb', action: 'kb_save', ok: true, code: 'ok', params: { day }, evidence: { file }, cost: { modelCalls: 0 } }
  ])
  return {
    ok: true,
    code: 'ok',
    day,
    file,
    counts: {
      hot: rows.filter((r) => r.kind === 'hot').length,
      video: rows.filter((r) => r.kind === 'video').length,
      search: rows.filter((r) => r.kind === 'search').length
    },
    markdown
  }
}

export function buildKbTools(ctx, cfg) {
  const logger = ctx.logger
  return [
    defineTool({
      name: 'kb_hot',
      description: '读抖音热榜（匿名可用）：返回标题/作者/时长/点赞/话题，并落进本地知识库。拒绝时返回 code+hint。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '最多返回几条（默认 20，上限 50）' }
        },
        additionalProperties: false
      },
      timeoutMs: 120000,
      execute: async (args) => runHot(cfg, logger, args ?? {})
    }),
    defineTool({
      name: 'kb_video',
      description:
        '打开一条抖音视频或图文（note）并读它的元数据；视频可 seek 后抓帧，图文可逐页截图。modalId 接受纯数字 id、含 modal_id= 的地址、/video/<id>、/note/<id>，以及 v.douyin.com 短链。标题/作者/点赞取自打开的弹层本身。不声称已理解画面。',
      parameters: {
        type: 'object',
        properties: {
          cardIndex: { type: 'integer', description: '推荐流中第几张卡片（从 0 开始，默认 0）' },
          modalId: {
            type: 'string',
            description: '纯数字 id、含 modal_id= 的地址、/video/<id> 或 /note/<id> 分享链接、v.douyin.com 短链；给了就直接打开'
          },
          seekTo: { type: 'number', description: '抓帧前跳转到第几秒（默认 3）' },
          frame: { type: 'boolean', description: '是否存图（默认 true）' },
          pages: { type: 'integer', description: '图文作品最多截几页（默认 1，上限 6）' }
        },
        additionalProperties: false
      },
      timeoutMs: 150000,
      execute: async (args) => runVideo(cfg, logger, args ?? {})
    }),
    defineTool({
      name: 'kb_search',
      description: '在抖音搜索关键词并返回结构化结果。当前若未登录会明确返回 needs-login（抖音搜索需要登录）。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词' },
          limit: { type: 'integer', description: '最多返回几条（默认 15，上限 50）' }
        },
        required: ['keyword'],
        additionalProperties: false
      },
      timeoutMs: 150000,
      execute: async (args) => runSearch(cfg, logger, args ?? {})
    }),
    defineTool({
      name: 'kb_comments',
      description:
        '读取某条视频的评论（只读，不点赞不回复）。会打开独立视频页 /video/<id>——模态播放器里没有评论 DOM。可用 modalId（id/地址/分享链接）或 cardIndex 指定视频。',
      parameters: {
        type: 'object',
        properties: {
          modalId: { type: 'string', description: '纯数字 id、含 modal_id= 的地址，或 /video/<id> 分享链接' },
          cardIndex: { type: 'integer', description: '不给 modalId 时，点开推荐流第几张卡来获取 id（默认 0）' },
          limit: { type: 'integer', description: '最多读几条评论（默认 20，上限 100）' }
        },
        additionalProperties: false
      },
      timeoutMs: 180000,
      execute: async (args) => runComments(cfg, logger, args ?? {})
    }),
    defineTool({
      name: 'kb_save',
      description: '把某天采集到的知识条目（热榜/视频详情/搜索）落成一份 Markdown。',
      parameters: {
        type: 'object',
        properties: {
          day: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
          outDir: { type: 'string', description: '输出目录（默认插件数据目录下的 knowledge/）' }
        },
        additionalProperties: false
      },
      timeoutMs: 30000,
      execute: async (args) => runSave(cfg, args ?? {})
    })
  ]
}
