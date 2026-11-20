/**
 * Surface A — autonomous watching (`dy_*`).
 *
 * Behaviour is deliberately unchanged from v0.1.0: read cards, keep covers,
 * update memory, refresh the report. What is new here is only plumbing: it runs
 * on the shared session, and each round appends a journal entry so budgets can
 * be derived in one place instead of counted per surface.
 */
import fs from 'node:fs'
import { findBrowser, resolveBrowser } from '../cdp.js'
import {
  FEED_URL,
  cardId,
  collectScript,
  focusScript,
  parseCard
} from '../adapters/douyin/feed.js'
import * as session from '../session.js'
import * as store from '../store.js'
import { checkBudget } from '../policy.js'
import { clampInt, defineTool, refusal } from '../tool-util.js'

async function runRound(ctx, cfg, args = {}) {
  const logger = ctx.logger
  const dir = store.ensureDirs()
  const now = new Date()
  const day = store.dayKey(now)
  const quota = store.loadQuota(day)

  const gate = store.checkQuota(cfg, quota, now)
  if (!gate.ok) return refusal(gate.code, gate.error, gate.hint, { quota })

  const budgetGate = checkBudget(cfg, day)
  if (!budgetGate.ok) return refusal(budgetGate.code, budgetGate.error, budgetGate.hint, { quota })

  const wantCards = clampInt(args.cards, 1, cfg.cardsPerRound, cfg.cardsPerRound)
  const maxCards = Math.min(wantCards, cfg.dailyCards - quota.cards)
  if (maxCards <= 0) {
    return refusal('quota-cards', '本轮的额度已经用完。', '跑 dy_report 收尾，或提高 config.dailyCards。', { quota })
  }

  let handle
  try {
    handle = await session.openFeed(cfg, logger)
  } catch (err) {
    if (err?.code === 'no-browser') return refusal(err.code, err.message, err.hint)
    return refusal(
      'browser-failed',
      `浏览器起不来：${err?.message ?? err}`,
      '先跑 dy_diagnose 看是哪一步失败；必要时把 config.headless 设为 false 观察窗口。'
    )
  }

  const { page, probe, channel } = handle
  try {
    if (probe?.captchaVisible) {
      return refusal(
        'captcha',
        '抖音弹出了人机验证，我停在这里不动。',
        '在那个浏览器窗口里手动完成验证，然后重新调用 dy_watch（窗口会保持打开，不会重开）。'
      )
    }
    if (!probe || probe.cards === 0) {
      const needsLogin = Boolean(probe?.loginWall || probe?.loginModal)
      return refusal(
        needsLogin ? 'needs-login' : 'no-feed',
        needsLogin ? '抖音要求登录才能看推荐流。' : '页面打开了，但一张视频卡都没读到。',
        needsLogin
          ? '在那个浏览器窗口里扫码登录抖音，登录态会保存在本插件自己的 profile 里，只需要一次。'
          : '跑 dy_diagnose 看页面到底渲染成了什么；抖音改版时这条最可能出现。',
        { probe, channel }
      )
    }

    const collected = await page.evaluate(
      collectScript(cfg.scrollRounds, cfg.scrollStepPx, Math.max(maxCards * 4, 24))
    )
    const items = Array.isArray(collected?.items) ? collected.items : []
    if (!items.length) {
      return refusal(
        'no-cards-parsed',
        '卡片在，但一条都没解析出标题。',
        '跑 dy_diagnose，把前几条卡片的原文贴出来，我按真实结构改解析器。',
        { probe, total: collected?.total }
      )
    }

    const seen = store.loadSeen()
    const fresh = []
    for (const item of items) {
      const parsed = parseCard(item.text)
      if (!parsed) continue
      const id = cardId(parsed)
      if (seen[id]) continue
      fresh.push({ ...parsed, id, index: item.index, text: item.text })
      if (fresh.length >= maxCards) break
    }

    if (!fresh.length) {
      return {
        ok: true,
        code: 'nothing-new',
        watched: 0,
        collected: items.length,
        message: `扫到 ${items.length} 条，但都是看过的。`,
        hint: '想换一批就把 config.scrollRounds / scrollStepPx 调大，或等推荐流刷新。',
        quota
      }
    }

    // The login dialog can reappear between scrolling and capturing; clear it
    // once more so it is never baked into a cover.
    await session.dismissOverlays(page, logger)

    const watchedAt = Date.now()
    const logRows = []
    let covers = 0
    for (const item of fresh) {
      let coverFile = null
      try {
        const rect = await page.evaluate(focusScript(item.index))
        if (rect && rect.visible) {
          const png = await page.screenshot(rect)
          coverFile = store.coverPath(day, item.id)
          fs.writeFileSync(coverFile, png)
          covers++
        }
      } catch (err) {
        logger?.warn?.(`douyin-watch: cover failed for ${item.id}: ${err?.message ?? err}`)
      }
      delete item.text
      delete item.index
      logRows.push({ ts: watchedAt, day, ...item, coverFile, channel })
    }

    store.appendJsonl(`${dir}/watch-log.jsonl`, logRows)
    for (const row of logRows) seen[row.id] = watchedAt
    store.saveSeen(seen)

    const interests = store.loadInterests()
    for (const row of logRows) store.mergeInterests(interests, row, watchedAt)
    store.saveInterests(interests)

    const nextQuota = {
      day,
      cards: quota.cards + logRows.length,
      rounds: quota.rounds + 1,
      lastRunAt: watchedAt
    }
    store.saveQuota(nextQuota)

    store.appendJournal(
      logRows.map((row) => ({
        surface: 'watch',
        action: 'watch_card',
        ok: true,
        code: 'ok',
        target: { id: row.id, title: row.title, author: row.author },
        evidence: { file: row.coverFile },
        cost: { modelCalls: 0, watchSeconds: 0 }
      }))
    )

    const today = store.readJsonl(`${dir}/watch-log.jsonl`).filter((e) => e.day === day)
    const markdown = store.buildReport({
      day,
      entries: today,
      interests,
      quota: nextQuota,
      config: cfg,
      nowMs: watchedAt
    })
    const reportFile = store.writeReport(day, markdown)

    return {
      ok: true,
      code: 'ok',
      watched: logRows.length,
      covers,
      scanned: items.length,
      channel,
      quota: {
        cards: nextQuota.cards,
        rounds: nextQuota.rounds,
        dailyCards: cfg.dailyCards,
        dailyRounds: cfg.dailyRounds
      },
      reportFile,
      videos: logRows.map((r) => ({
        title: r.title,
        author: r.author,
        likes: r.likes,
        durationSec: r.durationSec,
        tags: r.tags,
        cover: r.coverFile
      })),
      next: 'dy_report 看今天的汇总；下一轮至少隔 ' + cfg.minIntervalMin + ' 分钟。'
    }
  } catch (err) {
    return refusal(
      'round-failed',
      `这一轮中途失败：${err?.message ?? err}`,
      '页面结构可能变了，先跑 dy_diagnose 看当前页面；页面本身没关，可以直接重试。'
    )
  }
}

export function buildWatchTools(ctx, cfg) {
  return [
    defineTool({
      name: 'dy_watch',
      description:
        '看一轮抖音推荐流：受每日条数/轮数/时段/冷却与预算约束，只收没看过的卡片，落盘封面与元数据并更新日报。拒绝时返回 code+hint。',
      parameters: {
        type: 'object',
        properties: {
          cards: {
            type: 'integer',
            description: `本轮最多看几条（默认 ${cfg.cardsPerRound}，不超过 config.cardsPerRound）`
          }
        },
        additionalProperties: false
      },
      execute: async (args) => runRound(ctx, cfg, args ?? {})
    }),
    defineTool({
      name: 'dy_status',
      description:
        '看额度、预算、浏览器通道与状态、数据目录与兴趣画像概要；closeBrowser=true 可以关掉专用浏览器窗口。',
      parameters: {
        type: 'object',
        properties: {
          closeBrowser: { type: 'boolean', description: '关掉本插件启动的浏览器（释放 profile 锁）' }
        },
        additionalProperties: false
      },
      timeoutMs: 30000,
      execute: async (args) => {
        const closed = args?.closeBrowser ? await session.disposeBrowser() : false
        const day = store.dayKey()
        const quota = store.loadQuota(day)
        const interests = store.loadInterests()
        const nowMs = Date.now()
        const state = session.browserState()
        const resolved = resolveBrowser(cfg.chromePath, cfg.browserChannel)
        return {
          ok: true,
          day,
          quota: {
            cards: quota.cards,
            rounds: quota.rounds,
            dailyCards: cfg.dailyCards,
            dailyRounds: cfg.dailyRounds
          },
          gate: store.checkQuota(cfg, quota),
          budget: {
            ...store.journalBudget(day),
            dailyMinutes: cfg.dailyMinutes,
            dailyModelCalls: cfg.dailyModelCalls,
            gate: checkBudget(cfg, day)
          },
          browser: {
            running: state.running,
            channel: state.channel ?? resolved.channel,
            requestedChannel: cfg.browserChannel,
            executable: resolved.executable,
            closedThisCall: closed,
            headless: cfg.headless
          },
          dataDir: store.dataDir(),
          feedUrl: FEED_URL,
          interests: {
            tags: store.topEntries(interests.tags, nowMs, 6),
            authors: store.topEntries(interests.authors, nowMs, 4)
          }
        }
      }
    }),
    defineTool({
      name: 'dy_report',
      description: '生成/读取某一天的观看日报（默认今天），返回 Markdown 与文件路径。',
      parameters: {
        type: 'object',
        properties: {
          day: { type: 'string', description: 'YYYY-MM-DD，默认今天' }
        },
        additionalProperties: false
      },
      timeoutMs: 30000,
      execute: async (args) => {
        const day = /^\d{4}-\d{2}-\d{2}$/.test(args?.day ?? '') ? args.day : store.dayKey()
        const quota = store.loadQuota(day)
        const entries = store.readJsonl(`${store.dataDir()}/watch-log.jsonl`).filter((e) => e.day === day)
        const interests = store.loadInterests()
        const markdown = store.buildReport({ day, entries, interests, quota, config: cfg, nowMs: Date.now() })
        const file = store.writeReport(day, markdown)
        return { ok: true, day, entries: entries.length, file, markdown }
      }
    }),
    defineTool({
      name: 'dy_diagnose',
      description:
        '把抖音页面此刻的真实状态倒出来（卡片数、滚动容器、验证码、登录墙、通道、前几条卡片原文），用来在改版后重新校准解析器。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 90000,
      execute: async () => {
        let handle
        try {
          handle = await session.openFeed(cfg, ctx.logger)
        } catch (err) {
          if (err?.code === 'no-browser') return refusal(err.code, err.message, err.hint)
          return refusal(
            'browser-failed',
            `浏览器起不来：${err?.message ?? err}`,
            '检查 config.browserChannel / chromePath，或先把 headless 关掉看真实窗口。'
          )
        }
        const { page, probe } = handle
        let sample = []
        try {
          const collected = await page.evaluate(collectScript(1, cfg.scrollStepPx, 6))
          sample = (collected?.items ?? []).map((i) => ({ index: i.index, text: i.text.slice(0, 220) }))
        } catch (err) {
          sample = [{ index: -1, text: `collect failed: ${err?.message ?? err}` }]
        }
        return {
          ok: true,
          probe,
          sample,
          channel: handle.channel,
          executable: findBrowser(cfg.chromePath, cfg.browserChannel),
          feedUrl: FEED_URL,
          dataDir: store.dataDir(),
          pageReused: handle.reused
        }
      }
    })
  ]
}
