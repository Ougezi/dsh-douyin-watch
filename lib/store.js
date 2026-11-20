/**
 * On-disk state for the Douyin watch loop.
 *
 * Layout under $DSH_HOME/plugin-data/dsh-douyin-watch/:
 *   quota.json       today's counters (cards / rounds / last run)
 *   seen.json        id -> first-seen timestamp, so a card is only watched once
 *   watch-log.jsonl  append-only record of every watched card
 *   interests.json   decayed interest profile derived from watched tags/authors
 *   covers/          one PNG per watched card
 *   reports/         one Markdown report per day
 *   profile/         the dedicated Chrome profile (keeps the Douyin login)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function dataDir() {
  return path.join(dshHome(), 'plugin-data', 'dsh-douyin-watch')
}

export function ensureDirs() {
  const dir = dataDir()
  // Per-browser profiles are created by session.js (profile-<channel>); the old
  // single `profile/` is only read for one-time migration, never created here.
  for (const sub of ['', 'covers', 'reports']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true })
  }
  return dir
}

export function dayKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export function appendJsonl(file, rows) {
  if (!rows.length) return
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

export function readJsonl(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const out = []
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        out.push(JSON.parse(t))
      } catch {}
    }
    return out
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- quota

export function loadQuota(day) {
  const file = path.join(dataDir(), 'quota.json')
  const raw = readJson(file, null)
  if (!raw || raw.day !== day) return { day, cards: 0, rounds: 0, lastRunAt: 0 }
  return {
    day,
    cards: Number(raw.cards) || 0,
    rounds: Number(raw.rounds) || 0,
    lastRunAt: Number(raw.lastRunAt) || 0
  }
}

export function saveQuota(quota) {
  writeJsonAtomic(path.join(dataDir(), 'quota.json'), quota)
}

/**
 * Decide whether a round may start *now*. Always returns a machine code and a
 * hint on refusal, because a silent quota refusal is indistinguishable from a
 * broken plugin.
 */
export function checkQuota(config, quota, now = new Date()) {
  const hour = now.getHours()
  const [from, to] = config.hours
  if (!(hour >= from && hour < to)) {
    return {
      ok: false,
      code: 'outside-hours',
      error: `当前 ${hour} 点不在允许观看的时段内（${from}:00–${to}:00）。`,
      hint: `想现在看就把 hours 改成包含 ${hour} 的区间，或等到 ${from} 点再来。`
    }
  }
  if (quota.rounds >= config.dailyRounds) {
    return {
      ok: false,
      code: 'quota-rounds',
      error: `今天已经看了 ${quota.rounds} 轮，达到上限 ${config.dailyRounds} 轮。`,
      hint: '提高 config.dailyRounds，或者明天再看；先跑 dy_report 把今天的看完的东西整理掉。'
    }
  }
  if (quota.cards >= config.dailyCards) {
    return {
      ok: false,
      code: 'quota-cards',
      error: `今天已经看了 ${quota.cards} 条，达到上限 ${config.dailyCards} 条。`,
      hint: '提高 config.dailyCards，或者明天再看；先跑 dy_report。'
    }
  }
  const gap = config.minIntervalMin * 60000
  const since = now.getTime() - (quota.lastRunAt || 0)
  if (quota.lastRunAt && since < gap) {
    const waitMin = Math.ceil((gap - since) / 60000)
    return {
      ok: false,
      code: 'cooldown',
      error: `距离上一轮只过了 ${Math.floor(since / 60000)} 分钟，还差 ${waitMin} 分钟。`,
      hint: `等 ${waitMin} 分钟后再来，或把 config.minIntervalMin 调小。`
    }
  }
  return { ok: true, remainingCards: config.dailyCards - quota.cards, remainingRounds: config.dailyRounds - quota.rounds }
}

// ---------------------------------------------------------------- seen

const SEEN_LIMIT = 5000

export function loadSeen() {
  const raw = readJson(path.join(dataDir(), 'seen.json'), {})
  return raw && typeof raw === 'object' ? raw : {}
}

export function saveSeen(seen) {
  const entries = Object.entries(seen)
  if (entries.length > SEEN_LIMIT) {
    entries.sort((a, b) => (a[1] || 0) - (b[1] || 0))
    seen = Object.fromEntries(entries.slice(entries.length - SEEN_LIMIT))
  }
  writeJsonAtomic(path.join(dataDir(), 'seen.json'), seen)
}

// ---------------------------------------------------------------- interests

const DEFAULT_HALF_LIFE_DAYS = 14

/** Exponential forgetting with reactivation on re-encounter (spacing effect). */
export function decayedSalience(entry, nowMs, halfLifeDays = DEFAULT_HALF_LIFE_DAYS) {
  if (!entry) return 0
  const ageDays = Math.max(0, (nowMs - (entry.last || 0)) / 86400000)
  return (entry.s || 0) * Math.pow(0.5, ageDays / halfLifeDays)
}

export function reinforce(entry, nowMs, weight = 0.35) {
  const base = decayedSalience(entry, nowMs)
  return {
    s: Math.min(1, base + weight * (1 - base)),
    n: (entry?.n || 0) + 1,
    last: nowMs
  }
}

export function loadInterests() {
  const raw = readJson(path.join(dataDir(), 'interests.json'), null)
  return {
    tags: raw?.tags && typeof raw.tags === 'object' ? raw.tags : {},
    authors: raw?.authors && typeof raw.authors === 'object' ? raw.authors : {}
  }
}

export function saveInterests(interests) {
  writeJsonAtomic(path.join(dataDir(), 'interests.json'), interests)
}

export function mergeInterests(interests, record, nowMs) {
  for (const tag of record.tags ?? []) {
    interests.tags[tag] = reinforce(interests.tags[tag], nowMs)
  }
  if (record.author) {
    interests.authors[record.author] = reinforce(interests.authors[record.author], nowMs)
  }
  return interests
}

export function topEntries(map, nowMs, limit = 5) {
  return Object.entries(map)
    .map(([name, entry]) => ({ name, salience: Number(decayedSalience(entry, nowMs).toFixed(3)), seen: entry.n || 0 }))
    .filter((e) => e.salience > 0.001)
    .sort((a, b) => b.salience - a.salience)
    .slice(0, limit)
}

// ---------------------------------------------------------------- journal

/**
 * One append-only stream for every surface (watch / kb / ops). Budgets, reports
 * and audits are all derived from here, so the three surfaces can never disagree
 * about how much was spent.
 */
export function appendJournal(rows) {
  if (!rows || !rows.length) return 0
  const now = Date.now()
  const day = dayKey(new Date(now))
  const stamped = rows.map((r) => ({ ts: now, day, ...r }))
  appendJsonl(path.join(dataDir(), 'journal.jsonl'), stamped)
  return stamped.length
}

export function readJournal(day) {
  const rows = readJsonl(path.join(dataDir(), 'journal.jsonl'))
  return day ? rows.filter((r) => r.day === day) : rows
}

/** Aggregate today's spend from the journal; the single source for all budgets. */
export function journalBudget(day) {
  const rows = readJournal(day)
  const sum = { modelCalls: 0, watchSeconds: 0, writeActions: 0, events: rows.length, bySurface: {} }
  for (const row of rows) {
    const cost = row.cost ?? {}
    sum.modelCalls += Number(cost.modelCalls) || 0
    sum.watchSeconds += Number(cost.watchSeconds) || 0
    if (row.surface === 'ops' && row.ok) sum.writeActions += 1
    sum.bySurface[row.surface] = (sum.bySurface[row.surface] || 0) + 1
  }
  return sum
}

// ---------------------------------------------------------------- knowledge

/**
 * Read-only knowledge items collected by the `kb_*` surface. Kept apart from
 * watch-log so a plain `dy_report` never has to filter out hot-list rows.
 */
export function appendKnowledge(rows) {
  if (!rows || !rows.length) return 0
  const now = Date.now()
  const day = dayKey(new Date(now))
  const stamped = rows.map((r) => ({ ts: now, day, ...r }))
  appendJsonl(path.join(dataDir(), 'knowledge.jsonl'), stamped)
  return stamped.length
}

export function readKnowledge(day) {
  const rows = readJsonl(path.join(dataDir(), 'knowledge.jsonl'))
  return day ? rows.filter((r) => r.day === day) : rows
}

export function framePath(day, id) {
  const dir = path.join(dataDir(), 'frames', day)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${id}.png`)
}

export function knowledgeDir() {
  const dir = path.join(dataDir(), 'knowledge')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------- report

function fmtDuration(sec) {
  if (!sec && sec !== 0) return '--'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function fmtLikes(n) {
  if (n == null) return '--'
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`
  return String(n)
}

export function buildReport({ day, entries, interests, quota, config, nowMs }) {
  const lines = []
  lines.push(`# 抖音观看日报 · ${day}`)
  lines.push('')
  lines.push(`- 今天看了 **${entries.length}** 条（额度 ${quota.cards}/${config.dailyCards} 条，${quota.rounds}/${config.dailyRounds} 轮）`)
  const playedRows = entries.filter((e) => e.modalId)
  const framed = entries.filter((e) => e.frameFile).length
  const playedSec = playedRows.reduce((a, e) => a + (Number(e.durationSec) || 0), 0)
  const allSec = entries.reduce((a, e) => a + (Number(e.durationSec) || 0), 0)
  if (playedRows.length) {
    // Only count videos that actually entered the player. A failed open still
    // carries the card's advertised duration, and summing that would inflate the
    // budget line (measured: 69 min reported vs 23.8 min actually opened).
    lines.push(
      `- 打开的视频总时长 **${Math.round(playedSec / 60)} 分钟**（${playedRows.length} 条进入播放器，抓帧 ${framed} 张）——这是元数据与帧的读数，不等于"我看完了"`
    )
  } else if (allSec) {
    lines.push(`- 卡片标称总时长 **${Math.round(allSec / 60)} 分钟**（未进入播放器，仅封面与文案读数）`)
  }
  if (entries.length) {
    const known = entries.filter((e) => e.likes != null).sort((a, b) => b.likes - a.likes)
    if (known.length) lines.push(`- 最高赞：**${fmtLikes(known[0].likes)}** — ${known[0].title}`)
  }
  lines.push('')

  const tags = topEntries(interests.tags, nowMs, 8)
  if (tags.length) {
    lines.push('## 兴趣轮廓（按衰减后的显著度）')
    lines.push('')
    lines.push('| 话题 | 显著度 | 累计出现 |')
    lines.push('| --- | --- | --- |')
    for (const t of tags) lines.push(`| #${t.name} | ${t.salience} | ${t.seen} |`)
    lines.push('')
  }

  const authors = topEntries(interests.authors, nowMs, 5)
  if (authors.length) {
    lines.push('## 反复出现的作者')
    lines.push('')
    lines.push('| 作者 | 显著度 | 累计出现 |')
    lines.push('| --- | --- | --- |')
    for (const a of authors) lines.push(`| @${a.name} | ${a.salience} | ${a.seen} |`)
    lines.push('')
  }

  lines.push('## 今日清单')
  lines.push('')
  if (!entries.length) {
    lines.push('_今天还没有观看记录。_')
  } else {
    lines.push('| # | 标题 | 作者 | 时长 | 点赞 | 话题 |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    entries.forEach((e, i) => {
      const title = String(e.title ?? '').replace(/\|/g, '\\|').slice(0, 60)
      const tagsCell = (e.tags ?? []).map((t) => `#${t}`).join(' ')
      lines.push(`| ${i + 1} | ${title} | ${e.author ? '@' + e.author : '--'} | ${fmtDuration(e.durationSec)} | ${fmtLikes(e.likes)} | ${tagsCell || '--'} |`)
    })
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('_由 dsh-douyin-watch 生成：额度、去重与兴趣衰减都在本地，没有账号数据离开这台机器。_')
  return lines.join('\n')
}

export function writeReport(day, markdown) {
  const file = path.join(dataDir(), 'reports', `${day}.md`)
  fs.writeFileSync(file, markdown, 'utf8')
  return file
}

export function coverPath(day, id) {
  const dir = path.join(dataDir(), 'covers', day)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${id}.png`)
}
