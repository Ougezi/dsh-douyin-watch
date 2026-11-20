/**
 * dsh-douyin-watch — an autonomous Douyin watching loop with a quota, a decayed
 * interest memory and a daily report.
 *
 * Design notes (why it looks like this):
 *  - It drives its own Chrome through CDP instead of borrowing another plugin's
 *    browser. A shared runtime means a silent breakage whenever that plugin
 *    updates; this module only needs Node 22+ (global WebSocket) and a browser.
 *  - It keeps its own Chrome profile, so the one-time Douyin login survives.
 *  - "Watching" here means: read the card's metadata and keep its cover frame.
 *    Douyin's PC feed only mounts a real <video> after opening a card, so this
 *    plugin never claims to have decoded video it did not decode.
 *  - Every refusal carries a machine `code` and a human `hint`; a quota that
 *    refuses silently is indistinguishable from a broken plugin.
 */
import fs from 'node:fs'
import { Browser, findBrowser, browserCandidates } from './lib/cdp.js'
import {
  FEED_URL,
  PROBE_SCRIPT,
  DISMISS_OVERLAY_SCRIPT,
  cardId,
  collectScript,
  focusScript,
  parseCard
} from './lib/feed.js'
import * as store from './lib/store.js'

export const inject = ['tools']

const DEFAULTS = {
  cardsPerRound: 10,
  dailyCards: 40,
  dailyRounds: 4,
  minIntervalMin: 30,
  hours: [8, 24],
  headless: false,
  chromePath: '',
  scrollRounds: 4,
  scrollStepPx: 700
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function resolveConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  cfg.cardsPerRound = clampInt(cfg.cardsPerRound, 1, 40, DEFAULTS.cardsPerRound)
  cfg.dailyCards = clampInt(cfg.dailyCards, 1, 500, DEFAULTS.dailyCards)
  cfg.dailyRounds = clampInt(cfg.dailyRounds, 1, 50, DEFAULTS.dailyRounds)
  cfg.minIntervalMin = clampInt(cfg.minIntervalMin, 0, 1440, DEFAULTS.minIntervalMin)
  cfg.scrollRounds = clampInt(cfg.scrollRounds, 1, 12, DEFAULTS.scrollRounds)
  const h = Array.isArray(cfg.hours) && cfg.hours.length === 2 ? cfg.hours.map(Number) : DEFAULTS.hours
  cfg.hours = [clampInt(h[0], 0, 23, 8), clampInt(h[1], 1, 24, 24)]
  if (cfg.hours[1] <= cfg.hours[0]) cfg.hours = [cfg.hours[0], 24]
  cfg.headless = cfg.headless === true
  cfg.chromePath = typeof cfg.chromePath === 'string' ? cfg.chromePath : ''
  return cfg
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** One browser + one page per process, reused across calls.
 *
 * Closing the last page terminates Chrome (measured: exitCode becomes 0 right
 * after Page.close), so a per-call open/close cycle would tear the window down
 * between rounds — which is exactly wrong for a captcha or a login wall, where
 * the user needs that same window to stay put.
 */
let currentBrowser = null
let currentPage = null

async function pageAlive(page) {
  if (!page) return false
  try {
    await page.evaluate('1')
    return true
  } catch {
    return false
  }
}

async function getBrowser(cfg) {
  if (currentBrowser && currentBrowser.child && currentBrowser.child.exitCode === null) {
    return { browser: currentBrowser, reused: true }
  }
  const executable = findBrowser(cfg.chromePath)
  if (!executable) {
    const tried = browserCandidates(cfg.chromePath).slice(0, 4).join(' | ')
    const error = new Error('没有找到 Chrome / Edge / Chromium 可执行文件')
    error.code = 'no-browser'
    error.hint = `装一个 Chrome，或把 config.chromePath 指到浏览器 exe。试过：${tried}`
    throw error
  }
  const dir = store.ensureDirs()
  const browser = await Browser.launch({
    executable,
    userDataDir: `${dir}/profile`,
    headless: cfg.headless
  })
  currentBrowser = browser
  return { browser, reused: false, executable }
}

async function ensurePage(cfg) {
  if (currentPage && currentBrowser && currentBrowser.child.exitCode === null && (await pageAlive(currentPage))) {
    return { page: currentPage, reused: true }
  }
  await disposeBrowser()
  const { browser } = await getBrowser(cfg)
  const page = await browser.newPage('about:blank')
  await page.enable()
  currentPage = page
  return { page, reused: false }
}

async function disposeBrowser() {
  const b = currentBrowser
  currentBrowser = null
  currentPage = null
  if (!b) return false
  try {
    await b.dispose()
  } catch {}
  return true
}

/** Get the login overlay out of the way so covers and scrolling stay usable. */
async function dismissOverlays(ctx, page) {
  try {
    const result = await page.evaluate(DISMISS_OVERLAY_SCRIPT)
    if (result?.found && result.action === 'none') {
      await page.pressEscape()
      await sleep(350)
    }
    return result
  } catch (err) {
    ctx.logger?.warn?.(`douyin-watch: overlay dismiss failed: ${err?.message ?? err}`)
    return null
  }
}

/** Open the feed and poll until cards, a login wall or a captcha appears. */
async function openFeed(ctx, cfg, { waitMs = 25000 } = {}) {
  const { page, reused } = await ensurePage(cfg)
  await page.navigate(FEED_URL, { timeoutMs: 30000 })
  const deadline = Date.now() + waitMs
  let probe = null
  while (Date.now() < deadline) {
    try {
      probe = await page.evaluate(PROBE_SCRIPT)
    } catch (err) {
      ctx.logger?.warn?.(`douyin-watch: probe failed: ${err?.message ?? err}`)
    }
    if (probe && (probe.cards > 0 || probe.captchaVisible)) break
    await sleep(600)
  }
  if (probe?.loginModal) {
    await dismissOverlays(ctx, page)
    try {
      probe = await page.evaluate(PROBE_SCRIPT)
    } catch {}
  }
  return { page, probe, reused }
}

function refusal(code, error, hint, extra = {}) {
  return { ok: false, code, error, hint, ...extra }
}

// ------------------------------------------------------------------ round

async function runRound(ctx, cfg, args = {}) {
  const dir = store.ensureDirs()
  const now = new Date()
  const day = store.dayKey(now)
  const quota = store.loadQuota(day)

  const gate = store.checkQuota(cfg, quota, now)
  if (!gate.ok) return refusal(gate.code, gate.error, gate.hint, { quota })

  const wantCards = clampInt(args.cards, 1, cfg.cardsPerRound, cfg.cardsPerRound)
  const maxCards = Math.min(wantCards, cfg.dailyCards - quota.cards)
  if (maxCards <= 0) {
    return refusal('quota-cards', '本轮的额度已经用完。', '跑 dy_report 收尾，或提高 config.dailyCards。', { quota })
  }

  let handle
  try {
    handle = await openFeed(ctx, cfg)
  } catch (err) {
    if (err?.code === 'no-browser') return refusal(err.code, err.message, err.hint)
    return refusal('browser-failed', `浏览器起不来：${err?.message ?? err}`, '先跑 dy_diagnose 看是哪一步失败；必要时把 config.headless 设为 false 观察窗口。')
  }

  const { page, probe } = handle
  try {
    if (probe?.captchaVisible) {
      return refusal(
        'captcha',
        '抖音弹出了人机验证，我停在这里不动。',
        '在那个 Chrome 窗口里手动完成验证，然后重新调用 dy_watch（浏览器会保持打开，不会重开）。'
      )
    }
    if (!probe || probe.cards === 0) {
      const needsLogin = Boolean(probe?.loginWall || probe?.loginModal)
      return refusal(
        needsLogin ? 'needs-login' : 'no-feed',
        needsLogin ? '抖音要求登录才能看推荐流。' : '页面打开了，但一张视频卡都没读到。',
        needsLogin
          ? '在那个 Chrome 窗口里扫码登录抖音，登录态会保存在本插件自己的 profile 里，只需要一次。'
          : '跑 dy_diagnose 看页面到底渲染成了什么；抖音改版时这条最可能出现。',
        { probe }
      )
    }

    const collected = await page.evaluate(
      collectScript(cfg.scrollRounds, cfg.scrollStepPx, Math.max(maxCards * 4, 24))
    )
    const items = Array.isArray(collected?.items) ? collected.items : []
    if (!items.length) {
      return refusal('no-cards-parsed', '卡片在，但一条都没解析出标题。', '跑 dy_diagnose，把前几条卡片的原文贴出来，我按真实结构改解析器。', { probe, total: collected?.total })
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

    // The login dialog can appear again between scrolling and capturing; get rid
    // of it once more so it is never baked into a cover.
    await dismissOverlays(ctx, page)

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
        ctx.logger?.warn?.(`douyin-watch: cover failed for ${item.id}: ${err?.message ?? err}`)
      }
      delete item.text
      delete item.index
      logRows.push({ ts: watchedAt, day, ...item, coverFile })
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

    const today = store.readJsonl(`${dir}/watch-log.jsonl`).filter((e) => e.day === day)
    const markdown = store.buildReport({ day, entries: today, interests, quota: nextQuota, config: cfg, nowMs: watchedAt })
    const reportFile = store.writeReport(day, markdown)

    return {
      ok: true,
      code: 'ok',
      watched: logRows.length,
      covers,
      scanned: items.length,
      quota: { cards: nextQuota.cards, rounds: nextQuota.rounds, dailyCards: cfg.dailyCards, dailyRounds: cfg.dailyRounds },
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
    return refusal('round-failed', `这一轮中途失败：${err?.message ?? err}`, '页面结构可能变了，先跑 dy_diagnose 看当前页面；页面本身没关，可以直接重试。')
  }
}

// ------------------------------------------------------------------ tools

/** Model-facing text blocks. `output.render` is a required part of a ToolDefinition. */
function renderText(value) {
  let text
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
  }
  if (text.length > 12000) text = `${text.slice(0, 12000)}\n… (${text.length - 12000} more chars)`
  return [{ type: 'text', text }]
}

function defineTool(def) {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
    // Required: the registry rejects a definition without a renderer, and a
    // swallowed rejection looks exactly like "the plugin did nothing".
    output: {
      schema: { type: 'object' },
      render: (_args, value) => renderText(value)
    },
    timeoutMs: def.timeoutMs ?? 180000,
    execute: def.execute
  }
}

function buildTools(ctx, cfg) {
  return [
    defineTool({
      name: 'dy_watch',
      description:
        '看一轮抖音推荐流：受每日条数/轮数/时段/冷却四道额度约束，只收没看过的卡片，落盘封面与元数据并更新日报。拒绝时返回 code+hint。',
      parameters: {
        type: 'object',
        properties: {
          cards: { type: 'integer', description: `本轮最多看几条（默认 ${cfg.cardsPerRound}，不超过 config.cardsPerRound）` }
        },
        additionalProperties: false
      },
      execute: async (args) => runRound(ctx, cfg, args ?? {})
    }),
    defineTool({
      name: 'dy_status',
      description: '看额度、浏览器状态、数据目录与兴趣画像概要；closeBrowser=true 可以关掉那个专用 Chrome 窗口。',
      parameters: {
        type: 'object',
        properties: {
          closeBrowser: { type: 'boolean', description: '关掉本插件启动的 Chrome（释放 profile 锁）' }
        },
        additionalProperties: false
      },
      timeoutMs: 30000,
      execute: async (args) => {
        const closed = args?.closeBrowser ? await disposeBrowser() : false
        const day = store.dayKey()
        const quota = store.loadQuota(day)
        const interests = store.loadInterests()
        const nowMs = Date.now()
        const running = Boolean(currentBrowser && currentBrowser.child && currentBrowser.child.exitCode === null)
        return {
          ok: true,
          day,
          quota: { cards: quota.cards, rounds: quota.rounds, dailyCards: cfg.dailyCards, dailyRounds: cfg.dailyRounds },
          gate: store.checkQuota(cfg, quota),
          browser: { running, closedThisCall: closed, headless: cfg.headless, executable: findBrowser(cfg.chromePath) },
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
      description: '把抖音页面此刻的真实状态倒出来（卡片数、滚动容器、验证码、登录墙、前几条卡片原文），用来在改版后重新校准解析器。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 90000,
      execute: async () => {
        let handle
        try {
          handle = await openFeed(ctx, cfg)
        } catch (err) {
          if (err?.code === 'no-browser') return refusal(err.code, err.message, err.hint)
          return refusal('browser-failed', `浏览器起不来：${err?.message ?? err}`, '检查 config.chromePath，或先把 headless 关掉看真实窗口。')
        }
        const { page, probe } = handle
        let sample = []
        try {
          const collected = await page.evaluate(collectScript(1, cfg.scrollStepPx, 6))
          sample = (collected?.items ?? []).map((i) => ({ index: i.index, text: i.text.slice(0, 220) }))
        } catch (err) {
          sample = [{ index: -1, text: `collect failed: ${err?.message ?? err}` }]
        }
        return { ok: true, probe, sample, feedUrl: FEED_URL, dataDir: store.dataDir(), pageReused: handle.reused }
      }
    })
  ]
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  store.ensureDirs()
  const registered = []
  for (const tool of buildTools(ctx, cfg)) {
    // No try/catch here on purpose: a registration failure must surface in the
    // Loader (failed entry, visible in Plugins) instead of leaving the agent with
    // a plugin that silently has no tools.
    const off = ctx.tools.register(tool)
    registered.push(tool.name)
    ctx.effect?.(() => off)
  }
  ctx.effect?.(() => {
    return () => {
      disposeBrowser().catch(() => {})
    }
  })
  ctx.logger?.info?.(
    `douyin-watch: ready (${registered.length} tools: ${registered.join(', ')}; data=${store.dataDir()}; chrome=${findBrowser(cfg.chromePath) ?? 'not found'})`
  )
}
