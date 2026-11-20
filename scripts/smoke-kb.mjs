/**
 * M1 acceptance: hot list, one video + frame, search login wall, Markdown dump.
 *
 *   DSH_HOME=<tmp> node scripts/smoke-kb.mjs edge
 */
import fs from 'node:fs'
import { apply } from '../index.js'

const channel = process.argv[2] === 'chrome' ? 'chrome' : 'edge'
const tools = new Map()
const ctx = {
  logger: { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.warn('[warn]', ...a), error: (...a) => console.error('[error]', ...a) },
  tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
  effect: (fn) => { fn(); return () => {} }
}

apply(ctx, { browserChannel: channel, enableKb: true, minIntervalMin: 0, hours: [0, 24] })
console.log('tools:', [...tools.keys()].join(', '))
for (const name of ['kb_hot', 'kb_video', 'kb_search', 'kb_save']) {
  if (!tools.has(name)) {
    console.error(`FAIL: ${name} not registered`)
    process.exit(1)
  }
}

const fails = []
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`)
  else {
    console.error(`  FAIL ${msg}`)
    fails.push(msg)
  }
}

// ---- kb_hot ----
const hot = await tools.get('kb_hot').execute({ limit: 10 })
console.log('kb_hot:', hot.ok ? `count=${hot.count} scanned=${hot.scanned}` : `${hot.code} ${hot.hint}`)
ok(hot.ok === true, 'kb_hot ok')
ok((hot.count ?? 0) >= 5, `kb_hot returned >= 5 items (got ${hot.count})`)
ok(Boolean(hot.items?.[0]?.title), 'kb_hot items carry a title')
if (hot.items?.[0]) {
  const it = hot.items[0]
  console.log(`    first: ${it.title.slice(0, 40)} | @${it.author} | ${it.durationText} | ${it.likesText}`)
  ok(Boolean(it.durationSec), 'kb_hot parses duration')
}

// ---- kb_video (open the first card) ----
const video = await tools.get('kb_video').execute({ cardIndex: 0, seekTo: 2 })
console.log(
  'kb_video:',
  video.ok
    ? `modalId=${video.modalId} duration=${video.video?.durationSec}s frame=${video.frameBytes}B suspect=${video.frameSuspect}`
    : `${video.code} ${video.hint}`
)
ok(video.ok === true, 'kb_video ok')
ok(/^\d+$/.test(String(video.modalId ?? '')), 'kb_video returns a numeric modalId')
ok(Number(video.video?.durationSec) > 0, 'kb_video returns a positive duration')
ok(Boolean(video.frameFile) && fs.existsSync(video.frameFile), 'kb_video wrote a frame file')
ok(video.frameSuspect !== true, 'frame is not suspiciously small (not a black frame)')

// ---- kb_video reopen by modalId (share-link style input) ----
if (/^\d+$/.test(String(video.modalId ?? ''))) {
  const reopened = await tools.get('kb_video').execute({ modalId: `https://www.douyin.com/video/${video.modalId}`, frame: false })
  console.log('kb_video(reopen):', reopened.ok ? `modalId=${reopened.modalId}` : `${reopened.code}`)
  ok(reopened.ok === true, 'kb_video accepts a share link and reopens')
  ok(String(reopened.modalId) === String(video.modalId), 'reopened modalId matches')
}

// ---- kb_video rejects junk input with an actionable code ----
const junk = await tools.get('kb_video').execute({ modalId: '不是链接', frame: false })
ok(junk.ok === false && junk.code === 'invalid-argument', 'kb_video rejects an unparsable modalId')
ok(typeof junk.hint === 'string' && junk.hint.length > 10, 'invalid-argument carries a hint')

// ---- kb_comments (login-gated; read-only) ----
if (/^\d+$/.test(String(video.modalId ?? ''))) {
  const comments = await tools.get('kb_comments').execute({ modalId: video.modalId, limit: 5 })
  if (comments.ok) {
    console.log('kb_comments:', `count=${comments.count} scanned=${comments.scanned}`)
    ok((comments.count ?? 0) > 0, 'kb_comments returned comments (signed in)')
    ok(Boolean(comments.comments?.[0]?.content), 'comment carries content')
  } else {
    console.log('kb_comments:', comments.code)
    ok(['needs-login', 'no-comments'].includes(comments.code), `kb_comments refusal code is expected (got ${comments.code})`)
    ok(typeof comments.hint === 'string' && comments.hint.length > 10, 'kb_comments refusal carries a hint')
  }
}

// ---- kb_search (login-gated today) ----
const search = await tools.get('kb_search').execute({ keyword: '美食', limit: 5 })
console.log('kb_search:', search.ok ? `count=${search.count}` : `${search.code}`)
if (search.ok) {
  ok((search.count ?? 0) > 0, 'kb_search returned results (logged in)')
} else {
  ok(search.code === 'needs-login', 'kb_search reports needs-login while signed out')
  ok(typeof search.hint === 'string' && search.hint.length > 10, 'needs-login carries an actionable hint')
}

// ---- kb_save ----
const saved = await tools.get('kb_save').execute({})
console.log('kb_save:', saved.ok ? `${saved.file} (${JSON.stringify(saved.counts)})` : `${saved.code}`)
ok(saved.ok === true, 'kb_save ok')
ok(Boolean(saved.file) && fs.existsSync(saved.file), 'kb_save wrote the markdown file')

// ---- journal + budget ----
const status = await tools.get('dy_status').execute({})
console.log('budget:', JSON.stringify(status.budget))
ok(typeof status.budget?.events === 'number' && status.budget.events > 0, 'journal recorded kb events')
ok(status.budget?.modelCalls === 0, 'read-only surfaces spend 0 model calls')

await tools.get('dy_status').execute({ closeBrowser: true })

if (fails.length) {
  console.error(`\n${fails.length} check(s) failed`)
  process.exit(1)
}
console.log(`\nOK ${channel}`)
