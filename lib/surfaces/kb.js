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
import { FEED_URL, cardId, collectScript, parseCard } from '../adapters/douyin/feed.js'
import { HOT_STATE_SCRIPT, HOT_URL, collectHotScript } from '../adapters/douyin/hot.js'
import {
  DISMISS_COACH_SCRIPT,
  VIDEO_STATE_SCRIPT,
  closeModal,
  modalIdOf,
  modalUrl,
  openCardScript,
  seekScript,
  videoRect,
  waitForReady,
  waitForVideo
} from '../adapters/douyin/player.js'
import { SEARCH_STATE_SCRIPT, searchUrl } from '../adapters/douyin/search.js'
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
        collected = await page.evaluate(collectHotScript(limit * 2))
        if (collected.items.length) break
      }
      await sleep(600)
    }

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
  const modalIdInput = typeof args.modalId === 'string' && /^\d+$/.test(args.modalId) ? args.modalId : null
  const cardIndex = clampInt(args.cardIndex, 0, 200, 0)

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

    const rect = (await videoRect(page)) ?? state.rect

    // The modal can be open before the media is decodable; seeking then is a
    // no-op and the "frame" would be the poster image.
    const ready = await waitForReady(page, { timeoutMs: 8000 })
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

    const infoText = await page
      .evaluate(`(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400)`)
      .catch(() => '')
    const parsed = parseCard(infoText)

    store.appendKnowledge([
      {
        kind: 'video',
        modalId: modalId ?? null,
        url: state.url,
        durationSec: state.duration,
        currentTime: seek?.currentTime ?? state.currentTime,
        title: parsed?.title ?? null,
        author: parsed?.author ?? null,
        tags: parsed?.tags ?? [],
        frameFile
      }
    ])
    store.appendJournal([
      {
        surface: 'kb',
        action: 'kb_video',
        ok: true,
        code: 'ok',
        target: { id: modalId ?? `card${cardIndex}` },
        evidence: { file: frameFile },
        cost: { modelCalls: 0 }
      }
    ])

    await closeModal(page, logger)

    return {
      ok: true,
      code: 'ok',
      modalId: modalId ?? null,
      openedVia,
      url: state.url,
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
      title: parsed?.title ?? null,
      author: parsed?.author ?? null,
      frameFile,
      frameBytes,
      frameSuspect,
      frameHint: frameSuspect
        ? '截图体积偏小，可能是黑帧或尚未解码；需要视觉判断时请自行读这张图确认。'
        : null,
      infoText
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

    // The results may render a moment later; re-probe once before declaring a wall.
    if (state.needsLogin || state.cardCount === 0) {
      await sleep(2500)
      state = await page.evaluate(SEARCH_STATE_SCRIPT)
    }

    if (state.captchaVisible) {
      return refusal('captcha', '搜索页弹出了人机验证。', '在那个浏览器窗口里手动完成验证后重新调用 kb_search。', { state })
    }
    if (state.needsLogin) {
      return refusal(
        'needs-login',
        '抖音搜索需要登录后才能出结果。',
        '在插件自己的浏览器窗口里扫码登录抖音（一次即可，登录态保存在 profile-<channel>/）。登录后 kb_search 可直接用；在此之前热榜与视频详情仍可用。',
        { state }
      )
    }

    const collected = await page.evaluate(collectScript(cfg.scrollRounds, cfg.scrollStepPx, limit * 3))
    const items = []
    const rows = []
    for (const entry of collected?.items ?? []) {
      const parsed = parseCard(entry.text)
      if (!parsed) continue
      items.push(parsed)
      rows.push({ kind: 'search', keyword, id: cardId(parsed), ...parsed })
      if (items.length >= limit) break
    }

    if (!items.length) {
      return refusal('no-results-parsed', '搜索结果页没有解析出条目。', '可能仍是登录墙或改版；跑 dy_diagnose 看当前页面。', { state })
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

    return { ok: true, code: 'ok', keyword, count: items.length, url: state.url, items }
  } catch (err) {
    return refusal('kb-search-failed', `搜索失败：${err?.message ?? err}`, '页面没关，可直接重试。')
  }
}

function buildKnowledgeMarkdown(day, rows) {
  const hot = rows.filter((r) => r.kind === 'hot')
  const videos = rows.filter((r) => r.kind === 'video')
  const searches = rows.filter((r) => r.kind === 'search')
  const lines = [`# 抖音只读知识库 · ${day}`, '']
  lines.push(`- 热榜条目 **${hot.length}** · 视频详情 **${videos.length}** · 搜索结果 **${searches.length}**`)
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

  if (!hot.length && !videos.length && !searches.length) {
    lines.push('_今天还没有采集任何内容。先跑 kb_hot / kb_video / kb_search。_')
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
        '打开一条抖音视频的播放器，读时长与元数据，可抓一帧存盘。用 cardIndex 点开推荐流某张卡，或用 modalId 直接重开。不声称已理解画面。',
      parameters: {
        type: 'object',
        properties: {
          cardIndex: { type: 'integer', description: '推荐流中第几张卡片（从 0 开始，默认 0）' },
          modalId: { type: 'string', description: '已知的 modal_id；给了就直接打开该视频' },
          seekTo: { type: 'number', description: '抓帧前跳转到第几秒（默认 3）' },
          frame: { type: 'boolean', description: '是否抓一帧存盘（默认 true）' }
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
