/**
 * Surface D — downloads, user pages, collections, live status, search users,
 * exports/index, batch runs, account profiles and gated write ops.
 *
 * Every tool here is opt-in via its `enable*` flag and returns the same
 * `{ok, code, hint, ...}` envelope as the rest of the plugin. Write ops stay
 * behind `enableOps` + `ops.allowLike/allowCollect` and require `confirm: true`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { videoPageUrl } from '../adapters/douyin/comments.js'
import {
  liveStateScript,
  noteImagesScript,
  pageAssetUrlsScript,
  searchUsersScript,
  userPostsScript,
  userTabsScript,
  videoSourceScript
} from '../adapters/douyin/assets.js'
import { FEED_URL } from '../adapters/douyin/feed.js'
import { closeModal, modalIdFrom, modalIdOf, waitForVideo } from '../adapters/douyin/player.js'
import { targetFromUrl, resolveShareLink } from '../adapters/douyin/share.js'
import { searchUrl } from '../adapters/douyin/search.js'
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

async function getPage(cfg, logger) {
  try {
    return { page: (await session.ensurePage(cfg, logger)).page }
  } catch (err) {
    if (err?.code === 'no-browser') return { error: refusal(err.code, err.message, err.hint) }
    return { error: refusal('browser-failed', `浏览器起不来：${err?.message ?? err}`, '先跑 dy_diagnose 看是哪一步失败。') }
  }
}

async function resolveIdArgs(args, page = null) {
  const raw = args.modalId ?? args.id ?? args.url ?? ''
  if (!raw) return { error: refusal('invalid-argument', '缺 modalId（视频/图文 id、链接或短链）。', '传纯数字 id、/video/<id>、/note/<id> 或 v.douyin.com 短链。') }
  const direct = modalIdFrom(raw)
  if (direct) return { kind: /\/note\//.test(String(raw)) ? 'note' : 'video', id: direct, from: raw }
  const t = targetFromUrl(raw)
  if (t?.id) return { kind: t.kind === 'note' ? 'note' : 'video', id: t.id, from: raw }
  if (/v\.douyin\.com/i.test(String(raw))) {
    const resolved = await resolveShareLink(raw).catch(() => null)
    const rid = resolved?.modalId ?? resolved?.id
    if (rid) return { kind: resolved.kind === 'note' ? 'note' : 'video', id: rid, from: raw }
    try {
      const res = await fetch(String(raw), {
        redirect: 'follow',
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/157.0 Safari/537.36' },
        signal: AbortSignal.timeout(10000)
      })
      const t3 = targetFromUrl(res.url)
      if (t3?.id) return { kind: t3.kind === 'note' ? 'note' : 'video', id: t3.id, from: raw, via: 'redirect' }
    } catch {}
    // 短链没在 HTTP 层跳出来（分享页是 JS 壳）：用浏览器打开，看最终地址
    if (page) {
      try {
        await page.navigate(String(raw), { timeoutMs: 30000 })
        await session.dismissOverlays(page, { info() {}, warn() {}, error() {} }).catch(() => {})
        await sleep(1500)
        const href = await page.evaluate('location.href')
        const t2 = targetFromUrl(href)
        if (t2?.id) return { kind: t2.kind === 'note' ? 'note' : 'video', id: t2.id, from: raw, via: 'browser', resolvedUrl: href }
      } catch {}
    }
  }
  return { error: refusal('invalid-argument', `没能从 "${String(raw).slice(0, 80)}" 里解析出 id。`, '传纯数字 id、分享链接或短链。') }
}

// ---------------------------------------------------------------- downloads

function downloadsRoot(cfg) {
  const base = cfg.downloadDir && String(cfg.downloadDir).trim()
    ? String(cfg.downloadDir)
    : path.join(store.dataDir(), 'downloads')
  fs.mkdirSync(base, { recursive: true })
  return base
}

function manifestPath(cfg) {
  return path.join(downloadsRoot(cfg), 'manifest.json')
}

function loadManifest(cfg) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(cfg), 'utf8'))
  } catch {
    return { version: 1, items: {} }
  }
}

function saveManifest(cfg, manifest) {
  const file = manifestPath(cfg)
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 1), 'utf8')
  fs.renameSync(tmp, file)
}

/** 带 cookie 抓一个 URL，返回 { ok, bytes, b64 }；优先 Node fetch（页面里的安全 SDK 会拦 fetch） */
async function fetchBase64(page, url) {
  let cookie = ''
  try {
    const list = await page.cookies('douyin.com')
    cookie = (Array.isArray(list) ? list : []).map((c) => `${c.name}=${c.value}`).join('; ')
  } catch {}
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
        Referer: 'https://www.douyin.com/',
        ...(cookie ? { Cookie: cookie } : {})
      },
      signal: AbortSignal.timeout(30000)
    })
    if (!res.ok) return { ok: false, status: res.status }
    const buf = Buffer.from(await res.arrayBuffer())
    return { ok: true, status: res.status, bytes: buf.length, b64: buf.toString('base64') }
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message ?? err) }
  }
}

function safeName(s) {
  return String(s || 'file').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)
}

async function runDownload(cfg, logger, args) {
  const day = store.dayKey()
  const blocked = budgetRefusal(cfg, day)
  if (blocked) return blocked
  let resolved = await resolveIdArgs(args)
  let page0 = null
  if (resolved.error) {
    const got = await getPage(cfg, logger)
    if (got.error) return resolved.error
    page0 = got.page
    resolved = await resolveIdArgs(args, page0)
  } else {
    const got = await getPage(cfg, logger)
    if (got.error) return got.error
    page0 = got.page
  }
  if (resolved.error) return resolved.error
  const page = page0

  const want = new Set(
    (Array.isArray(args.parts) && args.parts.length ? args.parts : ['video', 'images', 'audio', 'cover'])
      .map((x) => String(x).toLowerCase())
  )

  const manifest = loadManifest(cfg)
  const cached = manifest.items[resolved.id]
  if (args.resume !== false && cached && cached.files?.length) {
    const alive = cached.files.every((f) => fs.existsSync(path.join(downloadsRoot(cfg), f.file)))
    if (alive) return { ok: true, code: 'cached', id: resolved.id, kind: cached.kind, files: cached.files, skipped: true, manifest: manifestPath(cfg) }
  }

  const dir = path.join(downloadsRoot(cfg), day, `${resolved.kind}-${resolved.id}`)
  fs.mkdirSync(dir, { recursive: true })
  const files = []
  const errors = []
  let title = ''
  let author = ''
  let visited = ''

  const save = async (name, b64, bytes) => {
    const file = safeName(name)
    fs.writeFileSync(path.join(dir, file), Buffer.from(b64, 'base64'))
    files.push({ file: path.relative(downloadsRoot(cfg), path.join(dir, file)).replace(/\\/g, '/'), bytes, kind: name.split('.')[0] })
  }

  const noteUrl = `https://www.douyin.com/note/${resolved.id}`
  const videoUrl = videoPageUrl(resolved.id)
  const pages = resolved.kind === 'note' ? [noteUrl, videoUrl] : [videoUrl, noteUrl]

  try {
    for (const candidate of pages) {
      if (files.length) break
      visited = candidate
      await page.navigate(candidate, { timeoutMs: 30000 })
      await session.dismissOverlays(page, logger)
      await sleep(2200)
      const meta = await page.evaluate(`(() => {
        const pick = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
        const t = pick('[data-e2e="video-desc"]') || pick('meta[property="og:title"]') || document.title || '';
        const a = pick('[data-e2e="video-author"]') || pick('[data-e2e="feed-video-nickname"]') || '';
        return { title: t.slice(0, 160), author: a.slice(0, 80), imgs: document.querySelectorAll('img').length };
      })()`).catch(() => null)
      if (meta) {
        if (meta.title) title = meta.title
        if (meta.author) author = meta.author
      }
      if (!meta || !meta.imgs) continue

      if (want.has('images')) {
        const imgs = await page.evaluate(noteImagesScript()).catch(() => [])
        for (let i = 0; i < (imgs?.length ?? 0) && i < 20; i += 1) {
          const got = await fetchBase64(page, imgs[i].src)
          if (!got?.ok) { errors.push({ url: imgs[i].src, status: got?.status }); continue }
          await save(`image-${String(i + 1).padStart(2, '0')}.jpg`, got.b64, got.bytes)
        }
      }

      if (want.has('video')) {
        const cands = [
          ...((await page.evaluate(videoSourceScript()).catch(() => [])) || []),
          ...(((await page.evaluate(pageAssetUrlsScript()).catch(() => [])) || []).filter((u) => /\.mp4|play_addr|playwm|video\/tos/i.test(u)))
        ]
        for (const src of cands.slice(0, 4)) {
          const got = await fetchBase64(page, src)
          if (!got?.ok || !got.bytes) { errors.push({ url: src, status: got?.status }); continue }
          await save('video.mp4', got.b64, got.bytes)
          break
        }
      }

      if (want.has('audio') || want.has('cover')) {
        const cands = (await page.evaluate(pageAssetUrlsScript()).catch(() => [])) || []
        for (const src of cands) {
          const isAudio = /\.m4a|music|audio/i.test(src)
          const isCover = /\.jpe?g|\.png|douyinpic|cover/i.test(src) && !isAudio
          if (want.has('audio') && isAudio) {
            const got = await fetchBase64(page, src)
            if (got?.ok) { await save('audio.m4a', got.b64, got.bytes); break }
          } else if (want.has('cover') && isCover) {
            const got = await fetchBase64(page, src)
            if (got?.ok) { await save('cover.jpg', got.b64, got.bytes); break }
          }
        }
      }
    }

    if (!files.length) {
      return refusal(
        'download-empty',
        '页面打开了，但没有下载到任何文件。',
        '视频地址可能是 blob/MSE 或需要登录；先 dy_login，再试 note（图文）或换一条视频。',
        { visited, errors: errors.slice(0, 5), title }
      )
    }

    const entry = { id: resolved.id, kind: resolved.kind, title, author, at: new Date().toISOString(), dir: path.relative(downloadsRoot(cfg), dir).replace(/\\/g, '/'), files }
    manifest.items[resolved.id] = entry
    saveManifest(cfg, manifest)
    store.appendJournal([{ surface: 'ext', action: 'kb_download', ok: true, code: 'ok', target: { id: resolved.id }, evidence: { files: files.length }, cost: { modelCalls: 0 } }])
    return { ok: true, code: 'ok', id: resolved.id, kind: resolved.kind, title, author, dir: entry.dir, files, bytes: files.reduce((n, f) => n + (f.bytes || 0), 0), errors: errors.slice(0, 5) }
  } catch (err) {
    return refusal('download-failed', `下载失败：${err?.message ?? err}`, '页面没关，可重试；若是结构问题跑 dy_diagnose。')
  }
}

// ---------------------------------------------------------------- user page

function userUrl(input) {
  const raw = String(input || '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^MS4wLjAB/.test(raw)) return `https://www.douyin.com/user/${raw}`
  if (/^[A-Za-z0-9_\-]{10,}$/.test(raw)) return `https://www.douyin.com/user/${raw}`
  return ''
}

async function runUser(cfg, logger, args) {
  const day = store.dayKey()
  const blocked = budgetRefusal(cfg, day)
  if (blocked) return blocked
  const limit = clampInt(args.limit, 1, 100, 30)
  const rounds = clampInt(args.rounds, 0, 20, 4)
  const tab = String(args.tab || 'post').toLowerCase()
  const { page, error } = await getPage(cfg, logger)
  if (error) return error

  let target = userUrl(args.user || args.url || args.secUid)
  if (!target && args.query) {
    await page.navigate(searchUrl(args.query), { timeoutMs: 30000 })
    await session.dismissOverlays(page, logger)
    await sleep(1500)
    let users = await page.evaluate(searchUsersScript())
    if (!users?.length) {
      // 搜索页默认是作品 tab：点开第一条作品，从作者链接拿 sec_uid
      const first = await page.evaluate(`(() => {
        for (const a of document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]')) {
          const m = (a.href || '').match(/\\/(video|note)\\/(\\d{6,})/);
          if (m) return a.href.split('?')[0];
        }
        return '';
      })()`)
      if (first) {
        await page.navigate(first, { timeoutMs: 30000 })
        await session.dismissOverlays(page, logger)
        await sleep(1500)
        const authorHref = await page.evaluate(`(() => {
          for (const a of document.querySelectorAll('a[href*="/user/"]')) {
            const m = (a.href || '').match(/\\/user\\/([\\w-]{6,})/);
            if (m) return a.href.split('?')[0];
          }
          return '';
        })()`)
        if (authorHref) users = [{ secUid: authorHref.split('/user/')[1], url: authorHref, text: '' }]
      }
    }
    if (!users?.length) return refusal('no-results', '没搜到用户。', '登录后搜索更完整；或直接传 sec_uid/主页链接。')
    target = users[0].url
  }
  if (!target) {
    return refusal('invalid-argument', '缺用户：传主页链接、sec_uid 或 query（先搜用户）。', '例如 kb_user({ user: "MS4wLjAB..." }) 或 kb_user({ query: "霖贝塔AI日记" })。')
  }

  try {
    await page.navigate(target, { timeoutMs: 30000 })
    await session.dismissOverlays(page, logger)
    await sleep(2500)
    const tabs = await page.evaluate(userTabsScript())
    if (tab !== 'post' && tabs?.length) {
      const wantTab = /like|喜欢/.test(tab) ? /喜欢|like/i : /collect|收藏/.test(tab) ? /收藏|collect/i : /collection|合集/.test(tab) ? /合集|collection/i : null
      const hit = wantTab ? tabs.find((t) => wantTab.test(t.label) || wantTab.test(t.e2e)) : null
      if (hit?.href) {
        await page.navigate(hit.href, { timeoutMs: 30000 })
        await session.dismissOverlays(page, logger)
        await sleep(2000)
      }
    }

    const seen = new Map()
    for (let i = 0; i <= rounds; i += 1) {
      const batch = await page.evaluate(userPostsScript())
      for (const p of batch || []) if (!seen.has(p.id)) seen.set(p.id, p)
      if (seen.size >= limit) break
      await page.evaluate('window.scrollBy(0, Math.round(window.innerHeight * 1.2))')
      await sleep(900)
    }
    const items = [...seen.values()].slice(0, limit)
    if (!items.length) {
      return refusal('no-posts', '主页打开了，但没找到作品链接。', '可能未登录/作者无公开作品/改版；跑 dy_diagnose 看页面。', { url: target, tabs })
    }
    store.appendKnowledge(items.map((p) => ({ kind: 'user-post', secUid: target.split('/user/')[1] || '', ...p })))
    return { ok: true, code: 'ok', url: target, tab, count: items.length, items, tabs }
  } catch (err) {
    return refusal('user-failed', `读主页失败：${err?.message ?? err}`, '页面没关可重试；结构问题跑 dy_diagnose。')
  }
}

// ---------------------------------------------------------------- search users / live / collections

async function runSearchUsers(cfg, logger, args) {
  const keyword = String(args.keyword || '').trim()
  if (!keyword) return refusal('invalid-argument', '缺关键词。', '传 keyword，例如「AI 日记」。')
  const { page, error } = await getPage(cfg, logger)
  if (error) return error
  try {
    await page.navigate(searchUrl(keyword), { timeoutMs: 30000 })
    await session.dismissOverlays(page, logger)
    await sleep(2000)
    let users = await page.evaluate(searchUsersScript())
    if (!users?.length) {
      return refusal('needs-login', '没读到用户结果（搜索通常需要登录）。', '调 dy_login 扫码后再试。')
    }
    users = users.slice(0, clampInt(args.limit, 1, 40, 20))
    store.appendKnowledge(users.map((u) => ({ kind: 'search-user', keyword, ...u })))
    return { ok: true, code: 'ok', keyword, count: users.length, users }
  } catch (err) {
    return refusal('search-users-failed', `搜用户失败：${err?.message ?? err}`, '重试或先登录。')
  }
}

async function runLive(cfg, logger, args) {
  const { page, error } = await getPage(cfg, logger)
  if (error) return error
  try {
    if (args.user || args.url) {
      const target = userUrl(args.user || args.url) || String(args.url)
      await page.navigate(target.replace(/\/$/, '') + (target.includes('?') ? '' : '/live'), { timeoutMs: 30000 }).catch(() => {})
      await sleep(2000)
      const state = await page.evaluate(liveStateScript())
      return { ok: true, code: 'ok', readOnly: true, ...state }
    }
    const state = await page.evaluate(liveStateScript())
    return { ok: true, code: 'ok', readOnly: true, ...state }
  } catch (err) {
    return refusal('live-failed', `读直播状态失败：${err?.message ?? err}`, '页面没关可重试。')
  }
}

async function runCollection(cfg, logger, args) {
  const uc = await runUser(cfg, logger, { ...args, tab: 'collection' })
  if (!uc.ok) return uc
  return { ok: true, code: 'ok', kind: 'collection', count: uc.count, items: uc.items }
}

// ---------------------------------------------------------------- export / index

async function runExport(cfg, logger, args) {
  const day = String(args.day || store.dayKey())
  const format = String(args.format || 'json').toLowerCase()
  const kind = String(args.kind || 'all').toLowerCase()
  const rows = store.readKnowledge(day).filter((r) => kind === 'all' || r.kind === kind)
  if (!rows.length) return refusal('no-data', `${day} 没有知识条目。`, '先跑 kb_hot / kb_video / kb_search / kb_comments。')
  const dir = store.knowledgeDir()
  fs.mkdirSync(dir, { recursive: true })
  const base = path.join(dir, `${day}-${kind}`)
  if (format === 'csv') {
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !['json'].includes(k))
    const esc = (v) => {
      const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)
      return '"' + s.replace(/"/g, '""') + '"'
    }
    const csv = [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n')
    fs.writeFileSync(base + '.csv', '\ufeff' + csv, 'utf8')
    return { ok: true, code: 'ok', day, kind, rows: rows.length, file: base + '.csv' }
  }
  fs.writeFileSync(base + '.json', JSON.stringify({ day, kind, rows }, null, 1), 'utf8')
  return { ok: true, code: 'ok', day, kind, rows: rows.length, file: base + '.json' }
}

let indexDb = null
async function runIndex(cfg, logger, args) {
  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    return refusal('no-sqlite', '当前 Node 没有 node:sqlite。', '升级到 Node 22.5+（或 24）后重试；也可先用 kb_export 出 JSON。')
  }
  const file = path.join(store.dataDir(), 'knowledge.sqlite')
  try {
    indexDb ??= new DatabaseSync(file)
    const db = indexDb
    db.exec(`CREATE TABLE IF NOT EXISTS kb (day TEXT, kind TEXT, id TEXT, title TEXT, author TEXT, body TEXT, json TEXT, PRIMARY KEY (day, kind, id, title))`)
    const insert = db.prepare('INSERT OR REPLACE INTO kb (day, kind, id, title, author, body, json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    let n = 0
    for (const day of (args.day ? [String(args.day)] : null) || []) {
      for (const r of store.readKnowledge(day)) {
        insert.run(day, r.kind || '', String(r.id || r.modalId || ''), String(r.title || r.text || '').slice(0, 200), String(r.author || ''), String(r.text || r.desc || '').slice(0, 2000), JSON.stringify(r))
        n += 1
      }
    }
    if (!args.day) {
      for (const day of (args.days ? args.days.map(String) : [])) {
        for (const r of store.readKnowledge(day)) {
          insert.run(day, r.kind || '', String(r.id || r.modalId || ''), String(r.title || r.text || '').slice(0, 200), String(r.author || ''), String(r.text || r.desc || '').slice(0, 2000), JSON.stringify(r))
          n += 1
        }
      }
    }
    if (args.query) {
      const rows = db.prepare('SELECT day, kind, id, title, author, body FROM kb WHERE title LIKE ? OR body LIKE ? LIMIT ?').all('%' + args.query + '%', '%' + args.query + '%', clampInt(args.limit, 1, 200, 20))
      return { ok: true, code: 'ok', query: args.query, count: rows.length, rows }
    }
    return { ok: true, code: 'ok', db: file, indexed: n, hint: '传 query 搜，传 day/days 建索引' }
  } catch (err) {
    return refusal('index-failed', `索引失败：${err?.message ?? err}`, '删掉 data/knowledge.sqlite 后重试。')
  }
}

// ---------------------------------------------------------------- batch

function batchStatePath(id) {
  return path.join(store.dataDir(), `batch-${id}.json`)
}

async function runBatch(cfg, logger, args) {
  const day = store.dayKey()
  const blocked = budgetRefusal(cfg, day)
  if (blocked) return blocked
  const authors = Array.isArray(args.authors) ? args.authors.map(String) : []
  const keywords = Array.isArray(args.keywords) ? args.keywords.map(String) : []
  if (!authors.length && !keywords.length) return refusal('invalid-argument', '缺任务：传 authors 或 keywords。', '例如 { authors: ["MS4wLjAB..."], limit: 20 }')
  const id = String(args.batchId || `b${Date.now().toString(36)}`)
  const stateFile = batchStatePath(id)
  let state = { id, startedAt: new Date().toISOString(), done: [], failed: [] }
  if (args.resume !== false && fs.existsSync(stateFile)) {
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch {}
  }
  const limit = clampInt(args.limit, 1, 100, 20)
  const results = []
  const queue = [
    ...authors.map((a) => ({ type: 'author', value: a })),
    ...keywords.map((k) => ({ type: 'keyword', value: k }))
  ].filter((t) => !state.done.includes(t.type + ':' + t.value))
  for (const job of queue) {
    const key = job.type + ':' + job.value
    try {
      const r = job.type === 'author'
        ? await runUser(cfg, logger, { user: job.value, limit, rounds: 2 })
        : await runSearchUsers(cfg, logger, { keyword: job.value, limit })
      results.push({ job: key, ok: Boolean(r.ok), count: r.count ?? 0, code: r.code })
      if (r.ok) state.done.push(key)
      else state.failed.push({ job: key, code: r.code })
    } catch (err) {
      state.failed.push({ job: key, code: 'exception', message: String(err?.message ?? err).slice(0, 120) })
    }
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 1), 'utf8')
    await sleep(clampInt(args.gapMs, 0, 10000, 800))
  }
  return { ok: true, code: 'ok', batchId: id, done: state.done.length, failed: state.failed.length, remaining: Math.max(0, authors.length + keywords.length - state.done.length), results, stateFile }
}

// ---------------------------------------------------------------- accounts

async function runAccounts(cfg, logger, args) {
  const action = String(args.action || 'list').toLowerCase()
  const base = store.dataDir()
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((f) => f.startsWith('profile-')) : []
  if (action === 'list') {
    return {
      ok: true,
      code: 'ok',
      dataDir: base,
      profiles: dirs.map((d) => {
        const dir = path.join(base, d)
        let size = 0
        try { size = fs.statSync(path.join(dir, 'Default', 'Network', 'Cookies')).size } catch {}
        return { profile: d, channel: d.replace('profile-', ''), hasCookies: size > 0, bytes: size }
      }),
      current: cfg.browserChannel
    }
  }
  if (action === 'switch') {
    const channel = String(args.channel || '').toLowerCase()
    if (!['auto', 'chrome', 'edge', 'chromium'].includes(channel)) {
      return refusal('invalid-argument', 'channel 只能是 auto/chrome/edge/chromium。', '例如 { action: "switch", channel: "edge" }')
    }
    return {
      ok: true,
      code: 'ok',
      note: '插件配置在宿主的 config 里，这里只告诉你改哪个键',
      hint: `把宿主 config 的 browserChannel 改成 "${channel}" 并重载插件行；当前是 "${cfg.browserChannel}"。`
    }
  }
  return refusal('invalid-argument', 'action 只能是 list 或 switch。', '')
}

// ---------------------------------------------------------------- gated writes

async function clickState(page, selector) {
  return page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    const pressed = el.getAttribute('aria-pressed') || el.getAttribute('data-pressed') || '';
    const text = (el.textContent || '').trim().slice(0, 40);
    return { found: true, pressed, text };
  })()`)
}

async function runWrite(cfg, logger, args, kind) {
  if (!cfg.enableOps) return refusal('ops-disabled', '写操作默认关闭（enableOps=false）。', '在宿主配置里打开 enableOps，并逐项打开 ops.allowLike/allowCollect。')
  if (kind === 'like' && !cfg.ops?.allowLike) return refusal('ops-not-allowed', '点赞未授权。', '把 ops.allowLike 设为 true 再试。')
  if (kind === 'collect' && !cfg.ops?.allowCollect) return refusal('ops-not-allowed', '收藏未授权。', '把 ops.allowCollect 设为 true 再试。')
  if (args.confirm !== true) return refusal('need-confirm', '写操作不可回滚，需要 confirm: true。', '确认要动账号再传 confirm: true。')
  const resolved = await resolveIdArgs(args)
  if (resolved.error) return resolved.error
  const cap = clampInt(cfg.dailyWriteActions, 0, 50, 0)
  const day = store.dayKey()
  if (cap <= 0) return refusal('write-quota', '今日写操作预算为 0。', '把 dailyWriteActions 设成 1~5 再试。')
  const used = store.readJournal(day).filter((e) => e.action === `ops_${kind}`).length
  if (used >= cap) return refusal('write-quota', `今日写操作已用 ${used}/${cap}。`, '明天再试，或调大 dailyWriteActions。')

  const { page, error } = await getPage(cfg, logger)
  if (error) return error
  try {
    const url = resolved.kind === 'note' ? `https://www.douyin.com/note/${resolved.id}` : videoPageUrl(resolved.id)
    await page.navigate(url, { timeoutMs: 30000 })
    await session.dismissOverlays(page, logger)
    await sleep(2000)
    const sel = kind === 'like'
      ? '[data-e2e="video-player-digg"], [data-e2e="like-icon"]'
      : '[data-e2e="video-player-collect"], [data-e2e="collect-icon"]'
    const before = await clickState(page, sel)
    if (!before.found) return refusal('no-button', `没找到${kind === 'like' ? '点赞' : '收藏'}按钮。`, '可能未登录或改版；先 dy_login，再跑 dy_diagnose。')
    await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.click(); })()`)
    await sleep(1200)
    const after = await clickState(page, sel)
    const changed = before.pressed !== after.pressed || before.text !== after.text
    store.appendJournal([{ surface: 'ops', action: `ops_${kind}`, ok: changed, code: changed ? 'ok' : 'unverified', target: { id: resolved.id }, evidence: { before, after }, cost: { modelCalls: 0 } }])
    if (!changed) {
      return refusal('unverified', '点了，但状态没变（可能是登录墙/改版）。', '去浏览器窗口看一眼；确认后把结果记进 JOURNAL。', { before, after })
    }
    return { ok: true, code: 'ok', kind, id: resolved.id, before, after, confirm: true }
  } catch (err) {
    return refusal(`ops-${kind}-failed`, `写操作失败：${err?.message ?? err}`, '页面没关可重试；不可回滚，确认后再来。')
  }
}

// ---------------------------------------------------------------- registration

export function buildExtTools(ctx, cfg) {
  const { logger } = ctx
  const tools = []

  if (cfg.enableDownload !== false) {
    tools.push(defineTool({
      name: 'kb_download',
      description: '下载一条抖音作品的原文件（视频 mp4 / 图文原图 / 音频 / 封面），落盘到 data/downloads，带 manifest 与去重；纯本地读取，0 模型调用。',
      parameters: {
        type: 'object',
        properties: {
          modalId: { type: 'string', description: 'id、/video/<id>、/note/<id> 或 v.douyin.com 短链' },
          parts: { type: 'array', items: { type: 'string' }, description: '要下的部分：video/images/audio/cover，默认 video+images+audio+cover' },
          resume: { type: 'boolean', description: '已下载过就直接返回（默认 true）' },
          downloadDir: { type: 'string', description: '自定义下载根目录（默认 data/downloads）' }
        },
        required: ['modalId']
      },
      execute: (args) => runDownload(cfg, logger, args)
    }))
  }

  if (cfg.enableUser !== false) {
    tools.push(defineTool({
      name: 'kb_user',
      description: '读某个作者主页的作品列表（发布/喜欢/收藏/合集），支持 sec_uid、主页链接或先按 query 搜用户；只读。',
      parameters: {
        type: 'object',
        properties: {
          user: { type: 'string', description: 'sec_uid 或主页链接' },
          query: { type: 'string', description: '没有 sec_uid 时先搜这个用户名' },
          tab: { type: 'string', enum: ['post', 'like', 'collect', 'collection'], description: '默认 post' },
          limit: { type: 'integer', description: '最多返回几条（默认 30）' },
          rounds: { type: 'integer', description: '额外的滚动轮数（默认 4）' }
        }
      },
      execute: (args) => runUser(cfg, logger, args)
    }))
    tools.push(defineTool({
      name: 'kb_collection',
      description: '读某个作者主页里的合集/收藏列表（等价 kb_user 的 tab=collection）。',
      parameters: { type: 'object', properties: { user: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer' } } },
      execute: (args) => runCollection(cfg, logger, args)
    }))
    tools.push(defineTool({
      name: 'kb_live',
      description: '只读直播状态：打开作者主页/直播间，报告是否在直播、标题与页面样本；不录制。',
      parameters: { type: 'object', properties: { user: { type: 'string' }, url: { type: 'string' } } },
      execute: (args) => runLive(cfg, logger, args)
    }))
  }

  if (cfg.enableSearchUser !== false) {
    tools.push(defineTool({
      name: 'kb_search_users',
      description: '按关键词搜抖音用户（需登录），返回 secUid / 主页链接。',
      parameters: { type: 'object', properties: { keyword: { type: 'string' }, limit: { type: 'integer' } }, required: ['keyword'] },
      execute: (args) => runSearchUsers(cfg, logger, args)
    }))
  }

  if (cfg.enableExport !== false) {
    tools.push(defineTool({
      name: 'kb_export',
      description: '把某天的知识库导出成 JSON 或 CSV（落盘到 knowledge 目录）。',
      parameters: {
        type: 'object',
        properties: {
          day: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
          format: { type: 'string', enum: ['json', 'csv'], description: '默认 json' },
          kind: { type: 'string', description: 'hot/video/search/comment/... 默认 all' }
        }
      },
      execute: (args) => runExport(cfg, logger, args)
    }))
    tools.push(defineTool({
      name: 'kb_index',
      description: '把知识库建进 SQLite（node:sqlite）并支持 query 检索；不传 day 时按 days 建索引。',
      parameters: {
        type: 'object',
        properties: {
          day: { type: 'string' },
          days: { type: 'array', items: { type: 'string' } },
          query: { type: 'string' },
          limit: { type: 'integer' }
        }
      },
      execute: (args) => runIndex(cfg, logger, args)
    }))
  }

  if (cfg.enableBatch !== false) {
    tools.push(defineTool({
      name: 'kb_batch',
      description: '批量任务：对多个作者主页/搜索关键词依次执行，断点续跑（batchId + resume），带间隔。',
      parameters: {
        type: 'object',
        properties: {
          authors: { type: 'array', items: { type: 'string' }, description: 'sec_uid 或主页链接列表' },
          keywords: { type: 'array', items: { type: 'string' }, description: '关键词列表（搜用户）' },
          limit: { type: 'integer' },
          gapMs: { type: 'integer' },
          batchId: { type: 'string' },
          resume: { type: 'boolean' }
        }
      },
      execute: (args) => runBatch(cfg, logger, args)
    }))
  }

  if (cfg.enableAccounts !== false) {
    tools.push(defineTool({
      name: 'dy_accounts',
      description: '列出插件各浏览器通道的 profile（是否带登录 cookie），或提示如何切换 browserChannel。',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'switch'] }, channel: { type: 'string' } } },
      execute: (args) => runAccounts(cfg, logger, args)
    }))
  }

  if (cfg.enableOps) {
    tools.push(defineTool({
      name: 'ops_like',
      description: '（写）给一条视频/图文点赞。默认关闭；需要 enableOps + ops.allowLike + confirm:true + 写预算。',
      parameters: {
        type: 'object',
        properties: { modalId: { type: 'string' }, confirm: { type: 'boolean' } },
        required: ['modalId']
      },
      execute: (args) => runWrite(cfg, logger, args, 'like')
    }))
    tools.push(defineTool({
      name: 'ops_collect',
      description: '（写）收藏一条视频/图文。默认关闭；需要 enableOps + ops.allowCollect + confirm:true + 写预算。',
      parameters: {
        type: 'object',
        properties: { modalId: { type: 'string' }, confirm: { type: 'boolean' } },
        required: ['modalId']
      },
      execute: (args) => runWrite(cfg, logger, args, 'collect')
    }))
  }

  return tools
}
